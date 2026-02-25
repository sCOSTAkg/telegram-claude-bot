require('dotenv').config();
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedIds = process.env.ALLOWED_USER_IDS.split(',').map(Number);
const API = `https://api.telegram.org/bot${token}`;
const FILE_API = `https://api.telegram.org/file/bot${token}`;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PID_FILE = path.join(__dirname, 'bot.pid');
const CLAUDE_PATH = process.env.CLAUDE_PATH || '/opt/homebrew/bin/claude';
let tmpCounter = 0;

// === Мультимодельный AI провайдер ===
const MODEL_MAP = {
  'claude-sonnet': 'claude-sonnet-4-5-20250929',
  'claude-opus': 'claude-opus-4-6',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-2.0-flash': 'gemini-2.0-flash',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'llama-70b': 'llama-3.3-70b-versatile',
  'mixtral-8x7b': 'mixtral-8x7b-32768',
};

const PROVIDER_MODELS = {
  anthropic: [
    { id: 'claude-sonnet', label: 'Sonnet 4.5' },
    { id: 'claude-opus', label: 'Opus 4.6' },
    { id: 'claude-haiku', label: 'Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  ],
  google: [
    { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: '2.5 Flash Lite' },
    { id: 'gemini-2.0-flash', label: '2.0 Flash' },
    { id: 'gemini-3.1-pro', label: '3.1 Pro ✨' },
    { id: 'gemini-3-pro', label: '3 Pro' },
    { id: 'gemini-3-flash', label: '3 Flash' },
  ],
  groq: [
    { id: 'llama-70b', label: 'Llama 3.3 70B' },
    { id: 'mixtral-8x7b', label: 'Mixtral 8x7B' },
  ],
};

const PROVIDER_LABELS = { anthropic: '🟣 Anthropic', openai: '🟢 OpenAI', google: '🔵 Google', groq: '⚡ Groq' };

function getProvider(model) {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('llama-') || model.startsWith('mixtral-')) return 'groq';
  return 'anthropic';
}

function normalizeMessages(messages) {
  if (messages.length === 0) return [{ role: 'user', content: '' }];
  const result = [];
  for (const msg of messages) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      result[result.length - 1].content += '\n\n' + msg.content;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  if (result[0]?.role !== 'user') result.unshift({ role: 'user', content: '(начало диалога)' });
  return result;
}

function autoSelectModel(text) {
  const t = text.toLowerCase();
  const len = text.length;

  // Код / программирование (высший приоритет)
  const codeSignals = /```|`[^`]+`|function\s|class\s|const\s|let\s|var\s|import\s|def\s|return\s|=>|console\.|print\(|\.(js|ts|py|jsx|tsx|html|css|sql|sh|json|yaml)\b|npm\s|git\s|docker|api\s|endpoint|база данн|database|сервер|бэкенд|фронтенд|backend|frontend/;
  if (codeSignals.test(text)) return { model: 'claude-sonnet', reason: '💻 Код' };

  // Математика / логика
  const mathSignals = /посчитай|вычисли|калькул|формул|уравнен|интеграл|производн|матриц|\d+[\s]*[+\-*/^]\s*\d+|математик|логическ|алгоритм/;
  if (mathSignals.test(t)) return { model: 'gemini-2.5-pro', reason: '🔢 Математика' };

  // Перевод
  const translateSignals = /^(переведи|translate|перевод|переведите|переведём)/;
  if (translateSignals.test(t)) return { model: 'gemini-2.5-flash', reason: '🌐 Перевод' };

  // Сложный анализ (длинный текст или явные маркеры)
  const analysisSignals = /проанализируй|анализ|разбери|объясни подробно|детально|сравни|исследуй|рассмотри|оцени|review|analyze|explain in detail/;
  if (analysisSignals.test(t) || len > 500) return { model: 'gemini-2.5-pro', reason: '🧠 Анализ' };

  // Творчество / написание текста
  const creativeSignals = /напиши|сочини|придумай|создай текст|статью|пост|рассказ|стих|сценарий|письмо|резюме|эссе|story|write|compose/;
  if (creativeSignals.test(t)) return { model: 'claude-sonnet', reason: '✍️ Текст' };

  // Быстрый чат (короткие сообщения, приветствия)
  const quickSignals = /^(привет|здравствуй|хай|ку|хей|спасибо|ок|да|нет|понял|ладно|hi|hello|hey|thanks|ok|yes|no|👋|👍|🙏)/;
  if (quickSignals.test(t) || len < 80) return { model: 'llama-70b', reason: '⚡ Быстрый' };

  // Общий — по умолчанию
  return { model: 'gemini-2.5-flash', reason: '💬 Общий' };
}

async function callAnthropic(modelId, messages, systemPrompt) {
  // Через локальный Claude Code CLI
  const cliModelMap = { 'claude-sonnet-4-5-20250929': 'sonnet', 'claude-opus-4-6': 'opus', 'claude-haiku-4-5-20251001': 'haiku' };
  const cliModel = cliModelMap[modelId] || modelId;

  // Собираем текстовый промпт из messages
  let prompt;
  if (messages.length === 1) {
    prompt = messages[0].content;
  } else {
    let ctx = 'Предыдущие сообщения в диалоге:\n';
    for (let i = 0; i < messages.length - 1; i++) {
      ctx += `${messages[i].role === 'user' ? 'Пользователь' : 'Ассистент'}: ${messages[i].content}\n`;
    }
    ctx += `\nТекущее сообщение пользователя:\n${messages[messages.length - 1].content}`;
    prompt = ctx;
  }

  return new Promise((resolve, reject) => {
    const mcpSettingsPath = path.join(process.env.HOME || '/Users/guest1', '.claude', 'settings.json');
    const args = ['-p', '--model', cliModel, '--dangerously-skip-permissions'];
    if (fs.existsSync(mcpSettingsPath)) args.push('--mcp-config', mcpSettingsPath);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: config.workDir, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Claude CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, 300000);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !stdout) reject(new Error(stderr.trim() || `Код ${code}`));
      else resolve({ text: stdout.trim() || 'Готово (без вывода)', usage: null });
    });
  });
}

async function callOpenAI(modelId, messages, systemPrompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан в .env');
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096 }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { text: data.choices[0].message.content, usage: data.usage };
}

async function callGemini(modelId, messages, systemPrompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY не задан в .env');
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents, generationConfig: { maxOutputTokens: 4096 } };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text && data.candidates?.[0]?.finishReason === 'SAFETY') throw new Error('Заблокировано фильтром безопасности');
  return { text, usage: data.usageMetadata };
}

async function callGroqChat(modelId, messages, systemPrompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY не задан в .env');
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096 }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { text: data.choices[0].message.content, usage: data.usage };
}

async function callAI(model, messages, systemPrompt) {
  const start = Date.now();
  const provider = getProvider(model);
  const modelId = MODEL_MAP[model] || model;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropic(modelId, messages, systemPrompt); break;
    case 'openai': result = await callOpenAI(modelId, messages, systemPrompt); break;
    case 'google': result = await callGemini(modelId, messages, systemPrompt); break;
    case 'groq': result = await callGroqChat(modelId, messages, systemPrompt); break;
    default: throw new Error(`Неизвестный провайдер: ${model}`);
  }
  return { ...result, ms: Date.now() - start, provider, model };
}

// === Streaming AI провайдеры ===

async function parseSSEStream(response, extractContent, onChunk) {
  let accumulated = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const content = extractContent(json);
        if (content) {
          accumulated += content;
          onChunk(accumulated);
        }
      } catch (e) { /* skip malformed JSON */ }
    }
  }
  return accumulated;
}

async function callAnthropicStream(modelId, messages, systemPrompt, onChunk) {
  const cliModelMap = { 'claude-sonnet-4-5-20250929': 'sonnet', 'claude-opus-4-6': 'opus', 'claude-haiku-4-5-20251001': 'haiku' };
  const cliModel = cliModelMap[modelId] || modelId;

  let prompt;
  if (messages.length === 1) {
    prompt = messages[0].content;
  } else {
    let ctx = 'Предыдущие сообщения в диалоге:\n';
    for (let i = 0; i < messages.length - 1; i++) {
      ctx += `${messages[i].role === 'user' ? 'Пользователь' : 'Ассистент'}: ${messages[i].content}\n`;
    }
    ctx += `\nТекущее сообщение пользователя:\n${messages[messages.length - 1].content}`;
    prompt = ctx;
  }

  return new Promise((resolve, reject) => {
    const mcpSettingsPath = path.join(process.env.HOME || '/Users/guest1', '.claude', 'settings.json');
    const args = ['-p', '--model', cliModel, '--dangerously-skip-permissions'];
    if (fs.existsSync(mcpSettingsPath)) args.push('--mcp-config', mcpSettingsPath);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: config.workDir, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Claude CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
      onChunk(stdout.trim());
    });
    child.stderr.on('data', d => { stderr += d; });

    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, 300000);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !stdout) reject(new Error(stderr.trim() || `Код ${code}`));
      else resolve({ text: stdout.trim() || 'Готово (без вывода)', usage: null });
    });
  });
}

async function callOpenAIStream(modelId, messages, systemPrompt, onChunk) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан в .env');
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096, stream: true }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.choices?.[0]?.delta?.content || '', onChunk);
  return { text: text || 'Готово (без вывода)', usage: null };
}

async function callGeminiStream(modelId, messages, systemPrompt, onChunk) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY не задан в .env');
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents, generationConfig: { maxOutputTokens: 4096 } };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.candidates?.[0]?.content?.parts?.[0]?.text || '', onChunk);
  if (!text) throw new Error('Пустой ответ от Gemini');
  return { text, usage: null };
}

async function callGroqStream(modelId, messages, systemPrompt, onChunk) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY не задан в .env');
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096, stream: true }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.choices?.[0]?.delta?.content || '', onChunk);
  return { text: text || 'Готово (без вывода)', usage: null };
}

async function callAIStream(model, messages, systemPrompt, onChunk) {
  const start = Date.now();
  const provider = getProvider(model);
  const modelId = MODEL_MAP[model] || model;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropicStream(modelId, messages, systemPrompt, onChunk); break;
    case 'openai': result = await callOpenAIStream(modelId, messages, systemPrompt, onChunk); break;
    case 'google': result = await callGeminiStream(modelId, messages, systemPrompt, onChunk); break;
    case 'groq': result = await callGroqStream(modelId, messages, systemPrompt, onChunk); break;
    default: throw new Error(`Неизвестный провайдер: ${model}`);
  }
  return { ...result, ms: Date.now() - start, provider, model };
}

// === Защита от двойного запуска ===
if (fs.existsSync(PID_FILE)) {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
  try { process.kill(oldPid, 0); console.log(`⛔ Убиваю старый бот (PID ${oldPid})`); process.kill(oldPid); } catch(e) {}
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch(e) {} });

// === Конфигурация ===
const defaultConfig = { model: 'claude-sonnet', workDir: process.env.WORKING_DIR || '/Users/guest1', timeout: 300, historySize: 20, systemPrompt: '', channels: [], monitorInterval: 60, mtprotoSession: '', templates: [], pins: [], autoModel: true, reminders: [], streaming: true, agentMode: true, agentMaxSteps: 5 };
let config = { ...defaultConfig };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch (e) {}
}
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

// Миграция старых имён моделей
if (['sonnet', 'opus', 'haiku'].includes(config.model)) {
  config.model = 'claude-' + config.model;
  saveConfig();
}

// === История диалогов ===
const chatHistory = new Map(); // chatId -> [{role, text}]

function addToHistory(chatId, role, text) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);
  const trimmed = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
  history.push({ role, text: trimmed });
  while (history.length > config.historySize) history.shift();
}

function getHistoryPrompt(chatId, currentMsg) {
  const history = chatHistory.get(chatId);
  if (!history || history.length === 0) return currentMsg;

  let ctx = 'Предыдущие сообщения в диалоге:\n';
  for (const msg of history) {
    ctx += `${msg.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${msg.text}\n`;
  }
  ctx += `\nТекущее сообщение пользователя:\n${currentMsg}`;
  return ctx;
}

function clearHistory(chatId) {
  chatHistory.delete(chatId);
}

// === Очередь сообщений ===
const messageQueue = new Map(); // chatId -> [{text, type, filePath}]

function enqueue(chatId, item) {
  if (!messageQueue.has(chatId)) messageQueue.set(chatId, []);
  messageQueue.get(chatId).push(item);
}

function processQueue(chatId) {
  const queue = messageQueue.get(chatId);
  if (!queue || queue.length === 0) return;
  if (activeTasks.has(chatId)) return; // ещё занят

  const item = queue.shift();
  if (queue.length === 0) messageQueue.delete(chatId);

  runClaude(chatId, item.text);
}

function getQueueSize(chatId) {
  const queue = messageQueue.get(chatId);
  return queue ? queue.length : 0;
}

// === Telegram API (async через native fetch) ===
async function tgApi(method, body) {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    return await res.json();
  } catch (e) {
    console.error(`tgApi(${method}):`, e.message);
    return { ok: false };
  }
}

// Загрузка файлов (multipart) через async exec curl
function tgUpload(method, chatId, fieldName, filePath, caption) {
  return new Promise((resolve) => {
    const cap = caption ? cleanMarkdown(caption).slice(0, 1024).replace(/'/g, "'\\''") : '';
    let cmd = `curl -s -X POST '${API}/${method}' -F 'chat_id=${chatId}' -F '${fieldName}=@${filePath}'`;
    if (cap) cmd += ` -F 'caption=${cap}'`;
    exec(cmd, { encoding: 'utf8', timeout: 120000, shell: true }, (err, stdout) => {
      if (err) { resolve({ ok: false }); return; }
      try { resolve(JSON.parse(stdout)); } catch(e) { resolve({ ok: false }); }
    });
  });
}

async function send(chatId, text, opts = {}) {
  if (text.length > 4000) {
    const chunks = text.match(/[\s\S]{1,4000}/g) || [];
    let last;
    for (const c of chunks) last = await tgApi('sendMessage', { chat_id: chatId, text: c, ...opts });
    return last;
  }
  return tgApi('sendMessage', { chat_id: chatId, text, ...opts });
}

async function editText(chatId, msgId, text, opts = {}) {
  if (text.length > 4000) text = text.slice(0, 4000);
  return tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text, ...opts });
}

function del(chatId, msgId) { tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }); }

// === Очистка markdown из ответов Claude ===
function cleanMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')        // блоки кода
    .replace(/`([^`]+)`/g, '$1')           // инлайн код
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // жирный
    .replace(/\*([^*]+)\*/g, '$1')         // курсив
    .replace(/__([^_]+)__/g, '$1')         // жирный _
    .replace(/_([^_]+)_/g, '$1')           // курсив _
    .replace(/^#{1,6}\s+/gm, '')           // заголовки
    .replace(/^[-*]\s+/gm, '- ')           // списки → единый формат
    .replace(/^\d+\.\s+/gm, (m) => m)     // нумерованные — оставить
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2') // ссылки
    .replace(/\|[-:]+\|[-:|\s]+\|/g, '')   // markdown таблицы разделители
    .replace(/^\|(.+)\|$/gm, (m) => m.replace(/\|/g, ' ').trim()) // таблицы → пробелы (только строки-таблицы)
    .replace(/^---+$/gm, '')               // горизонтальные линии
    .replace(/\[ACTION:\s*\w+\]\n[\s\S]*?\n?\[\/ACTION\]/g, '') // убираем [ACTION] блоки
    .replace(/\n{3,}/g, '\n\n')            // тройные переносы
    .trim();
}

// === Отправка файлов в Telegram (async) ===
async function sendDocument(chatId, filePath, caption = '') {
  const resolved = path.resolve(config.workDir, filePath);
  if (!fs.existsSync(resolved)) { send(chatId, `❌ Файл не найден: ${resolved}`); return; }
  const res = await tgUpload('sendDocument', chatId, 'document', resolved, caption);
  if (!res.ok) send(chatId, `❌ Ошибка отправки файла`);
}

async function sendPhoto(chatId, filePath, caption = '') {
  const resolved = path.resolve(config.workDir, filePath);
  if (!fs.existsSync(resolved)) { await sendDocument(chatId, filePath, caption); return; }
  const res = await tgUpload('sendPhoto', chatId, 'photo', resolved, caption);
  if (!res.ok) await sendDocument(chatId, filePath, caption);
}

async function sendVideo(chatId, filePath, caption = '') {
  const resolved = path.resolve(config.workDir, filePath);
  if (!fs.existsSync(resolved)) { await sendDocument(chatId, filePath, caption); return; }
  const res = await tgUpload('sendVideo', chatId, 'video', resolved, caption);
  if (!res.ok) await sendDocument(chatId, filePath, caption);
}

async function sendAudio(chatId, filePath, caption = '') {
  const resolved = path.resolve(config.workDir, filePath);
  if (!fs.existsSync(resolved)) { await sendDocument(chatId, filePath, caption); return; }
  const res = await tgUpload('sendAudio', chatId, 'audio', resolved, caption);
  if (!res.ok) await sendDocument(chatId, filePath, caption);
}

// Скачать файл по URL (async)
function downloadUrl(url, filename) {
  return new Promise((resolve) => {
    const dest = path.join('/tmp', filename);
    exec(`curl -s -L -o '${dest}' '${url}'`, { timeout: 120000 }, (err) => {
      if (err || !fs.existsSync(dest) || fs.statSync(dest).size < 100) { resolve(null); return; }
      resolve(dest);
    });
  });
}

// Отправить файл по URL (async)
async function sendFileFromUrl(chatId, url, caption = '') {
  const ext = (url.match(/\.(\w+)(\?|$)/) || [])[1] || 'bin';
  const filename = `nb_${Date.now()}.${ext}`;
  const dest = await downloadUrl(url, filename);
  if (!dest) { send(chatId, caption || 'Файл недоступен для скачивания'); return; }
  const lower = ext.toLowerCase();
  if (['mp4', 'webm', 'mov'].includes(lower)) await sendVideo(chatId, dest, caption);
  else if (['mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(lower)) await sendAudio(chatId, dest, caption);
  else if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(lower)) await sendPhoto(chatId, dest, caption);
  else await sendDocument(chatId, dest, caption);
  try { fs.unlinkSync(dest); } catch(e) {}
}

// === Скачивание файла из Telegram (async) ===
async function downloadTelegramFile(fileId, destPath) {
  try {
    const res = await tgApi('getFile', { file_id: fileId });
    if (!res.ok) return null;
    const filePath = res.result.file_path;
    const url = `${FILE_API}/${filePath}`;
    return new Promise((resolve) => {
      exec(`curl -s -o '${destPath}' '${url}'`, { encoding: 'utf8', timeout: 30000 }, (err) => {
        resolve(err ? null : destPath);
      });
    });
  } catch (e) {
    return null;
  }
}

// === Меню ===
const persistentKeyboard = { reply_markup: { keyboard: [
  [{ text: '📋 Меню' }, { text: '⚙️ Настройки' }, { text: '📊 Статус' }],
  [{ text: '⛔ Стоп' }, { text: '📓 NB' }],
], resize_keyboard: true, is_persistent: true }};

function mainMenu() { return { reply_markup: { inline_keyboard: [
  [{ text: '⚙️ Настройки', callback_data: 'settings' }, { text: '📊 Статус', callback_data: 'status' }],
  [{ text: '📡 Каналы', callback_data: 'channels' }, { text: '📓 NotebookLM', callback_data: 'nb_menu' }],
  [{ text: '📌 Шаблоны', callback_data: 'templates' }, { text: '📈 Статистика', callback_data: 'stats' }],
  [{ text: `🤖 Агент: ${config.agentMode !== false ? '✅' : '❌'}`, callback_data: 'toggle_agent' }, { text: '❓ Помощь', callback_data: 'help' }],
  [{ text: '🗑 Очистить историю', callback_data: 'clear' }]
]}}; }


function settingsMenu() { return { reply_markup: { inline_keyboard: [
  [{ text: `🤖 Модель: ${config.model}`, callback_data: 'set_model' }],
  [{ text: `📁 ${config.workDir}`, callback_data: 'set_dir' }],
  [{ text: `⏱ Таймаут: ${config.timeout}с`, callback_data: 'set_timeout' }],
  [{ text: `💬 Системный промпт: ${config.systemPrompt ? '✅' : '❌'}`, callback_data: 'set_system' }],
  [{ text: `🧠 Авто-модель: ${config.autoModel ? '✅' : '❌'}`, callback_data: 'toggle_auto' }],
  [{ text: `📡 Стриминг: ${config.streaming ? '✅' : '❌'}`, callback_data: 'toggle_stream' }],
  [{ text: '◀️ Назад', callback_data: 'back' }]
]}}; }

function modelMenu() { return { reply_markup: { inline_keyboard: [
  [{ text: '🟣 Anthropic (Claude)', callback_data: 'modelgrp_anthropic' }, { text: '🟢 OpenAI (GPT)', callback_data: 'modelgrp_openai' }],
  [{ text: '🔵 Google (Gemini)', callback_data: 'modelgrp_google' }, { text: '⚡ Groq (Fast)', callback_data: 'modelgrp_groq' }],
  [{ text: '◀️ Назад', callback_data: 'settings' }]
]}}; }

function modelProviderMenu(provider) {
  const models = PROVIDER_MODELS[provider] || [];
  return { reply_markup: { inline_keyboard: [
    ...models.map(m => [{ text: (m.id === config.model ? '✅ ' : '') + m.label, callback_data: `model_${m.id}` }]),
    [{ text: '◀️ Назад к провайдерам', callback_data: 'set_model' }]
  ]}};
}

function timeoutMenu() { return { reply_markup: { inline_keyboard: [
  ...[120, 300, 600].map(t => [{ text: (t === config.timeout ? '✅ ' : '') + t + 'с', callback_data: `timeout_${t}` }]),
  [{ text: '◀️ Назад', callback_data: 'settings' }]
]}}; }

function langMenu() { return { reply_markup: { inline_keyboard: [
  [{ text: '🇷🇺 Русский', callback_data: 'lang_ru' }, { text: '🇬🇧 English', callback_data: 'lang_en' }],
  [{ text: '🔄 Сбросить', callback_data: 'lang_clear' }],
  [{ text: '◀️ Назад', callback_data: 'back' }]
]}}; }

// === Состояние ===
let activeTasks = new Map();
let waitingDir = new Set();
let waitingSystemPrompt = new Set();
let waitingChannelAdd = new Set();
let waitingChannelKeywords = new Map(); // chatId -> channelIndex
let waitingSmartSetup = new Set();
let waitingChannelPrompt = new Map(); // chatId -> channelIndex
let waitingAuthPhone = new Set();
let waitingAuthCode = new Set();
let waitingAuthPassword = new Set();
let waitingNbCreate = new Set();
let waitingNbQuery = new Map(); // chatId -> notebookId
let waitingNbUrl = new Map(); // chatId -> notebookId
let waitingNbText = new Map(); // chatId -> notebookId
let waitingNbRename = new Map(); // chatId -> notebookId
let waitingNbResearch = new Set();
let waitingNbReportCustom = new Map(); // chatId -> notebookId
let waitingNbAudioFocus = new Map(); // chatId -> {nbId, format}
let waitingTemplateName = new Set(); // chatId -> ожидание имени шаблона
let waitingTemplatePrompt = new Map(); // chatId -> templateName
let offset = 0;
let polling = false;
let monitorTimer = null;

// === Статистика ===
const stats = { startTime: Date.now(), messages: 0, claudeCalls: 0, errors: 0, voiceMessages: 0, files: 0, totalResponseTime: 0 };

// === Напоминания (персистентные) ===
const reminderTimers = new Map(); // id -> timerId
let nextReminderId = 1;

function fireReminder(id) {
  const reminder = (config.reminders || []).find(r => r.id === id);
  if (!reminder) return;
  send(reminder.chatId, `🔔 Напоминание!\n\n${reminder.text}`);
  config.reminders = config.reminders.filter(r => r.id !== id);
  saveConfig();
  reminderTimers.delete(id);
}

function loadReminders() {
  if (!config.reminders) config.reminders = [];
  // Determine next ID
  nextReminderId = config.reminders.reduce((max, r) => Math.max(max, r.id + 1), 1);
  const now = Date.now();
  for (const r of [...config.reminders]) {
    if (r.fireAt <= now) {
      // Пропущенное — отправить сразу
      send(r.chatId, `🔔 Пропущенное напоминание!\n\n${r.text}`);
      config.reminders = config.reminders.filter(x => x.id !== r.id);
    } else {
      // Будущее — пересоздать таймер
      const delay = r.fireAt - now;
      const timerId = setTimeout(() => fireReminder(r.id), delay);
      reminderTimers.set(r.id, timerId);
    }
  }
  if (config.reminders.length >= 0) saveConfig();
}

// Загрузка персистентных напоминаний
loadReminders();

// === Последний ответ (для quick actions) ===
const lastResponse = new Map(); // chatId -> {text, prompt}

// === MTProto клиент ===
const apiId = parseInt(process.env.TG_API_ID) || 0;
const apiHash = process.env.TG_API_HASH || '';
let mtClient = null;
let mtConnected = false;
let mtAuthResolvers = {}; // {phone, code, password} resolvers для интерактивной авторизации

// === Меню каналов ===
function channelsMenu() {
  const rows = config.channels.map((ch, i) => [{ text: `${ch.enabled ? '✅' : '❌'} @${ch.username}${ch.keywords.length ? ' [' + ch.keywords.length + ' кл.]' : ''}`, callback_data: `ch_${i}` }]);
  const mtStatus = mtConnected ? '🟢 MTProto' : '🔴 MTProto';
  return { reply_markup: { inline_keyboard: [
    ...rows,
    [{ text: '➕ Добавить канал', callback_data: 'ch_add' }, { text: '🧠 Умная настройка', callback_data: 'ch_smart' }],
    [{ text: `⏱ Интервал: ${config.monitorInterval}с`, callback_data: 'ch_interval' }, { text: mtStatus, callback_data: 'ch_mtproto' }],
    [{ text: '◀️ Назад', callback_data: 'back' }]
  ]}};
}

function channelDetailMenu(idx) {
  const ch = config.channels[idx];
  if (!ch) return channelsMenu();
  const kwText = ch.keywords.length ? ch.keywords.join(', ') : 'все';
  const hasPrompt = ch.prompt ? '✅' : '❌';
  return { reply_markup: { inline_keyboard: [
    [{ text: ch.enabled ? '⏸ Выключить' : '▶️ Включить', callback_data: `ch_toggle_${idx}` }],
    [{ text: `🧠 Инструкция: ${hasPrompt}`, callback_data: `ch_prompt_${idx}` }],
    [{ text: `🔑 Ключевые: ${kwText}`, callback_data: `ch_kw_${idx}` }],
    [{ text: '🔄 Проверить сейчас', callback_data: `ch_check_${idx}` }],
    [{ text: '🗑 Удалить', callback_data: `ch_del_${idx}` }],
    [{ text: '◀️ Назад', callback_data: 'channels' }]
  ]}};
}

function monitorIntervalMenu() { return { reply_markup: { inline_keyboard: [
  ...[30, 60, 120, 300].map(t => [{ text: (t === config.monitorInterval ? '✅ ' : '') + t + 'с', callback_data: `ch_intval_${t}` }]),
  [{ text: '◀️ Назад', callback_data: 'channels' }]
]}}; }

// === NotebookLM меню ===
const nbMainMenu = { reply_markup: { inline_keyboard: [
  [{ text: '📋 Мои блокноты', callback_data: 'nb_list' }],
  [{ text: '➕ Создать блокнот', callback_data: 'nb_create' }],
  [{ text: '🔍 Исследование', callback_data: 'nb_research' }],
  [{ text: '◀️ Назад', callback_data: 'back' }]
]}};

function nbDetailMenu(nbId) { return { reply_markup: { inline_keyboard: [
  [{ text: '❓ Задать вопрос', callback_data: `nb_query_${nbId}` }],
  [{ text: '🔗 Добавить URL', callback_data: `nb_addurl_${nbId}` }, { text: '📝 Добавить текст', callback_data: `nb_addtxt_${nbId}` }],
  [{ text: '🎙 Подкаст', callback_data: `nb_audio_${nbId}` }, { text: '📊 Отчёт', callback_data: `nb_report_${nbId}` }],
  [{ text: '🎬 Видео', callback_data: `nb_video_${nbId}` }, { text: '🖼 Инфографика', callback_data: `nb_infog_${nbId}` }],
  [{ text: '📑 Слайды', callback_data: `nb_slides_${nbId}` }, { text: '🧠 Mind Map', callback_data: `nb_mindmap_${nbId}` }],
  [{ text: '✏️ Переименовать', callback_data: `nb_rename_${nbId}` }, { text: '🗑 Удалить', callback_data: `nb_delete_${nbId}` }],
  [{ text: '◀️ Назад', callback_data: 'nb_list' }]
]}}; }

function nbAudioMenu(nbId) { return { reply_markup: { inline_keyboard: [
  [{ text: '🎧 Deep Dive', callback_data: `nb_aud_deep_dive_${nbId}` }],
  [{ text: '⚡ Краткий', callback_data: `nb_aud_brief_${nbId}` }],
  [{ text: '🔬 Критика', callback_data: `nb_aud_critique_${nbId}` }],
  [{ text: '⚔️ Дебаты', callback_data: `nb_aud_debate_${nbId}` }],
  [{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]
]}}; }

function nbReportMenu(nbId) { return { reply_markup: { inline_keyboard: [
  [{ text: '📋 Брифинг', callback_data: `nb_rep_briefing_${nbId}` }],
  [{ text: '📖 Учебный гайд', callback_data: `nb_rep_study_${nbId}` }],
  [{ text: '✍️ Блог-пост', callback_data: `nb_rep_blog_${nbId}` }],
  [{ text: '🎨 Свой формат', callback_data: `nb_rep_custom_${nbId}` }],
  [{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]
]}}; }

// === Обработка постов через AI ===
function processPostWithClaude(post, channel, callback) {
  const prompt = channel.prompt;
  if (!prompt) { callback(null); return; }

  const input = `Ты — ассистент для обработки постов из Telegram-каналов.

ИНСТРУКЦИЯ ПОЛЬЗОВАТЕЛЯ:
${prompt}

ПОСТ ИЗ КАНАЛА @${channel.username} (#${post.id}):
---
${post.text}
---

Обработай пост согласно инструкции. Если пост не подходит под критерии — ответь ТОЛЬКО словом "SKIP" и ничего больше. Если подходит — верни обработанный текст в нужном формате.`;

  callAI(config.model, [{ role: 'user', content: input }])
    .then(result => {
      const text = result.text.trim();
      if (!text || text === 'SKIP') callback(null);
      else callback(text);
    })
    .catch(() => callback(null));
}

// Умная настройка — AI парсит описание пользователя
async function processSmartSetup(chatId, description) {
  send(chatId, '🧠 Анализирую...');

  const input = `Пользователь хочет настроить мониторинг Telegram-каналов. Проанализируй его описание и верни ТОЛЬКО валидный JSON (без markdown, без комментариев).

ОПИСАНИЕ ПОЛЬЗОВАТЕЛЯ:
"${description}"

Верни JSON в формате:
{
  "channels": [
    {
      "username": "channelname",
      "prompt": "Подробная инструкция для AI: что фильтровать, в каком формате выдавать, что игнорировать",
      "keywords": ["опционально", "ключевые слова для быстрого фильтра"]
    }
  ]
}

ПРАВИЛА:
- username без @ и без https://t.me/
- prompt должен быть подробной инструкцией для AI на русском языке, описывающей: что именно отслеживать, в каком формате отправлять уведомление, что игнорировать
- keywords — опционально, для грубого предварительного фильтра (пустой массив = все посты пропускать через AI)
- Если пользователь не указал конкретный канал, поставь username: "UNKNOWN"
- Ответь ТОЛЬКО JSON, без объяснений`;

  try {
    const result = await callAI(config.model, [{ role: 'user', content: input }]);
    const stdout = result.text;

    // Извлекаем JSON из ответа
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.channels || !Array.isArray(parsed.channels) || parsed.channels.length === 0) {
      send(chatId, '❌ Не удалось определить каналы. Укажите @username канала в описании.');
      return;
    }

    if (!config.channels) config.channels = [];
    const added = [];
    const unknown = [];

    for (const ch of parsed.channels) {
      if (!ch.username || ch.username === 'UNKNOWN') {
        unknown.push(ch.prompt || '');
        continue;
      }
      const uname = ch.username.replace(/^@/, '').toLowerCase();
      if (config.channels.find(c => c.username.toLowerCase() === uname)) {
        const idx = config.channels.findIndex(c => c.username.toLowerCase() === uname);
        config.channels[idx].prompt = ch.prompt || '';
        if (ch.keywords && ch.keywords.length) config.channels[idx].keywords = ch.keywords;
        added.push(`🔄 @${uname} — инструкция обновлена`);
      } else {
        config.channels.push({
          username: uname,
          enabled: true,
          keywords: ch.keywords || [],
          lastPostId: 0,
          prompt: ch.prompt || ''
        });
        added.push(`✅ @${uname} — добавлен`);
      }
    }

    saveConfig();
    restartMonitoring();

    let response = '🧠 Настройка завершена!\n\n';
    if (added.length) response += added.join('\n') + '\n';
    if (unknown.length) response += '\n⚠️ Не удалось определить канал для:\n' + unknown.join('\n');

    for (const ch of parsed.channels) {
      if (ch.username && ch.username !== 'UNKNOWN') {
        response += `\n\n📡 @${ch.username}\n🧠 ${ch.prompt}`;
        if (ch.keywords && ch.keywords.length) response += `\n🔑 ${ch.keywords.join(', ')}`;
      }
    }

    send(chatId, response, channelsMenu());
  } catch (e) {
    send(chatId, `❌ Ошибка: ${e.message}`);
  }
}

// === Утилиты мониторинга ===
function matchesKeywords(text, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function formatPost(username, post) {
  const preview = post.text.length > 500 ? post.text.slice(0, 500) + '...' : post.text;
  return `📡 @${username}\n\n${preview}\n\n🔗 https://t.me/${username}/${post.id}`;
}

// === MTProto: Инициализация и авторизация ===
async function initMTProto() {
  if (!apiId || !apiHash) {
    console.log('⚠️ MTProto: TG_API_ID/TG_API_HASH не заданы, мониторинг отключён');
    return;
  }
  try {
    const session = new StringSession(config.mtprotoSession || '');
    mtClient = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      baseLogger: { log: () => {}, warn: console.warn, error: console.error, debug: () => {}, info: () => {}, canSend: () => false, _log: () => {}, setLevel: () => {} }
    });
    await mtClient.connect();

    if (await mtClient.isUserAuthorized()) {
      mtConnected = true;
      console.log('✅ MTProto: подключён и авторизован');
      setupRealtimeMonitor();
    } else {
      console.log('⚠️ MTProto: подключён, но не авторизован. Используйте /auth в боте');
    }
  } catch (e) {
    console.error(`❌ MTProto init: ${e.message}`);
  }
}

async function startMTProtoAuth(chatId, phone) {
  if (!mtClient) {
    send(chatId, '❌ MTProto клиент не инициализирован. Проверьте TG_API_ID/TG_API_HASH в .env');
    return;
  }
  try {
    send(chatId, `📱 Авторизация для ${phone}...\nТелеграм отправит код на этот номер.`);

    await mtClient.start({
      phoneNumber: () => Promise.resolve(phone),
      phoneCode: () => new Promise((resolve) => {
        mtAuthResolvers.code = resolve;
        send(chatId, '🔑 Введите код из Telegram ЧЕРЕЗ ПРОБЕЛЫ\n(например: 1 2 3 4 5)\n\n⚠️ Не вводите код слитно — Telegram заблокирует вход!', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'auth_cancel' }]] } });
        waitingAuthCode.add(chatId);
      }),
      password: () => new Promise((resolve) => {
        mtAuthResolvers.password = resolve;
        send(chatId, '🔒 Введите пароль двухфакторной аутентификации:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'auth_cancel' }]] } });
        waitingAuthPassword.add(chatId);
      }),
      onError: (err) => {
        console.error('MTProto auth error:', err.message);
        send(chatId, `❌ Ошибка авторизации: ${err.message}`);
        throw err; // Прерываем retry-цикл
      }
    });

    // Сохраняем сессию
    config.mtprotoSession = mtClient.session.save();
    saveConfig();
    mtConnected = true;

    send(chatId, '✅ MTProto авторизован! Мониторинг каналов через API включён.', mainMenu());
    console.log('✅ MTProto: авторизация успешна, сессия сохранена');
    setupRealtimeMonitor();

  } catch (e) {
    console.error(`❌ MTProto auth: ${e.message}`);
    send(chatId, `❌ Ошибка: ${e.message}`);
    waitingAuthCode.delete(chatId);
    waitingAuthPassword.delete(chatId);
  }
}

// === MTProto: Получение сообщений канала ===
async function getChannelMessages(username, limit = 20) {
  if (!mtClient || !mtConnected) return [];
  try {
    const entity = await mtClient.getEntity(username);
    const messages = await mtClient.getMessages(entity, { limit });
    return messages
      .filter(m => m.message)
      .map(m => ({ id: m.id, text: m.message, date: m.date }))
      .sort((a, b) => a.id - b.id);
  } catch (e) {
    console.error(`❌ MTProto getMessages @${username}: ${e.message}`);
    return [];
  }
}

// === MTProto: Проверка канала (существование) ===
async function resolveChannel(username) {
  if (!mtClient || !mtConnected) return null;
  try {
    const entity = await mtClient.getEntity(username);
    return entity;
  } catch (e) {
    return null;
  }
}

// === Реалтайм мониторинг через MTProto ===
function setupRealtimeMonitor() {
  if (!mtClient || !mtConnected) return;

  // Убираем старые обработчики (при рестарте)
  mtClient.removeEventHandler(handleNewMessage, new NewMessage({}));

  // Слушаем все новые сообщения
  mtClient.addEventHandler(handleNewMessage, new NewMessage({}));
  console.log('📡 MTProto: реалтайм-мониторинг запущен');
}

async function handleNewMessage(event) {
  try {
    const msg = event.message;
    if (!msg || !msg.message) return;

    // Определяем канал
    const chat = await msg.getChat();
    if (!chat) return;

    const username = chat.username;
    if (!username) return;

    // Ищем в списке мониторинга
    const idx = config.channels.findIndex(c => c.username.toLowerCase() === username.toLowerCase() && c.enabled);
    if (idx === -1) return;

    const ch = config.channels[idx];
    const post = { id: msg.id, text: msg.message };

    // Проверяем что пост новый
    if (msg.id <= (ch.lastPostId || 0)) return;

    // Обновляем lastPostId
    config.channels[idx].lastPostId = msg.id;
    saveConfig();

    // Быстрый фильтр по ключевым словам
    if (!matchesKeywords(post.text, ch.keywords)) return;

    // Если есть AI-инструкция — обрабатываем через Claude
    if (ch.prompt) {
      processPostWithClaude(post, ch, (processed) => {
        if (!processed) return; // Claude сказал SKIP
        for (const uid of allowedIds) {
          send(uid, `📡 @${username} #${post.id}\n\n${processed}\n\n🔗 https://t.me/${username}/${post.id}`);
        }
        console.log(`📡 RT+AI @${username}: пост #${msg.id}`);
      });
    } else {
      // Без инструкции — отправляем как есть
      for (const uid of allowedIds) {
        send(uid, formatPost(username, post));
      }
      console.log(`📡 RT @${username}: пост #${msg.id}`);
    }
  } catch (e) {
    console.error('Ошибка обработки поста:', e.message);
  }
}

// === Мониторинг каналов (polling fallback) ===
async function checkAllChannels() {
  if (!config.channels || config.channels.length === 0) return;
  // Если MTProto подключён — realtime работает, polling не нужен
  if (mtConnected) return;

  for (let i = 0; i < config.channels.length; i++) {
    const ch = config.channels[i];
    if (!ch.enabled) continue;
    await checkChannelFallback(i);
  }
}

async function checkChannelFallback(idx) {
  const ch = config.channels[idx];
  if (!ch) return [];

  // Скрапинг t.me/s/ как fallback
  let posts;
  try {
    const html = execSync(`curl -s -L --max-time 15 "https://t.me/s/${ch.username}"`, { encoding: 'utf8', timeout: 20000 });
    posts = [];
    const simpleRegex = /data-post="([^"]+)"/g;
    const textRegex = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g;
    const ids = [], texts = [];
    let m;
    while ((m = simpleRegex.exec(html)) !== null) ids.push(m[1]);
    while ((m = textRegex.exec(html)) !== null) {
      const t = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      texts.push(t);
    }
    for (let i = 0; i < Math.min(ids.length, texts.length); i++) {
      const numId = parseInt(ids[i].split('/')[1]) || 0;
      if (texts[i] && numId > 0) posts.push({ id: numId, postId: ids[i], text: texts[i] });
    }
    posts.sort((a, b) => a.id - b.id);
  } catch (e) {
    return [];
  }
  if (posts.length === 0) return [];

  const newPosts = posts.filter(p => p.id > (ch.lastPostId || 0));
  const matched = newPosts.filter(p => matchesKeywords(p.text, ch.keywords));

  if (newPosts.length > 0) {
    config.channels[idx].lastPostId = Math.max(...posts.map(p => p.id));
    saveConfig();
  }

  if (matched.length > 0) {
    for (const post of matched) {
      if (ch.prompt) {
        processPostWithClaude(post, ch, (processed) => {
          if (!processed) return;
          for (const uid of allowedIds) {
            send(uid, `📡 @${ch.username} #${post.id}\n\n${processed}\n\n🔗 https://t.me/${ch.username}/${post.id}`);
          }
        });
      } else {
        for (const uid of allowedIds) { send(uid, formatPost(ch.username, post)); }
      }
    }
    console.log(`📡 @${ch.username}: ${matched.length} новых`);
  }
  return matched;
}

// === Проверка одного канала (для кнопки "Проверить сейчас") ===
async function checkChannelNow(idx) {
  const ch = config.channels[idx];
  if (!ch) return [];

  let posts;
  if (mtConnected) {
    posts = await getChannelMessages(ch.username, 20);
  } else {
    // fallback scraping
    await checkChannelFallback(idx);
    return [];
  }
  if (!posts || posts.length === 0) return [];

  const newPosts = posts.filter(p => p.id > (ch.lastPostId || 0));
  const matched = newPosts.filter(p => matchesKeywords(p.text, ch.keywords));

  if (newPosts.length > 0) {
    config.channels[idx].lastPostId = Math.max(...posts.map(p => p.id));
    saveConfig();
  }
  if (matched.length > 0) {
    for (const uid of allowedIds) {
      for (const post of matched) { send(uid, formatPost(ch.username, post)); }
    }
  }
  return matched;
}

// === Добавление канала ===
async function addChannel(chatId, username) {
  if (!config.channels) config.channels = [];
  if (config.channels.find(c => c.username.toLowerCase() === username.toLowerCase())) {
    send(chatId, `⚠️ @${username} уже в списке`, channelsMenu());
    return;
  }

  send(chatId, `🔍 Проверяю @${username}...`);

  let lastId = 0;
  let postCount = 0;

  if (mtConnected) {
    const entity = await resolveChannel(username);
    if (!entity) {
      send(chatId, `❌ Канал @${username} не найден.`);
      return;
    }
    const posts = await getChannelMessages(username, 10);
    postCount = posts.length;
    if (posts.length > 0) lastId = Math.max(...posts.map(p => p.id));
  } else {
    // Fallback: scraping
    try {
      const html = execSync(`curl -s -L --max-time 15 "https://t.me/s/${username}"`, { encoding: 'utf8', timeout: 20000 });
      const idRegex = /data-post="[^/]+\/(\d+)"/g;
      let m;
      while ((m = idRegex.exec(html)) !== null) {
        const id = parseInt(m[1]);
        if (id > lastId) lastId = id;
        postCount++;
      }
      if (postCount === 0) {
        send(chatId, `❌ @${username} не найден или пуст.`);
        return;
      }
    } catch (e) {
      send(chatId, `❌ Не удалось проверить @${username}`);
      return;
    }
  }

  config.channels.push({ username, enabled: true, keywords: [], lastPostId: lastId });
  saveConfig();
  restartMonitoring();

  const mode = mtConnected ? 'MTProto realtime' : 'polling';
  send(chatId, `✅ @${username} добавлен!\n📝 ${postCount} постов, отслеживание с #${lastId}\n📡 Режим: ${mode}`, channelsMenu());
}

function startMonitoring() {
  if (monitorTimer) clearInterval(monitorTimer);
  if (config.channels && config.channels.length > 0) {
    // Если MTProto подключён — polling не нужен (реалтайм), но делаем редкую проверку на всякий случай
    const interval = mtConnected ? Math.max(config.monitorInterval, 300) : (config.monitorInterval || 60);
    monitorTimer = setInterval(() => checkAllChannels(), interval * 1000);
    const mode = mtConnected ? 'realtime + fallback' : 'polling';
    console.log(`📡 Мониторинг (${mode}): ${config.channels.filter(c => c.enabled).length} каналов`);
  }
}

function restartMonitoring() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  startMonitoring();
  if (mtConnected) setupRealtimeMonitor();
}

// === Callback кнопок (async) ===
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const data = cb.data;
  if (!data) return;

  if (data === 'settings') editText(chatId, msgId, '⚙️ Настройки:', settingsMenu());
  else if (data === 'status') {
    const busy = activeTasks.has(chatId);
    const histLen = (chatHistory.get(chatId) || []).length;
    const queueLen = getQueueSize(chatId);
    const sysPrompt = config.systemPrompt ? `\n💬 Системный промпт: ${config.systemPrompt.slice(0, 50)}${config.systemPrompt.length > 50 ? '...' : ''}` : '';
    editText(chatId, msgId, `📊 Статус\n\n🤖 Модель: ${config.model}\n📁 Папка: ${config.workDir}\n⏱ Таймаут: ${config.timeout}с\n🔄 Задача: ${busy ? 'Да' : 'Нет'}\n📬 Очередь: ${queueLen}\n💬 История: ${histLen} сообщений${sysPrompt}`, mainMenu());
  }
  else if (data === 'clear') { stopTask(chatId); clearHistory(chatId); messageQueue.delete(chatId); editText(chatId, msgId, '🗑 История, очередь и задачи очищены', mainMenu()); }
  else if (data === 'help') editText(chatId, msgId, helpText(), mainMenu());
  else if (data === 'set_model') editText(chatId, msgId, `🤖 Текущая модель: ${config.model}\n\nВыберите провайдер:`, modelMenu());
  else if (data.startsWith('modelgrp_')) {
    const provider = data.slice(9);
    const label = PROVIDER_LABELS[provider] || provider;
    editText(chatId, msgId, `${label} — выберите модель:`, modelProviderMenu(provider));
  }
  else if (data.startsWith('model_')) { config.model = data.slice(6); saveConfig(); editText(chatId, msgId, `✅ Модель: ${config.model} (${PROVIDER_LABELS[getProvider(config.model)] || ''})`, settingsMenu()); }
  else if (data === 'set_timeout') editText(chatId, msgId, '⏱ Таймаут:', timeoutMenu());
  else if (data.startsWith('timeout_')) { config.timeout = parseInt(data.slice(8)); saveConfig(); editText(chatId, msgId, `✅ Таймаут: ${config.timeout}с`, settingsMenu()); }
  else if (data === 'set_dir') { editText(chatId, msgId, `📁 Папка: ${config.workDir}\n\nОтправьте путь:`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'settings' }]] } }); waitingDir.add(chatId); }
  else if (data === 'set_system') {
    const current = config.systemPrompt ? `Текущий: ${config.systemPrompt}` : 'Не задан';
    editText(chatId, msgId, `💬 Системный промпт\n\n${current}\n\nОтправьте новый промпт или /clear_system для сброса:`, { reply_markup: { inline_keyboard: [
      [{ text: '🗑 Сбросить', callback_data: 'clear_system' }],
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
    waitingSystemPrompt.add(chatId);
  }
  else if (data === 'clear_system') { config.systemPrompt = ''; saveConfig(); editText(chatId, msgId, '✅ Системный промпт сброшен', settingsMenu()); waitingSystemPrompt.delete(chatId); }
  else if (data === 'toggle_auto') { config.autoModel = !config.autoModel; saveConfig(); editText(chatId, msgId, `🧠 Авто-модель: ${config.autoModel ? '✅ Включена' : '❌ Выключена'}`, settingsMenu()); }
  else if (data === 'toggle_stream') { config.streaming = !config.streaming; saveConfig(); editText(chatId, msgId, `📡 Стриминг: ${config.streaming ? '✅ Включён — текст появляется порциями' : '❌ Выключен — ожидание полного ответа'}`, settingsMenu()); }
  else if (data === 'toggle_agent') { config.agentMode = config.agentMode === false ? true : false; saveConfig(); editText(chatId, msgId, `🤖 Агент-режим: ${config.agentMode ? '✅ Включён — бот сам выполняет действия' : '❌ Выключен — только текстовые ответы'}`, mainMenu()); }
  else if (data === 'set_lang') editText(chatId, msgId, '🌐 Язык ответов Claude:', langMenu());
  else if (data === 'lang_ru') { config.systemPrompt = 'Всегда отвечай на русском языке.'; saveConfig(); editText(chatId, msgId, '✅ Язык: Русский', mainMenu()); }
  else if (data === 'lang_en') { config.systemPrompt = 'Always respond in English.'; saveConfig(); editText(chatId, msgId, '✅ Language: English', mainMenu()); }
  else if (data === 'lang_clear') { config.systemPrompt = ''; saveConfig(); editText(chatId, msgId, '✅ Языковая настройка сброшена', mainMenu()); }
  else if (data === 'back') editText(chatId, msgId, '👋 Claude Code Remote', mainMenu());

  // === Каналы ===
  else if (data === 'channels') {
    const count = config.channels ? config.channels.length : 0;
    const active = config.channels ? config.channels.filter(c => c.enabled).length : 0;
    editText(chatId, msgId, `📡 Мониторинг каналов\n\nВсего: ${count} | Активных: ${active}`, channelsMenu());
  }
  else if (data === 'ch_add') {
    editText(chatId, msgId, '📡 Отправьте @username или ссылку на канал\n\nПримеры:\n• durov\n• @durov\n• https://t.me/durov', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'channels' }]] } });
    waitingChannelAdd.add(chatId);
  }
  else if (data === 'ch_interval') {
    editText(chatId, msgId, `⏱ Интервал проверки (сейчас: ${config.monitorInterval}с):`, monitorIntervalMenu());
  }
  else if (data.startsWith('ch_intval_')) {
    config.monitorInterval = parseInt(data.slice(10));
    saveConfig();
    restartMonitoring();
    editText(chatId, msgId, `✅ Интервал: ${config.monitorInterval}с`, channelsMenu());
  }
  else if (data.startsWith('ch_toggle_')) {
    const idx = parseInt(data.slice(10));
    if (config.channels[idx]) {
      config.channels[idx].enabled = !config.channels[idx].enabled;
      saveConfig();
      restartMonitoring();
      editText(chatId, msgId, `${config.channels[idx].enabled ? '✅' : '❌'} @${config.channels[idx].username}: ${config.channels[idx].enabled ? 'включён' : 'выключен'}`, channelDetailMenu(idx));
    }
  }
  else if (data.startsWith('ch_del_')) {
    const idx = parseInt(data.slice(7));
    if (config.channels[idx]) {
      const name = config.channels[idx].username;
      config.channels.splice(idx, 1);
      saveConfig();
      restartMonitoring();
      editText(chatId, msgId, `🗑 @${name} удалён`, channelsMenu());
    }
  }
  else if (data.startsWith('ch_kw_')) {
    const idx = parseInt(data.slice(6));
    const ch = config.channels[idx];
    if (ch) {
      const current = ch.keywords.length ? ch.keywords.join(', ') : 'нет (все сообщения)';
      editText(chatId, msgId, `🔑 Ключевые слова для @${ch.username}\n\nТекущие: ${current}\n\nОтправьте новые через запятую или "clear" для сброса:`, { reply_markup: { inline_keyboard: [
        [{ text: '🗑 Сбросить фильтр', callback_data: `ch_kw_clear_${idx}` }],
        [{ text: '◀️ Назад', callback_data: `ch_${idx}` }]
      ] } });
      waitingChannelKeywords.set(chatId, idx);
    }
  }
  else if (data.startsWith('ch_kw_clear_')) {
    const idx = parseInt(data.slice(12));
    if (config.channels[idx]) {
      config.channels[idx].keywords = [];
      saveConfig();
      editText(chatId, msgId, `✅ Фильтр сброшен для @${config.channels[idx].username}`, channelDetailMenu(idx));
    }
    waitingChannelKeywords.delete(chatId);
  }
  else if (data.startsWith('ch_check_')) {
    const idx = parseInt(data.slice(9));
    const ch = config.channels[idx];
    if (ch) {
      editText(chatId, msgId, `🔄 Проверяю @${ch.username}...`);
      checkChannelNow(idx).then(matched => {
        if (matched.length === 0) {
          editText(chatId, msgId, `📡 @${ch.username}: нет новых сообщений`, channelDetailMenu(idx));
        } else {
          editText(chatId, msgId, `📡 @${ch.username}: ${matched.length} новых!`, channelDetailMenu(idx));
        }
      });
    }
  }
  else if (data === 'ch_smart') {
    editText(chatId, msgId, '🧠 Умная настройка\n\nОпишите своими словами:\n• Какой канал парсить\n• Что именно отслеживать\n• В каком виде присылать\n• Что игнорировать\n\nПримеры:\n• «Следи за @durov, присылай только анонсы обновлений Telegram в виде краткого резюме на 2-3 предложения»\n• «Парси @crypto_signals, отправляй только сигналы на покупку с ценой и монетой, остальное игнорируй»\n• «Мониторь @techcrunch — только новости про AI, кратко на русском»', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'channels' }]] } });
    waitingSmartSetup.add(chatId);
  }
  else if (data.startsWith('ch_prompt_')) {
    const idx = parseInt(data.slice(10));
    const ch = config.channels[idx];
    if (ch) {
      const current = ch.prompt ? ch.prompt : 'не задана (посты приходят как есть)';
      editText(chatId, msgId, `🧠 Инструкция для @${ch.username}\n\nТекущая:\n${current}\n\nОтправьте новую инструкцию или "clear" для сброса.\n\nПримеры:\n• «Присылай только новости про AI, кратко на 2 предложения»\n• «Фильтруй рекламу, присылай только полезный контент с кратким резюме»`, { reply_markup: { inline_keyboard: [
        [{ text: '🗑 Сбросить', callback_data: `ch_prompt_clear_${idx}` }],
        [{ text: '◀️ Назад', callback_data: `ch_${idx}` }]
      ] } });
      waitingChannelPrompt.set(chatId, idx);
    }
  }
  else if (data.startsWith('ch_prompt_clear_')) {
    const idx = parseInt(data.slice(16));
    if (config.channels[idx]) {
      config.channels[idx].prompt = '';
      saveConfig();
      editText(chatId, msgId, `✅ Инструкция сброшена для @${config.channels[idx].username}\nПосты будут приходить без AI-обработки.`, channelDetailMenu(idx));
    }
    waitingChannelPrompt.delete(chatId);
  }
  else if (data === 'ch_mtproto') {
    if (mtConnected) {
      editText(chatId, msgId, '🟢 MTProto подключён\n\nРеалтайм-мониторинг активен.\nНовые посты приходят мгновенно.', channelsMenu());
    } else {
      editText(chatId, msgId, '🔴 MTProto не авторизован\n\nИспользуется fallback (скрапинг t.me/s/).\nДля реалтайм-мониторинга: /auth', channelsMenu());
    }
  }
  else if (data === 'auth_cancel') {
    waitingAuthPhone.delete(chatId);
    waitingAuthCode.delete(chatId);
    waitingAuthPassword.delete(chatId);
    editText(chatId, msgId, '❌ Авторизация отменена', mainMenu());
  }
  else if (data.match(/^ch_\d+$/)) {
    const idx = parseInt(data.slice(3));
    const ch = config.channels[idx];
    if (ch) {
      const kwText = ch.keywords.length ? ch.keywords.join(', ') : 'все';
      editText(chatId, msgId, `📡 @${ch.username}\n\n${ch.enabled ? '✅ Включён' : '❌ Выключен'}\n🔑 Ключевые: ${kwText}\n📝 Последний пост: #${ch.lastPostId || '?'}`, channelDetailMenu(idx));
    }
  }

  // === NotebookLM ===
  else if (data === 'nb_menu') {
    editText(chatId, msgId, '📓 NotebookLM\n\nСоздавайте блокноты, добавляйте источники, генерируйте подкасты, отчёты и многое другое.', nbMainMenu);
  }
  else if (data === 'nb_list') {
    editText(chatId, msgId, '📋 Загружаю блокноты...');
    runNbCommand(chatId, 'Выведи список всех моих блокнотов NotebookLM. Для каждого покажи СТРОГО в формате: NOTEBOOK|название|id (по одному на строку). Без лишнего текста, только строки NOTEBOOK|...|... Если блокнотов нет, напиши EMPTY.', (result) => {
      const lines = result.split('\n').filter(l => l.startsWith('NOTEBOOK|'));
      if (lines.length === 0) {
        editText(chatId, msgId, '📋 Нет блокнотов', nbMainMenu);
      } else {
        const rows = lines.map(l => {
          const parts = l.split('|');
          const name = (parts[1] || '').trim().slice(0, 30);
          const id = (parts[2] || '').trim();
          return [{ text: `📓 ${name}`, callback_data: `nb_detail_${id}` }];
        });
        rows.push([{ text: '◀️ Назад', callback_data: 'nb_menu' }]);
        editText(chatId, msgId, `📋 Блокноты (${lines.length}):`, { reply_markup: { inline_keyboard: rows } });
      }
    }, { raw: true });
  }
  else if (data === 'nb_create') {
    editText(chatId, msgId, '➕ Введите название для нового блокнота:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'nb_menu' }]] } });
    waitingNbCreate.add(chatId);
  }
  else if (data === 'nb_research') {
    editText(chatId, msgId, '🔍 Введите тему для исследования:\n\nNotebookLM найдёт релевантные источники в интернете.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'nb_menu' }]] } });
    waitingNbResearch.add(chatId);
  }
  else if (data.startsWith('nb_detail_')) {
    const nbId = data.slice(10);
    editText(chatId, msgId, '📓 Загружаю...');
    runNbCommand(chatId, `Получи информацию о блокноте NotebookLM с ID "${nbId}". Покажи: название, количество источников и их список (названия). Используй инструмент notebook_get.`, (result) => {
      editText(chatId, msgId, `📓 Блокнот\n\n${result}`, nbDetailMenu(nbId));
    });
  }
  else if (data.startsWith('nb_query_')) {
    const nbId = data.slice(9);
    editText(chatId, msgId, '❓ Задайте вопрос по содержимому блокнота:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbQuery.set(chatId, nbId);
  }
  else if (data.startsWith('nb_addurl_')) {
    const nbId = data.slice(10);
    editText(chatId, msgId, '🔗 Отправьте URL для добавления:\n\nПоддерживаются: веб-страницы, YouTube', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbUrl.set(chatId, nbId);
  }
  else if (data.startsWith('nb_addtxt_')) {
    const nbId = data.slice(10);
    editText(chatId, msgId, '📝 Отправьте текст для добавления в блокнот:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbText.set(chatId, nbId);
  }
  else if (data.startsWith('nb_audio_')) {
    const nbId = data.slice(9);
    editText(chatId, msgId, '🎙 Выберите формат подкаста:', nbAudioMenu(nbId));
  }
  else if (data.match(/^nb_aud_(deep_dive|brief|critique|debate)_/)) {
    const m = data.match(/^nb_aud_(deep_dive|brief|critique|debate)_(.+)$/);
    const format = m[1], nbId = m[2];
    const names = { deep_dive: 'Deep Dive подкаст', brief: 'Краткий подкаст', critique: 'Критика', debate: 'Дебаты' };
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай аудиообзор для блокнота "${nbId}" в формате "${format}" на русском (language="ru"). confirm=true.`,
      '🎙', names[format] || 'Подкаст', false);
  }
  else if (data.startsWith('nb_report_')) {
    const nbId = data.slice(10);
    editText(chatId, msgId, '📊 Выберите тип отчёта:', nbReportMenu(nbId));
  }
  else if (data.startsWith('nb_rep_briefing_')) {
    const nbId = data.slice(16);
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай отчёт "Briefing Doc" для блокнота "${nbId}" на русском. confirm=true. Выведи полный текст отчёта.`,
      '📋', 'Брифинг', true);
  }
  else if (data.startsWith('nb_rep_study_')) {
    const nbId = data.slice(13);
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай отчёт "Study Guide" для блокнота "${nbId}" на русском. confirm=true. Выведи полный текст гайда.`,
      '📖', 'Учебный гайд', true);
  }
  else if (data.startsWith('nb_rep_blog_')) {
    const nbId = data.slice(12);
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай отчёт "Blog Post" для блокнота "${nbId}" на русском. confirm=true. Выведи полный текст поста.`,
      '✍️', 'Блог-пост', true);
  }
  else if (data.startsWith('nb_rep_custom_')) {
    const nbId = data.slice(14);
    editText(chatId, msgId, '🎨 Опишите формат отчёта:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_report_${nbId}` }]] } });
    waitingNbReportCustom.set(chatId, nbId);
  }
  else if (data.startsWith('nb_video_')) {
    const nbId = data.slice(9);
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай видеообзор (explainer) для блокнота "${nbId}" на русском (language="ru"). confirm=true.`,
      '🎬', 'Видео', false);
  }
  else if (data.startsWith('nb_infog_')) {
    const nbId = data.slice(9);
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай инфографику (landscape, standard) для блокнота "${nbId}" на русском. confirm=true.`,
      '🖼', 'Инфографика', false);
  }
  else if (data.startsWith('nb_slides_')) {
    const nbId = data.slice(10);
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай слайды (detailed_deck) для блокнота "${nbId}" на русском. confirm=true.`,
      '📑', 'Слайды', false);
  }
  else if (data.startsWith('nb_mindmap_')) {
    const nbId = data.slice(11);
    nbGenerateAndSend(chatId, msgId, nbId,
      `Создай mind map для блокнота "${nbId}". confirm=true.`,
      '🧠', 'Mind Map', false);
  }
  else if (data.startsWith('nb_rename_')) {
    const nbId = data.slice(10);
    editText(chatId, msgId, '✏️ Введите новое название:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbRename.set(chatId, nbId);
  }
  else if (data.startsWith('nb_delete_')) {
    const nbId = data.slice(10);
    editText(chatId, msgId, '🗑 Удаляю блокнот...');
    runNbCommand(chatId, `Удали блокнот NotebookLM с ID "${nbId}". confirm=true. Подтверди удаление.`, (result) => {
      editText(chatId, msgId, `🗑 ${result}`, nbMainMenu);
    });
  }

  // === Quick Actions (после ответа Claude) ===
  else if (data === 'qa_continue') {
    const last = lastResponse.get(chatId);
    if (last) runClaude(chatId, 'Продолжи предыдущий ответ. Не повторяй то что уже написал.');
    else send(chatId, '❌ Нет предыдущего ответа');
  }
  else if (data === 'qa_shorter') {
    const last = lastResponse.get(chatId);
    if (last) runClaude(chatId, `Перескажи кратко в 2-3 предложениях:\n${last.text.slice(0, 2000)}`);
    else send(chatId, '❌ Нет предыдущего ответа');
  }
  else if (data === 'qa_translate') {
    const last = lastResponse.get(chatId);
    if (last) runClaude(chatId, `Переведи на английский (только перевод, без комментариев):\n${last.text.slice(0, 3000)}`);
    else send(chatId, '❌ Нет предыдущего ответа');
  }
  else if (data === 'qa_save') {
    const last = lastResponse.get(chatId);
    if (last) {
      const filePath = path.join(config.workDir, `claude_${Date.now()}.txt`);
      fs.writeFileSync(filePath, last.text);
      sendDocument(chatId, filePath, 'Сохранённый ответ Claude');
    } else send(chatId, '❌ Нет предыдущего ответа');
  }
  else if (data === 'qa_regen') {
    const last = lastResponse.get(chatId);
    if (last && last.prompt) runClaude(chatId, last.prompt);
    else send(chatId, '❌ Нет предыдущего запроса');
  }

  // === Шаблоны ===
  else if (data === 'templates') {
    const tpls = config.templates || [];
    if (tpls.length === 0) {
      editText(chatId, msgId, '📌 Шаблоны пусты\n\nСохраняйте часто используемые промпты:\n/save <имя> <промпт>\n\nПримеры:\n• /save review Сделай code review\n• /save summary Дай краткое резюме', { reply_markup: { inline_keyboard: [
        [{ text: '➕ Создать шаблон', callback_data: 'tpl_create' }],
        [{ text: '◀️ Назад', callback_data: 'back' }]
      ] } });
    } else {
      const rows = tpls.map((t, i) => [{ text: `📌 ${t.name}`, callback_data: `tpl_run_${i}` }, { text: '🗑', callback_data: `tpl_del_${i}` }]);
      rows.push([{ text: '➕ Создать', callback_data: 'tpl_create' }]);
      rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
      editText(chatId, msgId, `📌 Шаблоны (${tpls.length}):`, { reply_markup: { inline_keyboard: rows } });
    }
  }
  else if (data === 'tpl_create') {
    editText(chatId, msgId, '📌 Введите имя шаблона:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'templates' }]] } });
    waitingTemplateName.add(chatId);
  }
  else if (data.startsWith('tpl_run_')) {
    const idx = parseInt(data.slice(8));
    const tpl = (config.templates || [])[idx];
    if (tpl) {
      editText(chatId, msgId, `📌 Запускаю: ${tpl.name}`);
      runClaude(chatId, tpl.prompt);
    }
  }
  else if (data.startsWith('tpl_del_')) {
    const idx = parseInt(data.slice(8));
    if (config.templates && config.templates[idx]) {
      const name = config.templates[idx].name;
      config.templates.splice(idx, 1);
      saveConfig();
      editText(chatId, msgId, `🗑 Шаблон "${name}" удалён`, mainMenu());
    }
  }

  // === Статистика ===
  else if (data === 'stats') {
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const avgTime = stats.claudeCalls > 0 ? (stats.totalResponseTime / stats.claudeCalls / 1000).toFixed(1) : 0;
    editText(chatId, msgId, `📈 Статистика\n\n⏱ Аптайм: ${uptime} мин\n📨 Сообщений: ${stats.messages}\n🤖 Claude вызовов: ${stats.claudeCalls}\n⚡ Среднее время ответа: ${avgTime}с\n🎙 Голосовых: ${stats.voiceMessages}\n📎 Файлов: ${stats.files}\n❌ Ошибок: ${stats.errors}\n🧠 AI активен: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}\n🤖 Модель: ${config.model}`, mainMenu());
  }

  tgApi('answerCallbackQuery', { callback_query_id: cb.id });
}

function stopTask(chatId) {
  const task = activeTasks.get(chatId);
  if (task) {
    if (task.timer) clearInterval(task.timer);
    if (task.pid) { try { process.kill(task.pid); } catch(e) {} }
    if (task.abort) { try { task.abort.abort(); } catch(e) {} }
    if (task.msgId) del(chatId, task.msgId);
    activeTasks.delete(chatId);
  }
}

// === NotebookLM через Claude CLI ===
function runNbCommand(chatId, prompt, callback, opts = {}) {
  const mcpSettingsPath = path.join(process.env.HOME || '/Users/guest1', '.claude', 'settings.json');
  const args = ['-p', '--model', 'sonnet', '--dangerously-skip-permissions'];
  if (fs.existsSync(mcpSettingsPath)) {
    args.push('--mcp-config', mcpSettingsPath);
  }
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
  const child = spawn(CLAUDE_PATH, args, {
    cwd: config.workDir,
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let out = '', err = '';
  child.stdout.on('data', d => out += d.toString());
  child.stderr.on('data', d => err += d.toString());
  child.on('error', e => callback(`Ошибка: ${e.message}`));
  child.on('close', code => {
    let result = out.trim() || err.trim() || `Процесс завершён с кодом ${code}`;
    if (!opts.raw) result = cleanMarkdown(result);
    result = result.length > 3500 ? result.slice(0, 3500) + '...' : result;

    // Ищем URL файлов в ответе для автоскачивания
    if (opts.sendFiles) {
      const urls = result.match(/https?:\/\/[^\s"'<>]+\.(mp4|mp3|wav|ogg|m4a|webm|mov|png|jpg|jpeg|gif|webp|pdf|pptx|svg)/gi) || [];
      if (urls.length > 0) {
        for (const url of urls) {
          sendFileFromUrl(chatId, url, '');
        }
      }
    }
    callback(result);
  });
  const fullPrompt = `Ты работаешь с NotebookLM через MCP. Отвечай кратко и без markdown-форматирования (без звёздочек, решёток, обратных кавычек). Простой текст. ${prompt}`;
  child.stdin.write(fullPrompt);
  child.stdin.end();
  const timeout = opts.timeout || 180000;
  setTimeout(() => { try { child.kill(); } catch(e) {} }, timeout);
}

// NotebookLM: запустить генерацию → следить за статусом → отправить результат
function nbGenerateAndSend(chatId, msgId, nbId, genPrompt, statusEmoji, pollLabel, isTextContent) {
  editText(chatId, msgId, `${statusEmoji} Запускаю ${pollLabel}...\nЭто может занять несколько минут`);

  let fullPrompt;
  if (isTextContent) {
    // Для текстового контента — вернуть текст прямо в ответе
    fullPrompt = `${genPrompt}

После создания:
1. Вызови studio_status для блокнота "${nbId}" чтобы проверить статус
2. Если статус generating/pending — подожди 15 секунд, проверь снова (до 10 попыток)
3. Когда готово — выведи ПОЛНЫЙ ТЕКСТ результата
4. Без markdown-форматирования. Простой текст.`;
  } else {
    // Для медиа-контента — отследить статус и дать ссылку
    fullPrompt = `${genPrompt}

После создания:
1. Вызови studio_status для блокнота "${nbId}" чтобы проверить статус
2. Если статус generating/pending — подожди 15 секунд, проверь снова (до 10 попыток)
3. Когда готово — выведи:
   - Название артефакта
   - Статус: готово/ошибка
   - Краткое описание (1-2 предложения)
4. Без markdown. Простой текст.`;
  }

  runNbCommand(chatId, fullPrompt, (result) => {
    const nbLink = `https://notebooklm.google.com/notebook/${nbId}`;

    if (isTextContent) {
      // Текстовый контент — отправляем как сообщение
      editText(chatId, msgId, `${statusEmoji} ${pollLabel} готов`, nbDetailMenu(nbId));
      send(chatId, result);
    } else {
      // Медиа — отправляем статус + ссылку на блокнот
      editText(chatId, msgId, `${statusEmoji} ${pollLabel} готов\n\n${result}\n\nОткрыть в NotebookLM:\n${nbLink}`, nbDetailMenu(nbId));
    }
  }, { timeout: 600000 });
}

// === Помощь ===
function helpText() {
  return `❓ Claude Code Remote — Помощь

📝 Текст:
• Текст — AI выполнит
• --model gpt-4o Текст — выбрать модель

🤖 Модели:
${Object.entries(PROVIDER_MODELS).map(([k, models]) => `• ${PROVIDER_LABELS[k] || k}: ${models.map(m => m.id).join(', ')}`).join('\n')}

🔧 Основные:
• /menu — главное меню
• /stop — остановить
• /clear — очистить историю
• /settings — настройки

💻 Системные:
• /bash <cmd> — bash команда
• /file <путь> — отправить файл
• /git — git status
• /ps — процессы Claude
• /web <запрос> — поиск в интернете

📌 Шаблоны:
• /save <имя> <промпт> — сохранить
• /t <имя> — запустить шаблон
• /templates — список шаблонов

⏰ Напоминания:
• /remind 30 мин Текст — напомнить
• /remind 2 ч Текст — через 2 часа
• /reminders — активные
• /cancelremind <ID> — отменить

🔄 Сравнение:
• /compare <промпт> — сравнить все доступные модели

📌 Закрепление:
• /pin — закрепить последний ответ
• /pins — список закреплённых
• /pinget <N> — посмотреть

💾 Экспорт:
• /export — скачать историю диалога

📈 Статистика:
• /stats — аналитика использования

📡 Каналы:
• /channels — управление
• /addch — добавить канал
• /parse — AI-настройка
• /auth — MTProto

📓 NotebookLM:
• /nb — блокноты, подкасты, отчёты

💬 Промпт:
• /system <текст> — системный промпт
• /clear_system — сбросить

🧠 Авто-модель:
• Бот сам выбирает лучшую модель для задачи
• ⚡ Быстрый чат → Groq (мгновенно)
• 💻 Код → Claude Sonnet (инструменты)
• 🧠 Анализ → Gemini 2.5 Pro (глубокий)
• 🌐 Перевод → Gemini 2.5 Flash (быстрый)
• --model <имя> — ручной выбор (обходит авто)

📡 Стриминг:
• Текст появляется в реальном времени (каждые ~2с)
• Включить/выключить: Настройки → Стриминг

🎙 Голосовые сообщения распознаются автоматически (Groq Whisper)`;
}

// === Bash команда ===
function runBash(chatId, cmd) {
  if (!cmd.trim()) { send(chatId, '❌ Укажите команду: /bash ls -la'); return; }
  send(chatId, `⚡ Выполняю: ${cmd.slice(0, 100)}...`);

  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
  const child = spawn('bash', ['-c', cmd], {
    cwd: config.workDir,
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  const killTimer = setTimeout(() => {
    try { child.kill(); } catch(e) {}
  }, 30000);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    let result = '';
    if (stdout.trim()) result += stdout.trim();
    if (stderr.trim()) result += (result ? '\n\n' : '') + '⚠️ STDERR:\n' + stderr.trim();
    if (!result) result = `✅ Выполнено (код ${code})`;
    if (code !== 0 && !result.includes('⚠️')) result = `❌ Код ${code}\n${result}`;
    send(chatId, result);
  });
}

// === Git статус ===
function runGit(chatId) {
  const child = spawn('bash', ['-c', 'echo "📁 $(pwd)" && echo "" && echo "=== git status ===" && git status -sb 2>&1 && echo "" && echo "=== git log (последние 5) ===" && git log --oneline -5 2>&1'], {
    cwd: config.workDir,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stdout += d; });

  child.on('close', () => {
    send(chatId, stdout.trim() || '❌ Не удалось получить git статус');
  });
}

// === Процессы Claude ===
function runPs(chatId) {
  try {
    const result = execSync("ps aux | grep -E '[c]laude' | awk '{printf \"%s %s %s %s\\n\", $2, $3, $4, $11}'", { encoding: 'utf8', timeout: 5000 });
    if (result.trim()) {
      send(chatId, `🔍 Процессы Claude:\n\nPID  CPU  MEM  CMD\n${result.trim()}`);
    } else {
      send(chatId, '✅ Нет активных процессов Claude');
    }
  } catch (e) {
    send(chatId, '✅ Нет активных процессов Claude');
  }
}

// === Обработка файлов и фото (async) ===
async function handleFile(chatId, msg) {
  let fileId, fileName, caption;

  if (msg.document) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name || `file_${Date.now()}`;
    caption = msg.caption || '';
  } else if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    fileId = photo.file_id;
    fileName = `photo_${Date.now()}.jpg`;
    caption = msg.caption || '';
  } else if (msg.video) {
    fileId = msg.video.file_id;
    fileName = msg.video.file_name || `video_${Date.now()}.mp4`;
    caption = msg.caption || '';
  } else if (msg.video_note) {
    fileId = msg.video_note.file_id;
    fileName = `videonote_${Date.now()}.mp4`;
    caption = msg.caption || '';
  } else {
    return false;
  }

  const destPath = path.join(config.workDir, fileName);
  send(chatId, `📥 Скачиваю ${fileName}...`);

  const downloaded = await downloadTelegramFile(fileId, destPath);
  if (!downloaded) {
    send(chatId, `❌ Не удалось скачать файл`);
    return true;
  }

  send(chatId, `✅ Файл сохранён: ${destPath}`);

  const prompt = caption
    ? `Файл "${fileName}" сохранён в ${destPath}. ${caption}`
    : `Пользователь отправил файл "${fileName}", сохранён в ${destPath}. Опиши что это за файл и что с ним можно сделать.`;

  if (activeTasks.has(chatId)) {
    enqueue(chatId, { text: prompt, type: 'file' });
    send(chatId, `📬 Задача для файла добавлена в очередь (позиция: ${getQueueSize(chatId)})`);
  } else {
    runClaude(chatId, prompt);
  }
  return true;
}

// === Транскрипция голоса через Groq Whisper (async) ===
function transcribeVoice(filePath) {
  return new Promise((resolve) => {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) { resolve({ text: null, error: 'GROQ_API_KEY не задан' }); return; }
    exec(
      `curl -s -X POST "https://api.groq.com/openai/v1/audio/transcriptions" ` +
      `-H "Authorization: Bearer ${groqKey}" ` +
      `-F "file=@${filePath}" ` +
      `-F "model=whisper-large-v3-turbo" ` +
      `-F "language=ru" ` +
      `-F "response_format=json"`,
      { encoding: 'utf8', timeout: 30000 },
      (err, stdout) => {
        if (err) { resolve({ text: null, error: err.message }); return; }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.text) resolve({ text: parsed.text, error: null });
          else resolve({ text: null, error: parsed.error?.message || 'Groq error' });
        } catch (e) { resolve({ text: null, error: 'Parse error' }); }
      }
    );
  });
}

async function handleVoice(chatId, msg) {
  const voice = msg.voice || msg.audio;
  if (!voice) return false;

  const fileId = voice.file_id;
  const ext = msg.voice ? 'ogg' : (voice.mime_type || '').split('/')[1] || 'mp3';
  const fileName = `voice_${Date.now()}.${ext}`;
  const destPath = path.join(config.workDir, fileName);

  send(chatId, `🎙 Распознаю голосовое...`);

  const downloaded = await downloadTelegramFile(fileId, destPath);
  if (!downloaded) {
    send(chatId, `❌ Не удалось скачать голосовое`);
    return true;
  }

  const { text, error } = await transcribeVoice(destPath);
  try { fs.unlinkSync(destPath); } catch(e) {}

  if (error || !text) {
    send(chatId, `❌ Не удалось распознать: ${error || 'пустой текст'}`);
    return true;
  }

  console.log(`🎙 Голосовое: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
  send(chatId, `🎙 Вы сказали:\n«${text}»`);

  if (activeTasks.has(chatId)) {
    enqueue(chatId, { text, type: 'text' });
    send(chatId, `📬 В очереди (позиция: ${getQueueSize(chatId)})`);
  } else {
    runClaude(chatId, text);
  }
  return true;
}

// === Запуск AI (async) ===
const MAX_CLAUDE_PROCS = 3;
let activeClaudeCount = 0;

const BOT_SYSTEM_PROMPT = `Ты — AI-ассистент в Telegram-боте. У тебя есть расширенные возможности через команды бота:
- /remind <время> <текст> — установить напоминание (например: /remind 30 мин Позвонить)
- /cancelremind <ID> — отменить напоминание
- /reminders — список активных напоминаний
- /bash <команда> — выполнить bash-команду на сервере
- /file <путь> — отправить файл
- /web <запрос> — поиск в интернете
- /compare <промпт> — сравнить ответы нескольких моделей
- /export — экспорт диалога
- /pin — закрепить ответ

Если пользователь просит что-то, что можно сделать через команду бота — объясни ему какую команду использовать, вместо того чтобы говорить "я не могу". Например, если просят напоминание — скажи использовать /remind. Если просят выполнить команду — предложи /bash.
Отвечай кратко и по делу. На русском языке, если пользователь пишет по-русски.`;

const AGENT_SYSTEM_PROMPT = `Ты — AI-ассистент с возможностью ВЫПОЛНЯТЬ действия на сервере пользователя. Ты не просто советуешь — ты действуешь.

## Доступные действия

Формат блока действия (ровно один на ответ):

[ACTION: bash]
команда
[/ACTION]

[ACTION: remind]
минуты
текст напоминания
[/ACTION]

[ACTION: file]
путь/к/файлу
[/ACTION]

## Описание действий

1. **bash** — выполнить bash-команду на сервере. Рабочая директория: ${config.workDir}. Тайм-аут: 30 секунд.
2. **remind** — установить напоминание. Первая строка — минуты (число), вторая — текст.
3. **file** — отправить файл пользователю. Одна строка — путь к файлу.

## Среда выполнения

- macOS (Darwin), Node.js v25, Homebrew установлен
- Python НЕ установлен. НЕ пытайся использовать python/pip/python3
- Для создания файлов используй node -e или bash-команды (echo, cat с heredoc)
- Для скачивания: curl
- Для работы с JSON: node -e 'console.log(JSON.parse(...))'
- Для работы с API: curl с JSON body
- Gemini API доступен: ключ в $GEMINI_API_KEY

## Правила

- Когда пользователь просит что-то СДЕЛАТЬ — ДЕЛАЙ ЭТО через действия, не предлагай команды.
- Одно действие за ответ. После результата решай, нужно ли следующее.
- Если задача не требует действий (разговор, объяснение) — отвечай текстом БЕЗ блоков [ACTION].
- Текст ДО блока [ACTION] — короткий статус (5-10 слов). Например: "Проверяю файлы на рабочем столе."
- НЕ пиши длинных объяснений перед ACTION — только краткий статус.
- НЕ показывай пользователю raw-код, HTML, CSS в сообщениях. Файлы создавай ТОЛЬКО через bash.
- НИКОГДА не выводи содержимое файлов в текст ответа — сохраняй в файл и отправь через [ACTION: file].
- Для bash: НЕ выполняй деструктивные команды (rm -rf /, форматирование дисков).
- Отвечай на языке пользователя. Будь кратким.
- Когда создаёшь файл, в финальном ответе укажи путь и краткое описание. НЕ дублируй содержимое.
- Если задача выполнена за несколько шагов — дай финальный итог что сделано.
- НЕ предлагай нумерованные варианты выбора (1, 2, 3). Вместо этого действуй сразу или задай конкретный вопрос.
- Если запрос неясен — задай ОДИН уточняющий вопрос, а не меню из вариантов.`;

// === Agent: парсинг действий ===
function parseAction(text) {
  const match = text.match(/\[ACTION:\s*(\w+)\]\n([\s\S]*?)\n?\[\/ACTION\]/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const body = match[2].trim();
  const textBefore = text.slice(0, match.index).trim();
  return { name, body, textBefore, fullMatch: match[0] };
}

// === Agent: выполнение действий ===
const BASH_BLACKLIST = [
  /rm\s+(-rf?|--recursive)\s+\//,
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /:()\{\s*:\|:&\s*\};:/,
  /chmod\s+-R\s+777\s+\//,
  /shutdown|reboot|halt|poweroff/,
  /curl.*\|\s*(bash|sh|zsh)/,
  /wget.*\|\s*(bash|sh|zsh)/,
];

function isBashBlocked(cmd) {
  return BASH_BLACKLIST.some(pattern => pattern.test(cmd));
}

function executeBashAction(cmd) {
  return new Promise((resolve) => {
    if (isBashBlocked(cmd)) {
      resolve({ success: false, output: 'ЗАБЛОКИРОВАНО: команда запрещена по соображениям безопасности' });
      return;
    }
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn('bash', ['-c', cmd], {
      cwd: config.workDir,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch(e) {}
      resolve({ success: false, output: 'ТАЙМ-АУТ: команда выполнялась более 30 секунд' });
    }, 30000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      let output = '';
      if (stdout.trim()) output += stdout.trim();
      if (stderr.trim()) output += (output ? '\n' : '') + 'STDERR: ' + stderr.trim();
      if (!output) output = `Выполнено (код ${code})`;
      if (output.length > 3000) {
        output = output.slice(0, 1500) + '\n\n[...обрезано...]\n\n' + output.slice(-1500);
      }
      resolve({ success: code === 0, output });
    });
  });
}

function executeRemindAction(chatId, body) {
  const lines = body.split('\n');
  const minutes = parseInt(lines[0]);
  const text = lines.slice(1).join('\n').trim();
  if (isNaN(minutes) || minutes < 1 || !text) {
    return { success: false, output: 'Ошибка: укажи минуты (число) на первой строке и текст на второй' };
  }
  const id = nextReminderId++;
  const fireAt = Date.now() + minutes * 60000;
  if (!config.reminders) config.reminders = [];
  config.reminders.push({ id, chatId, text, fireAt });
  saveConfig();
  const timerId = setTimeout(() => fireReminder(id), minutes * 60000);
  reminderTimers.set(id, timerId);
  return { success: true, output: `Напоминание #${id} установлено через ${minutes} мин: "${text}"` };
}

function executeSearchAction(query) {
  return { success: true, output: `Поисковый запрос "${query}" принят. Ответь на основе своих знаний.`, isSearch: true, query };
}

function executeFileAction(chatId, filePath) {
  const resolved = path.resolve(config.workDir, filePath);
  if (!fs.existsSync(resolved)) {
    return { success: false, output: `Файл не найден: ${resolved}` };
  }
  sendDocument(chatId, resolved);
  return { success: true, output: `Файл отправлен: ${resolved}` };
}

async function executeAction(chatId, action) {
  switch (action.name) {
    case 'bash': return await executeBashAction(action.body);
    case 'remind': return executeRemindAction(chatId, action.body);
    case 'search': return executeSearchAction(action.body);
    case 'file': return executeFileAction(chatId, action.body);
    case 'think': return { success: true, output: '(размышление завершено)', silent: true };
    default: return { success: false, output: `Неизвестное действие: ${action.name}` };
  }
}

async function runClaude(chatId, text) {
  let model = config.model;
  let prompt = text;

  let manualModel = false;
  if (text.startsWith('--model ')) {
    const parts = text.split(' ');
    model = parts[1];
    prompt = parts.slice(2).join(' ');
    manualModel = true;
    if (['sonnet', 'opus', 'haiku'].includes(model)) model = 'claude-' + model;
  }

  let autoReason = '';
  if (config.autoModel && !manualModel) {
    const auto = autoSelectModel(prompt);
    const selectedProvider = getProvider(auto.model);
    const providerAvailable = selectedProvider === 'anthropic' ||
      (selectedProvider === 'google' && process.env.GEMINI_API_KEY) ||
      (selectedProvider === 'groq' && process.env.GROQ_API_KEY) ||
      (selectedProvider === 'openai' && process.env.OPENAI_API_KEY);
    if (providerAvailable) {
      model = auto.model;
      autoReason = auto.reason;
    }
  }

  if (activeClaudeCount >= MAX_CLAUDE_PROCS) {
    enqueue(chatId, { text, type: 'text' });
    send(chatId, `⏳ AI занят (${activeClaudeCount}/${MAX_CLAUDE_PROCS}). В очереди: ${getQueueSize(chatId)}`);
    return;
  }

  addToHistory(chatId, 'user', prompt);

  const history = chatHistory.get(chatId) || [];
  const messages = [];
  for (let i = 0; i < history.length - 1; i++) {
    messages.push({ role: history[i].role, content: history[i].text });
  }
  messages.push({ role: 'user', content: prompt });

  const queueLen = getQueueSize(chatId);
  const queueInfo = queueLen > 0 ? ` | 📬 ${queueLen} в очереди` : '';
  const provider = getProvider(model);
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  const autoTag = autoReason ? ` [${autoReason}]` : '';
  const res = await send(chatId, `🚀 ${providerLabel} ${model}${autoTag}...${queueInfo}`);
  const statusMsgId = res?.result?.message_id;

  const startTime = Date.now();
  console.log(`🔧 ${model} (${provider}) — ${prompt.length} символов`);
  activeClaudeCount++;
  activeTasks.set(chatId, { timer: null, msgId: statusMsgId });

  const agentEnabled = config.agentMode !== false;
  const basePrompt = agentEnabled ? AGENT_SYSTEM_PROMPT : BOT_SYSTEM_PROMPT;
  const fullSystemPrompt = [basePrompt, config.systemPrompt].filter(Boolean).join('\n\n');
  const maxSteps = config.agentMaxSteps || 5;

  try {
    let step = 0;
    let finalText = '';

    while (step < maxSteps) {
      if (!activeTasks.has(chatId)) {
        finalText = 'Остановлено пользователем.';
        break;
      }
      step++;

      if (statusMsgId && step > 1) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        editText(chatId, statusMsgId, `🔄 Шаг ${step}/${maxSteps}... (${elapsed}с)`);
      }

      let result;
      if (config.streaming) {
        let lastEditTime = 0;
        let chunkCount = 0;
        let lastLen = 0;
        const onChunk = (partial) => {
          const now = Date.now();
          if (now - lastEditTime < 2000) return;
          lastEditTime = now;
          chunkCount++;
          lastLen = partial.length;
          const elapsed = Math.round((now - startTime) / 1000);
          // Прогресс-бар: логарифмическая шкала, плавно растёт до 95%
          const pct = Math.min(Math.round(95 * (1 - Math.exp(-lastLen / 1500))), 95);
          const filled = Math.round(pct / 5);
          const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
          const stepInfo = agentEnabled && step > 1 ? `\n🔄 Шаг ${step}/${maxSteps}` : '';
          if (statusMsgId) editText(chatId, statusMsgId, `⏳ ${bar} ${pct}% (${elapsed}с)${stepInfo}`);
        };
        result = await callAIStream(model, normalizeMessages(messages), fullSystemPrompt, onChunk);
        // Финальное обновление на 100%
        if (statusMsgId) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          editText(chatId, statusMsgId, `✅ ${'█'.repeat(20)} 100% (${elapsed}с)`);
        }
      } else {
        // Classic mode — анимация ожидания
        let dots = 0;
        const frames = ['🔄', '⏳', '🤖', '💭'];
        const timer = setInterval(() => {
          dots++;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const frame = frames[dots % frames.length];
          if (statusMsgId) editText(chatId, statusMsgId, `${frame} ${model} работает... ${elapsed}с`);
        }, 3000);
        activeTasks.get(chatId).timer = timer;
        try {
          result = await callAI(model, normalizeMessages(messages), fullSystemPrompt);
        } finally {
          clearInterval(timer);
        }
      }

      stats.claudeCalls++;
      stats.totalResponseTime += result.ms;

      const responseText = result.text.trim();

      if (!agentEnabled) {
        finalText = responseText;
        break;
      }

      const action = parseAction(responseText);

      if (!action) {
        finalText = responseText;
        break;
      }

      // Показываем прогресс через редактирование статус-сообщения (не send!)
      if (action.textBefore && statusMsgId) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        editText(chatId, statusMsgId, `💭 ${cleanMarkdown(action.textBefore).slice(0, 200)}\n\n🔄 Шаг ${step}/${maxSteps} (${elapsed}с)`);
      }

      const actionResult = await executeAction(chatId, action);

      console.log(`🤖 Agent step ${step}: [${action.name}] → ${actionResult.success ? 'OK' : 'FAIL'} (${actionResult.output.slice(0, 100)})`);

      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content: `[RESULT: ${action.name}]\n${actionResult.output}\n[/RESULT]`
      });
    }

    activeTasks.delete(chatId);
    activeClaudeCount--;
    if (statusMsgId) del(chatId, statusMsgId);

    const displayText = cleanMarkdown(finalText) || (agentEnabled && step > 1 ? '✅ Задача выполнена.' : 'Готово (без вывода)');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`📋 ${model}: ${displayText.length}б, ${elapsed}с`);

    addToHistory(chatId, 'assistant', displayText);
    lastResponse.set(chatId, { text: displayText, prompt });

    send(chatId, displayText);

    if (step >= maxSteps && parseAction(finalText)) {
      send(chatId, `⚠️ Достигнут лимит шагов (${maxSteps}). Задача может быть не завершена.`);
    }

  } catch (e) {
    activeTasks.delete(chatId);
    activeClaudeCount--;
    stats.errors++;
    console.error(`❌ ${model} error: ${e.message}`);
    if (statusMsgId) del(chatId, statusMsgId);
    send(chatId, `❌ Ошибка ${model}: ${e.message}`);
  }

  processQueue(chatId);
}

// === Polling (Long Polling + async) ===
let stopPolling = false;

async function processUpdate(upd) {
  if (upd.callback_query) {
    handleCallback(upd.callback_query).catch(e => console.error('CB ERR:', e.message));
    return;
  }

  const msg = upd.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  console.log(`📨 ${msg.text || '[файл/медиа]'}`);
  stats.messages++;

  if (!allowedIds.includes(userId)) { send(chatId, `❌ Нет доступа. ID: ${userId}`); return; }

  // Обработка голосовых
  if (msg.voice || msg.audio) { stats.voiceMessages++; handleVoice(chatId, msg); return; }

  // Обработка файлов, фото и видео
  if (msg.document || msg.photo || msg.video || msg.video_note) { stats.files++; handleFile(chatId, msg); return; }

  if (!msg.text) return;
  const text = msg.text;

  // Ожидание телефона для авторизации MTProto
  if (waitingAuthPhone.has(chatId)) {
    waitingAuthPhone.delete(chatId);
    const phone = text.trim().replace(/[^+\d]/g, '');
    if (!phone || phone.length < 8) { send(chatId, '❌ Неверный номер. Формат: +77001234567'); return; }
    startMTProtoAuth(chatId, phone);
    return;
  }

  // Ожидание кода авторизации MTProto
  if (waitingAuthCode.has(chatId)) {
    waitingAuthCode.delete(chatId);
    if (msg.message_id) del(chatId, msg.message_id);
    const code = text.trim().replace(/[\s\-\.]/g, '');
    if (mtAuthResolvers.code) { mtAuthResolvers.code(code); mtAuthResolvers.code = null; }
    return;
  }

  // Ожидание пароля 2FA
  if (waitingAuthPassword.has(chatId)) {
    waitingAuthPassword.delete(chatId);
    if (msg.message_id) del(chatId, msg.message_id);
    if (mtAuthResolvers.password) { mtAuthResolvers.password(text); mtAuthResolvers.password = null; }
    return;
  }

  // === NotebookLM ввод ===
  if (waitingNbCreate.has(chatId)) {
    waitingNbCreate.delete(chatId);
    send(chatId, '➕ Создаю блокнот...');
    runNbCommand(chatId, `Создай новый блокнот NotebookLM с названием "${text}". Покажи название и ID созданного блокнота.`, (result) => {
      send(chatId, `📓 ${result}`, nbMainMenu);
    });
    return;
  }
  if (waitingNbQuery.has(chatId)) {
    const nbId = waitingNbQuery.get(chatId);
    waitingNbQuery.delete(chatId);
    send(chatId, '🔍 Ищу ответ...');
    runNbCommand(chatId, `Задай вопрос блокноту NotebookLM с ID "${nbId}": "${text}". Выведи ответ.`, (result) => {
      send(chatId, `💡 ${result}`, nbDetailMenu(nbId));
    });
    return;
  }
  if (waitingNbUrl.has(chatId)) {
    const nbId = waitingNbUrl.get(chatId);
    waitingNbUrl.delete(chatId);
    send(chatId, '🔗 Добавляю URL...');
    runNbCommand(chatId, `Добавь URL "${text}" как источник в блокнот NotebookLM с ID "${nbId}". Подтверди добавление.`, (result) => {
      send(chatId, `🔗 ${result}`, nbDetailMenu(nbId));
    });
    return;
  }
  if (waitingNbText.has(chatId)) {
    const nbId = waitingNbText.get(chatId);
    waitingNbText.delete(chatId);
    send(chatId, '📝 Добавляю текст...');
    runNbCommand(chatId, `Добавь следующий текст как источник в блокнот NotebookLM с ID "${nbId}": """${text}""". Подтверди добавление.`, (result) => {
      send(chatId, `📝 ${result}`, nbDetailMenu(nbId));
    });
    return;
  }
  if (waitingNbRename.has(chatId)) {
    const nbId = waitingNbRename.get(chatId);
    waitingNbRename.delete(chatId);
    runNbCommand(chatId, `Переименуй блокнот NotebookLM с ID "${nbId}" в "${text}". Подтверди.`, (result) => {
      send(chatId, `✏️ ${result}`, nbDetailMenu(nbId));
    });
    return;
  }
  if (waitingNbResearch.has(chatId)) {
    waitingNbResearch.delete(chatId);
    send(chatId, '🔍 Запускаю исследование...\n⏳ Это может занять до 30 секунд');
    runNbCommand(chatId, `Запусти быстрое исследование (research_start, mode="fast", source="web") по теме: "${text}". Создай новый блокнот для результатов. Покажи найденные источники и ID блокнота.`, (result) => {
      send(chatId, `🔍 Исследование\n\n${result}`, nbMainMenu);
    });
    return;
  }
  if (waitingNbReportCustom.has(chatId)) {
    const nbId = waitingNbReportCustom.get(chatId);
    waitingNbReportCustom.delete(chatId);
    send(chatId, '🎨 Генерирую отчёт...');
    runNbCommand(chatId, `Создай отчёт для блокнота "${nbId}" в формате "Create Your Own" с промптом: "${text}". language="ru", confirm=true. Выведи полный текст результата.`, (result) => {
      send(chatId, `🎨 Отчёт готов`, nbDetailMenu(nbId));
      send(chatId, result);
    });
    return;
  }

  // Умная настройка
  if (waitingSmartSetup.has(chatId)) {
    waitingSmartSetup.delete(chatId);
    processSmartSetup(chatId, text);
    return;
  }

  // Ожидание инструкции для канала
  if (waitingChannelPrompt.has(chatId)) {
    const idx = waitingChannelPrompt.get(chatId);
    waitingChannelPrompt.delete(chatId);
    if (text.toLowerCase() === 'clear') { config.channels[idx].prompt = ''; }
    else { config.channels[idx].prompt = text; }
    saveConfig();
    const status = config.channels[idx].prompt ? `установлена:\n${config.channels[idx].prompt}` : 'сброшена';
    send(chatId, `✅ Инструкция для @${config.channels[idx].username} ${status}`, channelsMenu());
    return;
  }

  // Ожидание добавления канала
  if (waitingChannelAdd.has(chatId)) {
    waitingChannelAdd.delete(chatId);
    let username = text.trim()
      .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
      .replace(/^@/, '')
      .replace(/\/$/, '')
      .split('/')[0];
    if (!username || username.length < 2) { send(chatId, '❌ Неверный формат. Используйте @username или ссылку.'); return; }
    addChannel(chatId, username);
    return;
  }

  // Ожидание ключевых слов
  if (waitingChannelKeywords.has(chatId)) {
    const idx = waitingChannelKeywords.get(chatId);
    waitingChannelKeywords.delete(chatId);
    if (text.toLowerCase() === 'clear') { config.channels[idx].keywords = []; }
    else { config.channels[idx].keywords = text.split(',').map(k => k.trim()).filter(k => k); }
    saveConfig();
    send(chatId, `✅ Ключевые слова для @${config.channels[idx].username}: ${config.channels[idx].keywords.length ? config.channels[idx].keywords.join(', ') : 'нет (все)'}`, channelsMenu());
    return;
  }

  // Ожидание системного промпта
  if (waitingSystemPrompt.has(chatId)) {
    waitingSystemPrompt.delete(chatId);
    config.systemPrompt = text;
    saveConfig();
    send(chatId, `✅ Системный промпт установлен:\n${text}`, mainMenu());
    return;
  }

  // Ожидание имени шаблона
  if (waitingTemplateName.has(chatId)) {
    waitingTemplateName.delete(chatId);
    waitingTemplatePrompt.set(chatId, text.trim());
    send(chatId, `📌 Имя: ${text.trim()}\n\nТеперь введите промпт для шаблона:`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'templates' }]] } });
    return;
  }
  if (waitingTemplatePrompt.has(chatId)) {
    const name = waitingTemplatePrompt.get(chatId);
    waitingTemplatePrompt.delete(chatId);
    if (!config.templates) config.templates = [];
    config.templates.push({ name, prompt: text });
    saveConfig();
    send(chatId, `✅ Шаблон "${name}" сохранён`, mainMenu());
    return;
  }

  // Ожидание пути
  if (waitingDir.has(chatId)) {
    waitingDir.delete(chatId);
    if (fs.existsSync(text)) { config.workDir = text; saveConfig(); send(chatId, `✅ Папка: ${text}`, mainMenu()); }
    else send(chatId, `❌ Не найдена: ${text}`);
    return;
  }

  if (text === '/start' || text === '/menu' || text === '📋 Меню') { send(chatId, '👋 Claude Code Remote', { ...mainMenu, ...persistentKeyboard }); return; }
  if (text === '/status' || text === '📊 Статус') { send(chatId, `📊 🤖 ${config.model} (${PROVIDER_LABELS[getProvider(config.model)] || ''}) | 📁 ${config.workDir} | ⏱ ${config.timeout}с | 🧠 AI: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}`, mainMenu()); return; }
  if (text === '/settings' || text === '⚙️ Настройки') { send(chatId, '⚙️ Настройки:', settingsMenu()); return; }
  if (text === '/stop' || text === '⛔ Стоп') { stopTask(chatId); send(chatId, '⛔ Остановлено'); return; }
  if (text === '/clear') { clearHistory(chatId); messageQueue.delete(chatId); send(chatId, '🗑 История и очередь очищены'); return; }
  if (text === '/help') { send(chatId, helpText()); return; }
  if (text === '/notebook' || text === '/nb' || text === '📓 NB') { send(chatId, '📓 NotebookLM', nbMainMenu); return; }

  if (text.startsWith('/bash ')) { runBash(chatId, text.slice(6)); return; }

  // /web — поиск в интернете через Claude
  if (text.startsWith('/web ')) {
    const query = text.slice(5).trim();
    if (!query) { send(chatId, '❌ Укажите запрос: /web что такое Telegram MTProto'); return; }
    runClaude(chatId, `Найди в интернете актуальную информацию по запросу: "${query}". Дай краткий структурированный ответ с источниками.`);
    return;
  }

  if (text.startsWith('/file ')) { sendDocument(chatId, text.slice(6).trim()); return; }

  // /save — сохранить шаблон
  if (text.startsWith('/save ')) {
    const parts = text.slice(6).trim().split(/\s+/);
    const name = parts[0];
    const prompt = parts.slice(1).join(' ');
    if (!name || !prompt) { send(chatId, '❌ Формат: /save имя промпт\nПример: /save review Сделай code review этого файла'); return; }
    if (!config.templates) config.templates = [];
    config.templates.push({ name, prompt });
    saveConfig();
    send(chatId, `✅ Шаблон "${name}" сохранён\nЗапуск: /t ${name}`);
    return;
  }

  // /t — запуск шаблона по имени
  if (text.startsWith('/t ')) {
    const name = text.slice(3).trim().toLowerCase();
    const tpl = (config.templates || []).find(t => t.name.toLowerCase() === name);
    if (tpl) { runClaude(chatId, tpl.prompt); }
    else { send(chatId, `❌ Шаблон "${name}" не найден. /templates — список`); }
    return;
  }
  if (text === '/templates') { send(chatId, '📌 Шаблоны', { reply_markup: { inline_keyboard: [...(config.templates || []).map((t, i) => [{ text: `📌 ${t.name}`, callback_data: `tpl_run_${i}` }, { text: '🗑', callback_data: `tpl_del_${i}` }]), [{ text: '➕ Создать', callback_data: 'tpl_create' }], [{ text: '◀️ Назад', callback_data: 'back' }]] } }); return; }

  // /remind — напоминание (персистентное)
  if (text.startsWith('/remind ')) {
    const match = text.slice(8).match(/^(\d+)\s*(м|m|мин|min|ч|h|час|с|s|сек)?\s+(.+)/i);
    if (!match) { send(chatId, '❌ Формат: /remind 30 мин Проверить сервер\n/remind 2 ч Созвон\n/remind 10 с Тест'); return; }
    let minutes = parseInt(match[1]);
    const unit = (match[2] || 'м').toLowerCase();
    if (unit.startsWith('ч') || unit === 'h') minutes *= 60;
    else if (unit.startsWith('с') || unit === 's') minutes = Math.max(1, Math.round(minutes / 60));
    const reminderText = match[3].trim();
    const id = nextReminderId++;
    const fireAt = Date.now() + minutes * 60000;
    if (!config.reminders) config.reminders = [];
    config.reminders.push({ id, chatId, text: reminderText, fireAt });
    saveConfig();
    const timerId = setTimeout(() => fireReminder(id), minutes * 60000);
    reminderTimers.set(id, timerId);
    send(chatId, `⏰ Напомню через ${minutes} мин (ID: ${id}):\n${reminderText}`);
    return;
  }
  if (text === '/reminders') {
    const active = (config.reminders || []).filter(r => r.chatId === chatId);
    if (active.length === 0) { send(chatId, '⏰ Нет активных напоминаний'); return; }
    const list = active.map((r, i) => {
      const left = Math.round((r.fireAt - Date.now()) / 60000);
      return `${i + 1}. [ID:${r.id}] ${r.text} (через ${left} мин)`;
    }).join('\n');
    send(chatId, `⏰ Напоминания:\n${list}\n\nОтмена: /cancelremind <ID>`);
    return;
  }
  // /cancelremind — отмена напоминания
  if (text.startsWith('/cancelremind ')) {
    const id = parseInt(text.slice(14).trim());
    if (!id) { send(chatId, '❌ Формат: /cancelremind <ID>'); return; }
    const idx = (config.reminders || []).findIndex(r => r.id === id && r.chatId === chatId);
    if (idx === -1) { send(chatId, `❌ Напоминание ID:${id} не найдено`); return; }
    const removed = config.reminders[idx];
    config.reminders.splice(idx, 1);
    saveConfig();
    const timerId = reminderTimers.get(id);
    if (timerId) { clearTimeout(timerId); reminderTimers.delete(id); }
    send(chatId, `✅ Напоминание отменено: ${removed.text}`);
    return;
  }

  // /export — экспорт диалога
  if (text === '/export') {
    const history = chatHistory.get(chatId);
    if (!history || history.length === 0) { send(chatId, '❌ История пуста'); return; }
    const content = history.map(m => `[${m.role === 'user' ? 'Вы' : 'Claude'}]\n${m.text}\n`).join('\n---\n\n');
    const filePath = path.join('/tmp', `chat_export_${Date.now()}.txt`);
    fs.writeFileSync(filePath, content);
    sendDocument(chatId, filePath, `Экспорт: ${history.length} сообщений`);
    return;
  }

  // /compare — сравнение моделей (мультипровайдер)
  if (text.startsWith('/compare ')) {
    const prompt = text.slice(9).trim();
    if (!prompt) { send(chatId, '❌ Формат: /compare Объясни квантовые вычисления'); return; }
    // Определяем модели для сравнения — по одной от каждого доступного провайдера
    const compareModels = ['claude-sonnet']; // Anthropic всегда доступен через CLI
    if (process.env.OPENAI_API_KEY) compareModels.push('gpt-4o');
    if (process.env.GEMINI_API_KEY) compareModels.push('gemini-2.5-flash');
    if (process.env.GROQ_API_KEY) compareModels.push('llama-70b');
    if (compareModels.length === 0) { send(chatId, '❌ Ни один API ключ не задан'); return; }
    send(chatId, `🔄 Сравниваю ${compareModels.length} моделей: ${compareModels.join(' vs ')}...`);
    let completed = 0;
    const total = compareModels.length;
    for (const m of compareModels) {
      callAI(m, [{ role: 'user', content: prompt }])
        .then(result => {
          completed++;
          const elapsed = (result.ms / 1000).toFixed(1);
          const answer = cleanMarkdown(result.text.trim()).slice(0, 1500) || 'Нет ответа';
          const label = PROVIDER_LABELS[result.provider] || result.provider;
          send(chatId, `${label} ${m} (${elapsed}с):\n\n${answer}`);
          if (completed === total) send(chatId, '✅ Сравнение завершено');
        })
        .catch(e => {
          completed++;
          send(chatId, `❌ ${m}: ${e.message}`);
          if (completed === total) send(chatId, '✅ Сравнение завершено');
        });
    }
    return;
  }

  // /pin — закрепить последний ответ
  if (text === '/pin') {
    const last = lastResponse.get(chatId);
    if (!last) { send(chatId, '❌ Нет ответа для закрепления'); return; }
    if (!config.pins) config.pins = [];
    config.pins.push({ text: last.text.slice(0, 500), prompt: last.prompt, date: Date.now() });
    if (config.pins.length > 20) config.pins.shift();
    saveConfig();
    send(chatId, `📌 Закреплено (${config.pins.length}/20)`);
    return;
  }
  if (text === '/pins') {
    if (!config.pins || config.pins.length === 0) { send(chatId, '📌 Нет закреплённых ответов. Используйте /pin'); return; }
    const list = config.pins.map((p, i) => `${i + 1}. ${p.text.slice(0, 80)}...`).join('\n');
    send(chatId, `📌 Закреплённые (${config.pins.length}):\n\n${list}\n\nИспользуйте /pinget <номер> для просмотра`);
    return;
  }
  if (text.startsWith('/pinget ')) {
    const idx = parseInt(text.slice(8)) - 1;
    const pin = (config.pins || [])[idx];
    if (!pin) { send(chatId, '❌ Не найдено'); return; }
    send(chatId, `📌 #${idx + 1}\n\n${pin.text}`);
    return;
  }

  // /stats — статистика
  if (text === '/stats') {
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const avgTime = stats.claudeCalls > 0 ? (stats.totalResponseTime / stats.claudeCalls / 1000).toFixed(1) : 0;
    send(chatId, `📈 Статистика\n\n⏱ Аптайм: ${uptime} мин\n📨 Сообщений: ${stats.messages}\n🤖 Claude вызовов: ${stats.claudeCalls}\n⚡ Ср. время: ${avgTime}с\n🎙 Голосовых: ${stats.voiceMessages}\n📎 Файлов: ${stats.files}\n❌ Ошибок: ${stats.errors}\n🧠 AI: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}\n🤖 Модель: ${config.model}`);
    return;
  }

  if (text.startsWith('/system ')) {
    config.systemPrompt = text.slice(8).trim();
    saveConfig();
    send(chatId, `✅ Системный промпт: ${config.systemPrompt}`);
    return;
  }
  if (text === '/clear_system') { config.systemPrompt = ''; saveConfig(); send(chatId, '✅ Системный промпт сброшен'); return; }

  if (text.startsWith('/parse ')) { processSmartSetup(chatId, text.slice(7)); return; }
  if (text === '/parse') { send(chatId, '🧠 Опишите что парсить. Например:\n/parse Следи за @durov, присылай только анонсы обновлений кратко'); return; }

  if (text === '/channels') {
    const count = config.channels ? config.channels.length : 0;
    const active = config.channels ? config.channels.filter(c => c.enabled).length : 0;
    send(chatId, `📡 Мониторинг каналов\n\nВсего: ${count} | Активных: ${active}`, channelsMenu());
    return;
  }

  if (text === '/auth') {
    if (mtConnected) { send(chatId, `✅ MTProto уже авторизован!`, mainMenu()); }
    else if (!apiId || !apiHash) { send(chatId, '❌ TG_API_ID и TG_API_HASH не заданы в .env'); }
    else { send(chatId, '📱 Введите номер телефона (формат +77001234567):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'auth_cancel' }]] } }); waitingAuthPhone.add(chatId); }
    return;
  }

  if (text.startsWith('/addch ')) {
    let username = text.slice(7).trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/\/$/, '').split('/')[0];
    if (!username || username.length < 2) { send(chatId, '❌ Используйте: /addch username'); return; }
    addChannel(chatId, username);
    return;
  }

  if (text === '/git') { runGit(chatId); return; }
  if (text === '/ps') { runPs(chatId); return; }
  if (text === '/queue') {
    const qLen = getQueueSize(chatId);
    send(chatId, `📬 Очередь: ${qLen} сообщений\n🔄 AI: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}`);
    return;
  }

  if (text.startsWith('/')) return;

  // Если Claude занят для этого чата — в очередь
  if (activeTasks.has(chatId)) {
    enqueue(chatId, { text, type: 'text' });
    send(chatId, `📬 В очереди (${getQueueSize(chatId)}). Будет выполнено после текущей задачи.`);
    return;
  }

  runClaude(chatId, text);
}

// Long polling — эффективнее и надёжнее
async function tick() {
  while (!stopPolling) {
    try {
      const data = await tgApi('getUpdates', { offset, timeout: 30 });
      if (!data.ok || !data.result) continue;
      for (const upd of data.result) {
        offset = upd.update_id + 1;
        processUpdate(upd).catch(e => console.error('UPD ERR:', e.message));
      }
    } catch (e) {
      console.error('Polling error:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// === Автоочистка waiting states (каждые 5 минут) ===
const WAITING_TIMEOUT = 5 * 60 * 1000;
const waitingTimers = new Map();

function setWaitingTimeout(chatId, waitingSet) {
  const key = `${chatId}_${waitingSet.constructor.name}`;
  if (waitingTimers.has(key)) clearTimeout(waitingTimers.get(key));
  waitingTimers.set(key, setTimeout(() => {
    if (waitingSet instanceof Set) waitingSet.delete(chatId);
    else if (waitingSet instanceof Map) waitingSet.delete(chatId);
    waitingTimers.delete(key);
  }, WAITING_TIMEOUT));
}

// === Graceful shutdown ===
function gracefulShutdown(signal) {
  console.log(`\n🛑 ${signal} — завершаю...`);
  stopPolling = true;

  // Останавливаем все активные задачи
  for (const [chatId, task] of activeTasks) {
    if (task.timer) clearInterval(task.timer);
    if (task.pid) { try { process.kill(task.pid); } catch(e) {} }
    if (task.abort) { try { task.abort.abort(); } catch(e) {} }
  }
  activeTasks.clear();

  // Отключаем MTProto
  if (mtClient) {
    mtClient.disconnect().catch(() => {});
  }

  // Удаляем PID файл
  try { fs.unlinkSync(PID_FILE); } catch(e) {}

  console.log('👋 Бот остановлен');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log('🤖 Multi-Model AI Telegram Bot');
console.log(`🔧 ${config.model} (${getProvider(config.model)}) | ${config.workDir} | ${config.timeout}с`);
const availableProviders = ['Anthropic (CLI)'];
if (process.env.OPENAI_API_KEY) availableProviders.push('OpenAI');
if (process.env.GEMINI_API_KEY) availableProviders.push('Google');
if (process.env.GROQ_API_KEY) availableProviders.push('Groq');
console.log(`🌐 Провайдеры: ${availableProviders.length > 0 ? availableProviders.join(', ') : '⚠️ ни одного API ключа!'}`);

// Запуск MTProto и мониторинга
initMTProto().then(() => {
  startMonitoring();
}).catch(e => {
  console.error('MTProto init failed:', e.message);
  startMonitoring();
});

// Регистрируем команды бота
tgApi('setMyCommands', { commands: [
  { command: 'menu', description: 'Главное меню' },
  { command: 'status', description: 'Статус бота' },
  { command: 'settings', description: 'Настройки' },
  { command: 'stop', description: 'Остановить задачу' },
  { command: 'clear', description: 'Очистить историю' },
  { command: 'help', description: 'Помощь' },
  { command: 'nb', description: 'NotebookLM' },
]});

tick();
