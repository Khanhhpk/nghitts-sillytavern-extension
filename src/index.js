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
let nghittsDictionary = JSON.parse(localStorage.getItem('nghitts_dictionary') || '[]');
let nghittsPauses = JSON.parse(localStorage.getItem('nghitts_pauses') || '[]');

class AudioStreamer {
    constructor() {
        this.audioContext = null;
        this.nextStartTime = 0;
        this.isPlaying = false;
        this.isGenerating = false;
        this.isPaused = false;
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
        this.isPaused = false;
        this.resolvePromise = resolve;
        this.sourceNodes = [];
        this.currentTaskId = taskId;
        
        this.expectedSequenceId = 0;
        this.pendingChunks.clear();
        this.totalChunksExpected = 0;
        this.chunksCompletedCount = 0;
    }

    addChunkData(taskId, sequenceId, audioData, sampleRate, text) {
        if (taskId !== this.currentTaskId) return;
        let seqObj = this.pendingChunks.get(sequenceId);
        if (!seqObj) {
            seqObj = { buffers: [], sampleRate, text, isComplete: false, playCursor: 0 };
            this.pendingChunks.set(sequenceId, seqObj);
        }
        seqObj.buffers.push(audioData);
        this.flushQueue();
    }

    markChunkComplete(taskId, sequenceId) {
        if (taskId !== this.currentTaskId) return;
        let seqObj = this.pendingChunks.get(sequenceId);
        if (!seqObj) {
            seqObj = { buffers: [], isComplete: true, playCursor: 0 };
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
            if (!seqObj) break;
            
            // Play any unplayed buffers progressively
            while (seqObj.playCursor < seqObj.buffers.length) {
                const audioData = seqObj.buffers[seqObj.playCursor];
                
                // Is this the very last buffer of the chunk?
                const isLastBuffer = seqObj.isComplete && (seqObj.playCursor === seqObj.buffers.length - 1);
                
                // Only pass the text (which contains the custom pause symbol) if it's the final buffer
                // This prevents duplicating extra pauses if a chunk yields multiple progressive buffers
                this.playAudioData(audioData, seqObj.sampleRate, this.currentTaskId, isLastBuffer ? seqObj.text : null);
                
                seqObj.playCursor++;
            }

            // Only advance to the next chunk if this one is fully complete and all its buffers played
            if (seqObj.isComplete && seqObj.playCursor === seqObj.buffers.length) {
                this.pendingChunks.delete(this.expectedSequenceId);
                this.expectedSequenceId++;
            } else {
                break; // Still waiting for more progressive buffers of this sequenceId
            }
        }
        
        this.checkCompletion();
    }

    playAudioData(audioData, sampleRate, taskId, text) {
        if (!this.isPlaying || !this.audioContext || taskId !== this.currentTaskId) return;

        const audioBuffer = this.audioContext.createBuffer(1, audioData.length, sampleRate);
        audioBuffer.getChannelData(0).set(audioData);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);

        let scheduleTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
        
        // If queue is empty (very first chunk, or we experienced an underrun),
        // we add a small buffer (250ms) ahead of currentTime. This gives sleepy
        // audio hardware/Bluetooth enough time to wake up, preventing clipped syllables.
        if (this.sourceNodes.length === 0) {
            scheduleTime = Math.max(scheduleTime, this.audioContext.currentTime + 0.25);
        }

        source.start(scheduleTime);
        this.sourceNodes.push(source);

        let extraPause = 0;
        if (text) {
            for (const p of nghittsPauses) {
                if (text.endsWith(p.symbol)) {
                    extraPause = parseFloat(p.time) || 0;
                    break;
                }
            }
        }

        this.nextStartTime = scheduleTime + audioBuffer.duration + extraPause;

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
            if (this.currentTaskId && typeof pendingTasks !== 'undefined') {
                pendingTasks.delete(this.currentTaskId);
            }
            this.isPlaying = false;
            this.isGenerating = false;
            if (this.resolvePromise) {
                this.resolvePromise();
                this.resolvePromise = null;
            }
        }
    }

    stop() {
        if (this.currentTaskId && typeof workerPool !== 'undefined') {
            workerPool.cancelTask(this.currentTaskId);
            if (typeof pendingTasks !== 'undefined') {
                pendingTasks.delete(this.currentTaskId);
            }
        }
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

    togglePause() {
        if (!this.audioContext || !this.isPlaying) return;
        
        if (this.audioContext.state === 'running') {
            this.audioContext.suspend();
            this.isPaused = true;
        } else if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
            this.isPaused = false;
        }
    }
}

const audioStreamer = new AudioStreamer();

function updateWorkerStatusUI() {
    const $list = $('#nghitts_worker_list');
    if ($list.length === 0) return;
    
    if (!workerPool || workerPool.workers.length === 0) {
        $list.html('<div style="color: var(--grey_text); font-style: italic;">Chưa khởi tạo (Chờ model)</div>');
        return;
    }
    
    let html = '';
    workerPool.workers.forEach((worker, i) => {
        let color = 'var(--grey_text)';
        if (worker.nghiState === 'Ready (Rảnh)') color = '#4CAF50'; // Green
        else if (worker.nghiState === 'Đang đọc...') color = '#2196F3'; // Blue
        else if (worker.nghiState === 'Lỗi') color = '#f44336'; // Red
        else if (worker.nghiState === 'Khởi tạo...') color = '#FF9800'; // Orange
        
        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px;">
                <span>Worker #${i + 1}</span>
                <span style="color: ${color}; font-weight: bold; font-size: 0.9em;">${worker.nghiState}</span>
            </div>
        `;
    });
    $list.html(html);
}

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
            
            worker.nghiState = 'Khởi tạo...';
            worker.onmessage = (e) => {
                const { status, voices, chunk, data, taskId, sequenceId } = e.data;
                if (status === 'ready') {
                    worker.nghiState = 'Ready (Rảnh)';
                    updateWorkerStatusUI();
                    
                    if (i === 0) { // Only update UI from the first worker
                        voicesList = voices || [];
                        updateVoicesDropdown();
                    }
                } else if (status === 'error') {
                    worker.nghiState = 'Lỗi';
                    updateWorkerStatusUI();
                    
                    console.error(`NghiTTS Worker ${i} Error:`, data);
                    if (taskId && pendingTasks.has(taskId)) {
                        pendingTasks.get(taskId).reject(new Error(data));
                        pendingTasks.delete(taskId);
                        if (audioStreamer.currentTaskId === taskId) {
                            audioStreamer.stop(); // Clear stalled queue to free memory
                        }
                    }
                } else if (status === 'complete') {
                    worker.nghiState = 'Ready (Rảnh)';
                    updateWorkerStatusUI();
                    
                    if (taskId && pendingTasks.has(taskId)) {
                        audioStreamer.markChunkComplete(taskId, sequenceId);
                    }
                } else if (status === 'stream' && chunk) {
                    worker.nghiState = 'Đang đọc...';
                    updateWorkerStatusUI();
                    
                    if (taskId && pendingTasks.has(taskId)) {
                        audioStreamer.addChunkData(taskId, sequenceId, chunk.audio, chunk.sampleRate, chunk.text);
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
        updateWorkerStatusUI();
    }

    dispatch(message) {
        if (this.workers.length === 0) return;
        const worker = this.workers[this.currentWorkerIdx];
        this.currentWorkerIdx = (this.currentWorkerIdx + 1) % this.poolSize;
        
        worker.nghiState = 'Đang đọc...';
        updateWorkerStatusUI();
        
        worker.postMessage(message);
    }
    
    cancelTask(taskId) {
        for (const worker of this.workers) {
            worker.postMessage({ type: 'cancel', taskId });
        }
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
        
        initAdvancedSettingsUI();
        
        if (typeof toastr !== 'undefined') {
            toastr.success('NghiTTS Extension Loaded!');
        }
    }
    
    injectUI();
}

function initAdvancedSettingsUI() {
    // Advanced Settings Button
    $('#nghitts_advanced_btn').on('click', () => {
        const modal = document.getElementById('nghitts_advanced_modal');
        if (modal) {
            renderDictionaryList();
            renderPausesList();
            modal.showModal();
        }
    });

    $('#nghitts_advanced_close').on('click', () => {
        const modal = document.getElementById('nghitts_advanced_modal');
        if (modal) modal.close();
    });

    // Payload Preview Logic
    $('#nghitts_preview_payload_btn').on('click', async () => {
        const text = $('#nghitts_test_text').val().trim();
        if (!text) {
            toastr?.warning('Vui lòng nhập văn bản vào ô Test TTS trước khi xem payload!');
            return;
        }

        const modal = document.getElementById('nghitts_payload_modal');
        if (!modal) return;

        // Simulate pre-processing steps
        let dictText = text;
        if (nghittsDictionary && nghittsDictionary.length > 0) {
            nghittsDictionary.forEach(item => {
                if (item.word && item.pron) {
                    const escapedWord = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    dictText = dictText.replace(new RegExp(escapedWord, 'gi'), item.pron);
                }
            });
        }

        let rawChunks = [dictText];
        if (nghittsPauses && nghittsPauses.length > 0) {
            let tempRaw = [];
            for (let rc of rawChunks) {
                let tempChunk = rc;
                nghittsPauses.forEach(p => {
                    if (p.symbol) {
                        const escaped = p.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        tempChunk = tempChunk.replace(new RegExp(escaped, 'g'), p.symbol + '||SPLIT||');
                    }
                });
                tempRaw.push(...tempChunk.split('||SPLIT||').filter(s => s.trim().length > 0));
            }
            rawChunks = tempRaw;
        }

        let finalChunks = [];
        for (let rc of rawChunks) {
            let endingPauseSymbol = null;
            if (nghittsPauses && nghittsPauses.length > 0) {
                for (let p of nghittsPauses) {
                    if (p.symbol && rc.endsWith(p.symbol)) {
                        endingPauseSymbol = p.symbol;
                        break;
                    }
                }
            }
            
            const processed = await processTextForTTS(rc);
            const subChunks = await chunkText(processed);
            
            if (endingPauseSymbol && subChunks.length > 0) {
                subChunks[subChunks.length - 1] += endingPauseSymbol;
            }
            
            finalChunks.push(...subChunks);
        }

        // Render to UI
        const $content = $('#nghitts_payload_content');
        $content.empty();
        
        if (finalChunks.length === 0) {
            $content.append('<div style="text-align: center; color: var(--grey_text);">Không có nội dung.</div>');
        } else {
            finalChunks.forEach((c, idx) => {
                // Escape HTML so <PARAGRAPH_BREAK> is visible
                const escapedText = $('<div>').text(c).html();
                $content.append(`
                    <div style="padding: 10px; background: rgba(0,0,0,0.2); border-radius: 5px; border-left: 3px solid var(--SmartThemeQuoteColor);">
                        <div style="font-size: 0.8em; color: var(--grey_text); margin-bottom: 3px;">Chunk #${idx + 1}</div>
                        <div>${escapedText}</div>
                    </div>
                `);
            });
        }
        
        modal.showModal();
    });

    $('#nghitts_payload_close').on('click', () => {
        const modal = document.getElementById('nghitts_payload_modal');
        if (modal) modal.close();
    });

    // Dictionary Logic
    function renderDictionaryList() {
        const $list = $('#nghitts_dict_list');
        $list.empty();
        if (nghittsDictionary.length === 0) {
            $list.append('<div style="padding: 10px; text-align: center; color: var(--grey_text);">Chưa có từ nào</div>');
            return;
        }
        nghittsDictionary.forEach((item, idx) => {
            $list.append(`
                <div style="display: flex; justify-content: space-between; padding: 5px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                    <div style="flex: 1; word-break: break-all;"><b>${item.word}</b> ➔ ${item.pron}</div>
                    <button class="menu_button fa-solid fa-trash" style="padding: 2px 8px;" data-idx="${idx}"></button>
                </div>
            `);
        });
        
        $list.find('.fa-trash').on('click', function() {
            const idx = $(this).data('idx');
            nghittsDictionary.splice(idx, 1);
            localStorage.setItem('nghitts_dictionary', JSON.stringify(nghittsDictionary));
            renderDictionaryList();
        });
    }

    $('#nghitts_dict_add').on('click', () => {
        const word = $('#nghitts_dict_word').val().trim();
        const pron = $('#nghitts_dict_pron').val().trim();
        if (word && pron) {
            nghittsDictionary.push({ word, pron });
            localStorage.setItem('nghitts_dictionary', JSON.stringify(nghittsDictionary));
            $('#nghitts_dict_word').val('');
            $('#nghitts_dict_pron').val('');
            renderDictionaryList();
        }
    });

    // Pauses Logic
    function renderPausesList() {
        const $list = $('#nghitts_pause_list');
        $list.empty();
        if (nghittsPauses.length === 0) {
            $list.append('<div style="padding: 10px; text-align: center; color: var(--grey_text);">Chưa có tuỳ chỉnh nào</div>');
            return;
        }
        nghittsPauses.forEach((item, idx) => {
            $list.append(`
                <div style="display: flex; justify-content: space-between; padding: 5px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                    <div style="flex: 1; word-break: break-all;"><b>${item.symbol}</b> ➔ ${item.time}s</div>
                    <button class="menu_button fa-solid fa-trash" style="padding: 2px 8px;" data-idx="${idx}"></button>
                </div>
            `);
        });
        
        $list.find('.fa-trash').on('click', function() {
            const idx = $(this).data('idx');
            nghittsPauses.splice(idx, 1);
            localStorage.setItem('nghitts_pauses', JSON.stringify(nghittsPauses));
            renderPausesList();
        });
    }

    $('#nghitts_pause_add').on('click', () => {
        const symbol = $('#nghitts_pause_symbol').val().trim();
        const time = $('#nghitts_pause_time').val().trim();
        if (symbol && time) {
            nghittsPauses.push({ symbol, time: parseFloat(time) || 0 });
            localStorage.setItem('nghitts_pauses', JSON.stringify(nghittsPauses));
            $('#nghitts_pause_symbol').val('');
            $('#nghitts_pause_time').val('');
            renderPausesList();
        }
    });
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
        let dictText = text;
        if (nghittsDictionary && nghittsDictionary.length > 0) {
            nghittsDictionary.forEach(item => {
                if (item.word && item.pron) {
                    const escapedWord = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    dictText = dictText.replace(new RegExp(escapedWord, 'gi'), item.pron);
                }
            });
        }
        
        // FIRST, split dictText by custom pause symbols
        let rawChunks = [dictText];
        if (nghittsPauses && nghittsPauses.length > 0) {
            let tempRaw = [];
            for (let rc of rawChunks) {
                let tempChunk = rc;
                nghittsPauses.forEach(p => {
                    if (p.symbol) {
                        const escaped = p.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        tempChunk = tempChunk.replace(new RegExp(escaped, 'g'), p.symbol + '||SPLIT||');
                    }
                });
                tempRaw.push(...tempChunk.split('||SPLIT||').filter(s => s.trim().length > 0));
            }
            rawChunks = tempRaw;
        }

        // NOW process and chunk EACH raw chunk!
        let chunks = [];
        for (let rc of rawChunks) {
            // Find which custom pause this rc ends with (if any)
            let endingPauseSymbol = null;
            if (nghittsPauses && nghittsPauses.length > 0) {
                for (let p of nghittsPauses) {
                    if (p.symbol && rc.endsWith(p.symbol)) {
                        endingPauseSymbol = p.symbol;
                        break;
                    }
                }
            }
            
            const processed = await processTextForTTS(rc);
            const subChunks = await chunkText(processed);
            
            // Append the original pause symbol back to the VERY LAST subChunk so AudioStreamer can see it
            if (endingPauseSymbol && subChunks.length > 0) {
                subChunks[subChunks.length - 1] += endingPauseSymbol;
            }
            
            chunks.push(...subChunks);
        }
        
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

jQuery(async () => {
    console.log("[NghiTTS] Extension initializing...");
    await initUI();
    
    // Inject dedicated UI buttons into ST chat and input bar
    injectDedicatedUI();
    
    // Export globally for manual testing or other scripts
    window.NghiTTS = { 
        generate: generateTTS,
        stop: () => audioStreamer.stop(),
        togglePause: () => audioStreamer.togglePause()
    };
});

// -----------------------------------------------------------------------
// Dedicated UI Injection (Standalone Buttons)
// -----------------------------------------------------------------------
let currentPlayingText = null;

async function playTextWithNghiTTS(text) {
    // If already playing this exact text, toggle pause
    if ((audioStreamer.isPlaying || audioStreamer.isGenerating) && currentPlayingText === text) {
        audioStreamer.togglePause();
        updateAllButtonsState();
        return;
    }
    
    // Stop any current audio
    audioStreamer.stop();
    
    currentPlayingText = text;
    
    const voiceId = $('#nghitts_voice').val();
    
    try {
        const p = new Promise((resolve, reject) => {
            generateTTS(text, voiceId, resolve, reject);
        });
        updateAllButtonsState(); // Update UI instantly after session starts
        await p;
    } catch (e) {
        console.error("NghiTTS Play Error:", e);
    } finally {
        if (currentPlayingText === text) {
            currentPlayingText = null;
            updateAllButtonsState();
        }
    }
}

function stopTextWithNghiTTS() {
    audioStreamer.stop();
    currentPlayingText = null;
    updateAllButtonsState();
}

function getReadableText($el) {
    if (!$el || $el.length === 0 || !$el[0]) return '';
    return ($el[0].innerText || $el.text() || '').trim();
}

function updateAllButtonsState() {
    const isPlaying = audioStreamer.isPlaying || audioStreamer.isGenerating;
    
    $('.nghitts-play-btn, #nghitts_quick_play').each(function() {
        const $this = $(this);
        let btnText = '';
        if ($this.attr('id') === 'nghitts_quick_play') {
            btnText = getReadableText($('.mes:visible .mes_text').last());
        } else {
            btnText = getReadableText($this.closest('.mes').find('.mes_text'));
        }
        
        const $i = $this.find('i');
        // Get the corresponding stop button
        const $stopBtn = $this.attr('id') === 'nghitts_quick_play' 
            ? $('#nghitts_quick_stop') 
            : $this.siblings('.nghitts-stop-btn');

        if (isPlaying && btnText === currentPlayingText && currentPlayingText !== null) {
            if (audioStreamer.isPaused) {
                $i.removeClass('fa-volume-high fa-circle-pause').addClass('fa-circle-play');
                $this.css('color', '#FF9800'); // orange paused
            } else {
                $i.removeClass('fa-volume-high fa-circle-play').addClass('fa-circle-pause');
                $this.css('color', '#4CAF50'); // green active
            }
            $stopBtn.show();
        } else {
            $i.removeClass('fa-circle-pause fa-circle-play').addClass('fa-volume-high');
            $this.css('color', '');
            $stopBtn.hide();
        }
    });
}

function addPlayButtonToMessage(mesElement) {
    const $mes = $(mesElement);
    const $existingPlayBtn = $mes.find('.nghitts-play-btn');
    
    if ($existingPlayBtn.length > 0) {
        if ($existingPlayBtn.siblings('.nghitts-stop-btn').length > 0) {
            return; // Already has the new group
        } else {
            $existingPlayBtn.remove(); // Remove old standalone button
        }
    }
    
    const $btnGroup = $('<div class="nghitts-btn-group" style="display:flex; gap: 5px; align-items: center;"></div>');
    
    const $playBtn = $('<div class="mes_button nghitts-play-btn" title="NghiTTS: Đọc/Tạm dừng tin nhắn này" style="cursor:pointer; opacity: 0.6;"><i class="fa-solid fa-volume-high"></i></div>');
    const $stopBtn = $('<div class="mes_button nghitts-stop-btn" title="NghiTTS: Hủy đọc" style="cursor:pointer; opacity: 0.6; display: none; color: #f44336;"><i class="fa-solid fa-circle-stop"></i></div>');
    
    $playBtn.on('mouseenter', () => $playBtn.css('opacity', '1'));
    $playBtn.on('mouseleave', () => $playBtn.css('opacity', '0.6'));
    $stopBtn.on('mouseenter', () => $stopBtn.css('opacity', '1'));
    $stopBtn.on('mouseleave', () => $stopBtn.css('opacity', '0.6'));
    
    $playBtn.on('click mousedown touchstart', function(e) {
        if (e.type !== 'click') return; // process click only
        e.preventDefault();
        e.stopPropagation();
        const text = getReadableText($mes.find('.mes_text'));
        if (text) {
            playTextWithNghiTTS(text);
        }
    });
    
    $stopBtn.on('click mousedown touchstart', function(e) {
        if (e.type !== 'click') return;
        e.preventDefault();
        e.stopPropagation();
        stopTextWithNghiTTS();
    });
    
    $btnGroup.append($playBtn).append($stopBtn);
    
    const $buttons = $mes.find('.mes_buttons');
    if ($buttons.length > 0) {
        $buttons.prepend($btnGroup);
    } else {
        $btnGroup.css({ position: 'absolute', right: '10px', top: '10px' });
        $mes.append($btnGroup);
    }
}

function injectDedicatedUI() {
    // 1. Inject into existing and future messages using a reliable interval
    // This handles cases where ST re-renders message contents (swipes, edits)
    setInterval(() => {
        $('.mes:visible:not(:has(.nghitts-play-btn))').each(function() {
            addPlayButtonToMessage(this);
        });
        // Also keep states in sync dynamically
        updateAllButtonsState();
    }, 1000);
    
    // 3. Inject Quick Play into input bar
    const checkInterval = setInterval(() => {
        const $sendControls = $('#send_controls');
        const $sendForm = $('#send_form');
        const $target = $sendControls.length > 0 ? $sendControls : $sendForm;
        
        if ($target.length > 0) {
            // Clean up old quick play if it lacks the stop button
            if ($('#nghitts_quick_play').length > 0 && $('#nghitts_quick_stop').length === 0) {
                $('#nghitts_quick_play').remove();
            }
            
            if ($('#nghitts_quick_play').length === 0) {
                const $playBtn = $('<div id="nghitts_quick_play" title="NghiTTS: Đọc/Tạm dừng tin nhắn mới nhất" style="cursor: pointer; padding: 10px; margin: 0 5px; opacity: 0.7; font-size: 1.2em; display: inline-flex; align-items: center; justify-content: center;"><i class="fa-solid fa-volume-high"></i></div>');
            const $stopBtn = $('<div id="nghitts_quick_stop" title="NghiTTS: Hủy đọc" style="cursor: pointer; padding: 10px; margin: 0; opacity: 0.7; font-size: 1.2em; display: none; align-items: center; justify-content: center; color: #f44336;"><i class="fa-solid fa-circle-stop"></i></div>');
            
            $playBtn.on('mouseenter', () => $playBtn.css('opacity', '1'));
            $playBtn.on('mouseleave', () => $playBtn.css('opacity', '0.7'));
            $stopBtn.on('mouseenter', () => $stopBtn.css('opacity', '1'));
            $stopBtn.on('mouseleave', () => $stopBtn.css('opacity', '0.7'));
            
            $playBtn.on('click mousedown touchstart', (e) => {
                if (e.type !== 'click') return;
                e.preventDefault();
                e.stopPropagation();
                // Find last message text (exclude swipes/hidden)
                const $lastMes = $('.mes:visible .mes_text').last();
                if ($lastMes.length > 0) {
                    const text = getReadableText($lastMes);
                    if (text) {
                        playTextWithNghiTTS(text);
                    }
                }
            });

            $stopBtn.on('click mousedown touchstart', (e) => {
                if (e.type !== 'click') return;
                e.preventDefault();
                e.stopPropagation();
                stopTextWithNghiTTS();
            });
            
            if ($('#send_but').length > 0) {
                $playBtn.insertBefore('#send_but');
                $stopBtn.insertBefore('#send_but');
            } else {
                $target.append($playBtn).append($stopBtn);
            }
            clearInterval(checkInterval);
            }
        }
    }, 1000);
}
