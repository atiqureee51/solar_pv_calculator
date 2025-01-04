from flask import Flask, render_template, request, jsonify
import pvlib
from pvlib import location, pvsystem, modelchain, irradiance, atmosphere, temperature
import pandas as pd
import numpy as np
import numpy_financial as npf
import json
import math
import requests
from datetime import datetime
import folium
from shapely.geometry import Polygon
from pyproj import Transformer
import random
from enum import Enum
from utils import *
from config import NREL_API_KEY, EMAIL
from geopy.geocoders import Nominatim
import io

app = Flask(__name__)

# Constants (same as before)
TEMPERATURE_MODEL_PARAMETERS = {
    'sapm': {
        'open_rack_glass_glass': {'a': -3.47, 'b': -0.0594, 'deltaT': 3},
        'close_mount_glass_glass': {'a': -2.98, 'b': -0.0471, 'deltaT': 1},
        'open_rack_glass_polymer': {'a': -3.56, 'b': -0.0750, 'deltaT': 3},
        'insulated_back_glass_polymer': {'a': -2.81, 'b': -0.0455, 'deltaT': 0},
    },
    'pvsyst': {
        'freestanding': {'u_c': 29.0, 'u_v': 0.0},
        'insulated': {'u_c': 15.0, 'u_v': 0.0}
    }
}

# System type to temperature model mapping
SYSTEM_TYPE_DEFAULTS = {
    'ground': {
        'temp_model': 'sapm',
        'sapm_type': 'open_rack',
        'pvsyst_type': 'freestanding'
    },
    'roof': {
        'temp_model': 'pvsyst',
        'sapm_type': 'close_mount',
        'pvsyst_type': 'integrated'
    },
    'floating': {
        'temp_model': 'pvsyst',
        'sapm_type': 'water_surface',
        'pvsyst_type': 'water_surface'
    }
}

currency_conversion = {"USD": 1, "BDT": 110}
def_elec_rate_bd = 0.08
def_elec_rate_us = 0.12
def_elec_rate_global = 0.10

# ------------- Weather Data Helpers -------------
def get_psm_url(lon):
    """Select correct NREL PSM3 endpoint based on longitude."""
    NSRDB_API_BASE = "https://developer.nrel.gov"
    PSM_URL1 = NSRDB_API_BASE + "/api/nsrdb/v2/solar/psm3-download.csv"
    MSG_URL = NSRDB_API_BASE + "/api/nsrdb/v2/solar/msg-iodc-download.csv"
    HIMAWARI_URL = NSRDB_API_BASE + "/api/nsrdb/v2/solar/himawari-download.csv"
    if -16 < lon < 91:
        return MSG_URL
    elif 91 <= lon < 182:
        return HIMAWARI_URL
    else:
        return PSM_URL1

def get_sample_weather_data():
    """Generate sample hourly data for a year if NREL fetch fails."""
    dates = pd.date_range(start='2019-01-01', end='2019-12-31 23:00:00', freq='H')
    n_hours = len(dates)
    
    weather_data = pd.DataFrame({
        'air_temperature': 25 + 5 * np.sin(np.linspace(0, 2*np.pi, n_hours)) + np.random.normal(0, 1, n_hours),
        'dhi': 200 * np.sin(np.linspace(0, 2*np.pi, n_hours))**2 + np.random.normal(0, 20, n_hours),
        'dni': 800 * np.sin(np.linspace(0, 2*np.pi, n_hours))**2 + np.random.normal(0, 50, n_hours),
        'ghi': 1000 * np.sin(np.linspace(0, 2*np.pi, n_hours))**2 + np.random.normal(0, 50, n_hours),
        'surface_albedo': np.full(n_hours, 0.2),
        'surface_pressure': np.full(n_hours, 101325),
        'wind_direction': np.random.uniform(0, 360, n_hours),
        'wind_speed': 5 + np.random.normal(0, 1, n_hours)
    }, index=dates)
    
    # Clip negative
    weather_data['dhi'] = weather_data['dhi'].clip(lower=0)
    weather_data['dni'] = weather_data['dni'].clip(lower=0)
    weather_data['ghi'] = weather_data['ghi'].clip(lower=0)
    weather_data['wind_speed'] = weather_data['wind_speed'].clip(lower=0)
    return weather_data

def parse_psm3(fbuf, map_variables=False):
    metadata_fields = fbuf.readline().split(',')
    metadata_fields[-1] = metadata_fields[-1].strip()
    metadata_values = fbuf.readline().split(',')
    metadata_values[-1] = metadata_values[-1].strip()
    metadata = dict(zip(metadata_fields, metadata_values))
    metadata['Local Time Zone'] = int(metadata['Local Time Zone'])
    metadata['Time Zone'] = int(metadata['Time Zone'])
    metadata['Latitude'] = float(metadata['Latitude'])
    metadata['Longitude'] = float(metadata['Longitude'])
    metadata['Elevation'] = int(metadata['Elevation'])
    columns = fbuf.readline().split(',')
    columns[-1] = columns[-1].strip()
    columns = [col for col in columns if col != '']
    dtypes = dict.fromkeys(columns, float)
    dtypes.update(Year=int, Month=int, Day=int, Hour=int, Minute=int)
    dtypes['Cloud Type'] = int
    dtypes['Fill Flag'] = int
    
    data = pd.read_csv(
        fbuf, header=None, names=columns, usecols=columns, dtype=dtypes,
        delimiter=',', lineterminator='\n')
    dtidx = pd.to_datetime(data[['Year', 'Month', 'Day', 'Hour', 'Minute']])
    tz = 'Etc/GMT%+d' % -metadata['Time Zone']
    data.index = pd.DatetimeIndex(dtidx).tz_localize(tz)

    if map_variables:
        VARIABLE_MAP = {
            'GHI': 'ghi',
            'DHI': 'dhi',
            'DNI': 'dni',
            'Clearsky GHI': 'ghi_clear',
            'Clearsky DHI': 'dhi_clear',
            'Clearsky DNI': 'dni_clear',
            'Solar Zenith Angle': 'solar_zenith',
            'Temperature': 'air_temperature',
            'Relative Humidity': 'relative_humidity',
            'Dew point': 'temp_dew',
            'Pressure': 'pressure',
            'Wind Direction': 'wind_direction',
            'Wind Speed': 'wind_speed',
            'Surface Albedo': 'albedo',
            'Precipitable Water': 'precipitable_water',
            'Surface Pressure': 'surface_pressure'
        }
        rename_map = {k: v for k, v in VARIABLE_MAP.items() if k in data.columns}
        data = data.rename(columns=rename_map)
        metadata['latitude'] = metadata.pop('Latitude')
        metadata['longitude'] = metadata.pop('Longitude')
        metadata['altitude'] = metadata.pop('Elevation')
    return data, metadata

def get_psm3_data(latitude, longitude, api_key, email, names='tmy', interval=60,
                  attributes=('air_temperature','dew_point','dhi','dni','ghi','surface_albedo','surface_pressure','wind_direction','wind_speed'),
                  leap_day=False, full_name='pvlib python',
                  affiliation='pvlib python', timeout=30):
    longitude_str = ('%9.4f' % longitude).strip()
    latitude_str = ('%8.4f' % latitude).strip()
    params = {
        'api_key': api_key,
        'full_name': full_name,
        'email': email,
        'affiliation': affiliation,
        'reason': 'pvlib python',
        'mailing_list': 'false',
        'wkt': f'POINT({longitude_str} {latitude_str})',
        'names': names,
        'attributes': ','.join(attributes),
        'leap_day': str(leap_day).lower(),
        'utc': 'false',
        'interval': interval
    }

    # Decide which endpoint:
    if any(prefix in names for prefix in ('tmy','tgy','tdy')):
        URL = "https://developer.nrel.gov/api/nsrdb/v2/solar/psm3-tmy-download.csv"
    elif interval in (5,15):
        URL = "https://developer.nrel.gov/api/nsrdb/v2/solar/psm3-5min-download.csv"
    else:
        URL = get_psm_url(float(longitude))

    response = requests.get(URL, params=params, timeout=timeout)
    if not response.ok:
        from json import JSONDecodeError
        try:
            errors = response.json()['errors']
        except JSONDecodeError:
            errors = response.content.decode('utf-8')
        raise requests.HTTPError(errors, response=response)

    fbuf = io.StringIO(response.content.decode('utf-8'))
    data, metadata = parse_psm3(fbuf, map_variables=True)
    return data, metadata

# ------------- PV/Financial Calculations -------------
def compute_area_of_polygon(latlon_list):
    """Compute polygon area from lat-lons using shapely & pyproj."""
    if len(latlon_list) < 3:
        return 0
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    coords_3857 = [transformer.transform(pt[1], pt[0]) for pt in latlon_list]
    polygon_3857 = Polygon(coords_3857)
    return polygon_3857.area

def calculate_financial_metrics(
    annual_energy, installed_cost, electricity_rate,
    project_life, fed_credit, st_credit,
    interest_rate, maintenance_cost
):
    """Compute LCOE, payback, etc., ensuring floats are JSON-serializable."""
    # annual_energy is kWh, so installed_cost is presumably numeric
    total_capital_cost = installed_cost - (installed_cost * fed_credit) - (installed_cost * st_credit)
    annual_savings = annual_energy * electricity_rate
    
    rpwf = (1 - ((1 + interest_rate)**(-project_life))) / interest_rate
    single_pwf = (1 / ((1 + interest_rate)**project_life))
    
    # Calculate present worth of recurring costs
    recurring_costs_pw = maintenance_cost * rpwf
    
    # Calculate net life cycle cost
    net_lcc_cost = total_capital_cost + recurring_costs_pw
    
    # Calculate payback period
    payback = total_capital_cost / annual_savings if annual_savings > 0 else float('inf')
    
    fixed_charge_rate = 1 / rpwf
    lcoe = ((total_capital_cost * fixed_charge_rate) + maintenance_cost) / annual_energy if annual_energy > 0 else 0
    
    co2_savings = (annual_energy * 0.7 / 1000)  # 0.7 kg/kWh => tons
    
    # Calculate total 25-year savings (undiscounted)
    total_savings = annual_savings * project_life - total_capital_cost
    
    return {
        'annual_energy_kwh': float(annual_energy),
        'annual_savings': float(annual_savings),
        'simple_payback': float(payback),
        'lcoe': float(lcoe),
        'co2_savings': float(co2_savings),
        'net_present_value': float(-net_lcc_cost),
        'total_capital_cost': float(total_capital_cost),
        'total_savings': float(total_savings)
    }

class ASHRAE_VERSION(Enum):
    v2009 = '2009'
    v2013 = '2013'
    v2017 = '2017'
    v2021 = '2021'

def fetch_ashrae_design_data(lat, lon, ashrae_version=ASHRAE_VERSION.v2021):
    """Fetch ASHRAE design temperatures for a location"""
    try:
        request_params = {
            'lat': lat,
            'long': lon,
            'number': '10',
            'ashrae_version': ashrae_version.value
        }
        url = 'https://ashrae-meteo.info/v2.0/request_places.php'
        resp = requests.post(url, data=request_params)
        if resp.status_code != 200:
            return None
        
        stations = resp.json().get('meteo_stations', [])
        if not stations:
            return None
        
        station_data = stations[0]
        request_params = {
            'wmo': station_data.get('wmo'),
            'ashrae_version': ashrae_version.value,
            'si_ip': 'SI'
        }
        url = 'https://ashrae-meteo.info/v2.0/request_meteo_parametres.php'
        
        resp = requests.post(url, data=request_params)
        if resp.status_code != 200:
            return None
        
        stations = resp.json().get('meteo_stations', [])
        if not stations:
            return None
        
        station = stations[0]
        return {
            'heating_DB_99.6': float(station.get('heating_DB_99.6', 0)),
            'cooling_DB_0.4': float(station.get('cooling_DB_MCWB_0.4_DB', 45))
        }
    except Exception as e:
        print(f"Error fetching ASHRAE data: {str(e)}")
        return None

def calculate_cell_temp_pvsyst(poa_global, temp_air, wind_speed, u_c, u_v):
    return temp_air + (poa_global * (u_c + u_v*wind_speed)/800)

def get_cell_temperature(env_data, weather, params):
    """pvsyst or sapm model, ensuring we read from 'air_temperature' not 'temp_air'."""
    if 'model' in params and params['model'] == 'pvsyst':
        return calculate_cell_temp_pvsyst(
            env_data['poa_global'],
            weather['air_temperature'],
            weather['wind_speed'],
            params['u_c'],
            params['u_v']
        )
    else:
        return pvlib.temperature.sapm_cell(
            poa_global=env_data['poa_global'],
            temp_air=weather['air_temperature'],
            wind_speed=weather['wind_speed'],
            a=params.get('a', -3.56),
            b=params.get('b', -0.075),
            deltaT=params.get('deltaT', 3)
        )

def calculate_pv_output(latitude, longitude, system_size_kw, module_name,
                        inverter_name, temperature_model_parameters,
                        tilt=30, azimuth=180, gcr=0.4):
    try:
        print("Starting PV output calculation...")
        mod_db = pvsystem.retrieve_sam('SandiaMod')
        inv_db = pvsystem.retrieve_sam('SandiaInverter')
        
        if module_name not in mod_db.columns:
            return {"error": f"Module '{module_name}' not found"}
        if inverter_name not in inv_db.columns:
            return {"error": f"Inverter '{inverter_name}' not found"}
            
        module = mod_db[module_name].to_dict()
        inverter = inv_db[inverter_name].to_dict()
        
        print("Module and inverter data retrieved successfully")
        
        weather, metadata = get_weather_data(latitude, longitude)
        print("Weather data retrieved successfully")
        
        # ASHRAE data
        ashrae_data = fetch_ashrae_design_data(latitude, longitude)
        if ashrae_data:
            min_db_temp_ashrae = ashrae_data['heating_DB_99.6']
            max_db_temp_ashrae = ashrae_data['cooling_DB_0.4']
        else:
            min_db_temp_ashrae = -3.7
            max_db_temp_ashrae = 45.0
        print("ASHRAE data processed")

        # Module temperature coefficients
        module['Bvoco%/C'] = float(module['Bvoco']/module['Voco']*100)
        module['Bvmpo%/C'] = float(module['Bvmpo']/module['Vmpo']*100)
        module['Aimpo%/C'] = float(module['Aimp']/module['Impo']*100)
        module['TPmpo%/C'] = float(module['Bvmpo%/C'] + module['Aimpo%/C'])
        
        max_module_voc = module['Voco']*(1 + ((min_db_temp_ashrae-25) * module['Bvoco%/C']/100))
        max_string_design_voltage = float(inverter['Vdcmax'])
        max_module_series = int(max_string_design_voltage / max_module_voc)
        
        dc_ac_ratio = float(inverter['Pdco']/inverter['Paco'])
        single_module_power = float(module['Vmpo']*module['Impo'])
        
        T_add = 25
        min_module_vmp = module['Vmpo']*(1 + ((T_add + max_db_temp_ashrae -25)*module['TPmpo%/C']/100))
        min_module_series_okay = math.ceil(inverter['Mppt_low'] * dc_ac_ratio / min_module_vmp)
        
        print("Module calculations completed")

        # Calculate number of modules based on desired system size
        total_power_needed = system_size_kw * 1000  # Convert kW to W
        total_modules_needed = math.ceil(total_power_needed / single_module_power)
        
        # Calculate optimal string configuration
        max_modules_per_string = min(
            math.floor(inverter['Vdcmax'] / module['Vmpo']),
            math.floor(inverter['Vdcmax'] / module['Voco'])
        )
        min_modules_per_string = math.ceil(inverter['Mppt_low'] / module['Vmpo'])
        
        # Choose optimal number of modules per string
        modules_per_string = min(max_modules_per_string, 
                               max(min_modules_per_string, 
                                   math.ceil(math.sqrt(total_modules_needed))))
        
        # Calculate number of parallel strings needed
        parallel_strings = math.ceil(total_modules_needed / modules_per_string)
        max_parallel_strings = math.floor(inverter['Idcmax'] / module['Impo'])
        
        # If we need more strings than the inverter can handle, use multiple inverters
        num_inverters = math.ceil(parallel_strings / max_parallel_strings)
        parallel_strings_per_inverter = min(parallel_strings // num_inverters, max_parallel_strings)
        
        # Recalculate actual number of modules to match desired system size as closely as possible
        actual_modules = modules_per_string * parallel_strings_per_inverter * num_inverters
        
        # Calculate actual DC system size
        dc_system_size = (single_module_power * actual_modules) / 1000  # kW
        
        location_obj = location.Location(latitude, longitude, 'Etc/GMT', altitude=0)
        
        if 'air_temperature' not in weather.columns:
            weather['air_temperature'] = 25.0
        if 'wind_speed' not in weather.columns:
            weather['wind_speed'] = 1.0

        # solar position
        sol_data = pvlib.solarposition.get_solarposition(
            time=weather.index,
            latitude=latitude,
            longitude=longitude,
            altitude=0,
            temperature=weather['air_temperature']
        )
        print("Solar position calculated")

        sol_data['dni_extra'] = pvlib.irradiance.get_extra_radiation(weather.index)
        
        env_data = pvlib.irradiance.get_total_irradiance(
            surface_tilt=tilt,
            surface_azimuth=azimuth,
            solar_zenith=sol_data['apparent_zenith'],
            solar_azimuth=sol_data['azimuth'],
            dni=weather['dni'],
            ghi=weather['ghi'],
            dhi=weather['dhi'],
            dni_extra=sol_data['dni_extra'],
            model='haydavies'
        )
        print("Irradiance calculated")

        env_data['aoi'] = pvlib.irradiance.aoi(
            surface_tilt=tilt,
            surface_azimuth=azimuth,
            solar_zenith=sol_data['apparent_zenith'],
            solar_azimuth=sol_data['azimuth']
        )
        
        env_data['airmass'] = pvlib.atmosphere.get_relative_airmass(
            zenith=sol_data['apparent_zenith']
        )
        pressure = 101325
        if 'surface_pressure' in weather.columns:
            pressure = weather['surface_pressure']*100
        am_abs = pvlib.atmosphere.get_absolute_airmass(env_data['airmass'], pressure=pressure)
        env_data['am_abs'] = am_abs
        print("Air mass calculated")

        wdf = weather.copy()
        
        cell_temps = get_cell_temperature(env_data, weather, temperature_model_parameters)
        wdf['cell_temperature'] = pd.Series(cell_temps, index=weather.index)
        print("Cell temperature done.")

        effective_irr = pvsystem.sapm_effective_irradiance(
            poa_direct=env_data['poa_direct'],
            poa_diffuse=env_data['poa_diffuse'],
            airmass_absolute=env_data['am_abs'],
            aoi=env_data['aoi'],
            module=module
        )
        wdf['effective_irradiance'] = pd.Series(effective_irr, index=weather.index)
        print("Effective irradiance done.")

        mount = pvsystem.FixedMount(surface_tilt=tilt, surface_azimuth=azimuth)
        array = pvsystem.Array(
            mount=mount,
            module_parameters=module,
            temperature_model_parameters=temperature_model_parameters,
            modules_per_string=modules_per_string,
            strings=parallel_strings_per_inverter
        )
        system_obj = pvsystem.PVSystem(
            arrays=[array],
            inverter_parameters=inverter,
            losses_parameters={'soiling': 2, 'mismatch': 2, 'wiring': 2, 'shading': 0}
        )
        
        mc = modelchain.ModelChain(system_obj, location_obj, losses_model='pvwatts')
        mc.run_model(wdf)
        print("ModelChain run completed")

        ac_filled = mc.results.ac.fillna(0)
        if isinstance(ac_filled, pd.DataFrame):
            ac_annual_series = ac_filled.sum(axis=1)
        else:
            ac_annual_series = ac_filled

        dc_filled = mc.results.dc.fillna(0)
        if isinstance(dc_filled, pd.DataFrame):
            dc_annual_series = dc_filled.sum(axis=1)
        else:
            dc_annual_series = dc_filled

        # Calculate daily and monthly energy
        # For daily profile, calculate average for each hour of the day
        daily_energy = [float(x) for x in ac_annual_series.groupby(ac_annual_series.index.hour).mean().tolist()]
        monthly_energy = [float(x) for x in ac_annual_series.resample('M').sum().tolist()]

        # Calculate annual energy and power values
        annual_energy_mwh = (ac_annual_series.sum()*num_inverters)/1e6
        peak_ac = ac_annual_series.max()
        peak_dc = dc_annual_series.max()
        
        annual_energy_kwh = float(annual_energy_mwh*1000)
        peak_ac_kW = float(peak_ac/1000)
        peak_dc_kW = float(peak_dc/1000)

        # Calculate performance metrics as before...
        poa_wh_m2=(env_data['poa_global'])
        poa_sum=poa_wh_m2.resample('Y').sum().values[0]
        Reference_Yield=poa_sum/1000
        Final_Yield=(annual_energy_kwh/(single_module_power*modules_per_string*parallel_strings_per_inverter*num_inverters))*1000
        performance_ratio=Final_Yield/Reference_Yield
        capacity_factor=((annual_energy_kwh)/(single_module_power*modules_per_string*parallel_strings_per_inverter*num_inverters*8760))*1000
        specific_yield = float(annual_energy_kwh / system_size_kw if system_size_kw > 0 else 0)

        # Calculate financial metrics
        base_module_cost = 0.35  # $/W for modules
        base_inverter_cost = 0.10  # $/W for inverters
        base_bos_cost = {
            'racking': 0.10,  # $/W
            'wiring': 0.15,   # $/W
            'disconnect': 0.05 # $/W
        }
        base_installation_cost = {
            'labor': 0.20,    # $/W
            'overhead': 0.10,  # $/W
            'profit': 0.10    # $/W
        }
        base_soft_cost = {
            'permitting': 0.10,  # $/W
            'inspection': 0.05,  # $/W
            'interconnection': 0.10,  # $/W
            'overhead': 0.10   # $/W
        }
        
        # Scale costs based on system size (economies of scale)
        size_factor = min(1.0, math.log10(system_size_kw) / math.log10(100))  # Reduces cost for larger systems
        
        # Calculate component costs
        module_cost = system_size_kw * 1000 * (base_module_cost * (1 - 0.1 * size_factor))
        inverter_cost = system_size_kw * 1000 * (base_inverter_cost * (1 - 0.1 * size_factor))
        bos_cost = system_size_kw * 1000 * sum(base_bos_cost.values()) * (1 - 0.15 * size_factor)
        installation_cost = system_size_kw * 1000 * sum(base_installation_cost.values()) * (1 - 0.2 * size_factor)
        soft_cost = system_size_kw * 1000 * sum(base_soft_cost.values()) * (1 - 0.1 * size_factor)
        
        total_capex = module_cost + inverter_cost + bos_cost + installation_cost + soft_cost
        
        # O&M costs (based on NREL data)
        annual_opex = 15 * system_size_kw  # $15/kW-year for fixed-tilt residential/commercial
        
        # Financial parameters
        annual_degradation = 0.005  # 0.5% annual degradation (industry standard)
        electricity_price_escalation = 0.025  # 2.5% annual increase (historical average)
        discount_rate = 0.06  # 6% discount rate (typical for solar projects)
        project_life = 25  # 25 years (standard warranty period)
        
        # Calculate cash flows
        cashflows = []
        cumulative_cashflow = [-total_capex]
        annual_energy = annual_energy_kwh
        electricity_price = 0.12  # $/kWh
        
        for year in range(1, project_life + 1):
            # Calculate degraded energy production
            annual_energy *= (1 - annual_degradation)
            # Calculate escalated electricity price
            electricity_price *= (1 + electricity_price_escalation)
            # Calculate revenue
            revenue = annual_energy * electricity_price
            # Calculate net cash flow
            net_cashflow = revenue - annual_opex
            cashflows.append(float(net_cashflow))
            cumulative_cashflow.append(float(cumulative_cashflow[-1] + net_cashflow))
        
        # Calculate NPV
        npv = -total_capex
        for i, cashflow in enumerate(cashflows, 1):
            npv += cashflow / ((1 + discount_rate) ** i)
        
        # Calculate LCOE
        total_energy = 0
        total_cost = total_capex
        for i in range(project_life):
            energy_produced = annual_energy_kwh * ((1 - annual_degradation) ** i)
            total_energy += energy_produced / ((1 + discount_rate) ** i)
            total_cost += annual_opex / ((1 + discount_rate) ** i)
        
        lcoe = total_cost / total_energy if total_energy > 0 else 0
        
        # Find payback period
        payback_period = None
        for i, cum_cashflow in enumerate(cumulative_cashflow):
            if cum_cashflow >= 0:
                payback_period = i
                break
        if payback_period is None:
            payback_period = project_life
            
        # Cost breakdown for pie chart
        cost_breakdown = {
            'Modules': float(module_cost),
            'Inverters': float(inverter_cost),
            'Balance of System': float(bos_cost),
            'Installation': float(installation_cost),
            'Soft Costs': float(soft_cost)
        }
        
        # Currency conversion rates
        currency_conversion = {"USD": 1, "BDT": 110}
        default_currency = "BDT"
        
        # Base costs in USD
        base_costs = {
            'module': 0.35,      # $/W
            'inverter': 0.10,    # $/W
            'bos': {
                'racking': 0.10,
                'wiring': 0.15,
                'disconnect': 0.05
            },
            'installation': {
                'labor': 0.20,
                'overhead': 0.10,
                'profit': 0.10
            },
            'soft': {
                'permitting': 0.10,
                'inspection': 0.05,
                'interconnection': 0.10,
                'overhead': 0.10
            }
        }
        
        # Default values in USD
        defaults = {
            'electricity_rate': 0.07,  # $0.07/kWh (7 BDT/kWh)
            'maintenance_cost': 15,    # $15/kW-year
            'degradation': 0.005,      # 0.5% per year
            'price_escalation': 0.025  # 2.5% per year
        }
        
        # Convert to selected currency
        selected_currency = "BDT"
        rate = currency_conversion[selected_currency]
        
        # Calculate costs with economies of scale
        system_size_w = system_size_kw * 1000
        size_factor = min(1.0, math.log10(system_size_kw) / math.log10(100))
        
        # Calculate component costs with scale factors
        module_cost = system_size_w * (base_costs['module'] * (1 - 0.1 * size_factor)) * rate
        inverter_cost = system_size_w * (base_costs['inverter'] * (1 - 0.1 * size_factor)) * rate
        bos_cost = system_size_w * sum(base_costs['bos'].values()) * (1 - 0.15 * size_factor) * rate
        installation_cost = system_size_w * sum(base_costs['installation'].values()) * (1 - 0.2 * size_factor) * rate
        soft_cost = system_size_w * sum(base_costs['soft'].values()) * (1 - 0.1 * size_factor) * rate
        
        total_capex = module_cost + inverter_cost + bos_cost + installation_cost + soft_cost
        
        # O&M costs
        annual_opex = defaults['maintenance_cost'] * system_size_kw * rate
        
        # Financial parameters
        annual_degradation = defaults['degradation']
        electricity_price = defaults['electricity_rate'] * rate
        electricity_price_escalation = defaults['price_escalation']
        
        return {
            'annual_energy': annual_energy_kwh,
            'peak_dc_power': peak_dc_kW,
            'peak_ac_power': peak_ac_kW,
            'performance_ratio': performance_ratio,
            'capacity_factor': capacity_factor,
            'specific_yield': specific_yield,
            'modules_per_string': int(modules_per_string),
            'strings_per_inverter': int(parallel_strings_per_inverter),
            'number_of_inverters': int(num_inverters),
            'dc_ac_ratio': float(dc_ac_ratio),
            'total_module_area': float(module['Area'] * modules_per_string * parallel_strings_per_inverter * num_inverters),
            'module_area': float(module['Area']),
            'module_type': module_name,
            'total_modules': int(modules_per_string * parallel_strings_per_inverter * num_inverters),
            'inverter_type': inverter_name,
            'system_size': system_size_kw,
            'inverter_power': inverter['Paco'],
            'module_power': single_module_power,
            'daily_energy': daily_energy,
            'monthly_energy': monthly_energy,
            'lcoe': float(lcoe),
            'npv': float(npv),
            'payback_period': float(payback_period if payback_period else project_life),
            'cost_breakdown': cost_breakdown,
            'cumulative_cashflow': [float(x) for x in cumulative_cashflow],
            'annual_cashflow': [float(-total_capex)] + cashflows,  # Include initial investment
            'min_design_temp': float(min_db_temp_ashrae),
            'max_design_temp': float(max_db_temp_ashrae),
            'effective_irradiance': float(wdf['effective_irradiance'].mean()),
            'cell_temperature': float(wdf['cell_temperature'].mean()),
            'monthly_ghi': [float(x) for x in weather['ghi'].resample('M').sum().tolist()],
            'monthly_temperature': [float(x) for x in weather['air_temperature'].resample('M').mean().tolist()],
            'hourly_wind_speed': [float(x) for x in weather['wind_speed'].tolist()]
        }
    except Exception as e:
        import traceback
        print("Error in calculate_pv_output:", str(e))
        print(traceback.format_exc())
        return {"error": str(e)}

def calculate_system_size_from_area(area_m2, module_power_w=400, ground_coverage_ratio=0.4):
    """Calculate system size in kW from area."""
    # Typical module is ~2m², so area/2 gives approximate number of modules
    # GCR accounts for spacing between rows
    num_modules = (area_m2 * ground_coverage_ratio) / 2
    system_size_w = num_modules * module_power_w
    return system_size_w / 1000  # Convert to kW

def calculate_area_from_system_size(system_size_kw, module_power_w=400, ground_coverage_ratio=0.4):
    """Calculate required area in m² from system size."""
    num_modules = (system_size_kw * 1000) / module_power_w
    area_m2 = (num_modules * 2) / ground_coverage_ratio  # 2m² per module
    return area_m2

def get_module_details(module_name):
    """Get detailed module information for display"""
    try:
        mod_db = pvsystem.retrieve_sam('SandiaMod')
        if module_name in mod_db.columns:
            module = mod_db[module_name]
            return {
                'name': module_name,
                'power': float(module['Vmpo'] * module['Impo']),  # W
                'voc': float(module['Voco']),  # V
                'isc': float(module['Isco']),  # A
                'vmpp': float(module['Vmpo']),  # V
                'impp': float(module['Impo']),  # A
                'area': float(module['Area']),  # m²
                'material': module.get('Material', 'Not specified'),
                'temp_coeff_pmax': float(module['Bvmpo']/module['Vmpo']*100 + module['Aimp']/module['Impo']*100)  # %/°C
            }
    except Exception as e:
        print(f"Error getting module details: {str(e)}")
    return None

def get_inverter_details(inverter_name):
    """Get detailed inverter information for display"""
    try:
        inv_db = pvsystem.retrieve_sam('SandiaInverter')
        if inverter_name in inv_db.columns:
            inverter = inv_db[inverter_name]
            return {
                'name': inverter_name,
                'pac': float(inverter['Paco']),  # W
                'pdc': float(inverter['Pdco']),  # W
                'vdc_min': float(inverter['Mppt_low']),  # V
                'vdc_max': float(inverter['Vdcmax']),  # V
                'idc_max': float(inverter['Idcmax']),  # A
                'efficiency': float(inverter['Paco']/inverter['Pdco']*100)  # %
            }
    except Exception as e:
        print(f"Error getting inverter details: {str(e)}")
    return None

def check_sizing_compatibility(module_name, inverter_name, system_size_kw):
    """Check if module and inverter combination is suitable for system size"""
    try:
        mod_db = pvsystem.retrieve_sam('SandiaMod')
        inv_db = pvsystem.retrieve_sam('SandiaInverter')
        
        if module_name not in mod_db.columns or inverter_name not in inv_db.columns:
            return None
            
        module = mod_db[module_name]
        inverter = inv_db[inverter_name]
        
        # Calculate key parameters
        module_power = float(module['Vmpo'] * module['Impo'])  # W
        inverter_power = float(inverter['Paco'])  # W
        system_power = system_size_kw * 1000  # W
        
        # Calculate number of inverters needed
        num_inverters = math.ceil(system_power / inverter_power)
        
        # Check if inverter is appropriately sized
        if inverter_power > system_power * 1.3:
            return {"status": "oversized", "message": f"Inverter is oversized. Consider using a smaller inverter for {system_size_kw}kW system."}
        elif inverter_power * num_inverters < system_power * 0.8:
            return {"status": "undersized", "message": f"Inverter is undersized. Need {num_inverters} inverters for {system_size_kw}kW system."}
        
        return {"status": "ok", "message": f"Sizing is appropriate. Using {num_inverters} inverter(s)."}
        
    except Exception as e:
        print(f"Error checking sizing: {str(e)}")
        return None

@app.route('/api/get_module_details', methods=['GET'])
def module_details_route():
    module_name = request.args.get('module')
    if not module_name:
        return jsonify({"error": "No module specified"}), 400
    details = get_module_details(module_name)
    if details:
        return jsonify(details)
    return jsonify({"error": "Module not found"}), 404

@app.route('/api/get_inverter_details', methods=['GET'])
def inverter_details_route():
    inverter_name = request.args.get('inverter')
    if not inverter_name:
        return jsonify({"error": "No inverter specified"}), 400
    details = get_inverter_details(inverter_name)
    if details:
        return jsonify(details)
    return jsonify({"error": "Inverter not found"}), 404

@app.route('/api/check_sizing', methods=['GET'])
def check_sizing_route():
    module = request.args.get('module')
    inverter = request.args.get('inverter')
    system_size = request.args.get('system_size', type=float)
    
    if not all([module, inverter, system_size]):
        return jsonify({"error": "Missing parameters"}), 400
        
    result = check_sizing_compatibility(module, inverter, system_size)
    if result:
        return jsonify(result)
    return jsonify({"error": "Could not check sizing"}), 400

# ---------------- FLASK ROUTES -----------------

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/calculate', methods=['POST'])
def calculate():
    """
    Main endpoint for the front-end to post JSON and get results back.
    """
    try:
        data = request.get_json()
        
        # Get basic parameters
        module_name = data.get('module')
        inverter_name = data.get('inverter')
        system_size = float(data.get('system_size', 5.0))
        gcr = float(data.get('gcr', 0.4))  # Default GCR of 0.4
        land_cost = float(data.get('land_cost', 0))  # Default land cost of 0
        
        # Check sizing compatibility
        sizing_check = check_sizing_compatibility(module_name, inverter_name, system_size)
        if not sizing_check or sizing_check['status'] == 'error':
            return jsonify({"error": "Invalid system sizing"}), 400
            
        # temperature model
        temp_model = data.get('temp_model','sapm')
        mount_type = data.get('mount_type','open_rack_glass_glass')

        # Build parameters
        if temp_model == 'pvsyst':
            temp_params = TEMPERATURE_MODEL_PARAMETERS['pvsyst'].get(
                mount_type, {'u_c': 29.0, 'u_v':0.0}
            )
        else:
            temp_params = TEMPERATURE_MODEL_PARAMETERS['sapm'].get(
                mount_type, {'a': -3.56,'b':-0.075,'deltaT':3}
            )
        temperature_model_parameters = {
            'model': temp_model,
            **temp_params
        }

        # do performance
        performance_data = calculate_pv_output(
            latitude=data.get('latitude',23.8103),
            longitude=data.get('longitude',90.4125),
            system_size_kw=system_size,
            module_name=module_name,
            inverter_name=inverter_name,
            temperature_model_parameters=temperature_model_parameters,
            tilt=data.get('tilt',30),
            azimuth=data.get('azimuth',180),
            gcr=gcr
        )
        
        # Add land cost to cost breakdown
        if 'cost_breakdown' in performance_data:
            performance_data['cost_breakdown']['Land Cost'] = land_cost
            # Recalculate total cost
            total_cost = sum(performance_data['cost_breakdown'].values())
            performance_data['total_installation_cost'] = total_cost
            
        # Add sizing status
        performance_data['sizing_status'] = sizing_check
        
        # compile final
        response = {
            'success': True,
            'system_analysis': {
                'annual_energy': performance_data['annual_energy'],
                'peak_dc_power': performance_data['peak_dc_power'],
                'peak_ac_power': performance_data['peak_ac_power'],
                'performance_ratio': performance_data['performance_ratio'],
                'capacity_factor': performance_data['capacity_factor'],
                'specific_yield': performance_data['specific_yield'],
                'modules_per_string': performance_data['modules_per_string'],
                'strings_per_inverter': performance_data['strings_per_inverter'],
                'number_of_inverters': performance_data['number_of_inverters'],
                'dc_ac_ratio': performance_data['dc_ac_ratio'],
                'total_module_area': performance_data['total_module_area'],
                'module_area': performance_data['module_area'],
                'module_type': module_name,
                'total_modules': performance_data['total_modules'],
                'inverter_type': inverter_name,
                'system_size': system_size,
                'inverter_power': performance_data['inverter_power'],
                'module_power': performance_data['module_power'],
                'daily_energy': performance_data['daily_energy'],
                'monthly_energy': performance_data['monthly_energy']
            },
            'financial_metrics': {
                'annual_savings': performance_data['annual_energy'] * data.get('electricity_rate', 0.08),
                'simple_payback': performance_data['payback_period'],
                'lcoe': performance_data['lcoe'],
                'co2_savings': (performance_data['annual_energy'] * 0.7 / 1000),  # 0.7 kg/kWh => tons
                'net_present_value': performance_data['npv'],
                'total_savings': performance_data['annual_energy'] * data.get('electricity_rate', 0.08) * data.get('project_life', 25)
            },
            'weather_data': {
                'monthly_ghi': performance_data['monthly_ghi'],
                'monthly_temperature': performance_data['monthly_temperature'],
                'monthly_energy': performance_data['monthly_energy'],
                'hourly_wind_speed': performance_data['hourly_wind_speed']
            },
            'location_info': get_location_info(
                data.get('latitude', 23.8103),
                data.get('longitude', 90.4125)
            ),
            'financials': {
                'lcoe': performance_data['lcoe'],
                'npv': performance_data['npv'],
                'payback_period': performance_data['payback_period'],
                'cost_breakdown': performance_data['cost_breakdown'],
                'cumulative_cashflow': performance_data['cumulative_cashflow'],
                'annual_cashflow': performance_data['annual_cashflow']
            }
        }
        print("Response prepared:", response)  # Debug log
        return jsonify(response)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error':str(e)}),400


def get_location_info(lat, lon):
    """Get city and country information from coordinates"""
    try:
        # For now, return placeholder data
        # In a real app, you would use a geocoding service like Nominatim or Google Maps
        return {
            'city': 'Dhaka',  # Default for Bangladesh coordinates
            'country': 'Bangladesh'
        }
    except Exception as e:
        print(f"Error getting location info: {e}")
        return {
            'city': '-',
            'country': '-'
        }

@app.route('/api/get_modules', methods=['GET'])
def get_modules():
    try:
        mod_db = pvsystem.retrieve_sam('SandiaMod')
        module_list = mod_db.columns.tolist()
        print("Total modules:", len(module_list))
        print("Default module (index 467):", module_list[467])
        return jsonify({'modules': module_list,'default_index':467})
    except Exception as e:
        print("Error getting modules:", str(e))
        return jsonify({'error': str(e)}),500

@app.route('/api/get_inverters', methods=['GET'])
def get_inverters():
    try:
        inv_db = pvsystem.retrieve_sam('SandiaInverter')
        inverter_list = inv_db.columns.tolist()
        print("Total inverters:", len(inverter_list))
        print("Default inverter (index 1337):", inverter_list[1337])
        return jsonify({'inverters': inverter_list,'default_index':1337})
    except Exception as e:
        print("Error getting inverters:", str(e))
        return jsonify({'error':str(e)}),500

def get_weather_data(latitude, longitude):
    """Get weather data from NREL PSM3 API or fallback."""
    try:
        weather, metadata = get_psm3_data(
            latitude, longitude, NREL_API_KEY, EMAIL,
            names="2019", interval=60,
            attributes=('air_temperature','dew_point','dhi','dni','ghi','surface_albedo','surface_pressure','wind_direction','wind_speed')
        )
        return weather, metadata
    except Exception as e:
        # fallback to sample data
        print("Error getting weather data, fallback to sample:", e)
        weather_data = get_sample_weather_data()
        return weather_data, {}

@app.route('/get_weather_data')
def get_weather_data_route():
    try:
        lat = float(request.args.get('latitude',23.8103))
        lon = float(request.args.get('longitude',90.4125))
        email = request.args.get('email','atiqureee@gmail.com')
        api_key = request.args.get('api_key','DEMO_KEY')

        df, meta = get_psm3_data(lat, lon, api_key, email)
        monthly_ghi = df['ghi'].resample('M').mean()
        monthly_temp = df['air_temperature'].resample('M').mean()
        return jsonify({
            'success':True,
            'monthly_ghi':monthly_ghi.to_dict(),
            'monthly_temp':monthly_temp.to_dict(),
            'metadata':meta
        })
    except Exception as e:
        return jsonify({'success':False,'error':str(e)})

@app.route('/get_api_config')
def get_api_config():
    return jsonify({'success':True,'api_key':NREL_API_KEY,'email':EMAIL})

if __name__ == '__main__':
    app.run(debug=True)
