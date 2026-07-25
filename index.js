// src/utils/model-cache.js
var ModelCache = class {
  constructor() {
    this.dbName = "piper-tts-cache";
    this.storeName = "models";
    this.version = 2;
    this.db = null;
  }
  async init() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "url" });
        }
      };
    });
  }
  async get(url) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.get(url);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.data);
        } else {
          resolve(null);
        }
      };
    });
  }
  async set(url, data) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.put({
        url,
        data,
        timestamp: Date.now()
      });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  async checkExists(url) {
    const data = await this.get(url);
    return data !== null;
  }
  async getAllKeys() {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.getAllKeys();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
};
var globalCache = new ModelCache();
async function downloadModelToCache(url, onProgress) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const contentLength = response.headers.get("content-length");
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;
    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (onProgress && total) {
        onProgress(loaded, total);
      }
    }
    const arrayBuffer = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      arrayBuffer.set(chunk, offset);
      offset += chunk.length;
    }
    await globalCache.set(url, arrayBuffer.buffer);
    return true;
  } catch (e) {
    console.error("Error downloading model", e);
    return false;
  }
}
async function checkModelInCache(url) {
  return await globalCache.checkExists(url);
}
async function getCachedModelsList() {
  const keys = await globalCache.getAllKeys();
  const models = /* @__PURE__ */ new Set();
  keys.forEach((url) => {
    if (url.endsWith(".onnx.json")) {
      const fileName = url.substring(url.lastIndexOf("/") + 1);
      const decoded = decodeURIComponent(fileName.replace(".onnx.json", ""));
      models.add(decoded);
    }
  });
  return Array.from(models);
}

// src/index.html
var index_default = '<div class="nghitts-settings">\n    <div class="inline-drawer">\n        <div class="inline-drawer-toggle inline-drawer-header">\n            <b>NghiTTS (Local WASM)</b>\n            <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>\n        </div>\n        <div class="inline-drawer-content" style="padding: 10px;">\n            <div class="flex-container">\n                <label for="nghitts_model">Model (Online List):</label>\n                <select id="nghitts_model" class="text_pole" style="flex: 1;"></select>\n                <button id="nghitts_refresh_btn" class="menu_button fa-solid fa-sync" title="Refresh List"></button>\n            </div>\n            \n            <div class="flex-container alignitemscenter" style="margin-top: 10px; justify-content: space-between;">\n                <div id="nghitts_download_status" style="font-weight: bold; color: var(--grey_text);">Checking cache...</div>\n                <button id="nghitts_download_btn" class="menu_button" style="display: none;">Download to Local Cache</button>\n            </div>\n\n            <hr>\n\n            <div class="flex-container" style="margin-top: 10px;">\n                <label for="nghitts_voice">Local Voice (Ready):</label>\n                <select id="nghitts_voice" class="text_pole" style="flex: 1;"></select>\n            </div>\n            \n            <div class="flex-container" style="margin-top: 10px; align-items: center;">\n                <label for="nghitts_speed" style="width: 60px;">Speed:</label>\n                <input type="range" id="nghitts_speed" min="0.5" max="2" step="0.1" value="1.0" style="flex: 1;">\n                <span id="nghitts_speed_val" style="width: 30px; text-align: right;">1.0</span>\n            </div>\n\n            <hr>\n            \n            <div style="margin-top: 10px;">\n                <label for="nghitts_test_text">Test TTS:</label>\n                <textarea id="nghitts_test_text" class="text_pole" rows="3" style="width: 100%; resize: vertical;" placeholder="Nh\u1EADp v\u0103n b\u1EA3n c\u1EA7n \u0111\u1ECDc..."></textarea>\n                <div style="display: flex; justify-content: flex-end; margin-top: 5px;">\n                    <button id="nghitts_test_btn" class="menu_button">Test Audio</button>\n                </div>\n            </div>\n        </div>\n    </div>\n</div>\n';

// src/style.css
var style_default = "/* CSS for NghiTTS Extension */\n.nghitts-settings {\n    margin-bottom: 10px;\n}\n.nghitts-settings .alignitemscenter {\n    align-items: center;\n}\n";

// src/index.js
console.log("[NghiTTS] Extension module loading...");
var worker = null;
var voicesList = [];
var modelsList = [];
var currentModel = "";
var currentSpeed = 1;
var pendingTasks = /* @__PURE__ */ new Map();
var NGHITTS_API = "https://nghitts.app/api";
async function initUI() {
  console.log("[NghiTTS] Initializing UI...");
  function injectUI() {
    const container = document.getElementById("extensions_settings");
    if (!container) {
      console.log("NghiTTS: Waiting for #extensions_settings...");
      setTimeout(injectUI, 500);
      return;
    }
    $("head").append(`<style>${style_default}</style>`);
    const $wrapper = $('<div class="extension_container nghitts_wrapper"></div>');
    $wrapper.html(index_default);
    $(container).append($wrapper);
    $("#nghitts_refresh_btn").on("click", fetchModelsList);
    $("#nghitts_model").on("change", onModelDropdownChange);
    $("#nghitts_download_btn").on("click", downloadSelectedModel);
    $("#nghitts_voice").on("change", onVoiceDropdownChange);
    $("#nghitts_speed").on("input", function() {
      currentSpeed = parseFloat($(this).val());
      $("#nghitts_speed_val").text(currentSpeed.toFixed(1));
    });
    $("#nghitts_test_btn").on("click", async function() {
      const text = $("#nghitts_test_text").val().trim();
      const voiceId = 0;
      if (!text) {
        toastr?.info("Vui l\xF2ng nh\u1EADp v\u0103n b\u1EA3n \u0111\u1EC3 test.");
        return;
      }
      if (!currentModel) {
        toastr?.error("Ch\u01B0a t\u1EA3i ho\u1EB7c ch\u01B0a ch\u1ECDn Voice.");
        return;
      }
      const $btn = $(this);
      $btn.prop("disabled", true).text("Generating...");
      try {
        const audioUrl = await generateTTS(text, voiceId);
        const audio = new Audio(audioUrl);
        audio.play();
        audio.onended = () => URL.revokeObjectURL(audioUrl);
      } catch (e) {
        console.error("Test TTS Error:", e);
      } finally {
        $btn.prop("disabled", false).text("Test Audio");
      }
    });
    fetchModelsList();
    refreshCachedVoicesList();
    if (typeof toastr !== "undefined") {
      toastr.success("NghiTTS Extension Loaded!");
    }
  }
  injectUI();
}
async function fetchModelsList() {
  try {
    const response = await fetch(`${NGHITTS_API}/models`);
    const data = await response.json();
    modelsList = data.models || [];
    const $select = $("#nghitts_model");
    $select.empty();
    modelsList.forEach((m) => {
      $select.append($("<option>", { value: m, text: m }));
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
  const selectedOnlineModel = $("#nghitts_model").val();
  if (!selectedOnlineModel) return;
  const encodedModel = encodeURIComponent(selectedOnlineModel);
  const modelUrl = `${NGHITTS_API}/model/${encodedModel}.onnx`;
  const configUrl = `${NGHITTS_API}/model/${encodedModel}.onnx.json`;
  $("#nghitts_download_status").text("Checking cache...");
  $("#nghitts_download_btn").hide();
  const hasModel = await checkModelInCache(modelUrl);
  const hasConfig = await checkModelInCache(configUrl);
  if (hasModel && hasConfig) {
    $("#nghitts_download_status").text("Cached Locally (Ready)");
    $("#nghitts_download_status").css("color", "green");
  } else {
    $("#nghitts_download_status").text("Not Downloaded");
    $("#nghitts_download_status").css("color", "red");
    $("#nghitts_download_btn").show();
  }
}
async function downloadSelectedModel() {
  const selectedOnlineModel = $("#nghitts_model").val();
  if (!selectedOnlineModel) return;
  const $btn = $("#nghitts_download_btn");
  const $status = $("#nghitts_download_status");
  $btn.prop("disabled", true);
  const encodedModel = encodeURIComponent(selectedOnlineModel);
  const modelUrl = `${NGHITTS_API}/model/${encodedModel}.onnx`;
  const configUrl = `${NGHITTS_API}/model/${encodedModel}.onnx.json`;
  try {
    $status.text("Downloading config...");
    await downloadModelToCache(configUrl);
    $status.text("Downloading model... (0%)");
    await downloadModelToCache(modelUrl, (loaded, total) => {
      const pct = Math.round(loaded / total * 100);
      $status.text(`Downloading model... (${pct}%)`);
    });
    $status.text("Cached Locally (Ready)");
    $status.css("color", "green");
    $btn.hide();
    await refreshCachedVoicesList();
    const currentVoice = $("#nghitts_voice").val();
    if (currentVoice === selectedOnlineModel) {
      onVoiceDropdownChange();
    }
  } catch (e) {
    console.error(e);
    $status.text("Download failed");
    $status.css("color", "red");
  } finally {
    $btn.prop("disabled", false);
  }
}
function initWorker(modelName) {
  if (worker) {
    worker.terminate();
    worker = null;
    for (const [taskId, task] of pendingTasks.entries()) {
      task.reject(new Error("Worker terminated before completion"));
    }
    pendingTasks.clear();
  }
  const workerUrl = import.meta.url.replace("index.js", "worker.js");
  worker = new Worker(workerUrl, { type: "module" });
  worker.postMessage({
    type: "init",
    model: modelName,
    baseUrl: NGHITTS_API
  });
  worker.onmessage = (e) => {
    const { status, voices, audio, chunk, data, taskId } = e.data;
    if (status === "ready") {
      voicesList = voices || [];
      updateVoicesDropdown();
    } else if (status === "error") {
      console.error("NghiTTS Worker Error:", data);
      if (taskId && pendingTasks.has(taskId)) {
        pendingTasks.get(taskId).reject(new Error(data));
        pendingTasks.delete(taskId);
      }
    } else if (status === "complete" && audio) {
      if (taskId && pendingTasks.has(taskId)) {
        const url = URL.createObjectURL(audio);
        pendingTasks.get(taskId).resolve(url);
        pendingTasks.delete(taskId);
      }
    } else if (status === "stream" && chunk) {
    }
  };
}
function updateVoicesDropdown() {
  console.log(`[NghiTTS] Model loaded. Found ${voicesList.length} internal voices.`);
}
async function refreshCachedVoicesList() {
  try {
    const cachedModels = await getCachedModelsList();
    const $select = $("#nghitts_voice");
    const prevSelected = $select.val() || currentModel;
    $select.empty();
    if (cachedModels.length === 0) {
      $select.append($("<option>", { value: "", text: "No local voices available" }));
    } else {
      cachedModels.forEach((m) => {
        $select.append($("<option>", { value: m, text: m }));
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
  const selectedVoice = $("#nghitts_voice").val();
  if (!selectedVoice) {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    currentModel = "";
    return;
  }
  if (currentModel !== selectedVoice) {
    currentModel = selectedVoice;
    console.log(`[NghiTTS] Loading voice (model): ${currentModel}`);
    initWorker(currentModel);
  }
}
async function generateTTS(text, voiceId) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      toastr?.error("NghiTTS model not loaded or cached.");
      return reject(new Error("Model not loaded"));
    }
    const taskId = Date.now().toString() + Math.random().toString(36).substring(2);
    pendingTasks.set(taskId, { resolve, reject });
    worker.postMessage({
      type: "generate",
      text,
      voice: voiceId,
      speed: currentSpeed,
      taskId
    });
  });
}
var providerInfo = {
  name: "nghitts_wasm",
  displayName: "NghiTTS (Local WASM)",
  // Tell ST we have at least one default voice, using the current model name
  get voices() {
    if (!currentModel) return [];
    return [{ id: 0, name: currentModel }];
  },
  fetchTtsGeneration: async (text, voiceId) => {
    const audioUrl = await generateTTS(text, 0);
    const audio = new Audio(audioUrl);
    audio.play();
    return new Promise((r) => audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      r();
    });
  }
};
jQuery(async () => {
  console.log("[NghiTTS] Extension initializing...");
  await initUI();
  try {
    const ttsModule = await import("../../tts/index.js");
    if (ttsModule && ttsModule.registerTTSProvider) {
      ttsModule.registerTTSProvider("nghitts", providerInfo);
      console.log("[NghiTTS] Registered with ST TTS subsystem");
    }
  } catch (e) {
    console.log("[NghiTTS] Standard TTS module not found. Hooking fallback.", e);
    window.NghiTTS = { generate: generateTTS };
  }
});
