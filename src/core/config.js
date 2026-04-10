/**
 * Config management module with LRU cache
 * Prevents excessive disk reads and provides caching layer
 */
const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor(configPath, maxCacheSize = 1000) {
    this.configPath = configPath;
    this.cache = new Map(); // LRU cache for configs
    this.maxCacheSize = maxCacheSize;
    this.accessOrder = []; // For LRU eviction
    this.lastSaveTime = 0;
    this.saveBatch = new Map(); // Batch saves with debounce
    this.batchTimeout = null;
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.error(`Config load error: ${e.message}`);
    }
    return {};
  }

  save(data) {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8');
      this.lastSaveTime = Date.now();
    } catch (e) {
      console.error(`Config save error: ${e.message}`);
    }
  }

  // Batched updates with debounce (3 sec)
  queueUpdate(key, value) {
    this.saveBatch.set(key, value);

    if (this.batchTimeout) clearTimeout(this.batchTimeout);
    this.batchTimeout = setTimeout(() => {
      const data = this.load();
      for (const [k, v] of this.saveBatch) {
        data[k] = v;
      }
      this.save(data);
      this.saveBatch.clear();
    }, 3000);
  }

  // Get from cache or disk
  get(key) {
    if (this.cache.has(key)) {
      this._updateLRU(key);
      return this.cache.get(key);
    }
    const data = this.load();
    const value = data[key];
    // Используем hasOwnProperty, чтобы кешировать валидные falsy-значения (false/0/''/null).
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      this._cacheSet(key, value);
    }
    return value;
  }

  _cacheSet(key, value) {
    if (this.cache.size >= this.maxCacheSize) {
      const lru = this.accessOrder.shift();
      this.cache.delete(lru);
    }
    this.cache.set(key, value);
    this.accessOrder.push(key);
  }

  _updateLRU(key) {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(key);
  }

  // Immediate save
  set(key, value) {
    this._cacheSet(key, value);
    const data = this.load();
    data[key] = value;
    this.save(data);
  }

  // Batch get all
  getAll() {
    return this.load();
  }
}

module.exports = ConfigManager;
