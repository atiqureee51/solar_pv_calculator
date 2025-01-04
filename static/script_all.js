// API Configuration from config.py
let NREL_API_KEY;
let EMAIL;

let map;
let drawControl;
let drawnItems;
let currentPolygon = null;
let weatherData = null;
let monthlyProductionChart = null;
let ghiChart = null;
let temperatureChart = null;
let windChart = null;
let cashflowChart = null;
let dailyProductionChart = null;

// Constants
const DEFAULT_VALUES = {
    bangladesh: {
        lat: 23.8103,
        lon: 90.4125,
        systemSize: 5,
        currency: 'BDT',
        installedCost: 80000,
        electricityRate: 0.08,
        federalTaxCredit: 0,
        stateTaxCredit: 0,
        interestRate: 5,
        projectLife: 25,
        maintenanceCost: 1000,
        tilt: 23,
        azimuth: 180
    },
    usa: {
        lat: 37.0902,
        lon: -95.7129,
        systemSize: 5,
        currency: 'USD',
        installedCost: 3000,
        electricityRate: 0.12,
        federalTaxCredit: 30,
        stateTaxCredit: 0,
        interestRate: 4,
        projectLife: 25,
        maintenanceCost: 100,
        tilt: 30,
        azimuth: 180
    },
    world: {
        lat: 30.2241,
        lon: -92.0198,
        systemSize: 5,
        currency: 'USD',
        installedCost: 1000,
        electricityRate: 0.12,
        federalTaxCredit: 30,
        stateTaxCredit: 0,
        interestRate: 4,
        projectLife: 25,
        maintenanceCost: 100,
        tilt: 30,
        azimuth: 180
    }
};

const LOCATION_DEFAULTS = {
    bangladesh: {
        lat: 23.8103,
        lon: 90.4125,
        name: "Dhaka, Bangladesh"
    },
    usa: {
        lat: 37.0902,
        lon: -95.7129,
        name: "USA"
    },
    world: {
        lat: 30.2241,
        lon: -92.0198,
        name: "Lafayette, LA, USA"
    }
};

const SYSTEM_TYPES = {
    'ground-mounted': {
        temp_model: 'sapm',
        sapm_type: 'open_rack_glass_polymer',
        pvsyst_type: 'freestanding'
    },
    'roof-based': {
        temp_model: 'sapm',
        sapm_type: 'close_mount_glass_glass',
        pvsyst_type: 'insulated'
    },
    'floating': {
        temp_model: 'sapm',
        sapm_type: 'open_rack_glass_polymer',
        pvsyst_type: 'freestanding'
    },
    'agrivoltaics': {
        temp_model: 'sapm',
        sapm_type: 'open_rack_glass_polymer',
        pvsyst_type: 'freestanding'
    }
};

const TEMPERATURE_MODEL_PARAMETERS = {
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
};

document.addEventListener('DOMContentLoaded', () => {
    loadAPIConfig().then(() => {
        initializeMap();
        initializeForm();
        initializeLocation();
        initializeCharts();
        setupEventListeners();
        setupQuickAccessControls();
        loadModulesAndInverters();
    });
});

// -------------------------------------------------------------------
// Load API config
async function loadAPIConfig() {
    try {
        const response = await fetch('/get_api_config');
        const data = await response.json();
        
        if (!data.success) {
            throw new Error('Failed to load API configuration');
        }
        
        NREL_API_KEY = data.api_key;
        EMAIL = data.email;
        
        document.getElementById('nrel-api-key').value = NREL_API_KEY;
        document.getElementById('email').value = EMAIL;
    } catch (error) {
        console.error('Error loading API configuration:', error);
        showError('Failed to load API configuration');
    }
}

// -------------------------------------------------------------------
// Form initialization
function initializeForm() {
    // Default values in USD
    const defaults = {
        system_size: 5,
        installed_cost: 5000,  // $5000 for 5kW system
        maintenance_cost: 15,  // $15/kW-year
        electricity_rate: 0.07,  // $0.07/kWh
        project_life: 25,
        degradation: 0.5,
        price_escalation: 2.5
    };

    // Convert to BDT by default
    const rate = 110;
    
    // Set form values
    $('#system-size').val(defaults.system_size);
    $('#installed_cost').val((defaults.installed_cost * rate).toFixed(0));
    $('#maintenance_cost').val((defaults.maintenance_cost * rate).toFixed(0));
    $('#electricity_rate').val((defaults.electricity_rate * rate).toFixed(2));
    $('#project_life').val(defaults.project_life);
    $('#degradation').val(defaults.degradation);
    $('#price_escalation').val(defaults.price_escalation);
    
    // Store USD values for later currency conversion
    $('#installed_cost').data('usd-value', defaults.installed_cost);
    $('#maintenance_cost').data('usd-value', defaults.maintenance_cost);
    $('#electricity_rate').data('usd-value', defaults.electricity_rate);

    initializeCostComponents();
    
    // Initialize location
    initializeLocation();
}

function initializeCostComponents() {
    const currency = $('#currency').val();
    const rate = currency === 'BDT' ? 110 : 1;
    
    // Default component costs in USD/W
    const defaultCosts = {
        module_cost: 0.35,
        inverter_cost: 0.10,
        racking_cost: 0.10,
        wiring_cost: 0.15,
        disconnect_cost: 0.05,
        labor_cost: 0.20,
        install_overhead_cost: 0.10,
        profit_cost: 0.10,
        permitting_cost: 0.10,
        inspection_cost: 0.05,
        interconnection_cost: 0.10,
        soft_overhead_cost: 0.10
    };
    
    // Set values and store USD values
    Object.keys(defaultCosts).forEach(component => {
        const $input = $(`#${component}`);
        const usdValue = defaultCosts[component];
        $input.val((usdValue * rate).toFixed(1));
        $input.data('usd-value', usdValue);
    });
}

function initializeLocation() {
    // Set initial location to Bangladesh
    updateLocationDefaults('bangladesh');
}

function updateLocationDefaults(region) {
    region = region || $('#region').val();
    const defaults = LOCATION_DEFAULTS[region];
    
    if (defaults) {
        $('#latitude').val(defaults.lat);
        $('#longitude').val(defaults.lon);
    }
}

// Initialize form when document is ready
$(document).ready(function() {
    // Handle cost breakdown modal
    $('#costBreakdownBtn').click(function() {
        updateCostBreakdown();
        $('#costBreakdownModal').modal('show');
    });
    
    // Update installed cost when cost components change
    $('.cost-component').change(function() {
        updateTotalCost();
    });
    
    // Handle region change
    $('#region').change(function() {
        updateLocationDefaults();
    });
});

function updateCostBreakdown() {
    const systemSize = parseFloat($('#system-size').val()) || 5;
    const currency = $('#currency').val();
    const rate = currency === 'BDT' ? 110 : 1;
    const symbol = currency === 'BDT' ? '৳' : '$';
    
    // Update labels and values
    $('.cost-component').each(function() {
        const usdValue = $(this).data('usd-value');
        $(this).val((usdValue * rate).toFixed(1));
        const label = $(this).closest('.form-group').find('label');
        label.text(label.text().replace(/[\$৳]\/W/, symbol + '/W'));
    });
}

function updateTotalCost() {
    const systemSize = parseFloat($('#system-size').val()) || 5;
    let totalCost = 0;
    
    $('.cost-component').each(function() {
        const costPerWatt = parseFloat($(this).val()) || 0;
        totalCost += costPerWatt * systemSize * 1000;
    });
    
    $('#installed_cost').val(totalCost.toFixed(0));
}

function updateSystemType() {
    const systemType = document.getElementById('system-type').value;
    const defaults = SYSTEM_TYPES[systemType];
    
    if (defaults) {
        document.getElementById('temp-model-family').value = defaults.temp_model;
        
        if (defaults.temp_model === 'sapm') {
            document.getElementById('sapm-type').value = defaults.sapm_type;
            document.getElementById('sapm-params').style.display = 'block';
            document.getElementById('pvsyst-params').style.display = 'none';
            updateSAPMParameters();
        } else {
            document.getElementById('pvsyst-type').value = defaults.pvsyst_type;
            document.getElementById('sapm-params').style.display = 'none';
            document.getElementById('pvsyst-params').style.display = 'block';
            updatePVsystParameters();
        }
    }
}

function updateSizingMethod() {
    const method = document.getElementById('sizing-method').value;
    const systemSizeInputs = document.getElementById('system-size-inputs');
    const areaInputs = document.getElementById('area-inputs');
    const areaInfo = document.getElementById('area-info');
    
    if (method === 'area') {
        systemSizeInputs.style.display = 'none';
        areaInputs.style.display = 'block';
        if (areaInfo) areaInfo.style.display = 'block';
        enableDrawControl();
    } else {
        systemSizeInputs.style.display = 'block';
        areaInputs.style.display = 'none';
        if (areaInfo) areaInfo.style.display = 'none';
        disableDrawControl();
    }
}

// -------------------------------------------------------------------
// Load modules/inverters
function loadModulesAndInverters() {
    $.get('/api/get_modules', function(data) {
        if (data.modules) {
            const moduleSelect = $('#module');
            moduleSelect.empty();
            data.modules.forEach(module => {
                moduleSelect.append($('<option>', {
                    value: module,
                    text: module
                }));
            });
            if (data.default_index && data.default_index < data.modules.length) {
                moduleSelect.prop('selectedIndex', data.default_index);
            }
        }
    });

    $.get('/api/get_inverters', function(data) {
        if (data.inverters) {
            const inverterSelect = $('#inverter');
            inverterSelect.empty();
            data.inverters.forEach(inverter => {
                inverterSelect.append($('<option>', {
                    value: inverter,
                    text: inverter
                }));
            });
            if (data.default_index && data.default_index < data.inverters.length) {
                inverterSelect.prop('selectedIndex', data.default_index);
            }
        }
    });
}

// -------------------------------------------------------------------
// Event listeners
function setupEventListeners() {
    document.getElementById('pv-calculator-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('region').addEventListener('change', handleRegionChange);
    document.getElementById('system-type').addEventListener('change', updateSystemType);
    document.getElementById('temp-model-family').addEventListener('change', handleTemperatureModelChange);
    document.getElementById('sapm-type').addEventListener('change', updateSAPMParameters);
    document.getElementById('pvsyst-type').addEventListener('change', updatePVsystParameters);
    document.getElementById('sizing-method').addEventListener('change', updateSizingMethod);
    document.getElementById('system-size').addEventListener('input', function(e) {
        if (document.getElementById('sizing-method').value === 'system-size') {
            const area = calculateArea(parseFloat(e.target.value));
            document.getElementById('area').value = area.toFixed(2);
        }
    });
    document.getElementById('latitude').addEventListener('change', updateMapLocation);
    document.getElementById('longitude').addEventListener('change', updateMapLocation);
}

function setupQuickAccessControls() {
    // Region change handler
    $('#quick-region').change(function() {
        const region = $(this).val();
        $('#region').val(region).trigger('change');
        updateLocationDefaults(region);
    });

    // Currency change handler
    $('#quick-currency').change(function() {
        const currency = $(this).val();
        $('#currency').val(currency).trigger('change');
    });

    // Sizing method change handler
    $('#quick-sizing-method').change(function() {
        const method = $(this).val();
        if (method === 'area') {
            $('#quick-area-group').show();
            $('#quick-system-size').prop('readonly', true);
        } else {
            $('#quick-area-group').hide();
            $('#quick-system-size').prop('readonly', false);
        }
        $('#sizing-method').val(method).trigger('change');
        updateSizingMethod();
    });

    $('#quick-system-size').change(function() {
        $('#system_size').val($(this).val()).trigger('change');
    });

    // Sync from collapsible panels to quick access
    $('#region').change(function() {
        $('#quick-region').val($(this).val());
    });

    $('#currency').change(function() {
        $('#quick-currency').val($(this).val());
    });

    $('#sizing-method').change(function() {
        $('#quick-sizing-method').val($(this).val());
    });

    // Sync from main controls to quick controls
    $('#system_size').change(function() {
        $('#quick-system-size').val($(this).val());
    });

    // Update area display when polygon is drawn
    function updateQuickAreaDisplay(area) {
        if (area) {
            $('#quick-area-size').val(area.toFixed(2));
            const systemSize = calculateSystemSize(area);
            $('#quick-system-size').val(systemSize.toFixed(2));
        }
    }
}

// -------------------------------------------------------------------
// Map init
function initializeMap() {
    map = L.map('map').setView([DEFAULT_VALUES.bangladesh.lat, DEFAULT_VALUES.bangladesh.lon], 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: ' OpenStreetMap contributors'
    }).addTo(map);

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    drawControl = new L.Control.Draw({
        draw: {
            polygon: true,
            circle: false,
            rectangle: false,
            circlemarker: false,
            marker: false,
            polyline: false
        },
        edit: {
            featureGroup: drawnItems
        }
    });
    map.addControl(drawControl);

    map.on('draw:created', handleDrawCreated);
    map.on('draw:edited', handleDrawEdited);
    map.on('draw:deleted', handleDrawDeleted);

    const marker = L.marker([DEFAULT_VALUES.bangladesh.lat, DEFAULT_VALUES.bangladesh.lon], {
        draggable: true
    }).addTo(map);

    marker.on('dragend', function(e) {
        const position = e.target.getLatLng();
        document.getElementById('latitude').value = position.lat.toFixed(6);
        document.getElementById('longitude').value = position.lng.toFixed(6);
    });
}

// -------------------------------------------------------------------
// Charts
function initializeCharts() {
    const productionChartEl = document.getElementById('monthly-production-chart');
    const dailyChartEl = document.getElementById('daily-production-chart');
    const ghiChartEl = document.getElementById('ghi-chart');
    const tempChartEl = document.getElementById('temperature-chart');
    const windChartEl = document.getElementById('wind-chart');
    const cashflowChartEl = document.getElementById('cashflow-chart');

    if (productionChartEl) {
        monthlyProductionChart = createProductionChart(productionChartEl);
    }
    if (dailyChartEl) {
        dailyProductionChart = createDailyProductionChart(dailyChartEl);
    }
    if (ghiChartEl) {
        ghiChart = createGHIChart(ghiChartEl);
    }
    if (tempChartEl) {
        temperatureChart = createTemperatureChart(tempChartEl);
    }
    if (windChartEl) {
        windChart = createWindChart(windChartEl);
    }
    if (cashflowChartEl) {
        cashflowChart = createCashflowChart(cashflowChartEl);
    }
}

function createProductionChart(canvas) {
    return new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
            datasets: [{
                label: 'Monthly Energy Production (kWh)',
                data: Array(12).fill(0),
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderColor: 'rgb(75, 192, 192)',
                borderWidth: 1
            }]
        },
        options: { responsive: true }
    });
}

function createDailyProductionChart(canvas) {
    const hours = Array.from({length: 24}, (_, i) => `${i}:00`);
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: hours,
            datasets: [{
                label: 'Daily Energy Profile (kW)',
                data: Array(24).fill(0),
                backgroundColor: 'rgba(54, 162, 235, 0.2)',
                borderColor: 'rgb(54, 162, 235)',
                borderWidth: 1,
                fill: true
            }]
        },
        options: { responsive: true }
    });
}

function createGHIChart(canvas) {
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
            datasets: [{
                label: 'Solar Irradiance (kWh/m²)',
                data: Array(12).fill(0),
                borderColor: 'rgb(255, 159, 64)',
                tension: 0.1
            }]
        },
        options: { responsive: true }
    });
}

function createTemperatureChart(canvas) {
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
            datasets: [{
                label: 'Temperature (°C)',
                data: Array(12).fill(0),
                borderColor: 'rgb(255, 99, 132)',
                tension: 0.1
            }]
        },
        options: { responsive: true }
    });
}

function createWindChart(canvas) {
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
            datasets: [{
                label: 'Wind Speed (m/s)',
                data: Array(12).fill(0),
                borderColor: 'rgb(54, 162, 235)',
                tension: 0.1
            }]
        },
        options: { responsive: true }
    });
}

function createCashflowChart(canvas) {
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: Array.from({length: 26}, (_, i) => `Year ${i}`),
            datasets: [{
                label: 'Cumulative Cash Flow',
                data: Array(26).fill(0),
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.1)',
                fill: true
            }]
        },
        options: { responsive: true }
    });
}

// -------------------------------------------------------------------
// Drawing
function handleDrawCreated(e) {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    
    const area = calculatePolygonArea(layer);
    document.getElementById('area').value = area.toFixed(1);

    if (document.getElementById('sizing-method').value === 'area') {
        updateSystemSizeFromArea(area);
    }
    const coords = layer.getLatLngs()[0].map(latLng => [latLng.lng, latLng.lat]);
    document.getElementById('polygon-coords').value = JSON.stringify(coords);
    updateQuickAreaDisplay(area);
}

function updateSystemSizeFromArea(area) {
    // no immediate action needed unless you do a backend call
}

function handleDrawEdited(e) {
    e.layers.eachLayer(function(layer) {
        if (layer instanceof L.Polygon) {
            const area = calculatePolygonArea(layer);
            document.getElementById('area').value = area.toFixed(1);
            
            if (document.getElementById('sizing-method').value === 'area') {
                const systemSize = calculateSystemSize(area);
                document.getElementById('system-size').value = systemSize.toFixed(2);
            }
        }
    });
}

function handleDrawDeleted(e) {
    currentPolygon = null;
    document.getElementById('area').value = '';
    if (document.getElementById('sizing-method').value === 'area') {
        document.getElementById('system-size').value = '';
    }
}

function calculatePolygonArea(polygon) {
    const latlngs = polygon.getLatLngs()[0];
    const center = polygon.getBounds().getCenter();
    const x = [];
    const y = [];
    
    latlngs.forEach(point => {
        const utm = L.CRS.EPSG3857.project(L.latLng(point.lat, point.lng));
        x.push(utm.x);
        y.push(utm.y);
    });
    
    let area = 0;
    for (let i = 0; i < x.length; i++) {
        const j = (i + 1) % x.length;
        area += x[i] * y[j];
        area -= y[i] * x[j];
    }
    area = Math.abs(area) / 2;
    return area;
}

function calculateSystemSize(area) {
    const powerDensity = 200; // W/m²
    return (area * powerDensity) / 1000;
}

function enableDrawControl() {
    map.addControl(drawControl);
}

function disableDrawControl() {
    map.removeControl(drawControl);
    if (currentPolygon) {
        drawnItems.removeLayer(currentPolygon);
        currentPolygon = null;
    }
    document.getElementById('area').value = '';
}

function updateMapLocation() {
    const lat = parseFloat(document.getElementById('latitude').value);
    const lng = parseFloat(document.getElementById('longitude').value);
    if (!isNaN(lat) && !isNaN(lng)) {
        map.setView([lat, lng], 13);
    }
}

// -------------------------------------------------------------------
// Temperature Model
function handleTemperatureModelChange() {
    const modelFamily = $('#temp-model-family').val();
    
    if (modelFamily === 'pvsyst') {
        $('#sapm-params').hide();
        $('#pvsyst-params').show();
        updatePVsystParameters();
    } else {
        $('#pvsyst-params').hide();
        $('#sapm-params').show();
        updateSAPMParameters();
    }
}

function updateSAPMParameters() {
    const mountType = $('#sapm-type').val();
    const params = TEMPERATURE_MODEL_PARAMETERS.sapm[mountType];
    if (params) {
        $('#param-a').val(params.a);
        $('#param-b').val(params.b);
        $('#param-deltaT').val(params.deltaT);
    }
}

function updatePVsystParameters() {
    const mountType = $('#pvsyst-type').val();
    const params = TEMPERATURE_MODEL_PARAMETERS.pvsyst[mountType];
    if (params) {
        $('#param-u-c').val(params.u_c);
        $('#param-u-v').val(params.u_v);
    }
}

// -------------------------------------------------------------------
// Submit + AJAX
async function handleFormSubmit(event) {
    event.preventDefault();
    showLoading();

    const formData = {
        latitude: parseFloat($('#latitude').val()),
        longitude: parseFloat($('#longitude').val()),
        system_size: parseFloat($('#system-size').val()),
        tilt: parseFloat($('#tilt').val()) || 30,
        azimuth: parseFloat($('#azimuth').val()) || 180,
        
        module: $('#module').val(),
        inverter: $('#inverter').val(),
        
        system_type: $('#system-type').val(),
        mount_type: ($('#temp-model-family').val() === 'pvsyst')
            ? $('#pvsyst-type').val()
            : $('#sapm-type').val(),
        
        temp_model: $('#temp-model-family').val() || 'sapm',
        
        installed_cost: parseFloat($('#installed-cost').val()) || 80000,
        electricity_rate: parseFloat($('#electricity-rate').val()) || 0.08,
        federal_tax_credit: parseFloat($('#federal-tax-credit').val()) || 0,
        state_tax_credit: parseFloat($('#state-tax-credit').val()) || 0,
        interest_rate: parseFloat($('#interest-rate').val()) || 5,
        project_life: parseInt($('#project-life').val()) || 25,
        maintenance_cost: parseFloat($('#maintenance-cost').val()) || 1000
    };

    console.log('Form Data:', formData);

    try {
        const response = await $.ajax({
            url: '/calculate',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(formData)
        });

        console.log('Server Response:', response);

        if (response.success) {
            updateResults(response);
            showSuccess('Calculation completed successfully!');
        } else {
            showError(response.error || 'Calculation failed');
        }
    } catch (error) {
        console.error('Error details:', {
            error,
            responseText: error.responseText,
            status: error.status,
            statusText: error.statusText
        });
        showError(error.responseJSON?.error || 'Server error occurred');
    } finally {
        hideLoading();
    }
}

// -------------------------------------------------------------------
// Region change
function handleRegionChange(event) {
    const region = event.target.value;
    const defaults = DEFAULT_VALUES[region];
    
    document.getElementById('latitude').value = defaults.lat;
    document.getElementById('longitude').value = defaults.lon;
    document.getElementById('system-size').value = defaults.systemSize;
    document.getElementById('tilt').value = defaults.tilt;
    document.getElementById('azimuth').value = defaults.azimuth;
    
    document.getElementById('installed-cost').value = defaults.installedCost;
    document.getElementById('electricity-rate').value = defaults.electricityRate;
    document.getElementById('federal-tax-credit').value = defaults.federalTaxCredit;
    document.getElementById('state-tax-credit').value = defaults.stateTaxCredit;
    document.getElementById('interest-rate').value = defaults.interestRate;
    document.getElementById('project-life').value = defaults.projectLife;
    document.getElementById('maintenance-cost').value = defaults.maintenanceCost;
    
    // If you have currency symbols to update, do so here
    // map.setView([defaults.lat, defaults.lon], 13);
}

// -------------------------------------------------------------------
// Updating Results
function updateResults(response) {
    console.log("Updating results with:", response);
    const { system_analysis, financial_metrics, weather_data, location_info } = response;
    const currency = $('#currency').val();
    const symbol = currency === 'BDT' ? '৳' : '$';

    // Update system performance metrics with units
    $('#peak-dc').text(`${system_analysis.peak_dc_power.toFixed(2)} kW`);
    $('#peak-ac').text(`${system_analysis.peak_ac_power.toFixed(2)} kW`);
    $('#capacity-factor').text(`${(system_analysis.capacity_factor * 100).toFixed(1)}%`);
    $('#performance-ratio').text(`${(system_analysis.performance_ratio * 100).toFixed(1)}%`);
    $('#annual-energy').text(`${system_analysis.annual_energy.toFixed(0)} kWh`);
    $('#specific-yield').text(`${system_analysis.specific_yield.toFixed(0)} kWh/kWp`);
    
    // ---------- TOP DASHBOARD ----------
    $('#total-production').text(system_analysis.annual_energy.toFixed(0) + ' kWh');
    $('#cost-savings').text(symbol + financial_metrics.annual_savings.toFixed(0));
    $('#payback-period').text(financial_metrics.simple_payback.toFixed(1) + ' yrs');
    $('#co2-savings').text(financial_metrics.co2_savings.toFixed(1) + ' tons');

    //----------------------------------------------
    // Second Dashboard: under the map
    //----------------------------------------------

    // 1) Total Savings (25 years):
    // We multiply the annual_savings from financial_metrics by 25
    const totalSavings25 = financial_metrics.annual_savings * 25;
    $('#total-savings25').text(symbol + `${totalSavings25.toFixed(2)}`);

    // 2) System Size (kW):
    // We'll display the final DC rating as "peak_dc_power" from system_analysis, 
    // but you could also use the user input if you prefer.
    const systemSizeKW = system_analysis.peak_dc_power; 
    $('#system-size-display').text(`${systemSizeKW.toFixed(2)} kW`);

    // 3) LCOE:
    const lcoeVal = financial_metrics.lcoe;
    $('#dashboard-lcoe').text(symbol + `${lcoeVal.toFixed(3)}/kWh`);

    // 4) System Area (m²):
    // From system_analysis.total_module_area
    const totalArea = system_analysis.total_module_area;
    $('#system-area').text(`${totalArea.toFixed(2)} m²`);

    // ---------- System Info -----------
    $('#total-modules').text(
        system_analysis.modules_per_string *
        system_analysis.strings_per_inverter *
        system_analysis.number_of_inverters
    );
    $('#modules-per-string').text(system_analysis.modules_per_string);
    $('#strings-per-inverter').text(system_analysis.strings_per_inverter);
    $('#number-of-inverters').text(system_analysis.number_of_inverters);
    $('#dc-ac-ratio').text(system_analysis.dc_ac_ratio.toFixed(2));

    // ---------- Site Information -----------
    const lat = $('#latitude').val();
    const lon = $('#longitude').val();
    $('#site-location').text(`${lat}, ${lon}`);
    $('#site-city').text(response.location_info?.city || '-');
    $('#site-country').text(response.location_info?.country || '-');
    
    // Calculate averages from monthly/hourly data
    const monthlyGHI = weather_data.monthly_ghi || [];
    const monthlyTemp = weather_data.monthly_temperature || [];
    const hourlyWind = weather_data.hourly_wind_speed || [];
    
    const annualGHI = monthlyGHI.reduce((a, b) => a + b, 0);
    const avgTemp = monthlyTemp.length > 0 ? monthlyTemp.reduce((a, b) => a + b, 0) / monthlyTemp.length : 0;
    const avgWind = hourlyWind.length > 0 ? hourlyWind.reduce((a, b) => a + b, 0) / hourlyWind.length : 0;
    
    $('#annual-ghi').text(`${annualGHI.toFixed(0)} kWh/m²`);
    $('#avg-temp').text(`${avgTemp.toFixed(1)}°C`);
    $('#avg-wind').text(`${avgWind.toFixed(1)} m/s`);

    // ---------- System Performance -----------
    $('#peak-dc-power').text(`${system_analysis.peak_dc_power.toFixed(2)} kW`);
    $('#peak-ac-power').text(`${system_analysis.peak_ac_power.toFixed(2)} kW`);
    $('#annual-production').text(`${(system_analysis.annual_energy/1000).toFixed(2)} MWh`);
    
    // Display Specific Yield (kWh/kWp)
    const specificYield = system_analysis.specific_yield;
    $('#specific-yield').text(specificYield ? `${specificYield.toFixed(2)} kWh/kWp` : '-');
    
    // Display Performance Ratio (as percentage)
    const performanceRatio = system_analysis.performance_ratio;
    $('#performance-ratio').text(performanceRatio ? `${(performanceRatio * 100).toFixed(2)}%` : '-');
    
    // Display Capacity Factor (as percentage)
    const capacityFactor = system_analysis.capacity_factor;
    $('#capacity-factor').text(capacityFactor ? `${(capacityFactor * 100).toFixed(2)}%` : '-');

    // ---------- Energy Production -----
    // annual_energy is kWh
    $('#annual-energy').text((system_analysis.annual_energy / 1000).toFixed(2)); // MWh
    $('#peak-dc-power').text(system_analysis.peak_dc_power.toFixed(2));
    $('#peak-ac-power').text(system_analysis.peak_ac_power.toFixed(2));
    $('#performance-ratio').text((system_analysis.performance_ratio * 100).toFixed(2));
    $('#capacity-factor').text((system_analysis.capacity_factor * 100).toFixed(2));

    // ---------- Area Info -------------
    $('#module-area').text(system_analysis.module_area.toFixed(2));
    $('#total-area').text(system_analysis.total_module_area.toFixed(2));

    // ---------- Temp & Irradiance -----
    if (system_analysis.min_design_temp !== undefined && system_analysis.max_design_temp !== undefined) {
        $('#min-design-temp').text(system_analysis.min_design_temp.toFixed(1));
        $('#max-design-temp').text(system_analysis.max_design_temp.toFixed(1));
    }
    if (system_analysis.effective_irradiance !== undefined) {
        $('#effective-irradiance').text(system_analysis.effective_irradiance.toFixed(1));
    }
    if (system_analysis.cell_temperature !== undefined) {
        $('#cell-temperature').text(system_analysis.cell_temperature.toFixed(1));
    }

    // ---------- Financial -------------
    // Update metrics display
    if (response.financial_metrics && response.financials) {
        // Use the same values from financials for both displays
        $('#lcoe-value').text(symbol + `${response.financials.lcoe.toFixed(3)}/kWh`);
        $('#npv-value').text(symbol + `${response.financials.npv.toFixed(2)}`);
        $('#payback-value').text(`${response.financials.payback_period.toFixed(1)} years`);

        // Update cost breakdown pie chart
        if (response.financials.cost_breakdown) {
            const ctx = document.getElementById('cost-breakdown-chart').getContext('2d');
            let existingChart = Chart.getChart('cost-breakdown-chart');
            if (existingChart) {
                existingChart.destroy();
            }

            const costData = response.financials.cost_breakdown;
            new Chart(ctx, {
                type: 'pie',
                data: {
                    labels: Object.keys(costData),
                    datasets: [{
                        data: Object.values(costData),
                        backgroundColor: [
                            'rgba(255, 99, 132, 0.8)',
                            'rgba(54, 162, 235, 0.8)',
                            'rgba(255, 206, 86, 0.8)',
                            'rgba(75, 192, 192, 0.8)',
                            'rgba(153, 102, 255, 0.8)'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Project Cost Breakdown'
                        },
                        legend: {
                            position: 'right'
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const value = context.raw;
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const percentage = ((value / total) * 100).toFixed(1);
                                    return `${context.label}: ${symbol}${value.toFixed(2)} (${percentage}%)`;
                                }
                            }
                        }
                    }
                }
            });
        }

        // Update cashflow chart
        if (response.financials.cumulative_cashflow) {
            const ctx = document.getElementById('cashflow-chart').getContext('2d');
            let existingChart = Chart.getChart('cashflow-chart');
            if (existingChart) {
                existingChart.destroy();
            }

            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: Array.from({length: response.financials.cumulative_cashflow.length}, (_, i) => `Year ${i}`),
                    datasets: [{
                        label: 'Cumulative Cash Flow',
                        data: response.financials.cumulative_cashflow,
                        borderColor: 'rgb(75, 192, 192)',
                        tension: 0.1,
                        fill: true,
                        backgroundColor: 'rgba(75, 192, 192, 0.1)'
                    }]
                },
                options: {
                    responsive: true,
                    scales: {
                        x: {
                            title: {
                                display: true,
                                text: 'Project Timeline'
                            }
                        },
                        y: {
                            title: {
                                display: true,
                                text: 'Cumulative Cash Flow'
                            },
                            ticks: {
                                callback: function(value) {
                                    return symbol + value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                                }
                            }
                        }
                    },
                    plugins: {
                        title: {
                            display: true,
                            text: 'Project Cash Flow Over Time'
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const value = context.raw;
                                    return `Cash Flow: ${symbol}${value.toLocaleString()}`;
                                }
                            }
                        }
                    }
                }
            });
        }
    }

    // ---------- Weather charts --------
    if (response.weather_data) {
        updateWeatherCharts(response.weather_data);
    }

    // ---------- Technical Details -----------
    if (response.system_analysis) {
        $('#module-type').text(response.system_analysis.module_type || '-');
        $('#module-power').text(response.system_analysis.module_power ? `${response.system_analysis.module_power.toFixed(0)} W` : '-');
        $('#modules-series').text(response.system_analysis.modules_per_string || '-');
        $('#parallel-strings').text(response.system_analysis.strings_per_inverter || '-');
        $('#total-modules').text(response.system_analysis.total_modules || '-');
        $('#inverter-type').text(response.system_analysis.inverter_type || '-');
        $('#inverter-power').text(response.system_analysis.inverter_power ? `${(response.system_analysis.inverter_power/1000).toFixed(2)} kW` : '-');
        $('#num-inverters').text(response.system_analysis.number_of_inverters || '-');
        $('#dc-ac-ratio').text(response.system_analysis.dc_ac_ratio ? response.system_analysis.dc_ac_ratio.toFixed(2) : '-');
        $('#system-size').text(response.system_analysis.system_size ? `${response.system_analysis.system_size.toFixed(2)} kW` : '-');

        // Update Monthly Energy Profile
        if (response.system_analysis.monthly_energy && response.system_analysis.monthly_energy.length > 0) {
            updateChart('monthly-production-chart',
                Array.from({length: 12}, (_, i) => i + 1),  // Months 1-12
                response.system_analysis.monthly_energy,
                'Monthly Energy Production',
                'Month',
                'Energy (kWh)'
            );
        }

        // Update Daily Energy Profile
        if (response.system_analysis.daily_energy && response.system_analysis.daily_energy.length > 0) {
            // Take first 24 hours for daily profile
            const dailyData = response.system_analysis.daily_energy.slice(0, 24);
            updateChart('daily-production-chart',
                Array.from({length: 24}, (_, i) => i),  // Hours 0-23
                dailyData,
                'Daily Energy Production',
                'Hour',
                'Energy (kWh)'
            );
        }
    }
}

function updateWeatherCharts(data) {
    // monthly_ghi and monthly_temperature are arrays of length 12
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // GHI chart
    ghiChart.data = {
        labels: months,
        datasets: [{
            label: 'Monthly GHI (kWh/m²)',
            data: data.monthly_ghi,
            backgroundColor: 'rgba(255, 159, 64, 0.2)',
            borderColor: 'rgb(255, 159, 64)',
            borderWidth: 1
        }]
    };
    ghiChart.update();

    // Temperature chart
    temperatureChart.data = {
        labels: months,
        datasets: [{
            label: 'Monthly Avg Temperature (°C)',
            data: data.monthly_temperature,
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
            borderColor: 'rgb(255, 99, 132)',
            borderWidth: 1
        }]
    };
    temperatureChart.update();
}

function updateChart(canvasId, labels, data, title, xLabel, yLabel) {
    // Check if chart already exists and destroy it
    let existingChart = Chart.getChart(canvasId);
    if (existingChart) {
        existingChart.destroy();
    }

    const ctx = document.getElementById(canvasId).getContext('2d');
    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: title,
                data: data,
                backgroundColor: 'rgba(54, 162, 235, 0.2)',
                borderColor: 'rgb(54, 162, 235)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    title: {
                        display: true,
                        text: xLabel
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: yLabel
                    }
                }
            }
        }
    });
}

// -------------------------------------------------------------------
// Utility
function showLoading() {
    const loadingSpinner = document.getElementById('loading-spinner');
    if (loadingSpinner) {
        loadingSpinner.classList.remove('d-none');
    }
}

function hideLoading() {
    const loadingSpinner = document.getElementById('loading-spinner');
    if (loadingSpinner) {
        loadingSpinner.classList.add('d-none');
    }
}

function showError(message) {
    const errorAlert = document.getElementById('error-alert');
    if (errorAlert) {
        errorAlert.textContent = message;
        errorAlert.classList.remove('d-none');
        setTimeout(() => {
            errorAlert.classList.add('d-none');
        }, 5000);
    }
}

function showSuccess(message) {
    const alertDiv = $('<div>')
        .addClass('alert alert-success alert-dismissible fade show')
        .attr('role', 'alert')
        .html(`
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `);
    $('#alerts').empty().append(alertDiv);
    setTimeout(() => {
        alertDiv.alert('close');
    }, 5000);
}

// Update currency display
$('#currency').change(function() {
    const currency = $(this).val();
    const rate = currency === 'BDT' ? 110 : 1;
    const symbol = currency === 'BDT' ? '৳' : '$';
    
    // Update all cost labels
    $('.cost-component').each(function() {
        const usdValue = $(this).data('usd-value');
        $(this).val((usdValue * rate).toFixed(1));
        $(this).prev('label').text($(this).prev('label').text().replace(/[\$৳]\/W/, symbol + '/W'));
    });
    
    // Update installed cost
    const installedCostUSD = $('#installed_cost').data('usd-value');
    $('#installed_cost').val((installedCostUSD * rate).toFixed(0));
    
    // Update maintenance cost
    const maintenanceUSD = $('#maintenance_cost').data('usd-value');
    $('#maintenance_cost').val((maintenanceUSD * rate).toFixed(0));
    
    // Update electricity rate
    const electricityUSD = $('#electricity_rate').data('usd-value');
    $('#electricity_rate').val((electricityUSD * rate).toFixed(2));
})

// Calculate total cost from components
$('#updateCosts').click(function() {
    const systemSize = parseFloat($('#system-size').val()) || 5;
    const currency = $('#currency').val();
    const rate = currency === 'BDT' ? 110 : 1;
    let totalCost = 0;
    
    $('.cost-component').each(function() {
        const costPerWatt = parseFloat($(this).val()) || 0;
        totalCost += costPerWatt * systemSize * 1000;
    });
    
    $('#installed_cost').val(totalCost.toFixed(0));
    const modal = bootstrap.Modal.getInstance(document.getElementById('costBreakdownModal'));
    modal.hide();
});

// Store USD values on load
$(document).ready(function() {
    setupQuickAccessControls();
    const rate = 110; // BDT to USD
    
    // Store USD values for cost components
    $('.cost-component').each(function() {
        const bdtValue = parseFloat($(this).val());
        $(this).data('usd-value', bdtValue / rate);
    });
    
    // Store USD values for other inputs
    $('#installed_cost').data('usd-value', parseFloat($('#installed_cost').val()) / rate);
    $('#maintenance_cost').data('usd-value', parseFloat($('#maintenance_cost').val()) / rate);
    $('#electricity_rate').data('usd-value', parseFloat($('#electricity_rate').val()) / rate);
});
