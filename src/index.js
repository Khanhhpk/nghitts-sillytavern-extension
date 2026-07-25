// NghiTTS SillyTavern Extension
import { downloadModelToCache, checkModelInCache, getCachedModelsList } from './utils/model-cache.js';
import uiHtml from './index.html';
import uiCss from './style.css';

console.log("[NghiTTS] Extension module loading...");

let worker = null;
let voicesList = [];
let modelsList = [];
let currentModel = '';
let currentSpeed = 1.0;

const NGHITTS_API = 'https://nghitts.app/api';

async function initUI() {
    console.log("[NghiTTS] Initializing UI...");
    
    function injectUI() {
        const container = document.getElementById('extensions_settings');
        if (!container) {
            console.log("NghiTTS: Waiting for #extensions_settings...");
            setTimeout(injectUI, 500);
            return;
        }
        
        $('head').append(`<style>${uiCss}</style>`);
        
        const $wrapper = $('<div class="extension_container nghitts_wrapper"></div>');
        $wrapper.html(uiHtml);
        $(container).append($wrapper);
        
        $('#nghitts_refresh_btn').on('click', fetchModelsList);
        $('#nghitts_model').on('change', onModelDropdownChange);
        $('#nghitts_download_btn').on('click', downloadSelectedModel);
        $('#nghitts_voice').on('change', onVoiceDropdownChange);
        $('#nghitts_speed').on('input', function() {
            currentSpeed = parseFloat($(this).val());
            $('#nghitts_speed_val').text(currentSpeed.toFixed(1));
        });
        
        $('#nghitts_test_btn').on('click', async function() {
            const text = $('#nghitts_test_text').val().trim();
            const voiceId = 0; // We always use internal voice 0 for the selected model
            if (!text) {
                toastr?.info("Vui lòng nhập văn bản để test.");
                return;
            }
            if (!currentModel) {
                toastr?.error("Chưa tải hoặc chưa chọn Voice.");
                return;
            }
            
            const $btn = $(this);
            $btn.prop('disabled', true).text('Generating...');
            try {
                const audioUrl = await generateTTS(text, voiceId);
                const audio = new Audio(audioUrl);
                audio.play();
                audio.onended = () => URL.revokeObjectURL(audioUrl);
            } catch (e) {
                console.error("Test TTS Error:", e);
            } finally {
                $btn.prop('disabled', false).text('Test Audio');
            }
        });
        
        // Initially fetch lists
        fetchModelsList();
        refreshCachedVoicesList();
        
        if (typeof toastr !== 'undefined') {
            toastr.success('NghiTTS Extension Loaded!');
        }
    }
    
    injectUI();
}

async function fetchModelsList() {
    try {
        const response = await fetch(`${NGHITTS_API}/models`);
        const data = await response.json();
        modelsList = data.models || [];
        
        const $select = $('#nghitts_model');
        $select.empty();
        
        modelsList.forEach(m => {
            $select.append($('<option>', { value: m, text: m }));
        });
        
        if (modelsList.length > 0) {
            $select.val(modelsList[0]);
            await onModelDropdownChange();
        }
    } catch (e) {
        console.error("NghiTTS: Failed to fetch models", e);
    }
}

async function onModelDropdownChange() {
    const selectedOnlineModel = $('#nghitts_model').val();
    if (!selectedOnlineModel) return;
    
    const encodedModel = encodeURIComponent(selectedOnlineModel);
    const modelUrl = `${NGHITTS_API}/model/${encodedModel}.onnx`;
    const configUrl = `${NGHITTS_API}/model/${encodedModel}.onnx.json`;
    
    $('#nghitts_download_status').text('Checking cache...');
    $('#nghitts_download_btn').hide();
    
    const hasModel = await checkModelInCache(modelUrl);
    const hasConfig = await checkModelInCache(configUrl);
    
    if (hasModel && hasConfig) {
        $('#nghitts_download_status').text('Cached Locally (Ready)');
        $('#nghitts_download_status').css('color', 'green');
    } else {
        $('#nghitts_download_status').text('Not Downloaded');
        $('#nghitts_download_status').css('color', 'red');
        $('#nghitts_download_btn').show();
    }
}

async function downloadSelectedModel() {
    const selectedOnlineModel = $('#nghitts_model').val();
    if (!selectedOnlineModel) return;
    
    const $btn = $('#nghitts_download_btn');
    const $status = $('#nghitts_download_status');
    $btn.prop('disabled', true);
    
    const encodedModel = encodeURIComponent(selectedOnlineModel);
    const modelUrl = `${NGHITTS_API}/model/${encodedModel}.onnx`;
    const configUrl = `${NGHITTS_API}/model/${encodedModel}.onnx.json`;
    
    try {
        $status.text('Downloading config...');
        await downloadModelToCache(configUrl);
        
        $status.text('Downloading model... (0%)');
        await downloadModelToCache(modelUrl, (loaded, total) => {
            const pct = Math.round((loaded / total) * 100);
            $status.text(`Downloading model... (${pct}%)`);
        });
        
        $status.text('Cached Locally (Ready)');
        $status.css('color', 'green');
        $btn.hide();
        
        // Refresh the local voice dropdown list
        await refreshCachedVoicesList();
        
        // If it's the only one, automatically select and load it
        const currentVoice = $('#nghitts_voice').val();
        if (currentVoice === selectedOnlineModel) {
            onVoiceDropdownChange();
        }
        
    } catch (e) {
        console.error(e);
        $status.text('Download failed');
        $status.css('color', 'red');
    } finally {
        $btn.prop('disabled', false);
    }
}

function initWorker(modelName) {
    if (worker) {
        worker.terminate();
        worker = null;
    }
    
    const workerUrl = import.meta.url.replace('index.js', 'worker.js');
    worker = new Worker(workerUrl, { type: 'module' });
    
    // We must pass the base URL so the worker knows where to fetch the ONNX wasm from if needed
    // However, the nghitts API will be used to fetch the model from cache
    worker.postMessage({
        type: 'init',
        model: modelName,
        baseUrl: NGHITTS_API
    });
    
    worker.onmessage = (e) => {
        const { status, voices, audio, chunk, data } = e.data;
        if (status === 'ready') {
            voicesList = voices || [];
            updateVoicesDropdown();
        } else if (status === 'error') {
            console.error("NghiTTS Worker Error:", data);
        } else if (status === 'complete' && audio) {
            // For now, if we are doing manual queueing
            handleAudioComplete(audio);
        } else if (status === 'stream' && chunk) {
            // Stream chunks if needed
        }
    };
}

function updateVoicesDropdown() {
    // We don't populate dropdown with internal voices anymore,
    // the dropdown is populated by refreshCachedVoicesList()
    console.log(`[NghiTTS] Model loaded. Found ${voicesList.length} internal voices.`);
}

async function refreshCachedVoicesList() {
    try {
        const cachedModels = await getCachedModelsList();
        const $select = $('#nghitts_voice');
        const prevSelected = $select.val() || currentModel;
        
        $select.empty();
        if (cachedModels.length === 0) {
            $select.append($('<option>', { value: '', text: 'No local voices available' }));
        } else {
            cachedModels.forEach(m => {
                $select.append($('<option>', { value: m, text: m }));
            });
            
            if (prevSelected && cachedModels.includes(prevSelected)) {
                $select.val(prevSelected);
            } else {
                $select.val(cachedModels[0]);
            }
        }
        
        onVoiceDropdownChange();
    } catch (e) {
        console.error("Failed to refresh cached voices list", e);
    }
}

function onVoiceDropdownChange() {
    const selectedVoice = $('#nghitts_voice').val();
    if (!selectedVoice) {
        if (worker) {
            worker.terminate();
            worker = null;
        }
        currentModel = '';
        return;
    }
    
    if (currentModel !== selectedVoice) {
        currentModel = selectedVoice;
        console.log(`[NghiTTS] Loading voice (model): ${currentModel}`);
        initWorker(currentModel);
    }
}

// -----------------------------------------------------------------------
// TTS Provider Registration
// -----------------------------------------------------------------------
let generationResolve = null;

function handleAudioComplete(audioBlob) {
    if (generationResolve) {
        // Return a blob URL that SillyTavern's audio player can play
        const url = URL.createObjectURL(audioBlob);
        generationResolve(url);
        generationResolve = null;
    }
}

async function generateTTS(text, voiceId) {
    return new Promise((resolve, reject) => {
        if (!worker) {
            toastr.error("NghiTTS model not loaded or cached.");
            return reject("Model not loaded");
        }
        
        generationResolve = resolve;
        worker.postMessage({
            type: 'generate',
            text: text,
            voice: voiceId,
            speed: currentSpeed
        });
    });
}

// Register with SillyTavern 1.18 TTS subsystem
const providerInfo = {
    name: 'nghitts_wasm',
    displayName: 'NghiTTS (Local WASM)',
    // Tell ST we have at least one default voice, using the current model name
    get voices() {
        if (!currentModel) return [];
        return [{ id: 0, name: currentModel }];
    },
    fetchTtsGeneration: async (text, voiceId) => {
        // We ignore the voiceId from ST since our model IS the voice 
        // (but we pass 0 internally)
        const audioUrl = await generateTTS(text, 0);
        const audio = new Audio(audioUrl);
        audio.play();
        return new Promise(r => audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            r();
        });
    }
};

jQuery(async () => {
    console.log("[NghiTTS] Extension initializing...");
    await initUI();
    
    try {
        const ttsModule = await import('../../tts/index.js');
        if (ttsModule && ttsModule.registerTTSProvider) {
            ttsModule.registerTTSProvider('nghitts', providerInfo);
            console.log("[NghiTTS] Registered with ST TTS subsystem");
        }
    } catch (e) {
        console.log("[NghiTTS] Standard TTS module not found. Hooking fallback.", e);
        window.NghiTTS = { generate: generateTTS };
    }
});
