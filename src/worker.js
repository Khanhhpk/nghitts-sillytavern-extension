import { PiperTTS, TextSplitterStream } from "./lib/piper-tts.js";

let tts = null;
let initPromise = null;

// Initialize the model
async function initializeModel(modelName = null, baseUrl = '') {
  try {
    // Default to the original model if no model name provided
    const defaultModel = 'en_US-libritts_r-medium';
    const model = modelName || defaultModel;
    // Encode to handle spaces or special characters in filenames
    const encodedModel = encodeURIComponent(model);
    
    // Construct paths
    const modelPath = `${baseUrl}/model/${encodedModel}.onnx`;
    const configPath = `${baseUrl}/model/${encodedModel}.onnx.json`;
    
    tts = await PiperTTS.from_pretrained(modelPath, configPath);
    
    // Get available speakers
    const speakers = tts.getSpeakers();
    
    self.postMessage({ status: "ready", voices: speakers });
  } catch (e) {
    console.error("Error loading model:", e);
    self.postMessage({ status: "error", data: e.message });
  }
}

// Handle voice preview
async function handlePreview(text, voice, speed) {
  try {
    const streamer = new TextSplitterStream();
    await streamer.push(text);
    streamer.close();

    const speakerId = typeof voice === 'number' ? voice : parseInt(voice) || 0;
    const lengthScale = 1.0 / (speed || 1.0);
    
    const stream = tts.stream(streamer, { 
      speakerId, 
      lengthScale
    });

    // Get just the first chunk for preview
    for await (const { audio } of stream) {
      // Create and play preview audio
      const audioBlob = audio.toBlob();
      self.postMessage({ status: "preview", audio: audioBlob });
      break; // Only preview the first chunk
    }
  } catch (error) {
    console.error('Error generating preview:', error);
  }
}

// Listen for messages from the main thread
self.addEventListener("message", async (e) => {
  const { type, text, voice, speed, model, taskId, sequenceId } = e.data;
  
  // Handle initialization
  if (type === 'init') {
    initPromise = initializeModel(e.data.model, e.data.baseUrl);
    await initPromise;
    return;
  }
  
  if (!tts && initPromise) {
    await initPromise;
  }

  // Handle TTS generation
  if (!tts) {
    self.postMessage({ status: "error", data: "Model not initialized", taskId });
    return;
  }
  
  // Handle voice preview
  if (type === 'preview') {
    await handlePreview(text, voice, speed);
    return;
  }
  
  // Convert voice from voice ID to speaker ID
  const speakerId = typeof voice === 'number' ? voice : parseInt(voice) || 0;
  const lengthScale = 1.0 / (speed || 1.0);
  
  // Create a simple async generator that just yields the single chunk
  const simpleStreamer = async function*() {
      yield text;
  };

  const stream = tts.stream(simpleStreamer(), { 
    speakerId, 
    lengthScale
  });
  // console.log('🎤 Worker received voice ID:', voice);
  // console.log('🎤 Worker converted to speaker ID:', speakerId);
  
  // lengthScale and stream() already defined above

  try {
    for await (const { text, audio } of stream) {
      self.postMessage({
        status: "stream",
        chunk: {
          audio: audio.audio,
          sampleRate: audio.sampling_rate,
          text,
        },
        taskId,
        sequenceId
      });
    }
  } catch (error) {
    console.error("Error during streaming:", error);
    self.postMessage({ status: "error", data: error.message, taskId, sequenceId });
    return;
  }

  self.postMessage({ status: "complete", taskId, sequenceId });
});

function normalizePeak(f32, target = 0.9) {
  if (!f32?.length) return;
  let max = 1e-9;
  for (let i = 0; i < f32.length; i++) max = Math.max(max, Math.abs(f32[i]));
  const g = Math.min(4, target / max);
  if (g < 1) {
    for (let i = 0; i < f32.length; i++) f32[i] *= g;
  }
}

// Note: Initialization now handled via init message from UI
