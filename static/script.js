// API Configuration from config.py
let NREL_API_KEY;
let EMAIL;

// Global variables
let map = null;
let marker = null;
let drawnItems;
let drawControl;

// Chart variables
let monthlyProductionChart = null;
let ghiChart = null;
let temperatureChart = null;
let dailyProductionChart = null;
let windChart = null;
let financialChart = null;
let cashflowChart = null;

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
        lat: 30.2241,
        lon: -92.0198,
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
        lat: 37.0902,
        lon: -95.7129,
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
    world: {
        lat: 37.0902,
        lon: -95.7129,
        name: "USA"
    },
    usa: {
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

// Initialize calculator
function initializeCalculator() {
    try {
        // Initialize form elements
        initializeForm();
        initializeCostComponents();
        initializeLocation();
        loadModulesAndInverters();
        
        // Initialize map before setting up event listeners
        initializeMap();
        
        // Setup remaining components
        setupEventListeners();
        setupQuickAccessControls();
        setupQuickControls();
        
        // Setup initial values
        updateSystemType();
        updateSizingMethod();
        updateCostBreakdown();
        
        // Load API configuration
        loadAPIConfig();
    } catch (error) {
        console.error('Error initializing calculator:', error);
    }
}

// Map initialization
function initializeMap() {
    try {
        // Get initial region
        const initialRegion = $('#region').val();
        const defaults = getDefaultsForRegion(initialRegion);
        
        // Initialize map with correct starting position
        if (!map) {
            map = L.map('map').setView([defaults.lat, defaults.lon], defaults.zoom);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: ' OpenStreetMap contributors',
                maxZoom: 19,
                crossOrigin: true,
                useCache: false
            }).addTo(map);

            // Initialize marker with dragging enabled
            marker = L.marker([defaults.lat, defaults.lon], {
                draggable: true
            }).addTo(map);

            // Handle marker drag events
            marker.on('dragend', function(e) {
                const position = marker.getLatLng();
                updateCoordinates(position.lat, position.lng);
            });

            // Handle map click events
            map.on('click', function(e) {
                const position = e.latlng;
                marker.setLatLng(position);
                updateCoordinates(position.lat, position.lng);
            });

            // Initialize the FeatureGroup to store editable layers
            drawnItems = new L.FeatureGroup();
            map.addLayer(drawnItems);

            // Initialize draw control
            drawControl = new L.Control.Draw({
                draw: {
                    polygon: true,
                    rectangle: true,
                    circle: false,
                    circlemarker: false,
                    marker: false,
                    polyline: false
                },
                edit: {
                    featureGroup: drawnItems,
                    remove: true
                }
            });

            // Handle draw events
            map.on(L.Draw.Event.CREATED, handleDrawCreated);
            map.on(L.Draw.Event.EDITED, handleDrawEdited);
            map.on(L.Draw.Event.DELETED, handleDrawDeleted);
        }
    } catch (error) {
        console.error('Error initializing map:', error);
    }
}

function updateSizingMethod() {
    const method = document.getElementById('sizing-method').value;
    const systemSizeInputs = document.getElementById('system-size-inputs');
    const areaInputs = document.getElementById('area-inputs');
    const areaInfo = document.getElementById('area-info');
    const mapContainer = document.getElementById('map-container');
    
    if (method === 'area') {
        if (systemSizeInputs) systemSizeInputs.style.display = 'none';
        if (areaInputs) areaInputs.style.display = 'block';
        if (areaInfo) areaInfo.style.display = 'block';
        if (mapContainer) mapContainer.style.display = 'block';
        enableDrawControl();
    } else {
        if (systemSizeInputs) systemSizeInputs.style.display = 'block';
        if (areaInputs) areaInputs.style.display = 'none';
        if (areaInfo) areaInfo.style.display = 'none';
        if (mapContainer) mapContainer.style.display = 'none';
        disableDrawControl();
    }
}

function enableDrawControl() {
    try {
        if (map && drawControl) {
            map.addControl(drawControl);
        }
    } catch (error) {
        console.error('Error enabling draw control:', error);
    }
}

function disableDrawControl() {
    try {
        if (map && drawControl) {
            map.removeControl(drawControl);
        }
        if (drawnItems) {
            drawnItems.clearLayers();
        }
    } catch (error) {
        console.error('Error disabling draw control:', error);
    }
}

function updateMapLocation() {
    try {
        const lat = parseFloat(document.getElementById('latitude').value);
        const lng = parseFloat(document.getElementById('longitude').value);
        if (!isNaN(lat) && !isNaN(lng) && map) {
            map.setView([lat, lng], map.getZoom());
            if (marker) {
                marker.setLatLng([lat, lng]);
            }
        }
    } catch (error) {
        console.error('Error updating map location:', error);
    }
}

// Get default values based on region
function getDefaultsForRegion(region) {
    const defaults = {
        'bangladesh': {
            lat: 23.8103,
            lon: 90.4125,
            zoom: 12
        },
        'usa': {
            lat: 30.2241,
            lon: -92.0198,
            zoom: 12
        },
        'world': {
            lat: 37.0902,
            lon: -95.7129,
            zoom: 6
        }
    };
    return defaults[region] || defaults['usa'];
}

// Function to update coordinates in form
function updateCoordinates(lat, lng) {
    $('#latitude').val(lat.toFixed(6));
    $('#longitude').val(lng.toFixed(6));
    
    // Update help text based on current region
    const region = $('#region').val();
    const defaults = getDefaultsForRegion(region);
    $('#latitude').next('.form-text').text(`${region} default: ${defaults.lat}° N`);
    $('#longitude').next('.form-text').text(`${region} default: ${defaults.lon}° E`);
}

// Function to update marker position
function updateMarker(coordinates) {
    if (marker && map) {
        marker.setLatLng(coordinates);
        map.setView(coordinates, map.getZoom());
    }
}

// Handle coordinate input changes
$(document).ready(function() {
    $('#latitude, #longitude').on('change', function() {
        const lat = parseFloat($('#latitude').val());
        const lng = parseFloat($('#longitude').val());
        if (!isNaN(lat) && !isNaN(lng)) {
            updateMarker([lat, lng]);
        }
    });
});

// Chart initialization
function initializeCharts() {
    try {
        // Create production chart
        const productionCtx = document.getElementById('monthly-production-chart');
        if (productionCtx) {
            if (monthlyProductionChart) {
                monthlyProductionChart.destroy();
            }
            monthlyProductionChart = createProductionChart(productionCtx);
        }

        // Create GHI chart
        const ghiCtx = document.getElementById('ghi-chart');
        if (ghiCtx) {
            if (ghiChart) {
                ghiChart.destroy();
            }
            ghiChart = createGHIChart(ghiCtx);
        }

        // Create temperature chart
        const tempCtx = document.getElementById('temperature-chart');
        if (tempCtx) {
            if (temperatureChart) {
                temperatureChart.destroy();
            }
            temperatureChart = createTemperatureChart(tempCtx);
        }

        // Create daily production chart
        const dailyCtx = document.getElementById('daily-production-chart');
        if (dailyCtx) {
            if (dailyProductionChart) {
                dailyProductionChart.destroy();
            }
            dailyProductionChart = createDailyProductionChart(dailyCtx);
        }

        // Create wind chart
        const windCtx = document.getElementById('wind-chart');
        if (windCtx) {
            if (windChart) {
                windChart.destroy();
            }
            windChart = createWindChart(windCtx);
        }

        // Create cashflow chart
        const cashflowCtx = document.getElementById('cashflow-chart');
        if (cashflowCtx) {
            if (cashflowChart) {
                cashflowChart.destroy();
            }
            cashflowChart = createCashflowChart(cashflowCtx);
        }

    } catch (error) {
        console.error('Error initializing charts:', error);
    }
}

// Chart creation functions
function createProductionChart(canvas) {
    return new Chart(canvas, {
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
    return new Chart(canvas, {
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
    return new Chart(canvas, {
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
    return new Chart(canvas, {
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
    return new Chart(canvas, {
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
    return new Chart(canvas, {
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
        options: { 
            responsive: true,
            scales: {
                y: {
                    ticks: {
                        callback: function(value) {
                            return '$' + value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                        }
                    }
                }
            }
        }
    });
}

// Initialize everything
$(document).ready(function() {
    try {
        // Get initial region before any initialization
        const initialRegion = $('#region').val();
        const defaults = getDefaultsForRegion(initialRegion);
        
        // Set initial coordinates
        $('#latitude').val(defaults.lat.toFixed(6));
        $('#longitude').val(defaults.lon.toFixed(6));
        
        // Update help text
        $('#latitude').next('.form-text').text(`${initialRegion} default: ${defaults.lat}° N`);
        $('#longitude').next('.form-text').text(`${initialRegion} default: ${defaults.lon}° E`);
        
        // Make panel fields read-only
        $('#region, #system-size, #currency').prop('readonly', true);
        
        // Initialize components with correct defaults
        initializeCalculator();
        //initializeCollapse();
        loadModulesAndInverters();

        $('#region').change(function() {
            const region = $(this).val();
            const defaults = getDefaultsForRegion(region);
            
            // Update map and marker
            if (map) {
                map.setView([defaults.lat, defaults.lon], defaults.zoom);
                marker.setLatLng([defaults.lat, defaults.lon]);
            }
            
            // Update form values
            $('#latitude').val(defaults.lat.toFixed(6));
            $('#longitude').val(defaults.lon.toFixed(6));
        });
        
        $('#currency').change(function() {
            handleCurrencyChange($(this).val());
        });
        
        // Initialize sizing method
        $('#sizing-method').change(handleSizingMethodChange);
        handleSizingMethodChange();
        // Handle system size input
        $('#system-size').on('input', function() {
                if ($('#sizing-method').val() === 'system-size') {
                    const systemSize = parseFloat($(this).val());
                    if (!isNaN(systemSize)) {
                        const moduleArea = 2.0;  // m²
                        const gcr = parseFloat($('#gcr').val()) || 0.4;
                        const area = (systemSize * 1000 / 400) * moduleArea / gcr;
                        $('#area').val(area.toFixed(2));
                    }
                }
        });
        // Trigger initial handlers
        handleRegionChange($('#region').val());
        handleCurrencyChange($('#currency').val());

        // Show initial status
        $('#status-message')
            .removeClass('d-none alert-danger')
            .addClass('alert-info')
            .text('Ready to calculate. Fill in the details and click Calculate.');
            
        // Store initial currency values
        const rate = 110; // BDT to USD
        $('.cost-component').each(function() {
            const bdtValue = parseFloat($(this).val());
            $(this).data('base-value', bdtValue / rate);
        });
        
        ['#installed_cost', '#maintenance_cost', '#electricity_rate'].forEach(field => {
            const bdtValue = parseFloat($(field).val());
            $(this).data('base-value', bdtValue / rate);
        });
        
    } catch (error) {
        console.error('Initialization error:', error);
        showError('Failed to initialize the application. Please refresh the page.');
    }
});

// Event listeners
function setupEventListeners() {
    document.getElementById('pv-calculator-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('sizing-method').addEventListener('change', handleSizingMethodChange);
    document.getElementById('latitude').addEventListener('change', updateMapLocation);
    document.getElementById('longitude').addEventListener('change', updateMapLocation);
    
    // Temperature model event listeners
    const tempModelFamily = document.getElementById('temp-model-family');
    if (tempModelFamily) {
        tempModelFamily.addEventListener('change', handleTemperatureModelChange);
    }
    
    const sapmType = document.getElementById('sapm-type');
    if (sapmType) {
        sapmType.addEventListener('change', updateSAPMParameters);
    }
    
    const pvsystType = document.getElementById('pvsyst-type');
    if (pvsystType) {
        pvsystType.addEventListener('change', updatePVsystParameters);
    }
}

function handleSizingMethodChange() {
    const method = $('#sizing-method').val();
    
    if (method === 'system-size') {
        $('#system-size-inputs').show();
        $('#area-inputs').hide();
        $('#map-container').hide();
        $('#system-size').prop('readonly', false); // Enable manual system size input
        $('#area').prop('readonly', true);
        disableDrawControl();
    } else {
        $('#system-size-inputs').hide();
        $('#area-inputs').show();
        $('#map-container').show();
        $('#system-size').prop('readonly', true); // Disable system size input in area mode
        $('#area').prop('readonly', false);
        enableDrawControl();
        // If we already have an area drawn, update the calculations
        const areaValue = $('#area').val();
        if (areaValue) {
            updateSystemSizeFromArea(parseFloat(areaValue));
        }
    }
}

$(document).ready(function() {
    // Handle system size input changes
    $('#system-size').on('input', function() {
        const systemSize = parseFloat($(this).val());
        if (!isNaN(systemSize) && $('#sizing-method').val() === 'system-size') {
            const moduleArea = 2.0;  // m²
            const gcr = parseFloat($('#gcr').val()) || 0.4;
            const area = (systemSize * 1000 / 400) * moduleArea / gcr;  // 400W is default module power
            $('#area').val(area.toFixed(2));
        }
    });

    // Initialize the view
    handleSizingMethodChange();
});

function disableDrawControl() {
    if (map && drawControl) {
        map.removeControl(drawControl);
    }
    if (drawnItems) {
        drawnItems.clearLayers();
    }
}

function enableDrawControl() {
    if (map && drawControl) {
        map.addControl(drawControl);
    }
}

// Load API config when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    loadAPIConfig().catch(error => {
        console.error('Failed to load API config:', error);
        showError('Failed to load API configuration. Please check your settings.');
    });
});

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

// Top bar handlers
function setupTopBarHandlers() {
    // Region handlers
    $('#region').change(function() {
        const newRegion = $(this).val();
        
        // Update location and other settings
        const defaults = DEFAULT_VALUES[newRegion];
        if (defaults) {
            $('#latitude').val(defaults.lat);
            $('#longitude').val(defaults.lon);
            $('#system-size').val(defaults.systemSize);
            $('#currency').val(defaults.currency);
            $('#installed_cost').val(defaults.installedCost);
            $('#electricity_rate').val(defaults.electricityRate);
            $('#tilt').val(defaults.tilt);
            $('#azimuth').val(defaults.azimuth);
            
            // Update map
            if (map) {
                map.setView([defaults.lat, defaults.lon], 5);
                updateMapMarker(defaults.lat, defaults.lon);
            }
        }
    });

    // Currency handlers
    $('#currency').change(function() {
        const newCurrency = $(this).val();
        updateCurrencyValues(newCurrency);
    });

    // Sizing method handlers
    $('#sizing-method').change(function() {
        const method = $(this).val();
        updateSizingMethod();
    });
}

function updateCurrencyValues(currency) {
    const rate = currency === 'BDT' ? 110 : 1;
    
    // Update all cost components
    $('.cost-component').each(function() {
        const baseValue = $(this).data('base-value') || $(this).val();
        $(this).data('base-value', baseValue);
        $(this).val((baseValue * rate).toFixed(2));
    });
    
    // Update main financial inputs
    const fields = ['#installed_cost', '#maintenance_cost', '#electricity_rate'];
    fields.forEach(field => {
        const baseValue = $(field).data('base-value') || $(field).val();
        $(field).data('base-value', baseValue);
        $(field).val((baseValue * rate).toFixed(2));
    });
    
    // Update currency symbols in the UI
    const symbol = currency === 'BDT' ? '৳' : '$';
    $('.currency-symbol').text(symbol);
}

function updateMapMarker(lat, lng) {
    if (marker) {
        map.removeLayer(marker);
    }
    marker = L.marker([lat, lng], {
        draggable: true
    }).addTo(map);

    marker.on('dragend', function(event) {
        const position = event.target.getLatLng();
        $('#latitude').val(position.lat.toFixed(6));
        $('#longitude').val(position.lng.toFixed(6));
    });
}

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

// Event listeners
function setupEventListeners() {
    document.getElementById('pv-calculator-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('system-type').addEventListener('change', updateSystemType);
    document.getElementById('temp-model-family').addEventListener('change', handleTemperatureModelChange);
    document.getElementById('sapm-type').addEventListener('change', updateSAPMParameters);
    document.getElementById('pvsyst-type').addEventListener('change', updatePVsystParameters);
    document.getElementById('sizing-method').addEventListener('change', handleSizingMethodChange);
    document.getElementById('latitude').addEventListener('change', updateMapLocation);
    document.getElementById('longitude').addEventListener('change', updateMapLocation);
    
    // Temperature model event listeners
    const tempModelFamily = document.getElementById('temp-model-family');
    if (tempModelFamily) {
        tempModelFamily.addEventListener('change', handleTemperatureModelChange);
    }
    
    const sapmType = document.getElementById('sapm-type');
    if (sapmType) {
        sapmType.addEventListener('change', updateSAPMParameters);
    }
    
    const pvsystType = document.getElementById('pvsyst-type');
    if (pvsystType) {
        pvsystType.addEventListener('change', updatePVsystParameters);
    }
}

function setupQuickAccessControls() {
    // Region change handler
    $('#region').change(function() {
        const region = $(this).val();
        handleRegionChange(region);
    });

    // Currency change handler
    $('#currency').change(function() {
        const currency = $(this).val();
        handleCurrencyChange(currency);
    });

    // Sizing method change handler
    $('#sizing-method').change(function() {
        const method = $(this).val();
        if (method === 'area') {
            $('#quick-area-group').show();
            $('#quick-system-size').prop('readonly', true);
        } else {
            $('#quick-area-group').hide();
            $('#quick-system-size').prop('readonly', false);
        }
        updateSizingMethod();
    });

    $('#quick-system-size').change(function() {
        $('#system_size').val($(this).val()).trigger('change');
    });

    // Sync from collapsible panels to quick access
    $('#region').change(function() {
        handleRegionChange($(this).val());
    });

    $('#currency').change(function() {
        handleCurrencyChange($(this).val());
    });

    $('#sizing-method').change(function() {
        updateSizingMethod();
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

// Quick controls synchronization
function setupQuickControls() {
    // System size sync
    $('#quick-system-size').on('input', function() {
        const newSize = $(this).val();
        $('#system-size').val(newSize);
    });

    // Region sync
    $('#region').change(function() {
        const newRegion = $(this).val();
        
        // Update both selectors
        handleRegionChange(newRegion);
    });

    // Currency sync
    $('#currency').change(function() {
        const newCurrency = $(this).val();
        handleCurrencyChange(newCurrency);
    });
}

// Currency handling
function handleCurrencyChange(currency) {
    const rate = (currency === 'BDT') ? 110 : 1/110; // BDT to USD rate
    //const rate = currency === 'BDT' ? 110 : 1; // BDT to USD rate
    
    // Update all cost components
    $('.cost-component').each(function() {
        const baseValue = $(this).data('base-value') || $(this).val();
        $(this).data('base-value', baseValue);
        $(this).val((baseValue * rate).toFixed(2));
    });
    
    // Update main financial inputs
    const fields = ['#installed_cost', '#maintenance_cost', '#electricity_rate'];
    fields.forEach(field => {
        const baseValue = $(field).data('base-value') || $(field).val();
        $(field).data('base-value', baseValue);
        $(field).val((baseValue * rate).toFixed(2));
    });
    
    // Update currency symbols in the UI
    const symbol = currency === 'BDT' ? '৳' : '$';
    $('.currency-symbol').text(symbol);
}

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
    if (!area || isNaN(area)) {
        console.error('Invalid area value:', area);
        return;
    }

    const gcr = parseFloat($('#gcr').val()) || 0.4;
    const moduleArea = 2; // Assuming 2m² per module as standard
    const totalModules = Math.floor((area * gcr) / moduleArea);
    const systemSize = (totalModules * 0.4).toFixed(2); // Assuming 400W per module

    if (isNaN(systemSize) || systemSize <= 0) {
        console.error('Invalid system size calculation:', { area, gcr, totalModules });
        return;
    }

    $('#system-size').val(systemSize);
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

// Submit + AJAX
async function handleFormSubmit(event) {
    event.preventDefault();
    showLoading();

    const formData = {
        // System parameters
        sizing_method: document.getElementById('sizing-method').value,
        system_size: document.getElementById('system-size').value,
        area: document.getElementById('area').value,
        latitude: parseFloat($('#latitude').val()),
        longitude: parseFloat($('#longitude').val()),
        tilt: parseFloat($('#tilt').val()) || 30,
        azimuth: parseFloat($('#azimuth').val()) || 180,
        albedo: parseFloat($('#albedo').val()) || 0.2,
        losses: parseFloat($('#losses').val()) || 14,
        
        // Module and inverter selection
        module: $('#module').val(),
        inverter: $('#inverter').val(),
        
        // System configuration
        system_type: $('#system-type').val(),
        mount_type: ($('#temp-model-family').val() === 'pvsyst')
            ? $('#pvsyst-type').val()
            : $('#sapm-type').val(),
        
        temp_model: $('#temp-model-family').val() || 'sapm',
        
        // Component costs ($/W)
        module_cost: parseFloat($('#module-cost').val()) || 0.35,
        inverter_cost: parseFloat($('#inverter-cost').val()) || 0.10,
        bos_cost: parseFloat($('#bos-cost').val()) || 0.30,
        installation_cost: parseFloat($('#installation-cost').val()) || 0.40,
        soft_cost: parseFloat($('#soft-cost').val()) || 0.35,
        
        // Financial parameters
        electricity_rate: parseFloat($('#electricity-rate').val()) || 0.12,
        maintenance_cost: parseFloat($('#maintenance-cost').val()) || 15,
        degradation: parseFloat($('#degradation').val()) || 0.005,
        price_escalation: parseFloat($('#price-escalation').val()) || 0.025,
        project_life: parseInt($('#project-life').val()) || 25,
        interest_rate: parseFloat($('#interest-rate').val()) || 0.06,
        federal_tax_credit: parseFloat($('#federal-tax-credit').val()) || 0.30,
        state_tax_credit: parseFloat($('#state-tax-credit').val()) || 0,
        
        // Additional parameters
        gcr: parseFloat($('#gcr').val()) || 0.4,
        land_cost: parseFloat($('#land_cost').val()) || 0
    };

    console.log('Form Data:', formData);

    try {
        const response = await $.ajax({
            url: '/calculate',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(formData)
        });

        if (response.success) {
            updateResults(response.system_analysis);
            hideLoading();
        } else {
            showError(response.error || 'Calculation failed');
        }
    } catch (error) {
        console.error('Error:', error);
        showError(error.responseJSON?.error || 'Failed to calculate system performance');
    }
}

// Update calculations when inputs change
function updateCalculations() {
    showLoading();

    const formData = {
        // System parameters
        sizing_method: document.getElementById('sizing-method').value,
        system_size: document.getElementById('system-size').value,
        area: document.getElementById('area').value,
        latitude: parseFloat($('#latitude').val()),
        longitude: parseFloat($('#longitude').val()),
        tilt: parseFloat($('#tilt').val()) || 30,
        azimuth: parseFloat($('#azimuth').val()) || 180,
        albedo: parseFloat($('#albedo').val()) || 0.2,
        losses: parseFloat($('#losses').val()) || 14,
        
        // Module and inverter selection
        module: $('#module').val(),
        inverter: $('#inverter').val(),
        
        // System configuration
        system_type: $('#system-type').val(),
        mount_type: ($('#temp-model-family').val() === 'pvsyst')
            ? $('#pvsyst-type').val()
            : $('#sapm-type').val(),
        
        temp_model: $('#temp-model-family').val() || 'sapm',
        
        // Component costs ($/W)
        module_cost: parseFloat($('#module-cost').val()) || 0.35,
        inverter_cost: parseFloat($('#inverter-cost').val()) || 0.10,
        bos_cost: parseFloat($('#bos-cost').val()) || 0.30,
        installation_cost: parseFloat($('#installation-cost').val()) || 0.40,
        soft_cost: parseFloat($('#soft-cost').val()) || 0.35,
        
        // Financial parameters
        electricity_rate: parseFloat($('#electricity-rate').val()) || 0.12,
        maintenance_cost: parseFloat($('#maintenance-cost').val()) || 15,
        degradation: parseFloat($('#degradation').val()) || 0.005,
        price_escalation: parseFloat($('#price-escalation').val()) || 0.025,
        project_life: parseInt($('#project-life').val()) || 25,
        interest_rate: parseFloat($('#interest-rate').val()) || 0.06,
        federal_tax_credit: parseFloat($('#federal-tax-credit').val()) || 0.30,
        state_tax_credit: parseFloat($('#state-tax-credit').val()) || 0,
        
        // Additional parameters
        gcr: parseFloat($('#gcr').val()) || 0.4,
        land_cost: parseFloat($('#land_cost').val()) || 0
    };

    console.log('Form Data:', formData);

    $.ajax({
        url: '/calculate',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify(formData),
        success: function(response) {
            hideLoading();
            if (response.success) {
                updateResults(response.system_analysis);
            } else {
                showError(response.error || 'Calculation failed');
            }
        },
        error: function(xhr, status, error) {
            hideLoading();
            console.error('Error details:', {
                error,
                responseText: xhr.responseText,
                status: xhr.status,
                statusText: xhr.statusText
            });
            showError(xhr.responseJSON?.error || 'Server error occurred');
        }
    });
}

// Update results
function updateResults(systemAnalysis) {
    console.log("Updating results with:", systemAnalysis);
    const currency = $('#currency').val();
    const symbol = currency === 'BDT' ? '৳' : '$';

    // Add a new line to show "sizing_status" in the UI if desired:
    if (systemAnalysis.sizing_status && systemAnalysis.sizing_status.status) {
        const statusClass = systemAnalysis.sizing_status.status === 'ok' ? 'text-success' : 
                          systemAnalysis.sizing_status.status === 'oversized' ? 'text-warning' : 'text-danger';
        $('#sizingStatus').html(`<div class="${statusClass}">${systemAnalysis.sizing_status.message}</div>`);
    } else {
        $('#sizingStatus').html('');
    }
    // Update system performance metrics with units
    $('#peak-dc').text(`${systemAnalysis.peak_dc_power.toFixed(2)} kW`);
    $('#peak-ac').text(`${systemAnalysis.peak_ac_power.toFixed(2)} kW`);
    $('#capacity-factor').text(`${(systemAnalysis.capacity_factor * 100).toFixed(1)}%`);
    $('#performance-ratio').text(`${(systemAnalysis.performance_ratio * 100).toFixed(1)}%`);
    $('#annual-energy').text(`${systemAnalysis.annual_energy.toFixed(0)} kWh`);
    $('#specific-yield').text(`${systemAnalysis.specific_yield.toFixed(0)} kWh/kWp`);
    
    // ---------- TOP DASHBOARD ----------
    $('#total-production').text(systemAnalysis.annual_energy.toFixed(0) + ' kWh');
    $('#cost-savings').text(symbol + systemAnalysis.annual_savings.toFixed(0));
    $('#payback-period').text(systemAnalysis.simple_payback.toFixed(1) + ' yrs');
    $('#co2-savings').text(systemAnalysis.co2_savings.toFixed(1) + ' tons');
    //  existing usage:
    // 
    $('#number-of-inverters').text(systemAnalysis.number_of_inverters);
    //----------------------------------------------
    // Second Dashboard: under the map
    //----------------------------------------------

    // 1) Total Savings (25 years):
    // We multiply the annual_savings from financial_metrics by 25
    const totalSavings25 = systemAnalysis.annual_savings * 25;
    $('#total-savings25').text(symbol + `${totalSavings25.toFixed(2)}`);

    // 2) System Size (kW):
    // We'll display the final DC rating as "peak_dc_power" from system_analysis, 
    // but you could also use the user input if you prefer.
    const systemSizeKW = systemAnalysis.peak_dc_power; 
    //$('#system-size').text(`${systemSizeKW.toFixed(2)} kW`);

    // 3) LCOE:
    const lcoeVal = systemAnalysis.lcoe;
    $('#dashboard-lcoe').text(symbol + `${lcoeVal.toFixed(3)}/kWh`);

    // 4) System Area (m²):
    // From system_analysis.total_module_area
    const totalArea = systemAnalysis.total_module_area;
    $('#system-area').text(`${totalArea.toFixed(2)} m²`);

    // ---------- System Info -----------
    $('#total-modules').text(
        systemAnalysis.modules_per_string *
        systemAnalysis.strings_per_inverter *
        systemAnalysis.number_of_inverters
    );
    $('#modules-per-string').text(systemAnalysis.modules_per_string);
    $('#strings-per-inverter').text(systemAnalysis.strings_per_inverter);
    $('#number-of-inverters').text(systemAnalysis.number_of_inverters);
    $('#dc-ac-ratio').text(systemAnalysis.dc_ac_ratio.toFixed(2));

    // ---------- Site Information -----------
    const lat = $('#latitude').val();
    const lon = $('#longitude').val();
    $('#site-location').text(`${lat}, ${lon}`);
    $('#site-city').text(systemAnalysis.city || '-');
    $('#site-country').text(systemAnalysis.country || '-');
    

    const desiredSystemSize = parseFloat($('#system-size').val());
    let statusMessage = 'Calculation completed successfully!';
    let statusClass = 'alert-success';
    
    if (Math.abs(desiredSystemSize - systemSizeKW) > 1) { // If difference is more than 1 kW
        if (systemSizeKW < desiredSystemSize) {
            statusMessage = `Warning: System size reduced to ${systemSizeKW.toFixed(2)} kW due to inverter limitations. Consider using a larger inverter.`;
            statusClass = 'alert-warning';
        } else if (systemSizeKW > desiredSystemSize) {
            statusMessage = `Warning: System size increased to ${systemSizeKW.toFixed(2)} kW due to inverter configuration. Consider adjusting the design.`;
            statusClass = 'alert-warning';
        }
    }

    $('#status-message')
        .removeClass('d-none alert-primary alert-success alert-warning alert-danger')
        .addClass(statusClass)
        .text(statusMessage);

    $('#system-size-display').text(`${systemSizeKW.toFixed(2)} kW`);
    // Calculate averages from monthly/hourly data
    const monthlyGHI = systemAnalysis.monthly_ghi || [];
    const monthlyTemp = systemAnalysis.monthly_temperature || [];
    const hourlyWind = systemAnalysis.hourly_wind_speed || [];
    
    const annualGHI = monthlyGHI.reduce((a, b) => a + b, 0);
    const avgTemp = monthlyTemp.length > 0 ? monthlyTemp.reduce((a, b) => a + b, 0) / monthlyTemp.length : 0;
    const avgWind = hourlyWind.length > 0 ? hourlyWind.reduce((a, b) => a + b, 0) / hourlyWind.length : 0;
    
    $('#annual-ghi').text(`${annualGHI.toFixed(0)} kWh/m²`);
    $('#avg-temp').text(`${avgTemp.toFixed(1)}°C`);
    $('#avg-wind').text(`${avgWind.toFixed(1)} m/s`);

    // ---------- System Performance -----------

    $('#annual-production').text(`${(systemAnalysis.annual_energy/1000).toFixed(2)} MWh`);
    
    // Display Specific Yield (kWh/kWp)
    const specificYield = systemAnalysis.specific_yield;
    $('#specific-yield').text(specificYield ? `${specificYield.toFixed(2)} kWh/kWp` : '-');
    
    // Display Performance Ratio (as percentage)
    const performanceRatio = systemAnalysis.performance_ratio;
    $('#performance-ratio').text(performanceRatio ? `${(performanceRatio * 100).toFixed(2)}%` : '-');
    
    // Display Capacity Factor (as percentage)
    const capacityFactor = systemAnalysis.capacity_factor;
    $('#capacity-factor').text(capacityFactor ? `${(capacityFactor * 100).toFixed(2)}%` : '-');

    // ---------- Energy Production -----
    // annual_energy is kWh
    $('#annual-energy').text((systemAnalysis.annual_energy / 1000).toFixed(2)); // MWh

    $('#performance-ratio').text((systemAnalysis.performance_ratio * 100).toFixed(2));
    $('#capacity-factor').text((systemAnalysis.capacity_factor * 100).toFixed(2));

    // ---------- Area Info -------------
    $('#module-area').text(systemAnalysis.module_area.toFixed(2));
    $('#total-area').text(systemAnalysis.total_module_area.toFixed(2));

    // ---------- Temp & Irradiance -----
    if (systemAnalysis.min_design_temp !== undefined && systemAnalysis.max_design_temp !== undefined) {
        $('#min-design-temp').text(systemAnalysis.min_design_temp.toFixed(1));
        $('#max-design-temp').text(systemAnalysis.max_design_temp.toFixed(1));
    }
    if (systemAnalysis.effective_irradiance !== undefined) {
        $('#effective-irradiance').text(systemAnalysis.effective_irradiance.toFixed(1));
    }
    if (systemAnalysis.cell_temperature !== undefined) {
        $('#cell-temperature').text(systemAnalysis.cell_temperature.toFixed(1));
    }

    // ---------- Financial -------------
    // Update metrics display
    if (systemAnalysis.financial_metrics && systemAnalysis.financials) {
        // Use the same values from financials for both displays
        $('#lcoe-value').text(symbol + `${systemAnalysis.financials.lcoe.toFixed(3)}/kWh`);
        $('#npv-value').text(symbol + `${systemAnalysis.financials.npv.toFixed(2)}`);
        $('#payback-value').text(`${systemAnalysis.financials.payback_period.toFixed(1)} years`);

        // Update cost breakdown pie chart
        if (systemAnalysis.financials.cost_breakdown) {
            const ctx = document.getElementById('cost-breakdown-chart').getContext('2d');
            let existingChart = Chart.getChart('cost-breakdown-chart');
            if (existingChart) {
                existingChart.destroy();
            }

            const costData = systemAnalysis.financials.cost_breakdown;
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
        if (systemAnalysis.financials.cumulative_cashflow) {
            const ctx = document.getElementById('cashflow-chart').getContext('2d');
            let existingChart = Chart.getChart('cashflow-chart');
            if (existingChart) {
                existingChart.destroy();
            }

            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: Array.from({length: systemAnalysis.financials.cumulative_cashflow.length}, (_, i) => `Year ${i}`),
                    datasets: [{
                        label: 'Cumulative Cash Flow',
                        data: systemAnalysis.financials.cumulative_cashflow,
                        borderColor: 'rgb(75, 192, 192)',
                        tension: 0.1,
                        fill: true
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
    if (systemAnalysis.weather_data) {
        updateWeatherCharts(systemAnalysis.weather_data);
    }

    // ---------- Technical Details -----------
    if (systemAnalysis.system_analysis) {
        $('#module-type').text(systemAnalysis.module_type || '-');
        $('#module-power').text(systemAnalysis.module_power ? `${systemAnalysis.module_power.toFixed(0)} W` : '-');
        $('#modules-series').text(systemAnalysis.modules_per_string || '-');
        $('#parallel-strings').text(systemAnalysis.strings_per_inverter || '-');
        $('#total-modules').text(systemAnalysis.total_modules || '-');
        $('#inverter-type').text(systemAnalysis.inverter_type || '-');
        $('#inverter-power').text(systemAnalysis.inverter_power ? `${(systemAnalysis.inverter_power/1000).toFixed(2)} kW` : '-');
        $('#inverter-count').text(systemAnalysis.number_of_inverters || '-');
        $('#dc-ac-ratio').text(systemAnalysis.dc_ac_ratio ? systemAnalysis.dc_ac_ratio.toFixed(2) : '-');
        //$('#system-size').text(response.system_analysis.system_size ? `${response.system_analysis.system_size.toFixed(2)} kW` : '-');

        // Update Monthly Energy Profile
        if (systemAnalysis.monthly_energy && systemAnalysis.monthly_energy.length > 0) {
            updateChart('monthly-production-chart',
                Array.from({length: 12}, (_, i) => i + 1),  // Months 1-12
                systemAnalysis.monthly_energy,
                'Monthly Energy Production',
                'Month',
                'Energy (kWh)'
            );
        }

        // Update Daily Energy Profile
        if (systemAnalysis.daily_energy && systemAnalysis.daily_energy.length > 0) {
            // Take first 24 hours for daily profile
            const dailyData = systemAnalysis.daily_energy.slice(0, 24);
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
            <button type="button" class="btn-close" data-bs-dismiss="alert" ></button>
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
        const label = $(this).closest('.form-group').find('label');
        label.text(label.text().replace(/[\$৳]\/W/, symbol + '/W'));
    });
    
    // Update installed cost
    const installedCostUSD = $('#installed_cost').data('usd-value');
    if (installedCostUSD) {
        $('#installed_cost').val((installedCostUSD * rate).toFixed(2));
    }
    
    // Update maintenance cost
    const maintenanceUSD = $('#maintenance_cost').data('usd-value');
    if (maintenanceUSD) {
        $('#maintenance_cost').val((maintenanceUSD * rate).toFixed(2));
    }
    
    // Update electricity rate
    const electricityUSD = $('#electricity_rate').data('usd-value');
    if (electricityUSD) {
        $('#electricity_rate').val((electricityUSD * rate).toFixed(2));
    }
})

// Handle region change
function handleRegionChange(region) {
    const defaults = getDefaultsForRegion(region);
    
    // Update map view and marker
    if (map) {
        map.setView([defaults.lat, defaults.lon], defaults.zoom);
        marker.setLatLng([defaults.lat, defaults.lon]);
    }
    
    // Update form values
    $('#latitude').val(defaults.lat.toFixed(6));
    $('#longitude').val(defaults.lon.toFixed(6));
    
    // Update currency if needed
    if (region === 'bangladesh' && $('#currency').val() !== 'BDT') {
        $('#currency').val('BDT').trigger('change');
    } else if (region === 'usa' && $('#currency').val() !== 'USD') {
        $('#currency').val('USD').trigger('change');
    }
}

// House Energy Calculator
const APPLIANCE_POWER = {
    ac: 1500,        // Watts for typical AC
    fridge: 150,     // Watts for typical refrigerator
    light: 10,       // Watts per LED bulb
    tv: 100,         // Watts for typical TV
};

function initHouseEnergyCalculator() {
    // Enable/disable controls based on checkbox state
    document.querySelectorAll('.appliance-item input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('change', function() {
            const controls = this.closest('.appliance-item').querySelectorAll('select, input[type="number"]');
            controls.forEach(control => {
                control.disabled = !this.checked;
            });
            calculateTotalEnergy();
        });
    });

    // Calculate on any input change
    document.querySelectorAll('.appliance-item select, .appliance-item input[type="number"]').forEach(input => {
        input.addEventListener('change', calculateTotalEnergy);
        input.addEventListener('input', calculateTotalEnergy);
    });

    // Apply recommended size button
    document.getElementById('apply-recommended-size').addEventListener('click', function() {
        const recommendedSize = parseFloat(document.getElementById('recommended-system-size').textContent);
        if (recommendedSize > 0) {
            document.getElementById('system-size').value = recommendedSize;
            // Trigger any existing system size change handlers
            document.getElementById('system-size').dispatchEvent(new Event('change'));
        }
    });
}

function calculateTotalEnergy() {
    let totalWattHours = 0;

    // AC calculation
    if (document.getElementById('ac-check').checked) {
        const count = parseInt(document.getElementById('ac-count').value) || 0;
        const hours = parseFloat(document.getElementById('ac-hours').value) || 0;
        totalWattHours += APPLIANCE_POWER.ac * count * hours;
    }

    // Refrigerator calculation (24 hours fixed)
    if (document.getElementById('fridge-check').checked) {
        const count = parseInt(document.getElementById('fridge-count').value) || 0;
        totalWattHours += APPLIANCE_POWER.fridge * count * 24;
    }

    // LED Lighting calculation
    if (document.getElementById('light-check').checked) {
        const count = parseInt(document.getElementById('light-count').value) || 0;
        const hours = parseFloat(document.getElementById('light-hours').value) || 0;
        totalWattHours += APPLIANCE_POWER.light * count * hours;
    }

    // TV calculation
    if (document.getElementById('tv-check').checked) {
        const count = parseInt(document.getElementById('tv-count').value) || 0;
        const hours = parseFloat(document.getElementById('tv-hours').value) || 0;
        totalWattHours += APPLIANCE_POWER.tv * count * hours;
    }

    // Custom appliance calculation
    if (document.getElementById('custom-check').checked) {
        const watts = parseFloat(document.getElementById('custom-watts').value) || 0;
        const hours = parseFloat(document.getElementById('custom-hours').value) || 0;
        totalWattHours += watts * hours;
    }

    // Convert to kWh
    const totalKwh = totalWattHours / 1000;
    document.getElementById('total-daily-kwh').textContent = totalKwh.toFixed(2);

    // Calculate recommended system size (assuming 4 peak sun hours and 20% system losses)
    const recommendedSize = (totalKwh / 4) * 1.2;
    document.getElementById('recommended-system-size').textContent = recommendedSize.toFixed(2) + ' kW';
}

// Modal handling
document.addEventListener('DOMContentLoaded', function() {
    const moduleDetailsModal = document.getElementById('moduleDetailsModal');
    const inverterDetailsModal = document.getElementById('inverterDetailsModal');

    // Function to show a modal
    function showModal(modal) {
        modal.removeAttribute('inert');
        const closeButton = modal.querySelector('.btn-close');
        if (closeButton) {
            setTimeout(() => closeButton.focus(), 100);
        }
    }

    // Function to hide a modal
    function hideModal(modal) {
        modal.setAttribute('inert', '');
    }

    // Set up event listeners for both modals
    [moduleDetailsModal, inverterDetailsModal].forEach(modal => {
        modal.addEventListener('shown.bs.modal', () => {
            showModal(modal);
        });

        modal.addEventListener('hidden.bs.modal', () => {
            hideModal(modal);
            // Clear content and restore focus
            const contentDiv = modal.querySelector('.modal-body');
            if (contentDiv) {
                contentDiv.innerHTML = '';
            }
            const triggerButton = document.querySelector(`[data-bs-target="#${modal.id}"]`);
            if (triggerButton) {
                triggerButton.focus();
            }
        });
    });

    // Handle module details
    window.showModuleDetails = function() {
        const module = document.getElementById('module').value;
        if (!module) {
            showError('Please select a module first');
            return;
        }
        
        fetch(`/api/get_module_details?module=${encodeURIComponent(module)}`)
            .then(response => response.json())
            .then(data => {
                const content = `
                    <table class="table">
                        <tr><td>Name</td><td>${data.name}</td></tr>
                        <tr><td>Power</td><td>${data.power.toFixed(1)} W</td></tr>
                        <tr><td>Open Circuit Voltage (Voc)</td><td>${data.voc.toFixed(1)} V</td></tr>
                        <tr><td>Short Circuit Current (Isc)</td><td>${data.isc.toFixed(1)} A</td></tr>
                        <tr><td>MPP Voltage</td><td>${data.vmpp.toFixed(1)} V</td></tr>
                        <tr><td>MPP Current</td><td>${data.impp.toFixed(1)} A</td></tr>
                        <tr><td>Area</td><td>${data.area.toFixed(2)} m²</td></tr>
                        <tr><td>Material</td><td>${data.material}</td></tr>
                        <tr><td>Temperature Coefficient (Pmax)</td><td>${data.temp_coeff_pmax.toFixed(3)} %/°C</td></tr>
                    </table>`;
                document.getElementById('moduleDetailsContent').innerHTML = content;
                
                const bsModal = new bootstrap.Modal(moduleDetailsModal);
                bsModal.show();
            })
            .catch(error => {
                console.error('Error:', error);
                showError('Failed to load module details');
            });
    };
    
    // Handle inverter details
    window.showInverterDetails = function() {
        const inverter = document.getElementById('inverter').value;
        if (!inverter) {
            showError('Please select an inverter first');
            return;
        }
        
        fetch(`/api/get_inverter_details?inverter=${encodeURIComponent(inverter)}`)
            .then(response => response.json())
            .then(data => {
                const content = `
                    <table class="table">
                        <tr><td>Name</td><td>${data.name}</td></tr>
                        <tr><td>AC Power Rating</td><td>${data.pac.toFixed(1)} W</td></tr>
                        <tr><td>DC Power Rating</td><td>${data.pdc.toFixed(1)} W</td></tr>
                        <tr><td>Min DC Voltage</td><td>${data.vdc_min.toFixed(1)} V</td></tr>
                        <tr><td>Max DC Voltage</td><td>${data.vdc_max.toFixed(1)} V</td></tr>
                        <tr><td>Max DC Current</td><td>${data.idc_max.toFixed(1)} A</td></tr>
                        <tr><td>Efficiency</td><td>${data.efficiency.toFixed(1)}%</td></tr>
                    </table>`;
                document.getElementById('inverterDetailsContent').innerHTML = content;
                
                const bsModal = new bootstrap.Modal(inverterDetailsModal);
                bsModal.show();
            })
            .catch(error => {
                console.error('Error:', error);
                showError('Failed to load inverter details');
            });
    };
})

// Update cost breakdown chart
function updateCostBreakdown(costBreakdown) {
    if (!costBreakdown) return;
    
    const costData = {
        labels: Object.keys(costBreakdown),
        datasets: [{
            data: Object.values(costBreakdown),
            backgroundColor: [
                '#FF6384',
                '#36A2EB',
                '#FFCE56',
                '#4BC0C0',
                '#9966FF'
            ]
        }]
    };

    if (costBreakdownChart) {
        costBreakdownChart.destroy();
    }

    const ctx = document.getElementById('costBreakdownChart').getContext('2d');
    costBreakdownChart = new Chart(ctx, {
        type: 'pie',
        data: costData,
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'bottom'
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const value = context.raw;
                            return `${context.label}: $${value.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
                        }
                    }
                }
            }
        }
    });
}