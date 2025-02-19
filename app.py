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
import os

app = Flask(__name__)

# Module cache for better performance
_module_cache = {
    'sandia': None,
    'all_modules': None,
    'default_module': None
}

def get_modules():
    """
    Get list of Sandia modules.
    Uses efficient caching and lazy loading for better performance.
    """
    if _module_cache['all_modules'] is not None:
        return _module_cache['all_modules']

    # Load Sandia modules from CSV with optimized reading
    if _module_cache['sandia'] is None:
        try:
            sandia_file = os.path.join('data', 'Sandia Modules.csv')
            # Only read the Name column for the list
            _module_cache['sandia'] = pd.read_csv(sandia_file, usecols=['Name'])
            _module_cache['sandia_processed'] = [name for name in _module_cache['sandia']['Name']]
        except Exception as e:
            print(f"Error loading Sandia modules: {e}")
            _module_cache['sandia'] = pd.DataFrame()
            _module_cache['sandia_processed'] = []

    # Use Sandia modules only
    _module_cache['all_modules'] = _module_cache['sandia_processed']
    
    # Use SunPower SPR-315E-WHT [2007 (E)] as default (index 474 in Sandia CSV)
    default_module = None
    if len(_module_cache['sandia_processed']) > 474:
        default_module = _module_cache['sandia_processed'][474]
    
    # If target module not available, use first available module
    if default_module is None and len(_module_cache['sandia_processed']) > 0:
        default_module = _module_cache['sandia_processed'][0]
    
    _module_cache['default_module'] = default_module
    return _module_cache['all_modules']

@app.route('/api/get_modules', methods=['GET'])
def get_modules_route():
    try:
        modules = get_modules()
        default_module = _module_cache.get('default_module')
        
        # Find the index of the default module
        default_index = modules.index(default_module) if default_module in modules else 0
        
        return jsonify({
            'modules': modules,
            'default_index': default_index
        })
    except Exception as e:
        print("Error getting modules:", str(e))
        return jsonify({'error': str(e)}), 500

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
    annual_energy, installed_cost, electricity_rate, maintenance_cost,
    project_life, fed_credit, st_credit, interest_rate,
    degradation=0.005, price_escalation=0.025
):
    """
    Compute financial metrics for PV system.
    
    Parameters:
        annual_energy: float - First year energy production in kWh
        installed_cost: float - Total installed cost in currency units
        electricity_rate: float - Cost of electricity in currency units per kWh
        maintenance_cost: float - Annual maintenance cost in currency units
        project_life: int - Project lifetime in years
        fed_credit: float - Federal tax credit as decimal (e.g., 0.26 for 26%)
        st_credit: float - State tax credit as decimal
        interest_rate: float - Annual interest rate as decimal
        degradation: float - Annual panel degradation rate (default 0.5%)
        price_escalation: float - Annual electricity price escalation (default 2.5%)
    """
    try:
        # Initialize arrays for cash flows
        cashflows = []
        cumulative_cashflow = [-installed_cost]
        
        # Calculate total capital cost after tax credits
        total_capital_cost = installed_cost - (installed_cost * fed_credit) - (installed_cost * st_credit)
        
        # Calculate annual savings with degradation and price escalation
        annual_savings = 0
        total_energy = 0
        current_energy = annual_energy
        current_rate = electricity_rate
        
        for year in range(project_life):
            # Calculate degraded energy and escalated price
            year_energy = current_energy
            total_energy += year_energy
            year_savings = year_energy * current_rate
            
            # Calculate net cashflow
            net_cashflow = year_savings - maintenance_cost
            cashflows.append(float(net_cashflow))
            cumulative_cashflow.append(float(cumulative_cashflow[-1] + net_cashflow))
            
            # Update for next year
            current_energy *= (1 - degradation)
            current_rate *= (1 + price_escalation)
            annual_savings += year_savings
        
        # Calculate NPV
        npv = -total_capital_cost
        for i, cashflow in enumerate(cashflows, 1):
            npv += cashflow / ((1 + interest_rate) ** i)
        
        # Calculate average annual values
        avg_annual_energy = total_energy / project_life
        avg_annual_savings = annual_savings / project_life
        
        # Calculate simple payback period (using first year savings)
        first_year_savings = annual_energy * electricity_rate
        payback = total_capital_cost / first_year_savings if first_year_savings > 0 else float('inf')
        
        # Calculate LCOE
        total_cost = total_capital_cost
        discounted_energy = 0
        for i in range(project_life):
            energy_produced = annual_energy * ((1 - degradation) ** i)
            discounted_energy += energy_produced / ((1 + interest_rate) ** i)
            total_cost += maintenance_cost / ((1 + interest_rate) ** i)
        
        lcoe = total_cost / discounted_energy if discounted_energy > 0 else 0
        
        # Calculate CO2 savings (using average annual energy)
        co2_savings = (avg_annual_energy * 0.7 / 1000)  # 0.7 kg/kWh => tons
        
        return {
            'annual_energy_kwh': float(avg_annual_energy),
            'annual_savings': float(avg_annual_savings),
            'simple_payback': float(payback),
            'lcoe': float(lcoe),
            'co2_savings': float(co2_savings),
            'net_present_value': float(npv),
            'total_capital_cost': float(total_capital_cost),
            'total_savings': float(annual_savings - total_capital_cost - (maintenance_cost * project_life)),
            'cumulative_cashflow': [float(x) for x in cumulative_cashflow],
            'annual_cashflow': [float(-total_capital_cost)] + [float(x) for x in cashflows]
        }
    except Exception as e:
        print(f"Error in financial calculations: {str(e)}")
        return {
            'annual_energy_kwh': float(annual_energy),
            'annual_savings': 0.0,
            'simple_payback': float('inf'),
            'lcoe': 0.0,
            'co2_savings': 0.0,
            'net_present_value': 0.0,
            'total_capital_cost': float(installed_cost),
            'total_savings': 0.0,
            'cumulative_cashflow': [0.0],
            'annual_cashflow': [0.0]
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
        
        # Strip the prefix (CEC: or Sandia:) from the module name
        module_source, module_name = module_name.split(': ', 1) if ': ' in module_name else ('Sandia', module_name)
        
        # Get module data from our cache
        if module_source == 'Sandia':
            if _module_cache['sandia'] is None:
                sandia_file = os.path.join('data', 'Sandia Modules.csv')
                _module_cache['sandia'] = pd.read_csv(sandia_file)
            module_data = _module_cache['sandia'][_module_cache['sandia']['Name'] == module_name]
            if len(module_data) == 0:
                return {"error": f"Module '{module_name}' not found in Sandia database"}
            module = module_data.iloc[0].to_dict()
            
            # Map Sandia parameters to standard format for calculations
            module.update({
                'Voco': module['Voco'],
                'Vmpo': module['Vmpo'],
                'Impo': module['Impo'],
                'Isco': module['Isco'],
                'Aimp': module['Aisc'],
                'Bvoco': module['Bvoco'],
                'Bvmpo': module['Bvmpo'],  # Approximate
                'Area': module['Area']
            })
        
        # Get inverter data
        inv_db = pvsystem.retrieve_sam('SandiaInverter')
        if inverter_name not in inv_db.columns:
            print(f"Inverter '{inverter_name}' not found in database")
            return {"error": f"Inverter '{inverter_name}' not found in database"}
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
        system_size_w = max(system_size_kw * 1000, 1)  # Minimum 1W
        modules_needed = math.ceil(system_size_w / max(float(module.get('STC', 0)), 0.1))  # Minimum 0.1W
        
        # Calculate string sizing with safety checks
        vmp = max(float(module.get('V_mp_ref', 0)), 0.1)  # Minimum 0.1V
        voc = max(float(module.get('V_oc_ref', 0)), 0.1)  # Minimum 0.1V
        
        max_modules_per_string = min(
            math.floor(inverter.get('Vdcmax', 600) / vmp),
            math.floor(inverter.get('Vdcmax', 600) / voc)
        )
        
        # Calculate parallel strings
        imp = max(float(module.get('I_mp_ref', 0)), 0.1)  # Minimum 0.1A
        max_parallel_strings = max(1, math.floor(inverter.get('Idcmax', 10) / imp))
        
        # Calculate system configuration
        modules_per_inverter = max_modules_per_string * max_parallel_strings
        num_inverters_needed = max(1, math.ceil(modules_needed / modules_per_inverter))
        
        # Calculate actual system size and DC/AC ratio
        actual_system_size_w = modules_needed * module['STC']
        actual_system_size_kw = actual_system_size_w / 1000
        dc_ac_ratio = actual_system_size_w / (num_inverters_needed * inverter['Paco'])
        
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
            altitude=13,
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

        # Create array with temperature model parameters
        array = pvsystem.Array(
            mount=pvsystem.FixedMount(surface_tilt=tilt, surface_azimuth=azimuth),
            module_parameters=module,
            temperature_model_parameters=temperature_model_parameters,
            modules_per_string=max_modules_per_string,
            strings=max_parallel_strings
        )

        # Create PV system
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

        # Calculate annual energy from AC output (in kWh)
        annual_energy_kwh = float(ac_annual_series.sum() / 1000)  # Convert from Wh to kWh
        
        # Calculate daily and monthly energy
        daily_energy = [float(ac_annual_series.groupby(ac_annual_series.index.dayofyear).mean()[i]) for i in range(1, 366)]
        monthly_energy = [float(ac_annual_series.groupby(ac_annual_series.index.month).sum()[i] / 1000) for i in range(1, 13)]
        
        # Calculate performance metrics
        peak_dc_kW = float(dc_annual_series.max() / 1000)  # Convert peak DC power to kW
        peak_ac_kW = float(ac_annual_series.max() / 1000)  # Convert peak AC power to kW
        
        # Calculate capacity factor (actual output / theoretical maximum)
        capacity_factor = annual_energy_kwh / (system_size_kw * 8760)
        
        # Calculate performance ratio (actual output / theoretical output based on irradiance)
        theoretical_output = env_data['poa_global'].sum() * (system_size_kw / 1000)  # Convert to same units
        performance_ratio = annual_energy_kwh / theoretical_output if theoretical_output > 0 else 0
        
        # Calculate specific yield (kWh/kWp)
        specific_yield = annual_energy_kwh / system_size_kw if system_size_kw > 0 else 0

        performance_data = {
            'annual_energy': annual_energy_kwh,  # Use the calculated annual energy
            'peak_dc_power': peak_dc_kW,
            'peak_ac_power': peak_ac_kW,
            'performance_ratio': performance_ratio,
            'capacity_factor': capacity_factor,
            'specific_yield': specific_yield,
            'modules_per_string': max_modules_per_string,
            'strings_per_inverter': max_parallel_strings,
            'number_of_inverters': num_inverters_needed,
            'actual_system_size_kw': float(system_size_kw),
            'dc_ac_ratio': float(dc_ac_ratio),
            'total_module_area': float(module['Area'] * modules_per_inverter * math.ceil(modules_needed / modules_per_inverter)),
            'module_area': float(module['Area']),
            'module_type': module_name,
            'total_modules': int(modules_per_inverter * math.ceil(modules_needed / modules_per_inverter)),
            'inverter_type': inverter_name,
            'system_size': system_size_kw,
            'inverter_power': inverter['Paco'],
            'module_power': max(float(module.get('STC', 0)), 0.1),
            'daily_energy': daily_energy,
            'monthly_energy': monthly_energy,
            'min_design_temp': float(min_db_temp_ashrae),
            'max_design_temp': float(max_db_temp_ashrae),
            'effective_irradiance': float(wdf['effective_irradiance'].mean()),
            'cell_temperature': float(wdf['cell_temperature'].mean())
        }
        
        return performance_data
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

def get_module_details(module_name: str):
    """
    Get module details with efficient caching.
    """
    # Strip the prefix (CEC: or Sandia:) from the module name
    source, name = module_name.split(': ', 1) if ': ' in module_name else ('Sandia', module_name)
    
    try:
        if source == 'Sandia':
            if _module_cache['sandia'] is None:
                sandia_file = os.path.join('data', 'Sandia Modules.csv')
                _module_cache['sandia'] = pd.read_csv(sandia_file)
            
            module_data = _module_cache['sandia'][_module_cache['sandia']['Name'] == name]
            if len(module_data) == 0:
                return None
                
            row = module_data.iloc[0]
            return {
                'name': name,
                'manufacturer': row.get('Manufacturer', 'Unknown'),
                'technology': row.get('Material', 'Unknown'),  # Sandia uses Material instead of Technology
                'bifacial': False,  # Sandia doesn't specify this
                'stc': float(row.get('STC', 0)),  # STC rating directly from Sandia
                'ptc': None,  # Sandia doesn't provide PTC
                'area': float(row.get('Area', 0)),
                'cells_in_series': int(row.get('Cells in Series', 0)),
                'i_sc_ref': float(row.get('Isco', 0)),
                'v_oc_ref': float(row.get('Voco', 0)),
                'i_mp_ref': float(row.get('Impo', 0)),
                'v_mp_ref': float(row.get('Vmpo', 0)),
                'alpha_sc': float(row.get('Aisc', 0)),
                'beta_oc': float(row.get('Bvoco', 0)),
                'gamma_pmp': float(row.get('Bvmpo', 0)/row.get('Vmpo', 1)*100 + row.get('Aimp', 0)/row.get('Impo', 1)*100),
                'cells_in_parallel': int(row.get('Parallel Strings', 1)),
                'source': source
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
    """
    Professional PV System Design Logic:
    1. Start with desired DC system size
    2. Consider inverter configurations that minimize excess capacity
    3. Calculate optimal string configurations
    4. Verify voltage and current limits
    5. Ensure DC/AC ratio stays within 1.1-1.3 range
    6. Provide detailed design recommendations
    """
    module = get_module_details(module_name)
    inverter = get_inverter_details(inverter_name)
    
    if not module or not inverter:
        return {
            "compatible": False,
            "error": "Module or inverter information not found"
        }

    try:
        # Module characteristics with safety checks
        module_power_w = max(float(module.get('STC', 0)), 0.1)  # Minimum 0.1W
        vmp = max(float(module.get('V_mp_ref', 0)), 0.1)  # Minimum 0.1V
        imp = max(float(module.get('I_mp_ref', 0)), 0.1)  # Minimum 0.1A
        voc = max(float(module.get('V_oc_ref', 0)), 0.1)  # Minimum 0.1V
        isc = max(float(module.get('I_sc_ref', 0)), 0.1)  # Minimum 0.1A

        # Inverter characteristics with safety checks
        inverter_power_w = max(float(inverter.get('Paco', 0)), 0.1)  # Minimum 0.1W
        max_input_power = max(float(inverter.get('Pdco', 0)), inverter_power_w)  # Use AC power if DC not specified
        mppt_min_v = max(float(inverter.get('Mppt_low', 0)), 0.1)  # Minimum 0.1V
        mppt_max_v = max(float(inverter.get('Mppt_high', mppt_min_v * 2)), mppt_min_v * 2)  # Double min if not specified
        max_idc = max(float(inverter.get('Idcmax', 0)), 0.1)  # Minimum 0.1A

        # Validate critical values
        if module_power_w <= 0 or vmp <= 0 or voc <= 0 or inverter_power_w <= 0:
            return {
                "compatible": False,
                "error": "Invalid module or inverter specifications"
            }

        # System requirements with safety check
        system_size_kw = max(float(system_size_kw), 0.1)  # Minimum 0.1 kW
        desired_power_w = system_size_kw * 1000
        
        # Calculate optimal number of inverters based on DC power rating
        min_inverters_dc = max(1, math.ceil(desired_power_w / max_input_power))
        min_inverters_ac = max(1, math.ceil(desired_power_w / (inverter_power_w * 1.3)))  # Using max DC/AC ratio of 1.3
        min_inverters = max(min_inverters_dc, min_inverters_ac)
        
        # Calculate string sizing with safety checks
        temp_coeff_v = max(float(module.get('Beta_oc', -0.3)), -0.5) / 100  # Typical value if not provided
        max_system_voltage = 1000  # Standard max system voltage
        min_temp = -10  # Design minimum temperature in Celsius
        max_temp = 75   # Maximum cell temperature in Celsius
        
        # Calculate temperature-adjusted voltages
        voc_max = voc * (1 + temp_coeff_v * (min_temp - 25))
        voc_min = voc * (1 + temp_coeff_v * (max_temp - 25))
        vmp_min = vmp * (1 + temp_coeff_v * (max_temp - 25))
        
        # Calculate string sizes with safety checks
        max_modules_per_string = max(1, min(
            math.floor(mppt_max_v / vmp) if vmp > 0 else 1,
            math.floor(max_system_voltage / voc_max) if voc_max > 0 else 1
        ))
        min_modules_per_string = max(1, math.ceil(mppt_min_v / vmp_min) if vmp_min > 0 else 1)
        
        if max_modules_per_string < min_modules_per_string:
            return {
                "compatible": False,
                "error": "Cannot achieve valid string size with voltage constraints"
            }
        
        # Optimize modules per string for efficiency
        modules_per_string = max_modules_per_string
        while modules_per_string > min_modules_per_string:
            if desired_power_w % (modules_per_string * module_power_w) < module_power_w:
                break
            modules_per_string -= 1
        
        # Calculate strings per inverter with safety checks
        max_strings_per_inverter = max(1, min(
            math.floor(max_input_power / (modules_per_string * module_power_w)) if (modules_per_string * module_power_w) > 0 else 1,
            math.floor(max_idc / isc) if isc > 0 else 1
        ))
        
        # Calculate total system configuration
        modules_per_inverter = modules_per_string * max_strings_per_inverter
        total_modules_needed = max(1, math.ceil(desired_power_w / module_power_w))
        actual_strings_needed = max(1, math.ceil(total_modules_needed / modules_per_string))
        
        # Calculate actual system size and DC/AC ratio with safety checks
        actual_system_size_w = total_modules_needed * module_power_w
        actual_system_size_kw = actual_system_size_w / 1000
        dc_ac_ratio = actual_system_size_w / (min_inverters * inverter_power_w) if (min_inverters * inverter_power_w) > 0 else 999
        
        # Initialize warnings and recommendations
        warnings = []
        recommendations = []
        
        # Check for design issues
        if dc_ac_ratio > 1.3:
            warnings.append(f"DC/AC ratio of {dc_ac_ratio:.2f} exceeds recommended maximum of 1.3")
            recommendations.append("Consider adding another inverter to reduce DC/AC ratio")
        elif dc_ac_ratio < 1.1:
            warnings.append(f"DC/AC ratio of {dc_ac_ratio:.2f} is below recommended minimum of 1.1")
            recommendations.append("Consider reducing number of inverters or adding more modules")
        
        # Check inverter utilization with safety check
        inverter_utilization = (actual_system_size_w / min_inverters) / max_input_power if max_input_power > 0 else 0
        if inverter_utilization < 0.8:
            warnings.append(f"Inverters will be underutilized at {inverter_utilization:.1%} of rated capacity")
            recommendations.append("Consider using fewer or smaller inverters for better efficiency")
        
        # Calculate cost implications
        excess_capacity_kw = (min_inverters * inverter_power_w) - desired_power_w/1.2  # Using typical 1.2 DC/AC ratio
        if excess_capacity_kw > 10:  # If more than 10kW excess capacity
            warnings.append(f"Configuration has {excess_capacity_kw/1000:.1f}kW excess inverter capacity")
            recommendations.append("Consider alternative inverter sizes to optimize cost")

        return {
            "compatible": True,
            "warnings": warnings,
            "recommendations": recommendations,
            "design": {
                "total_modules_needed": total_modules_needed,
                "modules_per_string": modules_per_string,
                "strings_per_inverter": max_strings_per_inverter,
                "number_of_inverters": min_inverters,
                "actual_system_size_kw": actual_system_size_kw,
                "dc_ac_ratio": dc_ac_ratio,
                "string_voltage_at_min_temp": voc_max * modules_per_string,
                "string_voltage_at_max_temp": vmp_min * modules_per_string,
                "total_strings_needed": actual_strings_needed,
                "inverter_utilization": inverter_utilization
            }
        }
    except Exception as e:
        return {
            "compatible": False,
            "error": f"Error in sizing calculations: {str(e)}"
        }

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
    """Main endpoint for the front-end to post JSON and get results back."""
    try:
        data = request.get_json()
        
        # Extract system parameters
        latitude = float(data.get('latitude', 23.8103))
        longitude = float(data.get('longitude', 90.4125))
        system_size = float(data.get('system_size', 5))
        module_name = data.get('module_name', 'Canadian_Solar_Inc__CS1U_410MS')
        inverter_name = data.get('inverter_name', 'SMA_America__SB7_7_1SP_US_41__240V_')
        tilt = float(data.get('tilt', 23))
        azimuth = float(data.get('azimuth', 180))
        gcr = float(data.get('gcr', 0.4))
        system_type = data.get('system_type', 'ground-mounted')  # Changed from 'ground' to 'ground-mounted'
        
        # Extract financial parameters
        installed_cost = float(data.get('installed_cost', 5000))
        electricity_rate = float(data.get('electricity_rate', 0.12))
        project_life = int(data.get('project_life', 25))
        maintenance_cost = float(data.get('maintenance_cost', 15))
        degradation = float(data.get('degradation', 0.005))
        price_escalation = float(data.get('price_escalation', 0.025))
        fed_credit = float(data.get('federal_tax_credit', 0.30))
        st_credit = float(data.get('state_tax_credit', 0))
        interest_rate = float(data.get('interest_rate', 0.06))
        
        # Get cost breakdown if provided
        cost_breakdown = data.get('cost_breakdown', {})
        module_cost = cost_breakdown.get('moduleCost', 0.35)
        inverter_cost = cost_breakdown.get('inverterCost', 0.10)
        bos_cost = cost_breakdown.get('bosCost', 0.325)
        installation_cost = cost_breakdown.get('installationCost', 0.44)
        soft_cost = cost_breakdown.get('softCost', 0.275)
        land_cost = cost_breakdown.get('landCost', 0)

        # Get temperature model parameters directly from frontend
        temp_model = data.get('temperature_model')
        temp_model_params = {}
        
        if temp_model == 'sapm':
            temp_model_params = {
                'a': float(data.get('param_a', -3.56)),  # Default to open rack glass/polymer
                'b': float(data.get('param_b', -0.075)),
                'deltaT': float(data.get('param_deltaT', 3))
            }
        elif temp_model == 'pvsyst':
            temp_model_params = {
                'u_c': float(data.get('param_u_c', 29.0)),  # Default to freestanding
                'u_v': float(data.get('param_u_v', 0.0))
            }
            
        # Calculate PV system output
        system_output = calculate_pv_output(
            latitude, longitude, system_size, module_name,
            inverter_name, temp_model_params, tilt, azimuth, gcr
        )
        
        # Check if system_output contains an error
        if isinstance(system_output, dict) and 'error' in system_output:
            return jsonify({
                'success': False,
                'error': system_output['error']
            })
        
        if not system_output:
            return jsonify({
                'success': False,
                'error': 'Failed to calculate PV system output'
            })

        # Calculate financial metrics
        financial_metrics = calculate_financial_metrics(
            annual_energy=system_output['annual_energy'],
            installed_cost=installed_cost,
            electricity_rate=electricity_rate,
            maintenance_cost=maintenance_cost,
            project_life=project_life,
            fed_credit=fed_credit,
            st_credit=st_credit,
            interest_rate=interest_rate,
            degradation=degradation,
            price_escalation=price_escalation
        )
        
        # Combine all results
        results = {
            'success': True,
            'system_output': system_output,
            'financial_metrics': financial_metrics,
            'cost_breakdown': {
                'module_cost': module_cost * system_size * 1000,
                'inverter_cost': inverter_cost * system_size * 1000,
                'bos_cost': bos_cost * system_size * 1000,
                'installation_cost': installation_cost * system_size * 1000,
                'soft_cost': soft_cost * system_size * 1000,
                'land_cost': land_cost,
                'total_cost': installed_cost
            }
        }
        
        return jsonify(results)
        
    except Exception as e:
        print(f"Error in calculate route: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        })

def get_location_info(lat, lon):
    """Get city and country information from coordinates"""
    try:
        # For now, return placeholder data
        # In a real app, you would use a geocoding service like Nominatim or Google Maps
        geolocator = Nominatim(user_agent="my_application")
        location = geolocator.reverse(f"{lat}, {lon}") 
        return {
            'city': location.address.split(",")[0],  # Default for Bangladesh coordinates
            'country': location.address.split(",")[-1]
        }
    except Exception as e:
        print(f"Error getting location info: {e}")
        return {
            'city': '-',
            'country': '-'
        }

@app.route('/api/get_modules', methods=['GET'])
def get_modules_route():
    try:
        modules = get_modules()
        default_module = _module_cache.get('default_module')
        
        # Find the index of the default module
        default_index = modules.index(default_module) if default_module in modules else 0
        
        return jsonify({
            'modules': modules,
            'default_index': default_index
        })
    except Exception as e:
        print("Error getting modules:", str(e))
        return jsonify({'error': str(e)}), 500

@app.route('/api/get_inverters', methods=['GET'])

def get_inverters():
    try:
        inv_db = pvsystem.retrieve_sam('SandiaInverter')
        inverter_list = inv_db.columns.tolist()
        print("Total inverters:", len(inverter_list))
        print("Default inverter (index 1343):", inverter_list[1343])
        return jsonify({'inverters': inverter_list,'default_index':1343})
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



@app.route('/calculate_house_energy', methods=['POST'])
def calculate_house_energy():
    try:
        data = request.get_json()
        daily_kwh = float(data.get('daily_kwh', 0))
        peak_sun_hours = float(data.get('peak_sun_hours', 4))  # Default 4 hours
        system_losses = 0.2  # 20% losses

        if peak_sun_hours <= 0:
            return jsonify({
                'success': False,
                'error': 'Peak sun hours must be greater than 0'
            }), 400

        recommended_size = (daily_kwh / peak_sun_hours) * (1 + system_losses)
        
        return jsonify({
            'success': True,
            'recommended_size_kw': round(recommended_size, 2),
            'daily_energy_kwh': round(daily_kwh, 2),
            'annual_energy_kwh': round(daily_kwh * 365, 2)
        })
    except ZeroDivisionError:
        return jsonify({
            'success': False,
            'error': 'Peak sun hours cannot be zero'
        }), 400
    except ValueError as e:
        return jsonify({
            'success': False,
            'error': f'Invalid value: {str(e)}'
        }), 400
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(debug=True, host='0.0.0.0', port=port)
