// IndexedDB cache for model files
class ModelCache {
  constructor() {
    this.dbName = 'piper-tts-cache';
    this.storeName = 'models';
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
          db.createObjectStore(this.storeName, { keyPath: 'url' });
        } 
      };
    });
  }

  async get(url) {
    await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
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
      const transaction = this.db.transaction([this.storeName], 'readwrite');
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
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAllKeys();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
}

const globalCache = new ModelCache();

export async function downloadModelToCache(url, onProgress) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const contentLength = response.headers.get('content-length');
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

export async function checkModelInCache(url) {
    return await globalCache.checkExists(url);
}

export async function getCachedModelsList() {
    const keys = await globalCache.getAllKeys();
    const models = new Set();
    keys.forEach(url => {
        if (url.endsWith('.onnx.json')) {
            const fileName = url.substring(url.lastIndexOf('/') + 1);
            const decoded = decodeURIComponent(fileName.replace('.onnx.json', ''));
            models.add(decoded);
        }
    });
    return Array.from(models);
}

// Cached fetch function for model files (used by piper-tts.js to load into ONNX)
export async function cachedFetch(url) {
  // Try to get from cache first
  const cachedData = await globalCache.get(url);
  
  if (cachedData) {
      return new Response(cachedData, {
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/octet-stream' })
      });
  }

  // If not in cache, we fetch it (fallback, but UI should download first)
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.arrayBuffer();
  await globalCache.set(url, data);
  
  return new Response(data, {
    status: response.status,
    headers: response.headers
  });
}

export default ModelCache;