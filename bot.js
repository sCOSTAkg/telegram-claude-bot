require('dotenv').config();
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminIds = (process.env.ALLOWED_USER_IDS || '').split(',').map(Number).filter(Boolean);
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

async function callAnthropic(modelId, messages, systemPrompt, allowMcp = true) {
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
    if (allowMcp && fs.existsSync(mcpSettingsPath)) args.push('--mcp-config', mcpSettingsPath);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: process.env.WORKING_DIR || '/Users/guest1', env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

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

async function callAI(model, messages, systemPrompt, allowMcp = true) {
  const start = Date.now();
  const provider = getProvider(model);
  const modelId = MODEL_MAP[model] || model;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropic(modelId, messages, systemPrompt, allowMcp); break;
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

async function callAnthropicStream(modelId, messages, systemPrompt, onChunk, allowMcp = true) {
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
    if (allowMcp && fs.existsSync(mcpSettingsPath)) args.push('--mcp-config', mcpSettingsPath);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: process.env.WORKING_DIR || '/Users/guest1', env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

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

async function callAIStream(model, messages, systemPrompt, onChunk, allowMcp = true) {
  const start = Date.now();
  const provider = getProvider(model);
  const modelId = MODEL_MAP[model] || model;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropicStream(modelId, messages, systemPrompt, onChunk, allowMcp); break;
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
// Глобальный конфиг (API ключи, MTProto, polling — общие для всех)
const defaultGlobalConfig = { mtprotoSession: '', channels: [], monitorInterval: 60, reminders: [] };
let config = { ...defaultGlobalConfig };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...defaultGlobalConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch (e) {}
}
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

// Per-user конфиг (настройки, шаблоны, режимы — у каждого свои)
const USER_CONFIGS_PATH = path.join(__dirname, 'users.json');
const defaultUserConfig = { model: 'gemini-3.1-pro', workDir: '/tmp', timeout: 300, historySize: 20, systemPrompt: '', skills: [], pins: [], autoModel: false, streaming: true, agentMode: true, agentMaxSteps: 10, multiAgent: true, role: 'user', banned: false };
const userConfigs = new Map(); // chatId -> config

const SKILL_CATEGORIES = [
  { id: 'code', label: '💻 Код' },
  { id: 'text', label: '✍️ Текст' },
  { id: 'analysis', label: '🔍 Анализ' },
  { id: 'other', label: '📦 Другое' },
];

const PRESET_SKILLS = [
  { name: 'review', description: 'Code Review', category: 'code', prompt: 'Проведи code review этого кода. Оцени: структуру, читаемость, баги, производительность, безопасность. Предложи улучшения.' },
  { name: 'summary', description: 'Краткое резюме', category: 'text', prompt: 'Дай краткое резюме в 3-5 пунктов. Выдели главные идеи и выводы.' },
  { name: 'refactor', description: 'Рефакторинг кода', category: 'code', prompt: 'Выполни рефакторинг этого кода. Улучши структуру, убери дублирование. Покажи результат.' },
  { name: 'translate', description: 'Перевод текста', category: 'text', prompt: 'Переведи текст на русский (если на иностранном) или на английский (если на русском). Сохрани стиль и тон.' },
  { name: 'explain', description: 'Объяснение', category: 'analysis', prompt: 'Объясни это простым языком. Разбери по шагам, приведи примеры.' },
  { name: 'debug', description: 'Поиск багов', category: 'code', prompt: 'Найди баги и проблемы в этом коде. Объясни каждую проблему и как её исправить.' },
];

// === Мульти-агентная система ===
const AGENT_ROLES = {
  orchestrator: { icon: '🎯', label: 'Оркестратор', desc: 'Координирует субагентов, декомпозирует задачи' },
  coder: { icon: '💻', label: 'Кодер', desc: 'Пишет и модифицирует код' },
  researcher: { icon: '🔍', label: 'Аналитик', desc: 'Исследует, анализирует, ищет информацию' },
  reviewer: { icon: '🔎', label: 'Ревьюер', desc: 'Проверяет качество, находит ошибки' },
  writer: { icon: '✍️', label: 'Писатель', desc: 'Создаёт тексты, документацию' },
  executor: { icon: '⚡', label: 'Исполнитель', desc: 'Выполняет bash-команды и системные действия' },
};

const SUB_AGENT_PROMPT_TEMPLATE = (role, task, context) => {
  const roleInfo = AGENT_ROLES[role] || AGENT_ROLES.executor;
  return `Ты — ${roleInfo.label} (${roleInfo.desc}) в мульти-агентной системе.

ТВОЯ РОЛЬ: ${roleInfo.icon} ${roleInfo.label}
ЗАДАЧА: ${task}
${context ? `\nКОНТЕКСТ ОТ ОРКЕСТРАТОРА:\n${context}` : ''}

ПРАВИЛА:
- Выполняй ТОЛЬКО свою задачу, не отвлекайся
- Будь конкретным и структурированным
- Если нужно выполнить действие, используй формат [ACTION: тип]...[/ACTION]
- В конце дай чёткий результат, начиная с [RESULT]
- Если не можешь выполнить — объясни почему, начиная с [ERROR]
- Отвечай кратко и по делу`;
};

// Трекер состояния мульти-агентных задач
const multiAgentTasks = new Map(); // chatId -> { orchestratorMsgId, agents: [...], log: [...], startTime }

function loadUserConfigs() {
  if (!fs.existsSync(USER_CONFIGS_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(USER_CONFIGS_PATH, 'utf8'));
    for (const [id, cfg] of Object.entries(data)) {
      userConfigs.set(Number(id), { ...defaultUserConfig, ...cfg });
    }
  } catch (e) {}
}
loadUserConfigs();

// Миграция templates → skills
for (const [id, cfg] of userConfigs) {
  if (cfg.templates && cfg.templates.length > 0 && (!cfg.skills || cfg.skills.length === 0)) {
    cfg.skills = cfg.templates;
  }
  delete cfg.templates;
  // Миграция навыков: добавляем новые поля если отсутствуют
  if (cfg.skills && cfg.skills.length > 0) {
    for (const skill of cfg.skills) {
      if (skill.description === undefined) skill.description = '';
      if (skill.category === undefined) skill.category = 'other';
      if (skill.uses === undefined) skill.uses = 0;
      if (skill.lastUsed === undefined) skill.lastUsed = null;
    }
  }
}
saveUserConfigs();

function saveUserConfigs() {
  const obj = {};
  for (const [id, cfg] of userConfigs) obj[id] = cfg;
  fs.writeFileSync(USER_CONFIGS_PATH, JSON.stringify(obj, null, 2));
}

function getUserConfig(chatId) {
  if (!userConfigs.has(chatId)) {
    // Админы получают полный доступ и домашнюю директорию
    const isAdmin = adminIds.includes(chatId);
    userConfigs.set(chatId, { ...defaultUserConfig, role: isAdmin ? 'admin' : 'user', workDir: isAdmin ? (process.env.WORKING_DIR || '/Users/guest1') : '/tmp' });
    saveUserConfigs();
  }
  return userConfigs.get(chatId);
}

function saveUserConfig(chatId) {
  saveUserConfigs();
}

function isAdmin(chatId) {
  return getUserConfig(chatId).role === 'admin';
}

// Миграция из старого конфига (если есть per-user поля в глобальном)
if (config.model || config.workDir || config.systemPrompt !== undefined) {
  // Перенести старые настройки первому админу
  const firstAdmin = adminIds[0];
  if (firstAdmin && !userConfigs.has(firstAdmin)) {
    const migrated = { ...defaultUserConfig, role: 'admin' };
    if (config.model) migrated.model = config.model;
    if (config.workDir) migrated.workDir = config.workDir;
    if (config.timeout) migrated.timeout = config.timeout;
    if (config.historySize) migrated.historySize = config.historySize;
    if (config.systemPrompt) migrated.systemPrompt = config.systemPrompt;
    if (config.templates?.length) migrated.skills = config.templates;
    if (config.pins?.length) migrated.pins = config.pins;
    if (config.autoModel !== undefined) migrated.autoModel = config.autoModel;
    if (config.streaming !== undefined) migrated.streaming = config.streaming;
    if (config.agentMode !== undefined) migrated.agentMode = config.agentMode;
    if (config.agentMaxSteps) migrated.agentMaxSteps = config.agentMaxSteps;
    userConfigs.set(firstAdmin, migrated);
    saveUserConfigs();
  }
  // Очистить per-user поля из глобального конфига
  delete config.model; delete config.workDir; delete config.timeout;
  delete config.historySize; delete config.systemPrompt; delete config.templates;
  delete config.pins; delete config.autoModel; delete config.streaming;
  delete config.agentMode; delete config.agentMaxSteps;
  saveConfig();
}

// === История диалогов ===
const chatHistory = new Map(); // chatId -> [{role, text}]

function addToHistory(chatId, role, text) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);
  const trimmed = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
  history.push({ role, text: trimmed });
  const uc = getUserConfig(chatId);
  while (history.length > (uc.historySize || 20)) history.shift();
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
  const resolved = path.resolve(getUserConfig(chatId).workDir, filePath);
  if (!fs.existsSync(resolved)) { send(chatId, `❌ Файл не найден: ${resolved}`); return; }
  const res = await tgUpload('sendDocument', chatId, 'document', resolved, caption);
  if (!res.ok) send(chatId, `❌ Ошибка отправки файла`);
}

async function sendPhoto(chatId, filePath, caption = '') {
  const resolved = path.resolve(getUserConfig(chatId).workDir, filePath);
  if (!fs.existsSync(resolved)) { await sendDocument(chatId, filePath, caption); return; }
  const res = await tgUpload('sendPhoto', chatId, 'photo', resolved, caption);
  if (!res.ok) await sendDocument(chatId, filePath, caption);
}

async function sendVideo(chatId, filePath, caption = '') {
  const resolved = path.resolve(getUserConfig(chatId).workDir, filePath);
  if (!fs.existsSync(resolved)) { await sendDocument(chatId, filePath, caption); return; }
  const res = await tgUpload('sendVideo', chatId, 'video', resolved, caption);
  if (!res.ok) await sendDocument(chatId, filePath, caption);
}

async function sendAudio(chatId, filePath, caption = '') {
  const resolved = path.resolve(getUserConfig(chatId).workDir, filePath);
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

function mainMenu(chatId) { const uc = chatId ? getUserConfig(chatId) : defaultUserConfig; const admin = chatId ? isAdmin(chatId) : false; const rows = [
  [{ text: '⚙️ Настройки', callback_data: 'settings' }, { text: '📊 Статус', callback_data: 'status' }],
]; if (admin) rows.push([{ text: '📡 Каналы', callback_data: 'channels' }]); rows.push(
  [{ text: '📓 NotebookLM', callback_data: 'nb_menu' }, { text: '🔗 Интеграции', callback_data: 'integrations' }],
  [{ text: '⚡ Навыки', callback_data: 'skills_menu' }, ...(admin ? [{ text: '📈 Статистика', callback_data: 'stats' }] : [])],
  [{ text: `🤖 Агент: ${uc.agentMode !== false ? '✅' : '❌'}`, callback_data: 'toggle_agent' }, { text: '❓ Помощь', callback_data: 'help' }],
  [{ text: '🗑 Очистить историю', callback_data: 'clear' }],
); if (admin) rows.push([{ text: '👥 Пользователи', callback_data: 'users_panel' }]); return { reply_markup: { inline_keyboard: rows }}; }


function settingsMenu(chatId) { const uc = chatId ? getUserConfig(chatId) : defaultUserConfig; const admin = chatId ? isAdmin(chatId) : false; const rows = [
  [{ text: `🤖 Модель: ${uc.model}`, callback_data: 'set_model' }],
]; if (admin) rows.push([{ text: `📁 ${uc.workDir}`, callback_data: 'set_dir' }]); rows.push(
  [{ text: `⏱ Таймаут: ${uc.timeout}с`, callback_data: 'set_timeout' }],
  [{ text: `💬 Системный промпт: ${uc.systemPrompt ? '✅' : '❌'}`, callback_data: 'set_system' }],
  [{ text: `🧠 Авто-модель: ${uc.autoModel ? '✅' : '❌'}`, callback_data: 'toggle_auto' }],
  [{ text: `📡 Стриминг: ${uc.streaming ? '✅' : '❌'}`, callback_data: 'toggle_stream' }],
  [{ text: `👥 Мульти-агент: ${uc.multiAgent !== false ? '✅' : '❌'}`, callback_data: 'toggle_multi' }],
  [{ text: `🔢 Макс шагов: ${uc.agentMaxSteps || 10}`, callback_data: 'set_max_steps' }],
  [{ text: '◀️ Назад', callback_data: 'back' }],
); return { reply_markup: { inline_keyboard: rows }}; }

function modelMenu() { return { reply_markup: { inline_keyboard: [
  [{ text: '🟣 Anthropic (Claude)', callback_data: 'modelgrp_anthropic' }, { text: '🟢 OpenAI (GPT)', callback_data: 'modelgrp_openai' }],
  [{ text: '🔵 Google (Gemini)', callback_data: 'modelgrp_google' }, { text: '⚡ Groq (Fast)', callback_data: 'modelgrp_groq' }],
  [{ text: '◀️ Назад', callback_data: 'settings' }]
]}}; }

function modelProviderMenu(provider, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const models = PROVIDER_MODELS[provider] || [];
  return { reply_markup: { inline_keyboard: [
    ...models.map(m => [{ text: (m.id === uc.model ? '✅ ' : '') + m.label, callback_data: `model_${m.id}` }]),
    [{ text: '◀️ Назад к провайдерам', callback_data: 'set_model' }]
  ]}};
}

function timeoutMenu(chatId) { const uc = chatId ? getUserConfig(chatId) : defaultUserConfig; return { reply_markup: { inline_keyboard: [
  ...[120, 300, 600].map(t => [{ text: (t === uc.timeout ? '✅ ' : '') + t + 'с', callback_data: `timeout_${t}` }]),
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
let waitingSkillName = new Set(); // chatId -> ожидание имени навыка
let waitingSkillPrompt = new Map(); // chatId -> skillName or {name, category}
let waitingSkillEditName = new Map(); // chatId -> skill index
let waitingSkillEditPrompt = new Map(); // chatId -> skill index
let waitingSkillEditDesc = new Map(); // chatId -> skill index
let waitingSkillCategory = new Map(); // chatId -> skillName (for wizard)
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

  const adminModel = adminIds[0] ? getUserConfig(adminIds[0]).model : 'gemini-2.5-flash';
  callAI(adminModel, [{ role: 'user', content: input }])
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
    const uc = getUserConfig(chatId);
    const result = await callAI(uc.model, [{ role: 'user', content: input }]);
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
        for (const uid of adminIds) {
          send(uid, `📡 @${username} #${post.id}\n\n${processed}\n\n🔗 https://t.me/${username}/${post.id}`);
        }
        console.log(`📡 RT+AI @${username}: пост #${msg.id}`);
      });
    } else {
      // Без инструкции — отправляем как есть
      for (const uid of adminIds) {
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
          for (const uid of adminIds) {
            send(uid, `📡 @${ch.username} #${post.id}\n\n${processed}\n\n🔗 https://t.me/${ch.username}/${post.id}`);
          }
        });
      } else {
        for (const uid of adminIds) { send(uid, formatPost(ch.username, post)); }
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
    for (const uid of adminIds) {
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
  const uc = getUserConfig(chatId);

  // Гейтинг: admin-only callbacks
  const adminOnlyCallbacks = ['channels', 'ch_add', 'ch_interval', 'ch_smart', 'ch_mtproto', 'set_dir', 'stats', 'users_panel'];
  const isAdminOnly = adminOnlyCallbacks.includes(data) || data.startsWith('ch_') || data.startsWith('user_');
  if (isAdminOnly && !isAdmin(chatId)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Только для администраторов', show_alert: true });
    return;
  }

  if (data === 'settings') editText(chatId, msgId, '⚙️ Настройки:', settingsMenu(chatId));
  else if (data === 'status') {
    const busy = activeTasks.has(chatId);
    const histLen = (chatHistory.get(chatId) || []).length;
    const queueLen = getQueueSize(chatId);
    const sysPrompt = uc.systemPrompt ? `\n💬 Системный промпт: ${uc.systemPrompt.slice(0, 50)}${uc.systemPrompt.length > 50 ? '...' : ''}` : '';
    editText(chatId, msgId, `📊 Статус\n\n🤖 Модель: ${uc.model}\n📁 Папка: ${uc.workDir}\n⏱ Таймаут: ${uc.timeout}с\n🔄 Задача: ${busy ? 'Да' : 'Нет'}\n📬 Очередь: ${queueLen}\n💬 История: ${histLen} сообщений${sysPrompt}`, mainMenu(chatId));
  }
  else if (data === 'clear') { stopTask(chatId); clearHistory(chatId); messageQueue.delete(chatId); editText(chatId, msgId, '🗑 История, очередь и задачи очищены', mainMenu(chatId)); }
  else if (data === 'help') editText(chatId, msgId, helpText(), mainMenu(chatId));
  else if (data === 'set_model') editText(chatId, msgId, `🤖 Текущая модель: ${uc.model}\n\nВыберите провайдер:`, modelMenu());
  else if (data.startsWith('modelgrp_')) {
    const provider = data.slice(9);
    const label = PROVIDER_LABELS[provider] || provider;
    editText(chatId, msgId, `${label} — выберите модель:`, modelProviderMenu(provider, chatId));
  }
  else if (data.startsWith('model_')) { uc.model = data.slice(6); saveUserConfig(chatId); editText(chatId, msgId, `✅ Модель: ${uc.model} (${PROVIDER_LABELS[getProvider(uc.model)] || ''})`, settingsMenu(chatId)); }
  else if (data === 'set_timeout') editText(chatId, msgId, '⏱ Таймаут:', timeoutMenu(chatId));
  else if (data.startsWith('timeout_')) { uc.timeout = parseInt(data.slice(8)); saveUserConfig(chatId); editText(chatId, msgId, `✅ Таймаут: ${uc.timeout}с`, settingsMenu(chatId)); }
  else if (data === 'set_dir') { editText(chatId, msgId, `📁 Папка: ${uc.workDir}\n\nОтправьте путь:`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'settings' }]] } }); waitingDir.add(chatId); }
  else if (data === 'set_system') {
    const current = uc.systemPrompt ? `Текущий: ${uc.systemPrompt}` : 'Не задан';
    editText(chatId, msgId, `💬 Системный промпт\n\n${current}\n\nОтправьте новый промпт или /clear_system для сброса:`, { reply_markup: { inline_keyboard: [
      [{ text: '🗑 Сбросить', callback_data: 'clear_system' }],
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
    waitingSystemPrompt.add(chatId);
  }
  else if (data === 'clear_system') { uc.systemPrompt = ''; saveUserConfig(chatId); editText(chatId, msgId, '✅ Системный промпт сброшен', settingsMenu(chatId)); waitingSystemPrompt.delete(chatId); }
  else if (data === 'toggle_auto') { uc.autoModel = !uc.autoModel; saveUserConfig(chatId); editText(chatId, msgId, `🧠 Авто-модель: ${uc.autoModel ? '✅ Включена' : '❌ Выключена'}`, settingsMenu(chatId)); }
  else if (data === 'toggle_stream') { uc.streaming = !uc.streaming; saveUserConfig(chatId); editText(chatId, msgId, `📡 Стриминг: ${uc.streaming ? '✅ Включён — текст появляется порциями' : '❌ Выключен — ожидание полного ответа'}`, settingsMenu(chatId)); }
  else if (data === 'toggle_agent') { uc.agentMode = uc.agentMode === false ? true : false; saveUserConfig(chatId); editText(chatId, msgId, `🤖 Агент-режим: ${uc.agentMode ? '✅ Включён — бот сам выполняет действия' : '❌ Выключен — только текстовые ответы'}`, mainMenu(chatId)); }
  else if (data === 'toggle_multi') { uc.multiAgent = uc.multiAgent === false ? true : false; saveUserConfig(chatId); editText(chatId, msgId, `👥 Мульти-агент: ${uc.multiAgent !== false ? '✅ Включён — агент создаёт субагентов для сложных задач' : '❌ Выключен — один агент'}`, settingsMenu(chatId)); }
  else if (data === 'set_max_steps') {
    editText(chatId, msgId, `🔢 Максимум шагов агента (сейчас: ${uc.agentMaxSteps || 10}):`, { reply_markup: { inline_keyboard: [
      ...[5, 10, 15, 20].map(n => [{ text: (n === (uc.agentMaxSteps || 10) ? '✅ ' : '') + n, callback_data: `maxsteps_${n}` }]),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
  }
  else if (data.startsWith('maxsteps_')) { uc.agentMaxSteps = parseInt(data.slice(9)); saveUserConfig(chatId); editText(chatId, msgId, `✅ Макс шагов: ${uc.agentMaxSteps}`, settingsMenu(chatId)); }
  else if (data === 'set_lang') editText(chatId, msgId, '🌐 Язык ответов Claude:', langMenu());
  else if (data === 'lang_ru') { uc.systemPrompt = 'Всегда отвечай на русском языке.'; saveUserConfig(chatId); editText(chatId, msgId, '✅ Язык: Русский', mainMenu(chatId)); }
  else if (data === 'lang_en') { uc.systemPrompt = 'Always respond in English.'; saveUserConfig(chatId); editText(chatId, msgId, '✅ Language: English', mainMenu(chatId)); }
  else if (data === 'lang_clear') { uc.systemPrompt = ''; saveUserConfig(chatId); editText(chatId, msgId, '✅ Языковая настройка сброшена', mainMenu(chatId)); }
  else if (data === 'back') editText(chatId, msgId, '👋 Claude Code Remote', mainMenu(chatId));

  // === Навыки ===
  else if (data === 'noop') {
    // Пустой обработчик для разделителей/счётчиков
    tgApi('answerCallbackQuery', { callback_query_id: cb.id });
  }
  else if (data === 'skills_menu' || data.startsWith('skills_page_')) {
    const skills = uc.skills || [];
    const page = data.startsWith('skills_page_') ? parseInt(data.slice(12)) : 0;
    const PAGE_SIZE = 5;
    if (skills.length === 0) {
      editText(chatId, msgId, '⚡ Навыки пусты\n\nСохраняйте часто используемые промпты:\n/skill <имя> <промпт>\n\nПримеры:\n• /skill review Сделай code review\n• /skill summary Дай краткое резюме\n\nИли отправьте .txt файл при создании', { reply_markup: { inline_keyboard: [
        [{ text: '➕ Создать навык', callback_data: 'skill_create' }],
        [{ text: '📦 Галерея пресетов', callback_data: 'skill_presets' }],
        [{ text: '◀️ Назад', callback_data: 'back' }]
      ] } });
    } else {
      // Группировка по категориям
      const grouped = {};
      skills.forEach((s, i) => {
        const cat = s.category || 'other';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push({ ...s, _idx: i });
      });
      const allItems = [];
      for (const cat of SKILL_CATEGORIES) {
        if (grouped[cat.id] && grouped[cat.id].length > 0) {
          allItems.push({ type: 'separator', label: cat.label });
          allItems.push(...grouped[cat.id].map(s => ({ type: 'skill', ...s })));
        }
      }
      const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
      const pageItems = allItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const rows = [];
      for (const item of pageItems) {
        if (item.type === 'separator') {
          rows.push([{ text: `── ${item.label} ──`, callback_data: 'noop' }]);
        } else {
          const useBadge = item.uses > 0 ? ` (${item.uses})` : '';
          rows.push([
            { text: `⚡ ${item.name}${useBadge}`, callback_data: `skill_run_${item._idx}` },
            { text: 'ℹ️', callback_data: `skill_info_${item._idx}` },
            { text: '🗑', callback_data: `skill_del_${item._idx}` },
          ]);
        }
      }
      // Пагинация
      if (totalPages > 1) {
        const nav = [];
        if (page > 0) nav.push({ text: '◀️', callback_data: `skills_page_${page - 1}` });
        nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
        if (page < totalPages - 1) nav.push({ text: '▶️', callback_data: `skills_page_${page + 1}` });
        rows.push(nav);
      }
      rows.push([{ text: '➕ Создать', callback_data: 'skill_create' }, { text: '📦 Галерея пресетов', callback_data: 'skill_presets' }]);
      rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
      editText(chatId, msgId, `⚡ Навыки (${skills.length}):`, { reply_markup: { inline_keyboard: rows } });
    }
  }
  else if (data === 'skill_create') {
    editText(chatId, msgId, '⚡ Введите имя навыка:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'skills_menu' }]] } });
    waitingSkillName.add(chatId);
  }
  else if (data.startsWith('skill_run_')) {
    const idx = parseInt(data.slice(10));
    const skill = (uc.skills || [])[idx];
    if (skill) {
      skill.uses = (skill.uses || 0) + 1;
      skill.lastUsed = Date.now();
      saveUserConfig(chatId);
      editText(chatId, msgId, `⚡ Запускаю: ${skill.name}`);
      runClaude(chatId, skill.prompt);
    }
  }
  else if (data.startsWith('skill_info_')) {
    const idx = parseInt(data.slice(11));
    const skill = (uc.skills || [])[idx];
    if (skill) {
      const catLabel = (SKILL_CATEGORIES.find(c => c.id === skill.category) || {}).label || '📦 Другое';
      const lastUsedStr = skill.lastUsed ? new Date(skill.lastUsed).toLocaleString('ru-RU') : 'никогда';
      const promptPreview = skill.prompt.length > 300 ? skill.prompt.slice(0, 300) + '...' : skill.prompt;
      const desc = skill.description ? `\n📝 ${skill.description}` : '';
      editText(chatId, msgId,
        `⚡ ${skill.name}${desc}\n\n📂 Категория: ${catLabel}\n📊 Использований: ${skill.uses || 0}\n🕐 Последний запуск: ${lastUsedStr}\n\n📄 Промпт:\n${promptPreview}`,
        { reply_markup: { inline_keyboard: [
          [{ text: '▶️ Запуск', callback_data: `skill_run_${idx}` }, { text: '✏️ Редактировать', callback_data: `skill_edit_${idx}` }],
          [{ text: '🗑 Удалить', callback_data: `skill_del_${idx}` }, { text: '◀️ Назад', callback_data: 'skills_menu' }],
        ] } }
      );
    }
  }
  else if (data.startsWith('skill_edit_')) {
    const idx = parseInt(data.slice(11));
    const skill = (uc.skills || [])[idx];
    if (skill) {
      editText(chatId, msgId, `✏️ Редактирование: ${skill.name}\n\nВыберите что изменить:`, { reply_markup: { inline_keyboard: [
        [{ text: '📝 Имя', callback_data: `skedit_name_${idx}` }, { text: '📄 Промпт', callback_data: `skedit_prompt_${idx}` }],
        [{ text: '📝 Описание', callback_data: `skedit_desc_${idx}` }, { text: '📂 Категория', callback_data: `skedit_cat_${idx}` }],
        [{ text: '◀️ Назад', callback_data: `skill_info_${idx}` }],
      ] } });
    }
  }
  else if (data.startsWith('skedit_name_')) {
    const idx = parseInt(data.slice(12));
    waitingSkillEditName.set(chatId, idx);
    editText(chatId, msgId, '📝 Введите новое имя навыка:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]] } });
  }
  else if (data.startsWith('skedit_prompt_')) {
    const idx = parseInt(data.slice(14));
    waitingSkillEditPrompt.set(chatId, idx);
    editText(chatId, msgId, '📄 Введите новый промпт (или отправьте .txt файл):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]] } });
  }
  else if (data.startsWith('skedit_desc_')) {
    const idx = parseInt(data.slice(12));
    waitingSkillEditDesc.set(chatId, idx);
    editText(chatId, msgId, '📝 Введите описание навыка:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]] } });
  }
  else if (data.startsWith('skedit_cat_')) {
    const idx = parseInt(data.slice(11));
    const rows = SKILL_CATEGORIES.map(c => [{ text: c.label, callback_data: `skcat_${idx}_${c.id}` }]);
    rows.push([{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]);
    editText(chatId, msgId, '📂 Выберите категорию:', { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('skcat_')) {
    const parts = data.slice(6).split('_');
    const idx = parseInt(parts[0]);
    const catId = parts.slice(1).join('_');
    const skill = (uc.skills || [])[idx];
    if (skill) {
      skill.category = catId;
      saveUserConfig(chatId);
      const catLabel = (SKILL_CATEGORIES.find(c => c.id === catId) || {}).label || catId;
      editText(chatId, msgId, `✅ Категория "${skill.name}" → ${catLabel}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыку', callback_data: `skill_info_${idx}` }]] } });
    }
  }
  else if (data.startsWith('skill_del_')) {
    const idx = parseInt(data.slice(10));
    if (uc.skills && uc.skills[idx]) {
      const name = uc.skills[idx].name;
      uc.skills.splice(idx, 1);
      saveUserConfig(chatId);
      editText(chatId, msgId, `🗑 Навык "${name}" удалён`, mainMenu(chatId));
    }
  }
  // === Галерея пресетов ===
  else if (data === 'skill_presets') {
    const rows = PRESET_SKILLS.map((p, i) => {
      const catLabel = (SKILL_CATEGORIES.find(c => c.id === p.category) || {}).label || '📦';
      return [{ text: `${catLabel} ${p.name} — ${p.description}`, callback_data: `add_preset_${i}` }];
    });
    rows.push([{ text: '◀️ Назад', callback_data: 'skills_menu' }]);
    editText(chatId, msgId, '📦 Галерея пресетов\n\nВыберите навык для добавления:', { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('add_preset_')) {
    const idx = parseInt(data.slice(11));
    const preset = PRESET_SKILLS[idx];
    if (preset) {
      if (!uc.skills) uc.skills = [];
      const exists = uc.skills.find(s => s.name.toLowerCase() === preset.name.toLowerCase());
      if (exists) {
        editText(chatId, msgId, `⚠️ Навык "${preset.name}" уже существует`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'skill_presets' }]] } });
      } else {
        uc.skills.push({ name: preset.name, prompt: preset.prompt, description: preset.description, category: preset.category, uses: 0, lastUsed: null });
        saveUserConfig(chatId);
        editText(chatId, msgId, `✅ Навык "${preset.name}" добавлен из галереи`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыкам', callback_data: 'skills_menu' }, { text: '📦 Ещё', callback_data: 'skill_presets' }]] } });
      }
    }
  }
  // Wizard создания навыка — выбор категории
  else if (data.startsWith('newskill_cat_')) {
    const catId = data.slice(13);
    const skillName = waitingSkillCategory.get(chatId);
    waitingSkillCategory.delete(chatId);
    if (skillName) {
      waitingSkillPrompt.set(chatId, { name: skillName, category: catId });
      editText(chatId, msgId, `⚡ Имя: ${skillName}\n📂 Категория: ${(SKILL_CATEGORIES.find(c => c.id === catId) || {}).label || catId}\n\nТеперь введите промпт для навыка:\nИли отправьте .txt файл`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'skills_menu' }]] } });
    }
  }
  // Fallback для старых кнопок шаблонов
  else if (data === 'templates' || data.startsWith('tpl_')) {
    editText(chatId, msgId, '⚡ Шаблоны переименованы в Навыки!', mainMenu(chatId));
  }

  // === Интеграции (MCP / Rube) ===
  else if (data === 'integrations') {
    // Динамическое содержимое — читаем реальные MCP серверы
    let mcpInfo = '';
    let mcpServers = [];
    try {
      const settingsPath = path.join(process.env.HOME || '/Users/guest1', '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const servers = settings.mcpServers || {};
        mcpServers = Object.keys(servers);
        if (mcpServers.length > 0) {
          mcpInfo = `\n\n🟢 Подключённые MCP серверы (${mcpServers.length}):\n`;
          mcpServers.forEach(name => {
            const srv = servers[name];
            const cmd = srv.command || '';
            mcpInfo += `• ${name} (${cmd})\n`;
          });
        } else {
          mcpInfo = '\n\n🔴 MCP серверы не настроены';
        }
      } else {
        mcpInfo = '\n\n⚠️ Файл настроек Claude не найден';
      }
    } catch(e) {
      mcpInfo = '\n\n⚠️ Ошибка чтения настроек';
    }
    const rows = [
      [{ text: '🔍 Проверить подключение', callback_data: 'integ_test' }],
      [{ text: '🌐 Маркетплейс Rube', url: 'https://rube.app/marketplace' }],
      [{ text: '◀️ Назад', callback_data: 'back' }],
    ];
    editText(chatId, msgId, `🔗 Интеграции (MCP)${mcpInfo}\n\n📋 Как подключить:\n1. Настройте MCP серверы в ~/.claude/settings.json\n2. Или подключите через rube.app\n3. AI автоматически использует интеграции`, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data === 'integ_test') {
    // Проверка подключения MCP серверов
    let result = '🔍 Проверка MCP серверов...\n\n';
    try {
      const settingsPath = path.join(process.env.HOME || '/Users/guest1', '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const servers = settings.mcpServers || {};
        const names = Object.keys(servers);
        if (names.length === 0) {
          result += '❌ Нет настроенных серверов';
        } else {
          for (const name of names) {
            const srv = servers[name];
            const cmd = srv.command || '';
            let exists = false;
            try { execSync(`which ${cmd.split(' ')[0]} 2>/dev/null`, { encoding: 'utf8' }); exists = true; } catch(e) {}
            result += `${exists ? '✅' : '⚠️'} ${name} — ${cmd} ${exists ? '(найден)' : '(не найден в PATH)'}\n`;
          }
        }
      } else {
        result += '❌ ~/.claude/settings.json не найден';
      }
    } catch(e) {
      result += `❌ Ошибка: ${e.message}`;
    }
    editText(chatId, msgId, result, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'integrations' }]] } });
  }

  // === Админ-панель: Пользователи ===
  else if (data === 'users_panel') {
    const allUsers = Array.from(userConfigs.entries());
    let text = `👥 Пользователи (${allUsers.length})\n\n`;
    allUsers.forEach(([uid, cfg], i) => {
      const roleIcon = cfg.role === 'admin' ? '👑 admin' : '👤 user';
      const bannedTag = cfg.banned ? ' 🚫' : '';
      text += `${i + 1}. User ${uid} — ${roleIcon} — ${cfg.model}${bannedTag}\n`;
    });
    const rows = allUsers.filter(([uid]) => uid !== chatId).map(([uid]) => [{ text: `👤 ${uid}`, callback_data: `user_detail_${uid}` }]);
    rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
    editText(chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('user_detail_')) {
    const targetId = Number(data.slice(12));
    const tc = getUserConfig(targetId);
    const roleIcon = tc.role === 'admin' ? '👑 admin' : '👤 user';
    const bannedTag = tc.banned ? '🚫 Забанен' : '✅ Активен';
    const info = `👤 User ${targetId}\n\nРоль: ${roleIcon}\nСтатус: ${bannedTag}\nМодель: ${tc.model}\nПапка: ${tc.workDir}\nАгент: ${tc.agentMode !== false ? '✅' : '❌'}\nСтриминг: ${tc.streaming ? '✅' : '❌'}`;
    const rows = [];
    if (tc.banned) rows.push([{ text: '✅ Разбан', callback_data: `user_unban_${targetId}` }]);
    else rows.push([{ text: '🚫 Бан', callback_data: `user_ban_${targetId}` }]);
    if (tc.role === 'admin') rows.push([{ text: '👤 Сделать юзером', callback_data: `user_role_${targetId}` }]);
    else rows.push([{ text: '👑 Сделать админом', callback_data: `user_role_${targetId}` }]);
    rows.push([{ text: '🗑 Очистить историю', callback_data: `user_clear_${targetId}` }]);
    rows.push([{ text: '◀️ Назад к списку', callback_data: 'users_panel' }]);
    editText(chatId, msgId, info, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('user_ban_')) {
    const targetId = Number(data.slice(9));
    const tc = getUserConfig(targetId);
    tc.banned = true;
    saveUserConfig(targetId);
    editText(chatId, msgId, `🚫 User ${targetId} забанен`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }
  else if (data.startsWith('user_unban_')) {
    const targetId = Number(data.slice(11));
    const tc = getUserConfig(targetId);
    tc.banned = false;
    saveUserConfig(targetId);
    editText(chatId, msgId, `✅ User ${targetId} разбанен`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }
  else if (data.startsWith('user_role_')) {
    const targetId = Number(data.slice(10));
    const tc = getUserConfig(targetId);
    tc.role = tc.role === 'admin' ? 'user' : 'admin';
    if (tc.role === 'user') tc.workDir = '/tmp';
    saveUserConfig(targetId);
    const newRole = tc.role === 'admin' ? '👑 admin' : '👤 user';
    editText(chatId, msgId, `✅ User ${targetId} → ${newRole}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }
  else if (data.startsWith('user_clear_')) {
    const targetId = Number(data.slice(11));
    clearHistory(targetId);
    editText(chatId, msgId, `🗑 История User ${targetId} очищена`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }

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
      const filePath = path.join(uc.workDir, `claude_${Date.now()}.txt`);
      fs.writeFileSync(filePath, last.text);
      sendDocument(chatId, filePath, 'Сохранённый ответ Claude');
    } else send(chatId, '❌ Нет предыдущего ответа');
  }
  else if (data === 'qa_regen') {
    const last = lastResponse.get(chatId);
    if (last && last.prompt) runClaude(chatId, last.prompt);
    else send(chatId, '❌ Нет предыдущего запроса');
  }

  // === Статистика ===
  else if (data === 'stats') {
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const avgTime = stats.claudeCalls > 0 ? (stats.totalResponseTime / stats.claudeCalls / 1000).toFixed(1) : 0;
    editText(chatId, msgId, `📈 Статистика\n\n⏱ Аптайм: ${uptime} мин\n📨 Сообщений: ${stats.messages}\n🤖 Claude вызовов: ${stats.claudeCalls}\n⚡ Среднее время ответа: ${avgTime}с\n🎙 Голосовых: ${stats.voiceMessages}\n📎 Файлов: ${stats.files}\n❌ Ошибок: ${stats.errors}\n🧠 AI активен: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}\n🤖 Модель: ${uc.model}`, mainMenu(chatId));
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
    cwd: getUserConfig(chatId).workDir,
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

⚡ Навыки:
• /skill <имя> <промпт> — сохранить навык
• /skill edit <имя> — редактировать навык
• /skill info <имя> — информация о навыке
• /s <имя> — запустить навык
• /skills — список с категориями
• 📦 Галерея пресетов — готовые навыки
• .txt файл при создании → содержимое станет промптом
• Агент может вызывать навыки через [ACTION: skill]

👥 Мульти-агенты:
• /agents — статус и настройки
• Агент создаёт субагентов (💻🔍🔎✍️⚡) для сложных задач
• Субагенты общаются, делегируют, самокорректируются
• Live-статус: мысли, действия, прогресс — в одном сообщении
• Настройки → Мульти-агент / Макс шагов

🔗 Интеграции:
• AI использует подключённые MCP серверы автоматически
• 🔍 Проверка подключения в меню интеграций
• Настройка в ~/.claude/settings.json

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

  const uc = getUserConfig(chatId);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
  const child = spawn('bash', ['-c', cmd], {
    cwd: uc.workDir,
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
  const uc = getUserConfig(chatId);
  const child = spawn('bash', ['-c', 'echo "📁 $(pwd)" && echo "" && echo "=== git status ===" && git status -sb 2>&1 && echo "" && echo "=== git log (последние 5) ===" && git log --oneline -5 2>&1'], {
    cwd: uc.workDir,
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

  const uc = getUserConfig(chatId);
  const destPath = path.join(uc.workDir, fileName);
  send(chatId, `📥 Скачиваю ${fileName}...`);

  const downloaded = await downloadTelegramFile(fileId, destPath);
  if (!downloaded) {
    send(chatId, `❌ Не удалось скачать файл`);
    return true;
  }

  send(chatId, `✅ Файл сохранён: ${destPath}`);

  // Редактирование промпта навыка из .txt файла
  if (waitingSkillEditPrompt.has(chatId) && msg.document && fileName.endsWith('.txt')) {
    const idx = waitingSkillEditPrompt.get(chatId);
    waitingSkillEditPrompt.delete(chatId);
    try {
      const fileContent = fs.readFileSync(destPath, 'utf8').trim();
      if (!fileContent) { send(chatId, '❌ Файл пустой'); return true; }
      if (uc.skills && uc.skills[idx]) {
        uc.skills[idx].prompt = fileContent;
        saveUserConfig(chatId);
        send(chatId, `✅ Промпт "${uc.skills[idx].name}" обновлён из файла (${fileContent.length} символов)`, mainMenu(chatId));
      }
    } catch (e) {
      send(chatId, `❌ Ошибка чтения файла: ${e.message}`);
    }
    return true;
  }

  // Создание навыка из .txt файла
  if (waitingSkillPrompt.has(chatId) && msg.document && fileName.endsWith('.txt')) {
    const pending = waitingSkillPrompt.get(chatId);
    waitingSkillPrompt.delete(chatId);
    const name = typeof pending === 'object' ? pending.name : pending;
    const category = typeof pending === 'object' ? pending.category : 'other';
    try {
      const fileContent = fs.readFileSync(destPath, 'utf8').trim();
      if (!fileContent) { send(chatId, '❌ Файл пустой'); return true; }
      if (!uc.skills) uc.skills = [];
      uc.skills.push({ name, prompt: fileContent, description: '', category, uses: 0, lastUsed: null });
      saveUserConfig(chatId);
      send(chatId, `✅ Навык "${name}" создан из файла (${fileContent.length} символов)`, mainMenu(chatId));
    } catch (e) {
      send(chatId, `❌ Ошибка чтения файла: ${e.message}`);
    }
    return true;
  }

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

  const uc = getUserConfig(chatId);
  const fileId = voice.file_id;
  const ext = msg.voice ? 'ogg' : (voice.mime_type || '').split('/')[1] || 'mp3';
  const fileName = `voice_${Date.now()}.${ext}`;
  const destPath = path.join(uc.workDir, fileName);

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

[ACTION: skill]
имя_навыка
дополнительный контекст
[/ACTION]

[ACTION: delegate]
роль: coder|researcher|reviewer|writer|executor
задача: описание что нужно сделать
контекст: дополнительная информация
[/ACTION]

[ACTION: think]
Внутреннее размышление — анализ ситуации, планирование шагов.
Пользователь видит что ты думаешь, но не видит содержимое.
[/ACTION]

## Описание действий

1. **bash** — выполнить bash-команду. Тайм-аут: 30с.
2. **remind** — напоминание. Строка 1: минуты, строка 2: текст.
3. **file** — отправить файл. Одна строка — путь.
4. **skill** — навык пользователя. Строка 1: имя, строка 2: контекст.
5. **delegate** — делегировать субагенту. Формат: роль/задача/контекст.
6. **think** — внутреннее размышление перед действием.

## Роли субагентов (для delegate)
- **coder** — 💻 пишет/модифицирует код
- **researcher** — 🔍 исследует, анализирует, ищет информацию
- **reviewer** — 🔎 проверяет качество, находит ошибки
- **writer** — ✍️ создаёт тексты, документацию
- **executor** — ⚡ выполняет системные команды

## Среда выполнения

- macOS (Darwin), Node.js v25, Homebrew установлен
- Python НЕ установлен. НЕ пытайся использовать python/pip/python3
- Для файлов: node -e или bash (echo, cat heredoc)
- curl для скачивания, node -e для JSON, Gemini API в $GEMINI_API_KEY

## Правила

- Когда просят СДЕЛАТЬ — ДЕЛАЙ через действия, не предлагай команды.
- Одно действие за ответ. После результата решай, нужно ли следующее.
- Текст ДО блока [ACTION] — краткий статус (5-15 слов). Пример: "Анализирую структуру проекта."
- НЕ пиши длинных объяснений перед ACTION.
- Для сложных задач используй [ACTION: think] чтобы спланировать, затем delegate субагентам.
- Для простых задач действуй сам через bash/file/skill.
- Если субагент вернул ошибку — попробуй исправить и делегировать снова.
- НЕ показывай raw-код в сообщениях. Файлы — через bash.
- Файлы отправляй через [ACTION: file], не дублируй содержимое.
- НЕ делай деструктивных команд.
- Отвечай на языке пользователя. Будь кратким.
- Финальный итог — что сделано, какие файлы созданы.
- Не предлагай меню из вариантов — действуй или задай ОДИН вопрос.`;

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

function executeBashAction(cmd, workDir) {
  return new Promise((resolve) => {
    if (isBashBlocked(cmd)) {
      resolve({ success: false, output: 'ЗАБЛОКИРОВАНО: команда запрещена по соображениям безопасности' });
      return;
    }
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn('bash', ['-c', cmd], {
      cwd: workDir || '/tmp',
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
  const uc = getUserConfig(chatId);
  const resolved = path.resolve(uc.workDir, filePath);
  if (!fs.existsSync(resolved)) {
    return { success: false, output: `Файл не найден: ${resolved}` };
  }
  sendDocument(chatId, resolved);
  return { success: true, output: `Файл отправлен: ${resolved}` };
}

function executeSkillAction(chatId, body) {
  const lines = body.split('\n');
  const skillName = lines[0].trim().toLowerCase();
  const context = lines.slice(1).join('\n').trim();
  const uc = getUserConfig(chatId);
  const skill = (uc.skills || []).find(s => s.name.toLowerCase() === skillName);
  if (!skill) {
    return { success: false, output: `Навык "${skillName}" не найден. Доступные: ${(uc.skills || []).map(s => s.name).join(', ') || 'нет'}` };
  }
  skill.uses = (skill.uses || 0) + 1;
  skill.lastUsed = Date.now();
  saveUserConfig(chatId);
  const result = `[SKILL: ${skill.name}]\n${skill.prompt}\n${context ? `\nКонтекст: ${context}` : ''}\n[/SKILL]`;
  return { success: true, output: result };
}

async function executeDelegateAction(chatId, body, statusUpdater) {
  // Парсим роль, задачу, контекст
  const roleMatch = body.match(/роль:\s*(\w+)/i) || body.match(/role:\s*(\w+)/i);
  const taskMatch = body.match(/задача:\s*(.+)/i) || body.match(/task:\s*(.+)/i);
  const ctxMatch = body.match(/контекст:\s*([\s\S]*)/i) || body.match(/context:\s*([\s\S]*)/i);

  const role = roleMatch ? roleMatch[1].toLowerCase() : 'executor';
  const task = taskMatch ? taskMatch[1].trim() : body.split('\n')[0];
  const context = ctxMatch ? ctxMatch[1].trim() : '';

  if (!AGENT_ROLES[role]) {
    return { success: false, output: `Неизвестная роль: ${role}. Доступные: ${Object.keys(AGENT_ROLES).join(', ')}` };
  }

  const roleInfo = AGENT_ROLES[role];
  const subAgentId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Логируем в трекер
  const tracker = multiAgentTasks.get(chatId);
  if (tracker) {
    tracker.agents.push({ id: subAgentId, role, task: task.slice(0, 100), status: 'running', startTime: Date.now() });
    tracker.log.push(`${roleInfo.icon} ${roleInfo.label} запущен: ${task.slice(0, 80)}`);
  }

  if (statusUpdater) statusUpdater(`${roleInfo.icon} Субагент: ${roleInfo.label}\n📋 ${task.slice(0, 120)}`);

  // Формируем промпт субагента
  const subPrompt = SUB_AGENT_PROMPT_TEMPLATE(role, task, context);
  const uc = getUserConfig(chatId);
  const subModel = uc.model;

  try {
    // Субагент выполняет до 3 шагов
    const subMessages = [{ role: 'user', content: task + (context ? `\n\nКонтекст:\n${context}` : '') }];
    let subResult = '';
    const subMaxSteps = 3;

    for (let subStep = 0; subStep < subMaxSteps; subStep++) {
      const aiResult = await callAI(subModel, normalizeMessages(subMessages), subPrompt, true);
      const responseText = aiResult.text.trim();

      const subAction = parseAction(responseText);
      if (!subAction) {
        subResult = responseText;
        break;
      }

      // Субагент хочет выполнить действие
      if (statusUpdater) statusUpdater(`${roleInfo.icon} ${roleInfo.label} → [${subAction.name}]\n${subAction.textBefore || ''}`);

      if (subAction.name === 'delegate') {
        subResult = responseText.replace(subAction.fullMatch, '').trim() + '\n(Субагент не может делегировать дальше)';
        break;
      }

      const actionResult = await executeAction(chatId, subAction);
      subMessages.push({ role: 'assistant', content: responseText });
      subMessages.push({ role: 'user', content: `[RESULT: ${subAction.name}]\n${actionResult.output}\n[/RESULT]` });

      if (subStep === subMaxSteps - 1) {
        subResult = `Субагент выполнил ${subMaxSteps} шагов. Последний результат: ${actionResult.output.slice(0, 500)}`;
      }
    }

    // Обновляем статус субагента
    if (tracker) {
      const agent = tracker.agents.find(a => a.id === subAgentId);
      if (agent) { agent.status = 'done'; agent.endTime = Date.now(); }
      tracker.log.push(`${roleInfo.icon} ${roleInfo.label} завершён ✅`);
    }

    return { success: true, output: `[СУБАГЕНТ ${roleInfo.icon} ${roleInfo.label}]\n${subResult}\n[/СУБАГЕНТ]` };

  } catch (e) {
    if (tracker) {
      const agent = tracker.agents.find(a => a.id === subAgentId);
      if (agent) { agent.status = 'error'; agent.error = e.message; }
      tracker.log.push(`${roleInfo.icon} ${roleInfo.label} ошибка ❌: ${e.message}`);
    }
    return { success: false, output: `Ошибка субагента ${roleInfo.label}: ${e.message}` };
  }
}

async function executeAction(chatId, action, statusUpdater) {
  const uc = getUserConfig(chatId);
  const effectiveWorkDir = isAdmin(chatId) ? uc.workDir : '/tmp';
  switch (action.name) {
    case 'bash': {
      if (!isAdmin(chatId) && /\bcd\s+\/(Users|home|root|etc|var|opt)\b/.test(action.body)) {
        return { success: false, output: 'ЗАБЛОКИРОВАНО: доступ к системным директориям запрещён' };
      }
      return await executeBashAction(action.body, effectiveWorkDir);
    }
    case 'remind': return executeRemindAction(chatId, action.body);
    case 'search': return executeSearchAction(action.body);
    case 'file': return executeFileAction(chatId, action.body);
    case 'skill': return executeSkillAction(chatId, action.body);
    case 'delegate': return await executeDelegateAction(chatId, action.body, statusUpdater);
    case 'think': return { success: true, output: '(размышление завершено)', silent: true };
    default: return { success: false, output: `Неизвестное действие: ${action.name}` };
  }
}

// === Live Status Display ===
function buildStatusMessage(opts) {
  const { model, provider, step, maxSteps, startTime, thought, actionName, actionDetail, subAgents, phase, error } = opts;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  let lines = [];

  // Заголовок
  lines.push(`🤖 ${providerLabel} ${model} | ⏱ ${elapsed}с`);

  // Прогресс шагов
  const stepBar = '●'.repeat(step) + '○'.repeat(Math.max(0, maxSteps - step));
  lines.push(`📊 Шаг ${step}/${maxSteps} ${stepBar}`);

  // Фаза
  if (phase) lines.push(`\n${phase}`);

  // Мысли агента
  if (thought) {
    const trimmed = thought.slice(0, 200);
    lines.push(`\n💭 ${trimmed}${thought.length > 200 ? '...' : ''}`);
  }

  // Текущее действие
  if (actionName) {
    const icons = { bash: '⚡', remind: '⏰', file: '📄', skill: '🎯', delegate: '🤝', think: '🧠' };
    const icon = icons[actionName] || '🔄';
    lines.push(`\n${icon} Действие: ${actionName}`);
    if (actionDetail) lines.push(`   ${actionDetail.slice(0, 150)}`);
  }

  // Субагенты
  if (subAgents && subAgents.length > 0) {
    lines.push(`\n👥 Субагенты:`);
    for (const sa of subAgents) {
      const roleInfo = AGENT_ROLES[sa.role] || { icon: '🔄', label: sa.role };
      const statusIcon = sa.status === 'done' ? '✅' : sa.status === 'error' ? '❌' : '⏳';
      const dur = sa.endTime ? ` (${Math.round((sa.endTime - sa.startTime) / 1000)}с)` : '';
      lines.push(`   ${statusIcon} ${roleInfo.icon} ${roleInfo.label}: ${sa.task.slice(0, 60)}${dur}`);
    }
  }

  // Ошибка
  if (error) lines.push(`\n❌ ${error}`);

  return lines.join('\n');
}

async function runClaude(chatId, text) {
  const uc = getUserConfig(chatId);
  let model = uc.model;
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
  if (uc.autoModel && !manualModel) {
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

  const agentEnabled = uc.agentMode !== false;
  const multiAgentEnabled = uc.multiAgent !== false && agentEnabled;
  const basePrompt = agentEnabled ? AGENT_SYSTEM_PROMPT : BOT_SYSTEM_PROMPT;

  let skillsPrompt = '';
  const skills = uc.skills || [];
  if (skills.length > 0) {
    skillsPrompt = '\n\n## Доступные навыки пользователя\nКогда задача совпадает с навыком — используй [ACTION: skill] для его вызова.\n';
    skills.forEach((s, i) => {
      const catLabel = (SKILL_CATEGORIES.find(c => c.id === s.category) || {}).label || '📦';
      const desc = s.description ? ` (${s.description})` : '';
      skillsPrompt += `${i + 1}. ${catLabel} **${s.name}**${desc}:\n   ${s.prompt}\n`;
    });
    skillsPrompt += '\nДля вызова используй:\n[ACTION: skill]\nимя_навыка\nдополнительный контекст\n[/ACTION]';
  }

  // Если мульти-агент отключён — убираем delegate из промпта
  let effectiveBasePrompt = basePrompt;
  if (!multiAgentEnabled && agentEnabled) {
    effectiveBasePrompt = basePrompt.replace(/\[ACTION: delegate\][\s\S]*?\[\/ACTION\]\n?/, '').replace(/5\. \*\*delegate\*\*[^\n]*\n?/, '').replace(/6\. \*\*think\*\*/, '5. **think**').replace(/## Роли субагентов[\s\S]*?(?=## Среда)/, '');
  }

  const fullSystemPrompt = [effectiveBasePrompt, skillsPrompt, uc.systemPrompt].filter(Boolean).join('\n\n');
  const maxSteps = uc.agentMaxSteps || 10;

  // Инициализируем трекер мульти-агента
  const tracker = { orchestratorMsgId: statusMsgId, agents: [], log: [], startTime };
  multiAgentTasks.set(chatId, tracker);

  // Состояние для live display
  const statusState = { model, provider, step: 0, maxSteps, startTime, thought: null, actionName: null, actionDetail: null, subAgents: tracker.agents, phase: '🔄 Запуск...', error: null };

  let lastStatusUpdate = 0;
  const updateStatus = (overrides = {}) => {
    const now = Date.now();
    if (now - lastStatusUpdate < 800) return; // троттлинг
    lastStatusUpdate = now;
    Object.assign(statusState, overrides);
    if (statusMsgId) {
      const text = buildStatusMessage(statusState);
      editText(chatId, statusMsgId, text);
    }
  };

  try {
    let step = 0;
    let finalText = '';
    let retryCount = 0;
    const MAX_RETRIES = 2;

    while (step < maxSteps) {
      if (!activeTasks.has(chatId)) {
        finalText = 'Остановлено пользователем.';
        break;
      }
      step++;

      updateStatus({ step, phase: step === 1 ? '🧠 Анализирую запрос...' : `🔄 Шаг ${step}/${maxSteps}`, thought: null, actionName: null, actionDetail: null });

      let result;
      if (uc.streaming) {
        let lastEditTime = 0;
        let lastLen = 0;
        const onChunk = (partial) => {
          const now = Date.now();
          if (now - lastEditTime < 1500) return;
          lastEditTime = now;
          lastLen = partial.length;
          const pct = Math.min(Math.round(95 * (1 - Math.exp(-lastLen / 1500))), 95);
          const filled = Math.round(pct / 5);
          const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
          updateStatus({ phase: `⏳ ${bar} ${pct}%` });
        };
        result = await callAIStream(model, normalizeMessages(messages), fullSystemPrompt, onChunk, true);
      } else {
        let dots = 0;
        const frames = ['🔄', '⏳', '🤖', '💭'];
        const timer = setInterval(() => {
          dots++;
          const frame = frames[dots % frames.length];
          updateStatus({ phase: `${frame} Генерация ответа...` });
        }, 2500);
        activeTasks.get(chatId).timer = timer;
        try {
          result = await callAI(model, normalizeMessages(messages), fullSystemPrompt, true);
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

      // Обновляем статус: мысли агента + действие
      const thought = action.textBefore ? cleanMarkdown(action.textBefore) : null;
      updateStatus({
        thought,
        actionName: action.name,
        actionDetail: action.name === 'think' ? action.body.slice(0, 150) : action.body.split('\n')[0],
        phase: action.name === 'think' ? '🧠 Размышляю...' :
               action.name === 'delegate' ? '🤝 Делегирую субагенту...' :
               action.name === 'bash' ? '⚡ Выполняю команду...' :
               action.name === 'file' ? '📄 Отправляю файл...' :
               action.name === 'skill' ? '🎯 Вызываю навык...' :
               `🔄 ${action.name}...`
      });

      // Функция обновления статуса для субагентов
      const subStatusUpdater = (detail) => {
        updateStatus({ actionDetail: detail, phase: '🤝 Субагент работает...' });
      };

      const actionResult = await executeAction(chatId, action, subStatusUpdater);

      console.log(`🤖 Agent step ${step}: [${action.name}] → ${actionResult.success ? 'OK' : 'FAIL'} (${actionResult.output.slice(0, 100)})`);

      // Самокоррекция: если действие провалилось и есть retry
      if (!actionResult.success && retryCount < MAX_RETRIES) {
        retryCount++;
        updateStatus({ phase: `🔧 Самокоррекция (попытка ${retryCount}/${MAX_RETRIES})...`, error: actionResult.output.slice(0, 100) });
        tracker.log.push(`🔧 Самокоррекция: ${actionResult.output.slice(0, 80)}`);

        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: `[ERROR: ${action.name}]\n${actionResult.output}\n[/ERROR]\n\nДействие не удалось. Проанализируй ошибку и попробуй другой подход. Исправь проблему и продолжи выполнение.`
        });
        continue;
      }

      if (!actionResult.success) {
        updateStatus({ error: actionResult.output.slice(0, 100) });
      } else {
        updateStatus({ error: null });
        retryCount = 0; // Сбрасываем retry при успехе
      }

      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content: `[RESULT: ${action.name}]\n${actionResult.output}\n[/RESULT]`
      });
    }

    // === Финальный вывод ===
    activeTasks.delete(chatId);
    activeClaudeCount--;
    multiAgentTasks.delete(chatId);

    const displayText = cleanMarkdown(finalText) || (agentEnabled && step > 1 ? '✅ Задача выполнена.' : 'Готово (без вывода)');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`📋 ${model}: ${displayText.length}б, ${elapsed}с`);

    addToHistory(chatId, 'assistant', displayText);
    lastResponse.set(chatId, { text: displayText, prompt });

    // Финальный статус + агенты лог
    const agentsSummary = tracker.agents.length > 0
      ? `\n\n👥 Субагенты: ${tracker.agents.length}\n${tracker.agents.map(a => {
          const ri = AGENT_ROLES[a.role] || { icon: '🔄', label: a.role };
          const dur = a.endTime ? ` ${Math.round((a.endTime - a.startTime) / 1000)}с` : '';
          const st = a.status === 'done' ? '✅' : '❌';
          return `${st} ${ri.icon} ${ri.label}${dur}`;
        }).join('\n')}`
      : '';

    const logSummary = tracker.log.length > 0
      ? `\n\n📋 Лог:\n${tracker.log.slice(-5).join('\n')}`
      : '';

    // Обновляем статусное сообщение на итог
    if (statusMsgId) {
      const summary = `✅ Завершено за ${elapsed}с | ${step} шаг${step > 1 ? (step < 5 ? 'а' : 'ов') : ''} | ${model}${agentsSummary}${logSummary}`;
      editText(chatId, statusMsgId, summary);
    }

    send(chatId, displayText);

    if (step >= maxSteps && parseAction(finalText)) {
      send(chatId, `⚠️ Достигнут лимит шагов (${maxSteps}). Задача может быть не завершена.`);
    }

  } catch (e) {
    activeTasks.delete(chatId);
    activeClaudeCount--;
    multiAgentTasks.delete(chatId);
    stats.errors++;
    console.error(`❌ ${model} error: ${e.message}`);
    if (statusMsgId) editText(chatId, statusMsgId, `❌ Ошибка ${model}: ${e.message}`);
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

  // Инициализация per-user конфига (новый пользователь получит дефолтные настройки)
  const uc = getUserConfig(chatId);

  // Бан-проверка
  if (uc.banned) { send(chatId, '❌ Ваш доступ заблокирован'); return; }

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
    uc.systemPrompt = text;
    saveUserConfig(chatId);
    send(chatId, `✅ Системный промпт установлен:\n${text}`, mainMenu(chatId));
    return;
  }

  // Ожидание редактирования полей навыка
  if (waitingSkillEditName.has(chatId)) {
    const idx = waitingSkillEditName.get(chatId);
    waitingSkillEditName.delete(chatId);
    if (uc.skills && uc.skills[idx]) {
      uc.skills[idx].name = text.trim();
      saveUserConfig(chatId);
      send(chatId, `✅ Имя обновлено: ${text.trim()}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыку', callback_data: `skill_info_${idx}` }]] } });
    }
    return;
  }
  if (waitingSkillEditPrompt.has(chatId)) {
    const idx = waitingSkillEditPrompt.get(chatId);
    waitingSkillEditPrompt.delete(chatId);
    if (uc.skills && uc.skills[idx]) {
      uc.skills[idx].prompt = text;
      saveUserConfig(chatId);
      send(chatId, `✅ Промпт "${uc.skills[idx].name}" обновлён (${text.length} символов)`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыку', callback_data: `skill_info_${idx}` }]] } });
    }
    return;
  }
  if (waitingSkillEditDesc.has(chatId)) {
    const idx = waitingSkillEditDesc.get(chatId);
    waitingSkillEditDesc.delete(chatId);
    if (uc.skills && uc.skills[idx]) {
      uc.skills[idx].description = text.trim();
      saveUserConfig(chatId);
      send(chatId, `✅ Описание "${uc.skills[idx].name}" обновлено`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыку', callback_data: `skill_info_${idx}` }]] } });
    }
    return;
  }

  // Ожидание имени навыка → wizard: выбор категории
  if (waitingSkillName.has(chatId)) {
    waitingSkillName.delete(chatId);
    const skillName = text.trim();
    waitingSkillCategory.set(chatId, skillName);
    const catRows = SKILL_CATEGORIES.map(c => [{ text: c.label, callback_data: `newskill_cat_${c.id}` }]);
    catRows.push([{ text: '⏩ Пропустить', callback_data: 'newskill_cat_other' }]);
    send(chatId, `⚡ Имя: ${skillName}\n\n📂 Выберите категорию:`, { reply_markup: { inline_keyboard: catRows } });
    return;
  }
  if (waitingSkillPrompt.has(chatId)) {
    const pending = waitingSkillPrompt.get(chatId);
    waitingSkillPrompt.delete(chatId);
    const name = typeof pending === 'object' ? pending.name : pending;
    const category = typeof pending === 'object' ? pending.category : 'other';
    if (!uc.skills) uc.skills = [];
    uc.skills.push({ name, prompt: text, description: '', category, uses: 0, lastUsed: null });
    saveUserConfig(chatId);
    send(chatId, `✅ Навык "${name}" сохранён`, mainMenu(chatId));
    return;
  }

  // Ожидание пути
  if (waitingDir.has(chatId)) {
    waitingDir.delete(chatId);
    if (fs.existsSync(text)) { uc.workDir = text; saveUserConfig(chatId); send(chatId, `✅ Папка: ${text}`, mainMenu(chatId)); }
    else send(chatId, `❌ Не найдена: ${text}`);
    return;
  }

  if (text === '/start' || text === '/menu' || text === '📋 Меню') { send(chatId, '👋 Claude Code Remote', { ...mainMenu(chatId), ...persistentKeyboard }); return; }
  if (text === '/status' || text === '📊 Статус') { send(chatId, `📊 🤖 ${uc.model} (${PROVIDER_LABELS[getProvider(uc.model)] || ''}) | 📁 ${uc.workDir} | ⏱ ${uc.timeout}с | 🧠 AI: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}`, mainMenu(chatId)); return; }
  if (text === '/settings' || text === '⚙️ Настройки') { send(chatId, '⚙️ Настройки:', settingsMenu(chatId)); return; }
  if (text === '/stop' || text === '⛔ Стоп') { stopTask(chatId); send(chatId, '⛔ Остановлено'); return; }
  if (text === '/clear') { clearHistory(chatId); messageQueue.delete(chatId); send(chatId, '🗑 История и очередь очищены'); return; }
  if (text === '/help') { send(chatId, helpText()); return; }
  if (text === '/notebook' || text === '/nb' || text === '📓 NB') { send(chatId, '📓 NotebookLM', nbMainMenu); return; }

  if (text.startsWith('/bash ')) { if (!isAdmin(chatId)) { send(chatId, '❌ Только для администраторов'); return; } runBash(chatId, text.slice(6)); return; }

  // /web — поиск в интернете через Claude
  if (text.startsWith('/web ')) {
    const query = text.slice(5).trim();
    if (!query) { send(chatId, '❌ Укажите запрос: /web что такое Telegram MTProto'); return; }
    runClaude(chatId, `Найди в интернете актуальную информацию по запросу: "${query}". Дай краткий структурированный ответ с источниками.`);
    return;
  }

  if (text.startsWith('/file ')) { sendDocument(chatId, text.slice(6).trim()); return; }

  // /skill — навыки: создание, редактирование, инфо
  if (text.startsWith('/skill ')) {
    const args = text.slice(7).trim();
    // /skill edit <имя>
    if (args.startsWith('edit ')) {
      const skillName = args.slice(5).trim().toLowerCase();
      const idx = (uc.skills || []).findIndex(s => s.name.toLowerCase() === skillName);
      if (idx === -1) { send(chatId, `❌ Навык "${skillName}" не найден`); return; }
      const skill = uc.skills[idx];
      send(chatId, `✏️ Редактирование: ${skill.name}`, { reply_markup: { inline_keyboard: [
        [{ text: '📝 Имя', callback_data: `skedit_name_${idx}` }, { text: '📄 Промпт', callback_data: `skedit_prompt_${idx}` }],
        [{ text: '📝 Описание', callback_data: `skedit_desc_${idx}` }, { text: '📂 Категория', callback_data: `skedit_cat_${idx}` }],
        [{ text: '◀️ К навыку', callback_data: `skill_info_${idx}` }],
      ] } });
      return;
    }
    // /skill info <имя>
    if (args.startsWith('info ')) {
      const skillName = args.slice(5).trim().toLowerCase();
      const idx = (uc.skills || []).findIndex(s => s.name.toLowerCase() === skillName);
      if (idx === -1) { send(chatId, `❌ Навык "${skillName}" не найден`); return; }
      const skill = uc.skills[idx];
      const catLabel = (SKILL_CATEGORIES.find(c => c.id === skill.category) || {}).label || '📦 Другое';
      const lastUsedStr = skill.lastUsed ? new Date(skill.lastUsed).toLocaleString('ru-RU') : 'никогда';
      const promptPreview = skill.prompt.length > 300 ? skill.prompt.slice(0, 300) + '...' : skill.prompt;
      const desc = skill.description ? `\n📝 ${skill.description}` : '';
      send(chatId, `⚡ ${skill.name}${desc}\n\n📂 Категория: ${catLabel}\n📊 Использований: ${skill.uses || 0}\n🕐 Последний запуск: ${lastUsedStr}\n\n📄 Промпт:\n${promptPreview}`, { reply_markup: { inline_keyboard: [
        [{ text: '▶️ Запуск', callback_data: `skill_run_${idx}` }, { text: '✏️ Редактировать', callback_data: `skill_edit_${idx}` }],
        [{ text: '◀️ К навыкам', callback_data: 'skills_menu' }],
      ] } });
      return;
    }
    // /skill <имя> <промпт> — создание
    const parts = args.split(/\s+/);
    const name = parts[0];
    const prompt = parts.slice(1).join(' ');
    if (!name || !prompt) { send(chatId, '❌ Формат: /skill имя промпт\nПример: /skill review Сделай code review\n\n/skill edit <имя> — редактировать\n/skill info <имя> — информация'); return; }
    if (!uc.skills) uc.skills = [];
    uc.skills.push({ name, prompt, description: '', category: 'other', uses: 0, lastUsed: null });
    saveUserConfig(chatId);
    send(chatId, `✅ Навык "${name}" сохранён\nЗапуск: /s ${name}`);
    return;
  }

  // /s — запуск навыка по имени
  if (text.startsWith('/s ')) {
    const name = text.slice(3).trim().toLowerCase();
    const skill = (uc.skills || []).find(t => t.name.toLowerCase() === name);
    if (skill) {
      skill.uses = (skill.uses || 0) + 1;
      skill.lastUsed = Date.now();
      saveUserConfig(chatId);
      runClaude(chatId, skill.prompt);
    }
    else { send(chatId, `❌ Навык "${name}" не найден. /skills — список`); }
    return;
  }
  if (text === '/skills') {
    // Используем тот же формат что и callback skills_menu
    const skills = uc.skills || [];
    if (skills.length === 0) {
      send(chatId, '⚡ Навыки пусты\n\n/skill <имя> <промпт> — создать', { reply_markup: { inline_keyboard: [[{ text: '➕ Создать', callback_data: 'skill_create' }, { text: '📦 Галерея', callback_data: 'skill_presets' }], [{ text: '◀️ Назад', callback_data: 'back' }]] } });
    } else {
      const rows = skills.map((t, i) => {
        const useBadge = t.uses > 0 ? ` (${t.uses})` : '';
        return [{ text: `⚡ ${t.name}${useBadge}`, callback_data: `skill_run_${i}` }, { text: 'ℹ️', callback_data: `skill_info_${i}` }, { text: '🗑', callback_data: `skill_del_${i}` }];
      });
      rows.push([{ text: '➕ Создать', callback_data: 'skill_create' }, { text: '📦 Галерея', callback_data: 'skill_presets' }]);
      rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
      send(chatId, `⚡ Навыки (${skills.length}):`, { reply_markup: { inline_keyboard: rows } });
    }
    return;
  }

  // /agents — статус мульти-агентной системы
  if (text === '/agents') {
    const rolesText = Object.entries(AGENT_ROLES).map(([k, v]) => `${v.icon} ${v.label} — ${v.desc}`).join('\n');
    const multiOn = uc.multiAgent !== false;
    const agentOn = uc.agentMode !== false;
    send(chatId, `👥 Мульти-агентная система\n\nСтатус: ${multiOn && agentOn ? '✅ Активна' : '❌ Выключена'}\nАгент-режим: ${agentOn ? '✅' : '❌'}\nМульти-агент: ${multiOn ? '✅' : '❌'}\nМакс шагов: ${uc.agentMaxSteps || 10}\nСамокоррекция: ✅ (до 2 попыток)\n\n🎭 Роли субагентов:\n${rolesText}\n\n💡 Агент автоматически создаёт субагентов для сложных задач. Каждый субагент специализирован и может выполнять до 3 шагов.\n\nВесь прогресс отображается в одном обновляемом сообщении.`, { reply_markup: { inline_keyboard: [
      [{ text: `👥 Мульти-агент: ${multiOn ? '✅' : '❌'}`, callback_data: 'toggle_multi' }],
      [{ text: `🤖 Агент: ${agentOn ? '✅' : '❌'}`, callback_data: 'toggle_agent' }],
      [{ text: `🔢 Макс шагов: ${uc.agentMaxSteps || 10}`, callback_data: 'set_max_steps' }],
      [{ text: '◀️ Меню', callback_data: 'back' }],
    ] } });
    return;
  }

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
    if (!uc.pins) uc.pins = [];
    uc.pins.push({ text: last.text.slice(0, 500), prompt: last.prompt, date: Date.now() });
    if (uc.pins.length > 20) uc.pins.shift();
    saveUserConfig(chatId);
    send(chatId, `📌 Закреплено (${uc.pins.length}/20)`);
    return;
  }
  if (text === '/pins') {
    if (!uc.pins || uc.pins.length === 0) { send(chatId, '📌 Нет закреплённых ответов. Используйте /pin'); return; }
    const list = uc.pins.map((p, i) => `${i + 1}. ${p.text.slice(0, 80)}...`).join('\n');
    send(chatId, `📌 Закреплённые (${uc.pins.length}):\n\n${list}\n\nИспользуйте /pinget <номер> для просмотра`);
    return;
  }
  if (text.startsWith('/pinget ')) {
    const idx = parseInt(text.slice(8)) - 1;
    const pin = (uc.pins || [])[idx];
    if (!pin) { send(chatId, '❌ Не найдено'); return; }
    send(chatId, `📌 #${idx + 1}\n\n${pin.text}`);
    return;
  }

  // /stats — статистика
  if (text === '/stats') {
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const avgTime = stats.claudeCalls > 0 ? (stats.totalResponseTime / stats.claudeCalls / 1000).toFixed(1) : 0;
    send(chatId, `📈 Статистика\n\n⏱ Аптайм: ${uptime} мин\n📨 Сообщений: ${stats.messages}\n🤖 Claude вызовов: ${stats.claudeCalls}\n⚡ Ср. время: ${avgTime}с\n🎙 Голосовых: ${stats.voiceMessages}\n📎 Файлов: ${stats.files}\n❌ Ошибок: ${stats.errors}\n🧠 AI: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}\n🤖 Модель: ${uc.model}`);
    return;
  }

  if (text.startsWith('/system ')) {
    uc.systemPrompt = text.slice(8).trim();
    saveUserConfig(chatId);
    send(chatId, `✅ Системный промпт: ${uc.systemPrompt}`);
    return;
  }
  if (text === '/clear_system') { uc.systemPrompt = ''; saveUserConfig(chatId); send(chatId, '✅ Системный промпт сброшен'); return; }

  if (text.startsWith('/parse ')) { processSmartSetup(chatId, text.slice(7)); return; }
  if (text === '/parse') { send(chatId, '🧠 Опишите что парсить. Например:\n/parse Следи за @durov, присылай только анонсы обновлений кратко'); return; }

  if (text === '/channels') {
    if (!isAdmin(chatId)) { send(chatId, '❌ Только для администраторов'); return; }
    const count = config.channels ? config.channels.length : 0;
    const active = config.channels ? config.channels.filter(c => c.enabled).length : 0;
    send(chatId, `📡 Мониторинг каналов\n\nВсего: ${count} | Активных: ${active}`, channelsMenu());
    return;
  }

  if (text === '/auth') {
    if (!isAdmin(chatId)) { send(chatId, '❌ Только для администраторов'); return; }
    if (mtConnected) { send(chatId, `✅ MTProto уже авторизован!`, mainMenu(chatId)); }
    else if (!apiId || !apiHash) { send(chatId, '❌ TG_API_ID и TG_API_HASH не заданы в .env'); }
    else { send(chatId, '📱 Введите номер телефона (формат +77001234567):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'auth_cancel' }]] } }); waitingAuthPhone.add(chatId); }
    return;
  }

  if (text.startsWith('/addch ')) {
    if (!isAdmin(chatId)) { send(chatId, '❌ Только для администраторов'); return; }
    let username = text.slice(7).trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/\/$/, '').split('/')[0];
    if (!username || username.length < 2) { send(chatId, '❌ Используйте: /addch username'); return; }
    addChannel(chatId, username);
    return;
  }

  if (text === '/git') { if (!isAdmin(chatId)) { send(chatId, '❌ Только для администраторов'); return; } runGit(chatId); return; }
  if (text === '/ps') { if (!isAdmin(chatId)) { send(chatId, '❌ Только для администраторов'); return; } runPs(chatId); return; }
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
console.log(`🔧 Per-user config system enabled`);
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
  { command: 'skills', description: 'Навыки' },
  { command: 'skill', description: 'Навык: /skill имя промпт | edit | info' },
  { command: 'agents', description: 'Мульти-агенты' },
]});

tick();
