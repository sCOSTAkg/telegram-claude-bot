'use strict';
/**
 * zep_memory.js — Zep Cloud v3 + Local Fallback Memory
 *
 * Zep Cloud used when available. Local JSON fallback always works.
 * Facts extracted from conversations and stored locally.
 */

const fs = require('fs');
const path = require('path');

let ZepClient = null, Zep = null;
try {
  ({ ZepClient, Zep } = require('@getzep/zep-cloud'));
} catch (e) {
  console.warn('[Zep] @getzep/zep-cloud not installed');
}

const ZEP_API_KEY = process.env.ZEP_API_KEY;
const zepEnabled = !!(ZepClient && ZEP_API_KEY);

let client = null;
if (zepEnabled) {
  client = new ZepClient({ apiKey: ZEP_API_KEY });
  console.log('[Zep] ✅ Zep Cloud v3 initialized');
}

// === Local Memory ===
const LOCAL_MEMORY_FILE = path.join(__dirname, 'local_memory.json');
let localMemory = {}; // chatId → { facts: [...], updatedAt }

function loadLocalMemory() {
  try {
    if (fs.existsSync(LOCAL_MEMORY_FILE)) {
      localMemory = JSON.parse(fs.readFileSync(LOCAL_MEMORY_FILE, 'utf-8'));
    }
  } catch (e) { localMemory = {}; }
}

let _saveTimer = null;
function saveLocalMemory() {
  if (_saveTimer) return; // debounce: max 1 write per 2 sec
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    fs.promises.writeFile(LOCAL_MEMORY_FILE, JSON.stringify(localMemory, null, 2))
      .catch(e => console.error('[Memory] Save error:', e.message));
  }, 2000);
}

loadLocalMemory();

// Extract key facts from text using patterns
function extractFacts(text, role) {
  const facts = [];
  const lower = text.toLowerCase();

  // Name patterns
  const namePatterns = [
    /(?:меня зовут|мое имя|я\s+[-—]\s*|i'm|my name is)\s+([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+){0,2})/i,
    /(?:фио|ФИО)[:\s]+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2})/i,
  ];
  for (const p of namePatterns) {
    const m = text.match(p);
    if (m) facts.push({ type: 'name', value: m[1].trim(), source: text.slice(0, 60) });
  }

  // Location
  const locPatterns = [
    /(?:я из|живу в|я в городе|i'm from|i live in)\s+([А-ЯЁA-Z][а-яёa-z]+(?:[- ][А-ЯЁA-Z]?[а-яёa-z]+)*)/i,
  ];
  for (const p of locPatterns) {
    const m = text.match(p);
    if (m) facts.push({ type: 'location', value: m[1].trim() });
  }

  // Age
  const ageMatch = text.match(/мне\s+(\d{1,3})\s*(?:лет|год|года)/i);
  if (ageMatch) facts.push({ type: 'age', value: ageMatch[1] });

  // Profession
  const profPatterns = [
    /(?:я работаю|я\s+[-—]\s*|моя профессия|i work as|i am a)\s+([а-яёa-z]+(?:\s+[а-яёa-z]+){0,2})/i,
  ];
  for (const p of profPatterns) {
    const m = text.match(p);
    if (m && m[1].length > 3) facts.push({ type: 'profession', value: m[1].trim() });
  }

  // Preferences
  if (lower.includes('люблю') || lower.includes('нравится') || lower.includes('предпочитаю')) {
    const prefMatch = text.match(/(?:люблю|нравится|предпочитаю)\s+(.{3,40}?)(?:\.|,|!|\n|$)/i);
    if (prefMatch) facts.push({ type: 'preference', value: prefMatch[1].trim() });
  }

  return facts;
}

// Add/update facts for a user
function addFacts(chatId, facts) {
  if (facts.length === 0) return;
  const key = String(chatId);
  if (!localMemory[key]) localMemory[key] = { facts: [], updatedAt: Date.now() };
  const existing = localMemory[key].facts;

  for (const fact of facts) {
    // Replace existing fact of same type (name, location, etc.)
    const idx = existing.findIndex(f => f.type === fact.type);
    if (idx >= 0) {
      existing[idx] = { ...fact, ts: Date.now() };
    } else {
      existing.push({ ...fact, ts: Date.now() });
    }
  }

  // Keep max 20 facts per user
  if (existing.length > 20) existing.splice(0, existing.length - 20);
  localMemory[key].updatedAt = Date.now();
  saveLocalMemory();
}

// Get local facts as text
function getLocalContext(chatId) {
  const key = String(chatId);
  const data = localMemory[key];
  if (!data || !data.facts || data.facts.length === 0) return '';

  const typeLabels = {
    name: 'Имя', location: 'Город', age: 'Возраст',
    profession: 'Профессия', preference: 'Предпочтение', note: 'Заметка'
  };

  return data.facts
    .map(f => `${typeLabels[f.type] || f.type}: ${f.value}`)
    .join('\n');
}

// Save arbitrary fact
function saveFact(chatId, type, value) {
  addFacts(chatId, [{ type, value }]);
}

// === Zep helpers ===
function userId(chatId) { return `tg_${chatId}`; }
function threadId(chatId) { return `thr_${chatId}`; }

const contextCache = new Map();
const prefetching = new Map();
const userReady = new Set();
const needsRefresh = new Set();
const CACHE_TTL_MS = 30 * 60 * 1000;
let zepQuotaExhausted = false; // Track if Zep quota is hit

function bg(promise) {
  promise.catch(e => {
    if (e.message && (e.message.includes('403') || e.message.includes('429') || e.message.includes('over the'))) {
      if (!zepQuotaExhausted) {
        zepQuotaExhausted = true;
        console.log('[Zep] ⚠️ Quota exhausted, using local memory only');
      }
    }
    if (process.env.ZEP_DEBUG) console.error('[Zep bg]', e.message || e);
  });
}

async function ensureUserThread(chatId) {
  if (!zepEnabled || zepQuotaExhausted || userReady.has(chatId)) return;
  const uid = userId(chatId);
  const tid = threadId(chatId);
  try {
    await client.user.add({ userId: uid }).catch(() => {});
    await client.thread.create({ threadId: tid, userId: uid }).catch(() => {});
    userReady.add(chatId);
  } catch (e) {
    if (process.env.ZEP_DEBUG) console.error('[Zep] ensureUserThread:', e.message);
  }
}

// === Context Prefetch ===
function prefetchContext(chatId, lastUserMsg = '') {
  if (!zepEnabled || zepQuotaExhausted) return Promise.resolve();

  const cached = contextCache.get(chatId);
  const cacheOk = cached && (Date.now() - cached.ts < CACHE_TTL_MS) && !needsRefresh.has(chatId);
  if (cacheOk) return prefetching.get(chatId) || Promise.resolve();
  if (prefetching.has(chatId)) return prefetching.get(chatId);

  const forceRefresh = needsRefresh.has(chatId);
  needsRefresh.delete(chatId);

  const p = (async () => {
    try {
      await ensureUserThread(chatId);
      const uid = userId(chatId);
      const parts = [];

      const [ctxResult, graphResult] = await Promise.allSettled([
        client.thread.getUserContext(uid),
        (lastUserMsg && lastUserMsg.length > 3)
          ? client.graph.search({ query: lastUserMsg.slice(0, 200), userId: uid, scope: 'edges' })
          : Promise.resolve(null),
      ]);

      // Check for quota errors
      for (const r of [ctxResult, graphResult]) {
        if (r.status === 'rejected') {
          const msg = r.reason?.message || '';
          if (msg.includes('403') || msg.includes('429') || msg.includes('over the') || msg.includes('Rate limit')) {
            zepQuotaExhausted = true;
            console.log('[Zep] ⚠️ Quota exhausted:', msg.slice(0, 80));
          }
        }
      }

      if (ctxResult.status === 'fulfilled') {
        const ctx = ctxResult.value;
        if (ctx && ctx.context) parts.push(ctx.context);
        else if (typeof ctx === 'string' && ctx.length > 10) parts.push(ctx);
      }

      if (graphResult.status === 'fulfilled' && graphResult.value) {
        const facts = (graphResult.value.edges || [])
          .filter(e => e.fact).map(e => e.fact).slice(0, 10);
        if (facts.length > 0) parts.push('Факты: ' + facts.join('; '));
      }

      if (parts.length > 0) {
        contextCache.set(chatId, { text: parts.join('\n'), ts: Date.now() });
      } else {
        const old = contextCache.get(chatId);
        if (old && old.text) old.ts = Date.now();
      }
    } catch (e) {
      const old = contextCache.get(chatId);
      if (old) old.ts = Date.now();
    } finally {
      prefetching.delete(chatId);
    }
  })();

  prefetching.set(chatId, p);
  return p;
}

/** Get context — Zep first, local fallback */
function getContext(chatId) {
  const zepCtx = contextCache.get(chatId)?.text || '';
  const localCtx = getLocalContext(chatId);

  if (zepCtx && localCtx) return zepCtx + '\n' + localCtx;
  return zepCtx || localCtx;
}

// === Message Sync ===
function syncMessage(chatId, role, text) {
  // Always extract facts locally
  if (role === 'user') {
    const facts = extractFacts(text, role);
    if (facts.length > 0) addFacts(chatId, facts);
  }

  // Sync to Zep if available
  if (!zepEnabled || zepQuotaExhausted) return;
  const content = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
  const roleType = role === 'assistant' ? Zep.RoleType.AssistantRole : Zep.RoleType.UserRole;
  bg((async () => {
    await ensureUserThread(chatId);
    await client.thread.addMessages(threadId(chatId), {
      messages: [{ role: roleType, roleType, content }],
    });
    needsRefresh.add(chatId);
  })());
}

// === History Recovery ===
async function loadMessages(chatId) {
  if (!zepEnabled || zepQuotaExhausted) return [];
  try {
    await ensureUserThread(chatId);
    const thr = await client.thread.get(threadId(chatId));
    if (thr && thr.messages && thr.messages.length > 0) {
      return thr.messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        text: m.content || '',
      }));
    }
  } catch (e) {
    if (process.env.ZEP_DEBUG) console.error('[Zep] loadMessages:', e.message);
  }
  return [];
}

// === Clear Session ===
async function deleteSession(chatId) {
  // Clear local
  const key = String(chatId);
  delete localMemory[key];
  saveLocalMemory();

  // Clear Zep
  if (!zepEnabled) return;
  userReady.delete(chatId);
  contextCache.delete(chatId);
  needsRefresh.delete(chatId);
  try {
    await client.thread.delete(threadId(chatId));
  } catch (e) {}
}

// === Agent Experience ===
const AGENT_USER = 'bot_agent_system';
const AGENT_THREAD = 'thr_agent_experience';
let agentReady = false;

async function ensureAgentThread() {
  if (!zepEnabled || zepQuotaExhausted || agentReady) return;
  try {
    await client.user.add({ userId: AGENT_USER }).catch(() => {});
    await client.thread.create({ threadId: AGENT_THREAD, userId: AGENT_USER }).catch(() => {});
    agentReady = true;
  } catch (e) {}
}

function syncAgentExperience(type, description) {
  if (!zepEnabled || zepQuotaExhausted) return;
  bg((async () => {
    await ensureAgentThread();
    await client.thread.addMessages(AGENT_THREAD, {
      messages: [{
        role: Zep.RoleType.ToolRole,
        roleType: Zep.RoleType.ToolRole,
        content: `[${type.toUpperCase()}] ${description.slice(0, 500)}`,
      }],
    });
  })());
}

async function getAgentContext(query = '') {
  if (!zepEnabled || zepQuotaExhausted) return '';
  try {
    await ensureAgentThread();
    const res = await client.graph.search({
      query: query.slice(0, 200) || 'agent failures successes patterns',
      userId: AGENT_USER,
      scope: 'edges',
    });
    const facts = (res.edges || []).filter(e => e.fact).map(e => e.fact).slice(0, 8);
    return facts.length > 0 ? facts.join('\n') : '';
  } catch (e) {
    return '';
  }
}

// === Monitoring ===
function stats() {
  const key = Object.keys(localMemory);
  const totalFacts = key.reduce((sum, k) => sum + (localMemory[k]?.facts?.length || 0), 0);
  return {
    enabled: zepEnabled,
    zepQuotaExhausted,
    contextsInCache: contextCache.size,
    usersReady: userReady.size,
    localUsers: key.length,
    localFacts: totalFacts,
  };
}

module.exports = {
  enabled: true, // Always enabled (local fallback)
  prefetchContext,
  getContext,
  syncMessage,
  loadMessages,
  deleteSession,
  syncAgentExperience,
  getAgentContext,
  saveFact,
  stats,
};
