/**
 * Memory management with LRU cache
 * Handles chatHistory, backgroundTasks, etc.
 */

class MemoryManager {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.chatHistory = new Map(); // chatId -> [{role, content}]
    this.chatHistoryAccess = new Map(); // chatId -> timestamp
    this.backgroundTasks = new Map(); // chatId -> Map<taskId, taskInfo>
    this.accessOrder = []; // For LRU eviction
  }

  // Chat history management
  addToHistory(chatId, role, content) {
    if (!this.chatHistory.has(chatId)) {
      this.chatHistory.set(chatId, []);
    }
    const history = this.chatHistory.get(chatId);
    history.push({ role, content });
    this._updateAccess(chatId);
    this._checkSize();
  }

  getHistory(chatId) {
    const history = this.chatHistory.get(chatId) || [];
    this._updateAccess(chatId);
    return history;
  }

  clearHistory(chatId) {
    this.chatHistory.delete(chatId);
    this.chatHistoryAccess.delete(chatId);
  }

  // Background tasks
  getBgTasks(chatId) {
    if (!this.backgroundTasks.has(chatId)) {
      this.backgroundTasks.set(chatId, new Map());
    }
    return this.backgroundTasks.get(chatId);
  }

  addBgTask(chatId, taskId, taskInfo) {
    const tasks = this.getBgTasks(chatId);
    tasks.set(taskId, taskInfo);
  }

  removeBgTask(chatId, taskId) {
    const tasks = this.getBgTasks(chatId);
    tasks.delete(taskId);
  }

  // LRU enforcement
  _updateAccess(chatId) {
    this.chatHistoryAccess.set(chatId, Date.now());
    const idx = this.accessOrder.indexOf(chatId);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(chatId);
  }

  _checkSize() {
    if (this.chatHistory.size > this.maxSize) {
      const lru = this.accessOrder.shift();
      this.chatHistory.delete(lru);
      this.chatHistoryAccess.delete(lru);
      this.backgroundTasks.delete(lru);
    }
  }

  // Clear old entries (>24 hours)
  evictOld(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [chatId] of this.chatHistory) {
      if (now - (this.chatHistoryAccess.get(chatId) || 0) > maxAgeMs) {
        this.clearHistory(chatId);
      }
    }
  }

  stats() {
    return {
      historyEntries: this.chatHistory.size,
      bgTasksEntries: this.backgroundTasks.size,
      totalMemory: this.chatHistory.size + this.backgroundTasks.size,
    };
  }
}

module.exports = MemoryManager;
