// NghiTTS SillyTavern Extension
import { downloadModelToCache, checkModelInCache } from './utils/model-cache.js';

let worker = null;
let voicesList = [];
let modelsList = [];
let currentModel = '';
let currentSpeed = 1.0;

const NGHITTS_API = 'https://nghitts.app/api';

async function initUI() {
    const htmlResponse = await fetch(import.meta.url.replace('index.js', 'index.html'));
    const html = await htmlResponse.text();
    
    const cssUrl = import.meta.url.replace('index.js', 'style.css');
    $('head').append(`<link rel="stylesheet" href="${cssUrl}">`);
    
    // In ST, the TTS settings usually go into the #tts_settings area or a custom extensions tab.
    // For a generic extension, appending to the extensions menu:
    $('#extensions_settings').append(html);
    
    $('#nghitts_refresh_btn').on('click', fetchModelsList);
    $('#nghitts_model').on('change', onModelChange);
    $('#nghitts_download_btn').on('click', downloadSelectedModel);
    $('#nghitts_speed').on('input', function() {
        currentSpeed = parseFloat($(this).val());
        $('#nghitts_speed_val').text(currentSpeed.toFixed(1));
    });
    
    $('#nghitts_test_btn').on('click', async function() {
        const text = $('#nghitts_test_text').val().trim();
        const voiceId = $('#nghitts_voice').val();
        if (!text) {
            toastr?.info("Vui lòng nhập văn bản để test.");
            return;
        }
        if (!voiceId) {
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
    
    // Initially fetch the list
    await fetchModelsList();
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
            await onModelChange();
        }
    } catch (e) {
        console.error("NghiTTS: Failed to fetch models", e);
    }
}

async function onModelChange() {
    currentModel = $('#nghitts_model').val();
    if (!currentModel) return;
    
    const encodedModel = encodeURIComponent(currentModel);
    const modelUrl = `${NGHITTS_API}/model/${encodedModel}.onnx`;
    const configUrl = `${NGHITTS_API}/model/${encodedModel}.onnx.json`;
    
    $('#nghitts_download_status').text('Checking cache...');
    $('#nghitts_download_btn').hide();
    
    const hasModel = await checkModelInCache(modelUrl);
    const hasConfig = await checkModelInCache(configUrl);
    
    if (hasModel && hasConfig) {
        $('#nghitts_download_status').text('Cached Locally (Ready)');
        $('#nghitts_download_status').css('color', 'green');
        initWorker(currentModel);
    } else {
        $('#nghitts_download_status').text('Not Downloaded');
        $('#nghitts_download_status').css('color', 'red');
        $('#nghitts_download_btn').show();
        // Clear voice list since model isn't loaded
        $('#nghitts_voice').empty();
        if (worker) {
            worker.terminate();
            worker = null;
        }
    }
}

async function downloadSelectedModel() {
    if (!currentModel) return;
    
    const $btn = $('#nghitts_download_btn');
    const $status = $('#nghitts_download_status');
    $btn.prop('disabled', true);
    
    const encodedModel = encodeURIComponent(currentModel);
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
        
        // Init worker now that it's cached
        initWorker(currentModel);
        
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
    const $select = $('#nghitts_voice');
    $select.empty();
    voicesList.forEach(v => {
        $select.append($('<option>', { value: v.id, text: v.name }));
    });
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
    fetchTtsGeneration: async (text, voiceId) => {
        const audioUrl = await generateTTS(text, voiceId);
        // SillyTavern usually expects the provider to handle playing, or return an Audio object/URL.
        // Actually, depending on the ST version, returning the Blob/URL might be correct.
        // If the TTS API requires an audio context or plays it directly:
        const audio = new Audio(audioUrl);
        audio.play();
        return new Promise(r => audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            r();
        });
    }
};

// Wait for SillyTavern UI to load, then inject
jQuery(async () => {
    await initUI();
    
    try {
        // Try to register with SillyTavern's TTS extension (ST 1.11+)
        // Assuming extension is in public/scripts/extensions/third-party/nghitts
        const ttsModule = await import('../../tts/index.js');
        if (ttsModule && ttsModule.registerTTSProvider) {
            ttsModule.registerTTSProvider('nghitts', providerInfo);
            console.log("NghiTTS: Registered with ST TTS subsystem");
        }
    } catch (e) {
        console.log("NghiTTS: Standard TTS module not found. Hooking fallback.", e);
        // Fallback global exposure
        window.NghiTTS = {
            generate: generateTTS
        };
    }
});
