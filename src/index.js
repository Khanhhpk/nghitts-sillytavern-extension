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
const pendingTasks = new Map();

class AudioStreamer {
    constructor() {
        this.audioContext = null;
        this.nextStartTime = 0;
        this.isPlaying = false;
        this.resolvePromise = null;
        this.sourceNodes = [];
    }
    
    startNewSession(resolve) {
        this.stop();
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        this.nextStartTime = this.audioContext.currentTime + 0.05; // 50ms buffer
        this.isPlaying = true;
        this.resolvePromise = resolve;
        this.sourceNodes = [];
    }

    queueFloat32Array(audioData, sampleRate) {
        if (!this.isPlaying || !this.audioContext) return;

        const audioBuffer = this.audioContext.createBuffer(1, audioData.length, sampleRate);
        audioBuffer.getChannelData(0).set(audioData);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);

        const scheduleTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
        source.start(scheduleTime);
        this.sourceNodes.push(source);

        this.nextStartTime = scheduleTime + audioBuffer.duration;

        source.onended = () => {
            const idx = this.sourceNodes.indexOf(source);
            if (idx !== -1) {
                this.sourceNodes.splice(idx, 1);
            }
        };
    }

    markComplete() {
        if (!this.isPlaying) return;
        const remainingTime = this.nextStartTime - this.audioContext.currentTime;
        if (remainingTime > 0) {
            setTimeout(() => {
                if (this.isPlaying && this.resolvePromise) {
                    this.resolvePromise();
                    this.resolvePromise = null;
                    this.isPlaying = false;
                }
            }, remainingTime * 1000);
        } else {
            if (this.resolvePromise) this.resolvePromise();
            this.resolvePromise = null;
            this.isPlaying = false;
        }
    }

    stop() {
        this.isPlaying = false;
        for (const source of this.sourceNodes) {
            try {
                source.stop();
            } catch (e) {}
        }
        this.sourceNodes = [];
        if (this.resolvePromise) {
            this.resolvePromise();
            this.resolvePromise = null;
        }
    }
}

const audioStreamer = new AudioStreamer();

class WorkerPool {
    constructor(poolSize = 2) {
        this.poolSize = poolSize;
        this.workers = [];
        this.currentWorkerIdx = 0;
    }

    init(modelName) {
        this.terminateAll();
        for (let i = 0; i < this.poolSize; i++) {
            const workerUrl = import.meta.url.replace('index.js', 'worker.js');
            const worker = new Worker(workerUrl, { type: 'module' });
            worker.postMessage({ 
                type: 'init', 
                model: modelName,
                baseUrl: NGHITTS_API
            });
            
            worker.onmessage = (e) => {
                const { status, voices, chunk, data, taskId } = e.data;
                if (status === 'ready') {
                    if (i === 0) { // Only update UI from the first worker
                        voicesList = voices || [];
                        updateVoicesDropdown();
                    }
                } else if (status === 'error') {
                    console.error(`NghiTTS Worker ${i} Error:`, data);
                    if (taskId && pendingTasks.has(taskId)) {
                        pendingTasks.get(taskId).reject(new Error(data));
                        pendingTasks.delete(taskId);
                    }
                } else if (status === 'complete') {
                    if (taskId && pendingTasks.has(taskId)) {
                        pendingTasks.get(taskId).resolve();
                        pendingTasks.delete(taskId);
                        audioStreamer.markComplete();
                    }
                } else if (status === 'stream' && chunk) {
                    if (taskId && pendingTasks.has(taskId)) {
                        audioStreamer.queueFloat32Array(chunk.audio, chunk.sampleRate);
                    }
                }
            };
            this.workers.push(worker);
        }
    }

    terminateAll() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        
        for (const [taskId, task] of pendingTasks.entries()) {
            task.reject(new Error("Worker terminated"));
        }
        pendingTasks.clear();
    }

    dispatch(message) {
        if (this.workers.length === 0) return;
        const worker = this.workers[this.currentWorkerIdx];
        this.currentWorkerIdx = (this.currentWorkerIdx + 1) % this.poolSize;
        worker.postMessage(message);
    }
}

const workerPool = new WorkerPool(2); // Use 2 workers for parallel generation

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
        $('#nghitts_model').on('change', function() {
            const selectedModel = $(this).val();
            if (selectedModel && selectedModel !== '0') {
                currentModel = selectedModel;
                localStorage.setItem('nghitts_last_voice', currentModel);
                initWorker(currentModel);
            }
        });
        $('#nghitts_test_btn').on('click', async function() {
            const text = $('#nghitts_test_text').val() || "Xin chào, đây là giọng nói từ Nghi TTS.";
            const voiceId = $('#nghitts_voice').val();
            
            const $btn = $(this);
            $btn.prop('disabled', true).text('Generating...');
            try {
                await new Promise((resolve, reject) => {
                    audioStreamer.startNewSession(resolve);
                    generateTTS(text, voiceId, resolve, reject);
                });
            } catch (e) {
                console.error("Test TTS Error:", e);
            } finally {
                $btn.prop('disabled', false).text('Test Audio');
            }
        });
        
        // Initially fetch lists
        await fetchModelsList();

        // Restore last voice from memory and preload
        const lastVoice = localStorage.getItem('nghitts_last_voice');
        if (lastVoice) {
            // Ensure the last voice is still in the list
            const $modelDropdown = $('#nghitts_model');
            if ($modelDropdown.find(`option[value="${lastVoice}"]`).length > 0) {
                $modelDropdown.val(lastVoice).trigger('change');
            }
        }
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
    workerPool.init(modelName);
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

function generateTTS(text, voiceId, resolve, reject) {
    if (workerPool.workers.length === 0) {
        toastr?.error("NghiTTS model not loaded or cached.");
        reject(new Error("Model not loaded"));
        return;
    }
    
    const taskId = Date.now().toString() + Math.random().toString(36).substring(2);
    pendingTasks.set(taskId, { resolve, reject });
    
    workerPool.dispatch({
        type: 'generate',
        text: text,
        voice: voiceId,
        speed: currentSpeed,
        taskId: taskId
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
        return new Promise((resolve, reject) => {
            audioStreamer.startNewSession(resolve);
            generateTTS(text, 0, resolve, reject);
        });
    },
    onStopTts: () => {
        audioStreamer.stop();
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
