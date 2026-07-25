// NghiTTS SillyTavern Extension
import { downloadModelToCache, checkModelInCache, getCachedModelsList } from './utils/model-cache.js';
import { chunkText, processTextForTTS } from './utils/text-cleaner.js';
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
        this.isGenerating = false;
        this.resolvePromise = null;
        this.sourceNodes = [];
        this.currentTaskId = null;
        
        // Sequence handling
        this.expectedSequenceId = 0;
        this.pendingChunks = new Map(); // sequenceId -> chunk data
        this.totalChunksExpected = 0;
        this.chunksCompletedCount = 0;
    }
    
    startNewSession(resolve, taskId) {
        this.stop();
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        this.nextStartTime = this.audioContext.currentTime + 0.05; // 50ms buffer
        this.isPlaying = true;
        this.isGenerating = true;
        this.resolvePromise = resolve;
        this.sourceNodes = [];
        this.currentTaskId = taskId;
        
        this.expectedSequenceId = 0;
        this.pendingChunks.clear();
        this.totalChunksExpected = 0;
        this.chunksCompletedCount = 0;
    }

    addChunkData(taskId, sequenceId, audioData, sampleRate) {
        if (taskId !== this.currentTaskId) return;
        let seqObj = this.pendingChunks.get(sequenceId);
        if (!seqObj) {
            seqObj = { buffers: [], sampleRate, isComplete: false };
            this.pendingChunks.set(sequenceId, seqObj);
        }
        seqObj.buffers.push(audioData);
    }

    markChunkComplete(taskId, sequenceId) {
        if (taskId !== this.currentTaskId) return;
        let seqObj = this.pendingChunks.get(sequenceId);
        if (!seqObj) {
            seqObj = { buffers: [], isComplete: true };
            this.pendingChunks.set(sequenceId, seqObj);
        } else {
            seqObj.isComplete = true;
        }
        
        this.chunksCompletedCount++;
        this.flushQueue();
    }

    flushQueue() {
        if (!this.isPlaying || !this.audioContext) return;
        
        while (true) {
            const seqObj = this.pendingChunks.get(this.expectedSequenceId);
            if (seqObj && seqObj.isComplete) {
                // Play all buffers for this sequenceId
                for (const audioData of seqObj.buffers) {
                    this.playAudioData(audioData, seqObj.sampleRate, this.currentTaskId);
                }
                
                // Remove from pending map to free memory
                this.pendingChunks.delete(this.expectedSequenceId);
                this.expectedSequenceId++;
            } else {
                break; // Still waiting for this sequenceId
            }
        }
        
        this.checkCompletion();
    }

    playAudioData(audioData, sampleRate, taskId) {
        if (!this.isPlaying || !this.audioContext || taskId !== this.currentTaskId) return;

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
            this.checkCompletion();
        };
    }

    checkCompletion() {
        const allChunksProcessed = (this.totalChunksExpected > 0 && this.chunksCompletedCount === this.totalChunksExpected);
        if (allChunksProcessed && this.sourceNodes.length === 0 && this.isPlaying) {
            this.isPlaying = false;
            this.isGenerating = false;
            if (this.resolvePromise) {
                this.resolvePromise();
                this.resolvePromise = null;
            }
        }
    }

    stop() {
        this.isPlaying = false;
        this.isGenerating = false;
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
    constructor() {
        this.poolSize = parseInt(localStorage.getItem('nghitts_worker_pool_size')) || 2;
        this.workers = [];
        this.currentWorkerIdx = 0;
        this.currentModelName = '';
    }

    setPoolSize(size) {
        const newSize = Math.max(1, parseInt(size) || 1);
        if (newSize !== this.poolSize) {
            this.poolSize = newSize;
            localStorage.setItem('nghitts_worker_pool_size', this.poolSize);
            // Re-initialize workers if a model is already loaded
            if (this.currentModelName) {
                this.init(this.currentModelName);
            }
        }
    }

    init(modelName) {
        this.currentModelName = modelName;
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
                const { status, voices, chunk, data, taskId, sequenceId } = e.data;
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
                        if (audioStreamer.currentTaskId === taskId) {
                            audioStreamer.stop(); // Clear stalled queue to free memory
                        }
                    }
                } else if (status === 'complete') {
                    if (taskId && pendingTasks.has(taskId)) {
                        audioStreamer.markChunkComplete(taskId, sequenceId);
                    }
                } else if (status === 'stream' && chunk) {
                    if (taskId && pendingTasks.has(taskId)) {
                        audioStreamer.addChunkData(taskId, sequenceId, chunk.audio, chunk.sampleRate);
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

const workerPool = new WorkerPool();

const NGHITTS_API = 'https://nghitts.app/api';

async function initUI() {
    console.log("[NghiTTS] Initializing UI...");
    
    async function injectUI() {
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
                // Online model dropdown change doesn't trigger worker anymore,
                // it just selects it for download.
            }
        });
        $('#nghitts_speed').on('input', function() {
            currentSpeed = parseFloat($(this).val());
            $('#nghitts_speed_val').text(currentSpeed.toFixed(1));
        });
        
        // Initialize workers input value
        $('#nghitts_workers').val(workerPool.poolSize);
        $('#nghitts_workers').on('change', function() {
            workerPool.setPoolSize($(this).val());
            toastr?.success(`Đã đổi số lượng Worker thành ${workerPool.poolSize}`);
        });
        $('#nghitts_test_btn').on('click', async function() {
            const text = $('#nghitts_test_text').val() || "Xin chào, đây là giọng nói từ Nghi TTS.";
            const voiceId = $('#nghitts_voice').val();
            
            const $btn = $(this);
            const $stopBtn = $('#nghitts_stop_test_btn');
            
            // Explicitly stop previous test audio
            audioStreamer.stop();
            for (const [id, task] of pendingTasks.entries()) {
                task.resolve();
                pendingTasks.delete(id);
            }
            
            $btn.prop('disabled', true).text('Playing...');
            $stopBtn.show();
            
            try {
                await new Promise((resolve, reject) => {
                    generateTTS(text, voiceId, resolve, reject);
                });
            } catch (e) {
                console.error("Test TTS Error:", e);
            } finally {
                $btn.prop('disabled', false).text('Test Audio');
                $stopBtn.hide();
            }
        });

        $('#nghitts_stop_test_btn').on('click', function() {
            audioStreamer.stop();
        });
        
        // Initially fetch lists
        await fetchModelsList();

        // Restore last voice from memory before refreshing the local list
        const lastVoice = localStorage.getItem('nghitts_last_voice');
        if (lastVoice) {
            currentModel = lastVoice;
        }

        await refreshCachedVoicesList();
        
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
        workerPool.terminateAll();
        currentModel = '';
        localStorage.removeItem('nghitts_last_voice');
        return;
    }
    
    if (currentModel !== selectedVoice || workerPool.workers.length === 0) {
        currentModel = selectedVoice;
        localStorage.setItem('nghitts_last_voice', currentModel);
        console.log(`[NghiTTS] Loading local voice: ${currentModel}`);
        initWorker(currentModel);
    }
}

// -----------------------------------------------------------------------
// TTS Provider Registration
// -----------------------------------------------------------------------

async function generateTTS(text, voiceId, resolve, reject) {
    if (workerPool.workers.length === 0) {
        toastr?.error("NghiTTS model not loaded or cached.");
        reject(new Error("Model not loaded"));
        return;
    }
    
    const taskId = Date.now().toString() + Math.random().toString(36).substring(2);
    pendingTasks.set(taskId, { resolve, reject });
    
    audioStreamer.startNewSession(resolve, taskId);
    
    try {
        const processed = await processTextForTTS(text);
        const chunks = await chunkText(processed);
        
        if (chunks.length === 0) {
            audioStreamer.stop();
            return;
        }
        
        audioStreamer.totalChunksExpected = chunks.length;
        
        chunks.forEach((chunkText, idx) => {
            workerPool.dispatch({
                type: 'generate',
                text: chunkText,
                voice: voiceId,
                speed: currentSpeed,
                taskId: taskId,
                sequenceId: idx
            });
        });
    } catch (e) {
        console.error("Error in generateTTS:", e);
        reject(e);
    }
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
            generateTTS(text, 0, resolve, reject);
        });
    },
    onStopTts: () => {
        audioStreamer.stop();
        for (const [id, task] of pendingTasks.entries()) {
            task.resolve();
            pendingTasks.delete(id);
        }
    }
};

jQuery(async () => {
    console.log("[NghiTTS] Extension initializing...");
    await initUI();
    
    // Inject dedicated UI buttons into ST chat and input bar
    injectDedicatedUI();
    
    try {
        const ttsModule = await import('../tts/index.js');
        if (ttsModule && ttsModule.registerTtsProvider) {
            ttsModule.registerTtsProvider('nghitts', providerInfo);
            console.log("[NghiTTS] Registered with ST TTS subsystem");
        }
    } catch (e) {
        console.log("[NghiTTS] Standard TTS module not found. Hooking fallback.", e);
        window.NghiTTS = { generate: generateTTS };
    }
});

// -----------------------------------------------------------------------
// Dedicated UI Injection (Standalone Buttons)
// -----------------------------------------------------------------------
let currentPlayingBtn = null;

async function playTextWithNghiTTS(text, $btn) {
    // If this button is already playing, stop it
    if (currentPlayingBtn === $btn[0] && (audioStreamer.isPlaying || audioStreamer.isGenerating)) {
        audioStreamer.stop();
        resetBtnState($btn);
        return;
    }
    
    // Stop any current audio
    audioStreamer.stop();
    if (currentPlayingBtn) {
        resetBtnState($(currentPlayingBtn));
    }
    
    currentPlayingBtn = $btn[0];
    
    // Visual feedback: Loading/Playing
    $btn.find('i').removeClass('fa-volume-high').addClass('fa-circle-stop');
    $btn.css('color', '#4CAF50'); // green to indicate active
    
    const voiceId = $('#nghitts_voice').val();
    
    try {
        await new Promise((resolve, reject) => {
            generateTTS(text, voiceId, resolve, reject);
        });
    } catch (e) {
        console.error("NghiTTS Play Error:", e);
    } finally {
        if (currentPlayingBtn === $btn[0]) {
            resetBtnState($btn);
            currentPlayingBtn = null;
        }
    }
}

function resetBtnState($btn) {
    $btn.find('i').removeClass('fa-circle-stop').addClass('fa-volume-high');
    $btn.css('color', '');
}

function addPlayButtonToMessage(mesElement) {
    const $mes = $(mesElement);
    if ($mes.find('.nghitts-play-btn').length > 0) return;
    
    const $btn = $('<div class="mes_button nghitts-play-btn" title="NghiTTS: Đọc tin nhắn này" style="cursor:pointer; opacity: 0.6;"><i class="fa-solid fa-volume-high"></i></div>');
    
    $btn.on('mouseenter', () => $btn.css('opacity', '1'));
    $btn.on('mouseleave', () => $btn.css('opacity', '0.6'));
    
    $btn.on('click', function(e) {
        e.stopPropagation();
        const text = $mes.find('.mes_text').text();
        playTextWithNghiTTS(text, $btn);
    });
    
    const $buttons = $mes.find('.mes_buttons');
    if ($buttons.length > 0) {
        $buttons.prepend($btn);
    } else {
        $btn.css({ position: 'absolute', right: '10px', top: '10px' });
        $mes.append($btn);
    }
}

function injectDedicatedUI() {
    // 1. Inject into existing and future messages using a reliable interval
    // This handles cases where ST re-renders message contents (swipes, edits)
    setInterval(() => {
        $('.mes:visible:not(:has(.nghitts-play-btn))').each(function() {
            addPlayButtonToMessage(this);
        });
    }, 1000);
    
    // 3. Inject Quick Play into input bar
    const checkInterval = setInterval(() => {
        const $sendControls = $('#send_controls');
        const $sendForm = $('#send_form');
        const $target = $sendControls.length > 0 ? $sendControls : $sendForm;
        
        if ($target.length > 0 && $('#nghitts_quick_play').length === 0) {
            const $btn = $('<div id="nghitts_quick_play" title="NghiTTS: Đọc tin nhắn mới nhất" style="cursor: pointer; padding: 10px; margin: 0 5px; opacity: 0.7; font-size: 1.2em; display: inline-flex; align-items: center; justify-content: center;"><i class="fa-solid fa-volume-high"></i></div>');
            
            $btn.on('mouseenter', () => $btn.css('opacity', '1'));
            $btn.on('mouseleave', () => $btn.css('opacity', '0.7'));
            
            $btn.on('click', (e) => {
                e.stopPropagation();
                // Find last message text (exclude swipes/hidden)
                const $lastMes = $('.mes:visible .mes_text').last();
                if ($lastMes.length > 0) {
                    playTextWithNghiTTS($lastMes.text(), $btn);
                }
            });
            
            if ($('#send_but').length > 0) {
                $btn.insertBefore('#send_but');
            } else {
                $target.append($btn);
            }
            clearInterval(checkInterval);
        }
    }, 1000);
}
