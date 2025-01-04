import requests
import pandas as pd
import pvlib
from pvlib.pvsystem import PVSystem
from pvlib.location import Location
from pvlib.modelchain import ModelChain
from pvlib.temperature import TEMPERATURE_MODEL_PARAMETERS

def get_nrel_data(lat, lon, api_key, email, attributes='ghi,temp_air'):
    """Fetch weather data from NREL Solar Resource Database."""
    base_url = 'https://developer.nrel.gov/api/solar/nsrdb_psm3_download.csv'
    
    params = {
        'wkt': f'POINT({lon} {lat})',
        'names': attributes,
        'leap_day': 'false',
        'interval': '60',
        'utc': 'false',
        'email': email,
        'api_key': api_key,
    }
    
    try:
        response = requests.get(base_url, params=params)
        response.raise_for_status()
        
        df = pd.read_csv(response.text.split('\n', 2)[2:][0], parse_dates=True)
        
        return {
            'success': True,
            'data': {
                'ghi': df['GHI'].tolist(),
                'temp_air': df['Temperature'].tolist()
            }
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'Failed to fetch NREL data: {str(e)}'
        }

def calculate_pv_output(lat, lon, system_size_kw, temperature_model, module_name, 
                       inverter_name, system_type, api_key=None, email=None):
    """Calculate PV system output using pvlib and NREL data."""
    try:
        weather_data = get_nrel_data(lat, lon, api_key, email)
        if not weather_data['success']:
            return weather_data
        
        location = Location(latitude=lat, longitude=lon)
        
        sandia_modules = pvlib.pvsystem.retrieve_sam('SandiaMod')
        cec_inverters = pvlib.pvsystem.retrieve_sam('cecinverter')
        
        module = sandia_modules[module_name]
        inverter = cec_inverters[inverter_name]
        
        temperature_params = TEMPERATURE_MODEL_PARAMETERS['sapm'].copy()
        if 'roof' in system_type.lower():
            temperature_params['a'] = -2.98
            temperature_params['b'] = -0.0471
            temperature_params['deltaT'] = 1
        
        system = PVSystem(
            surface_tilt=30,
            surface_azimuth=180, 
            module_parameters=module,
            inverter_parameters=inverter,
            temperature_model_parameters=temperature_params,
            modules_per_string=int(system_size_kw * 1000 / module['Impo']),
            strings=1
        )
        
        mc = ModelChain(system, location)
        df_weather = pd.DataFrame({
            'ghi': weather_data['data']['ghi'],
            'temp_air': weather_data['data']['temp_air']
        })
        
        mc.run_model(df_weather)
        
        annual_energy_kwh = mc.ac.sum() / 1000  # Wh -> kWh
        
        return {
            'success': True,
            'annual_energy_kwh': annual_energy_kwh,
            'hourly_energy': mc.ac.tolist()
        }
        
    except Exception as e:
        return {
            'success': False,
            'error': f'Failed to calculate PV output: {str(e)}'
        }
