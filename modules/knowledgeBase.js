'use strict';

/**
 * Knowledge Base Hub — shared storage for multi-agent analysis via NotebookLM
 *
 * Agents write full results to a NotebookLM notebook (no truncation),
 * dependent agents query context via semantic search (notebook_query).
 */

// Write queue to prevent parallel stdio interleaving on nbClient
class WriteQueue {
  constructor() {
    this._queue = [];
    this._running = false;
  }

  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._running) return;
    this._running = true;
    try {
      while (this._queue.length > 0) {
        const { fn, resolve, reject } = this._queue.shift();
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      }
    } finally {
      this._running = false;
    }
  }
}

// Chunk boundary pattern for splitting large files
const CHUNK_BOUNDARY = /\n(?=function |class |module\.exports|\/\/ ===)/;
const MAX_SOURCE_SIZE = 50000; // 50KB per source
const CHUNK_OVERLAP = 500;

class KnowledgeBaseSession {
  constructor(nbClient, chatId) {
    this._nbClient = nbClient;
    this._chatId = chatId;
    this._notebookId = null;
    this._writeQueue = new WriteQueue();
    this._createdAt = Date.now();
  }

  get notebookId() { return this._notebookId; }
  get isActive() { return !!this._notebookId; }

  async init(title) {
    const res = await this._nbClient.call('notebook_create', { title });
    this._notebookId = res?.notebook_id || res?.notebookId || res?.id;
    if (!this._notebookId && typeof res === 'string') {
      const m = res.match(/notebook[_\s]?id[:\s]*["']?([a-zA-Z0-9_-]+)/i);
      if (m) this._notebookId = m[1];
    }
    if (!this._notebookId) throw new Error('Failed to create notebook: no id returned');
    console.log(`[KB] Created notebook: ${this._notebookId} for chat ${this._chatId}`);
    return this._notebookId;
  }

  async addCode(filePath, content) {
    if (!this._notebookId) throw new Error('KB not initialized');
    const chunks = this._chunkContent(filePath, content);
    for (const chunk of chunks) {
      await this._writeQueue.enqueue(() =>
        this._nbClient.call('notebook_add_text', {
          notebook_id: this._notebookId,
          title: chunk.title,
          content: chunk.content,
        })
      );
    }
    console.log(`[KB] Added code: ${filePath} (${chunks.length} chunk(s))`);
  }

  async addCodeBatch(files) {
    for (const { path: filePath, content } of files) {
      await this.addCode(filePath, content);
    }
  }

  // Fire-and-forget: saves findings without blocking the agent
  async saveFindings(role, stepId, text) {
    const title = `Findings: ${role} (step ${stepId})`;
    try {
      await this._writeQueue.enqueue(() =>
        this._nbClient.call('notebook_add_text', {
          notebook_id: this._notebookId,
          title,
          content: text,
        })
      );
      console.log(`[KB] Saved findings step ${stepId} (${role})`);
    } catch (e) {
      console.log(`[KB] Save findings failed step ${stepId}: ${e.message}`);
    }
  }

  async queryContext(query, { timeout = 60000 } = {}) {
    if (!this._notebookId) throw new Error('KB not initialized');
    const res = await this._nbClient.call('notebook_query', {
      notebook_id: this._notebookId,
      query,
    }, timeout);
    return typeof res === 'string' ? res : (res?.answer || res?.text || JSON.stringify(res));
  }

  async synthesize(goal) {
    if (!this._notebookId) throw new Error('KB not initialized');
    const res = await this._nbClient.call('notebook_query', {
      notebook_id: this._notebookId,
      query: `Synthesize all findings into a comprehensive report for the goal: "${goal}". Include all key results, code snippets, recommendations. Be detailed and actionable. Respond in Russian.`,
    }, 120000);
    return typeof res === 'string' ? res : (res?.answer || res?.text || JSON.stringify(res));
  }

  _chunkContent(filePath, content) {
    const name = filePath.split('/').pop() || filePath;
    if (content.length <= MAX_SOURCE_SIZE) {
      return [{ title: name, content }];
    }
    // Split on function/class/module boundaries
    const parts = content.split(CHUNK_BOUNDARY);
    const chunks = [];
    let current = '';
    let partNum = 1;

    for (const part of parts) {
      if (current.length + part.length > MAX_SOURCE_SIZE && current.length > 0) {
        chunks.push(current);
        // Overlap: keep tail of previous chunk
        current = current.slice(-CHUNK_OVERLAP) + part;
      } else {
        current += part;
      }
    }
    if (current.length > 0) chunks.push(current);

    const total = chunks.length;
    return chunks.map((c, i) => ({
      title: `${name} [part ${i + 1}/${total}]`,
      content: c,
    }));
  }
}

// KB usage heuristic
const KB_PATTERN = /analyz|review|audit|refactor|code.?base|project|architect|migrat|security|проанализ|аудит|рефактор|кодовую|проект|архитектур|миграц|безопасност/i;

// Singleton manager
const kbManager = {
  sessions: new Map(),

  async getOrCreate(chatId, title, nbClient) {
    if (this.sessions.has(chatId)) {
      const existing = this.sessions.get(chatId);
      if (existing.isActive) return existing;
    }
    if (!nbClient) throw new Error('nbClient required to create KB session');
    const session = new KnowledgeBaseSession(nbClient, chatId);
    await session.init(title);
    this.sessions.set(chatId, session);
    return session;
  },

  get(chatId) {
    return this.sessions.get(chatId) || null;
  },

  has(chatId) {
    return this.sessions.has(chatId) && this.sessions.get(chatId).isActive;
  },

  destroy(chatId) {
    this.sessions.delete(chatId);
  },

  /** Удалить сессии старше maxAge мс (по умолчанию 60 мин) */
  cleanup(maxAgeMs = 60 * 60 * 1000) {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (session._createdAt && now - session._createdAt > maxAgeMs) {
        this.sessions.delete(chatId);
      }
    }
  },

  shouldUseKB(goal, subtaskCount) {
    return subtaskCount >= 3 && KB_PATTERN.test(goal);
  },
};

module.exports = { KnowledgeBaseSession, kbManager };
