require('dotenv').config();
const { execSync, execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// === Глобальный обработчик необработанных rejected промисов ===
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

// === Rate limiter для callback queries ===
const rateLimitMap = new Map();
function isRateLimited(chatId) {
  const now = Date.now();
  if (now - (rateLimitMap.get(chatId) || 0) < 500) return true;
  rateLimitMap.set(chatId, now);
  return false;
}

// === Безопасный parseInt ===
function safeParseInt(str) {
  const n = parseInt(str, 10);
  return isNaN(n) ? -1 : n;
}

// === Парсинг негативного промпта (--no <текст>) ===
function parseNegativePrompt(text) {
  const match = text.match(/^([\s\S]*?)\s+--no\s+([\s\S]+)$/i);
  if (match) return { prompt: match[1].trim(), negativePrompt: match[2].trim() };
  return { prompt: text, negativePrompt: null };
}
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
const GEMINI_CLI_PATH = process.env.GEMINI_CLI_PATH || '/opt/homebrew/bin/gemini';
let tmpCounter = 0;

// === Мультимодельный AI провайдер ===
const MODEL_MAP = {
  // Anthropic
  'claude-sonnet': 'claude-sonnet-4-6-20250514',
  'claude-opus': 'claude-opus-4-6',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  // Google CLI
  'gemini-cli': 'gemini-cli',
  // OpenAI
  'gpt-5.2': 'gpt-5.2',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4.1-mini': 'gpt-4.1-mini',
  'gpt-4.1-nano': 'gpt-4.1-nano',
  'o3': 'o3',
  'o4-mini': 'o4-mini',
  // Google Gemini
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-tools': 'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash': 'gemini-3.1-flash-preview',
  // Groq
  'llama-70b': 'llama-3.3-70b-versatile',
  'llama-scout': 'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-maverick': 'meta-llama/llama-4-maverick-17b-128e-instruct',
  'deepseek-r1': 'deepseek-r1-distill-llama-70b',
  'qwen-qwq': 'qwen-qwq-32b',
  'qwen3-32b': 'qwen/qwen3-32b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
};

const PROVIDER_MODELS = {
  anthropic: [
    { id: 'claude-sonnet', label: 'Sonnet 4.6' },
    { id: 'claude-opus', label: 'Opus 4.6' },
    { id: 'claude-haiku', label: 'Haiku 4.5' },
  ],
  'google-cli': [
    { id: 'gemini-cli', label: 'Gemini CLI ✨' },
  ],
  openai: [
    { id: 'gpt-5.2', label: 'GPT-5.2 ✨' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano ⚡' },
    { id: 'o3', label: 'o3 Reasoning' },
    { id: 'o4-mini', label: 'o4-mini Reasoning ⚡' },
  ],
  google: [
    { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: '2.5 Flash Lite ⚡' },
    { id: 'gemini-3.1-pro', label: '3.1 Pro ✨' },
    { id: 'gemini-3.1-pro-tools', label: '3.1 Pro Tools' },
    { id: 'gemini-3.1-flash', label: '3.1 Flash' },
    { id: 'gemini-3-flash', label: '3 Flash' },
  ],
  groq: [
    { id: 'llama-maverick', label: 'Llama 4 Maverick ✨' },
    { id: 'llama-scout', label: 'Llama 4 Scout' },
    { id: 'llama-70b', label: 'Llama 3.3 70B' },
    { id: 'deepseek-r1', label: 'DeepSeek R1 70B' },
    { id: 'qwen-qwq', label: 'Qwen QwQ 32B' },
    { id: 'qwen3-32b', label: 'Qwen3 32B' },
    { id: 'gpt-oss-20b', label: 'GPT-OSS 20B' },
  ],
};

const PROVIDER_LABELS = { anthropic: '🟣 Anthropic', 'google-cli': '🔵 Google (CLI)', openai: '🟢 OpenAI', google: '🔵 Google', groq: '⚡ Groq' };

const IMAGE_MODELS = {
  'nano-banana': { id: 'gemini-2.5-flash-preview-image-generation', label: 'Nano Banana', desc: 'Быстрая генерация' },
  'nano-banana-2': { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2', desc: 'Самая быстрая, ~500мс' },
  'nano-banana-pro': { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro', desc: '4K, мульти-фото' },
  'imagen-3': { id: 'imagen-3.0-generate-002', label: 'Imagen 3', desc: 'Фотореалистичные' },
  'imagen-3-fast': { id: 'imagen-3.0-fast-generate-001', label: 'Imagen 3 Fast', desc: 'Быстрая фотореалистичная' },
  'imagen-4-fast': { id: 'imagen-4.0-fast-generate-001', label: 'Imagen 4 Fast', desc: 'Новое поколение, быстрая' },
  'imagen-4': { id: 'imagen-4.0-generate-001', label: 'Imagen 4', desc: 'Новое поколение, максимум деталей' },
  'imagen-4-ultra': { id: 'imagen-4.0-ultra-generate-001', label: 'Imagen 4 Ultra', desc: 'Ультра-качество' },
};

const VIDEO_MODELS = {
  'veo-3.1': { id: 'veo-3.1-generate-preview', label: 'Veo 3.1', desc: 'Лучшее качество, до 4K' },
  'veo-3.1-fast': { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', desc: 'Быстрая генерация' },
  'veo-2': { id: 'veo-2.0-generate-001', label: 'Veo 2', desc: 'Стабильная генерация видео' },
};

function getProvider(model) {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model === 'gemini-cli') return 'google-cli';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('llama-') || model.startsWith('deepseek-') || model.startsWith('qwen') || model.startsWith('gpt-oss')) return 'groq';
  if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  return 'anthropic';
}

// === Автоматический fallback моделей ===
const MODEL_FALLBACK_CHAIN = [
  'claude-sonnet',
  'gemini-2.5-pro',
  'gpt-4.1',
  'gemini-2.5-flash',
  'llama-maverick',
  'claude-haiku',
  'llama-70b',
];

function getAvailableFallbackChain(chatId, excludeModel = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const hasGoogle = !!(uc.apiKeys?.google || process.env.GEMINI_API_KEY);
  const hasOpenAI = !!(uc.apiKeys?.openai || process.env.OPENAI_API_KEY);
  const hasGroq = !!(uc.apiKeys?.groq || process.env.GROQ_API_KEY);
  return MODEL_FALLBACK_CHAIN.filter(m => {
    if (m === excludeModel) return false;
    const prov = getProvider(m);
    if (prov === 'anthropic' || prov === 'google-cli') return true;
    if (prov === 'google') return hasGoogle;
    if (prov === 'openai') return hasOpenAI;
    if (prov === 'groq') return hasGroq;
    return false;
  });
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

// === Контекстное понимание запроса ===
// Раскрывает короткие/неоднозначные запросы используя историю диалога и память
function rewriteQuery(chatId, text) {
  const t = text.trim();
  const tLow = t.toLowerCase();
  const history = chatHistory.get(chatId) || [];
  if (history.length < 2) return { text: t, rewritten: false, context: null };

  // Последние 2 пары user/assistant из истории
  const recent = history.slice(-4);
  const lastAssistant = [...recent].reverse().find(h => h.role === 'assistant');
  const lastUser = [...recent].reverse().find(h => h.role === 'user');

  // Определяем тип контекстной ссылки
  let contextType = null;
  let rewritten = t;

  // 1. Указательные местоимения без предмета: "а это?", "что это?", "расскажи подробнее"
  if (/^(а |и |ну |так )?(это|этот|эта|эти|то|тот|та|те|оно)\b/i.test(tLow) && t.length < 50) {
    contextType = 'deictic';
  }

  // 2. Запросы-продолжения: "подробнее", "ещё", "дальше", "продолжай", "а что если"
  if (/^(подробн|ещё|еще|дальше|продолж|больше деталей|расскажи больше|expand|continue|more|go on|а что если)/i.test(tLow)) {
    contextType = 'continuation';
  }

  // 3. Запрос перевода без текста: "а на русский?", "переведи на английский", "на японский"
  if (/^(а )?(на |to )(русск|англ|немец|француз|испан|итальян|китайск|японск|корейск|english|russian|german|french|spanish)/i.test(tLow) && t.length < 60) {
    contextType = 'translate_ref';
  }

  // 4. Коррекция: "нет, я имел в виду...", "не так, а ...", "я про другое"
  if (/^(нет|не так|неправильно|не то|ошибк|я (имел|имела) в виду|я про |я спрашива|i meant|no,? i)/i.test(tLow)) {
    contextType = 'correction';
  }

  // 5. Краткий follow-up с местоимением: "а его?", "а ей?", "сделай с ним"
  if (/\b(его|ей|ему|ним|ней|них|им|её|неё|него|it|them|this|that)\b/i.test(tLow) && t.length < 80 && !contextType) {
    contextType = 'pronoun_ref';
  }

  // 6. Оценка/фидбек предыдущего ответа: "отлично", "не то", "ок, а теперь..."
  if (/^(отлично|супер|класс|круто|хорошо|ок|ok|норм|плохо|не то|не нравится|perfect|great|good|nice)\b/i.test(tLow) && t.length < 15) {
    contextType = 'feedback';
  }

  if (!contextType) return { text: t, rewritten: false, context: null };

  // Собираем контекст для инъекции в промпт
  const lastAssistantText = lastAssistant?.text?.slice(0, 500) || '';
  const lastUserText = lastUser?.text?.slice(0, 300) || '';

  const contextBlock = `[КОНТЕКСТ — для понимания текущего запроса]
Предыдущий запрос пользователя: ${lastUserText}
Предыдущий ответ ассистента: ${lastAssistantText}
Текущий запрос: ${t}
Тип ссылки: ${contextType}
[/КОНТЕКСТ]

${t}`;

  return { text: contextBlock, rewritten: true, context: contextType, original: t };
}

function autoSelectModel(text, autoMap = {}, conversationHistory = []) {
  const t = text.toLowerCase();
  const len = text.length;
  const m = (cat) => autoMap[cat] || AUTO_MODEL_CATEGORIES[cat].default;

  // Изображения/видео — абсолютный приоритет
  if (/нарисуй|сгенерируй.*изображ|создай.*картинк|generate.*image|draw\b|illustration|нарисовать|рисунок|картинк|изображени/.test(t))
    return { model: m('image'), reason: '🎨 Изображение', isImage: true };
  if (/создай.*видео|сгенерируй.*видео|generate.*video|анимац|animate|сделай.*видео|видеоролик/.test(t))
    return { model: m('video'), reason: '🎬 Видео', isVideo: true };

  // Scoring system — каждая категория набирает очки, побеждает максимум
  const scores = { code: 0, math: 0, translate: 0, analysis: 0, creative: 0, quick: 0, general: 1 };

  // Код
  if (/```|`[^`]+`|=>|console\.|print\(/.test(text)) scores.code += 5;
  if (/function\s|class\s|const\s|let\s|var\s|import\s|def\s|return\s|\.(js|ts|py|jsx|tsx|html|css|sql|sh|json|yaml)\b|npm\s|git\s|docker|api\s|endpoint|база данн|database|сервер|бэкенд|фронтенд|backend|frontend/.test(t)) scores.code += 3;
  if (/напиши код|напиши скрипт|напиши функ|write code|write a function|create a script|debug|отлад|исправь (баг|ошибк|код)|fix (bug|code)|реализуй|implement/.test(t)) scores.code += 4;

  // Математика
  if (/посчитай|вычисли|калькул|формул|уравнен|интеграл|производн|матриц|математик|логическ|алгоритм/.test(t)) scores.math += 5;
  if (/\d+[\s]*[+\-*/^]\s*\d+/.test(t)) scores.math += 3;

  // Перевод
  if (/^(переведи|translate|перевод|переведите|переведём)/i.test(t)) scores.translate += 6;
  if (/на (английский|русский|немецкий|французский|испанский|китайский|японский|корейский|арабский)|to (english|russian|german|french|spanish)/i.test(t)) scores.translate += 3;

  // Анализ — градиентный бонус за длину вместо бинарного
  if (/проанализируй|анализ|разбери|объясни подробно|детально|сравни|исследуй|рассмотри|оцени|review|analyze|explain in detail/.test(t)) scores.analysis += 5;
  if (len > 800) scores.analysis += 3;
  else if (len > 500) scores.analysis += 2;
  else if (len > 300) scores.analysis += 1;

  // Креатив — disambiguate с кодом
  if (/напиши|сочини|придумай|создай текст|статью|пост|рассказ|стих|сценарий|письмо|резюме|эссе|story|write|compose/.test(t)) scores.creative += 4;
  if (scores.code >= 3 && /напиши/.test(t)) scores.creative -= 2;

  // Быстрый — обнуляется при наличии код/мат сигналов
  if (/^(привет|здравствуй|хай|ку|хей|спасибо|ок|да|нет|понял|ладно|hi|hello|hey|thanks|ok|yes|no)$/i.test(t.trim())) scores.quick += 6;
  if (len < 30) scores.quick += 3;
  else if (len < 80) scores.quick += 1;
  if (scores.code >= 3 || scores.math >= 3) scores.quick = 0;

  // Усиленный контекст из истории диалога (до +3 за категорию)
  if (conversationHistory.length > 0) {
    const last2 = conversationHistory.slice(-2).map(h => (h.content || h.text || '')).join(' ').toLowerCase();
    const last6 = conversationHistory.slice(-6).map(h => (h.content || h.text || '')).join(' ').toLowerCase();
    // Недавние (последние 2) дают +2, более ранние (6) дают +1
    if (/```|function\s|class\s|const\s|import\s|def\s|=>|console\.|npm\s|git\s/.test(last2)) scores.code += 2;
    else if (/```|function|class|const |import |def /.test(last6)) scores.code += 1;
    if (/формул|уравнен|матриц|\d+[\s]*[+\-*/]\s*\d+|интеграл|производн/.test(last2)) scores.math += 2;
    else if (/формул|уравнен|матриц|\d+[+\-*/]/.test(last6)) scores.math += 1;
    if (/перевед|translat|на (английский|русский|немецкий)|to (english|russian)/.test(last2)) scores.translate += 2;
    if (/проанализ|review|analyze|разбер|сравни/.test(last2)) scores.analysis += 1;
    if (/напиши|сочини|рассказ|story|стих|сценарий/.test(last2)) scores.creative += 1;
    // Контекстное усиление: если текущий запрос короткий и в истории ярко выражена категория → сильный бонус
    if (len < 60) {
      const histCats = { code: 0, math: 0, translate: 0, analysis: 0, creative: 0 };
      for (const h of conversationHistory.slice(-4)) {
        const ht = (h.content || h.text || '').toLowerCase();
        if (/```|function|class|const |def |import |npm|git/.test(ht)) histCats.code++;
        if (/формул|уравнен|матриц|посчитай|вычисли/.test(ht)) histCats.math++;
        if (/перевед|translat/.test(ht)) histCats.translate++;
        if (/анализ|review|analyze/.test(ht)) histCats.analysis++;
        if (/напиши|сочини|story|рассказ/.test(ht)) histCats.creative++;
      }
      const dominantCat = Object.entries(histCats).reduce((best, [c, v]) => v > best.v ? { c, v } : best, { c: null, v: 0 });
      if (dominantCat.v >= 2 && dominantCat.c) scores[dominantCat.c] += 3;
    }
  }

  // Победитель — максимальный score
  const winner = Object.entries(scores).reduce((best, [cat, score]) =>
    score > best.score ? { cat, score } : best,
    { cat: 'general', score: 0 }
  );

  const reasonMap = { code: '💻 Код', math: '🔢 Математика', translate: '🌐 Перевод', analysis: '🧠 Анализ', creative: '✍️ Текст', quick: '⚡ Быстрый', general: '💬 Общий' };
  return { model: m(winner.cat), reason: reasonMap[winner.cat] || '💬 Общий', category: winner.cat };
}

// Трекинг производительности категории → модели (самообучение)
function trackCategorySuccess(chatId, category, model, ms, success) {
  const uc = getUserConfig(chatId);
  if (!uc.categoryPerf) uc.categoryPerf = {};
  const key = `${category}:${model}`;
  if (!uc.categoryPerf[key]) uc.categoryPerf[key] = { successes: 0, failures: 0, totalMs: 0, count: 0 };
  const perf = uc.categoryPerf[key];
  perf.count++;
  perf.totalMs += ms || 0;
  if (success) perf.successes++;
  else perf.failures++;
  // Лимит: если >100 ключей, удаляем наименее используемые
  const keys = Object.keys(uc.categoryPerf);
  if (keys.length > 100) {
    keys.sort((a, b) => (uc.categoryPerf[a].count || 0) - (uc.categoryPerf[b].count || 0));
    for (let i = 0; i < keys.length - 80; i++) delete uc.categoryPerf[keys[i]];
  }
  // Сохраняем каждые 3 вызова
  if (perf.count % 3 === 0) saveUserConfig(chatId);
}

// Хелпер: собрать контекстную строку из массива сообщений
function buildContextString(messages) {
  if (messages.length === 1) return messages[0].content;
  let ctx = 'Предыдущие сообщения в диалоге:\n';
  for (let i = 0; i < messages.length - 1; i++) {
    ctx += `${messages[i].role === 'user' ? 'Пользователь' : 'Ассистент'}: ${messages[i].content}\n`;
  }
  ctx += `\nТекущее сообщение пользователя:\n${messages[messages.length - 1].content}`;
  return ctx;
}

// Хелпер: собрать CLI аргументы и промпт для Claude
function buildClaudeCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs = []) {
  const cliModelMap = { 'claude-sonnet-4-6-20250514': 'sonnet', 'claude-opus-4-6': 'opus', 'claude-haiku-4-5-20251001': 'haiku' };
  const cliModel = cliModelMap[modelId] || modelId;

  const prompt = buildContextString(messages);

  const mcpSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const args = ['-p', ...extraArgs, '--model', cliModel, '--dangerously-skip-permissions'];
  if (allowMcp) {
    const userMcpServers = chatId ? (getUserConfig(chatId).mcpServers || []).filter(s => s.enabled !== false) : [];
    if (userMcpServers.length > 0 || fs.existsSync(mcpSettingsPath)) {
      let mergedConfig = {};
      if (fs.existsSync(mcpSettingsPath)) {
        try { mergedConfig = JSON.parse(fs.readFileSync(mcpSettingsPath, 'utf8')); } catch(e) {}
      }
      if (userMcpServers.length > 0) {
        if (!mergedConfig.mcpServers) mergedConfig.mcpServers = {};
        for (const s of userMcpServers) {
          const mcpHeaders = {};
          if (s.apiKey) {
            const at = (s.authType || 'auto').toLowerCase();
            const k = s.apiKey.trim();
            if (at === 'x-api-key') mcpHeaders['x-api-key'] = k;
            else if (at === 'api-key') mcpHeaders['api-key'] = k;
            else if (at === 'custom' && k.includes(':')) {
              const ci = k.indexOf(':');
              mcpHeaders[k.slice(0, ci).trim()] = k.slice(ci + 1).trim();
            } else mcpHeaders['Authorization'] = k.toLowerCase().startsWith('bearer ') ? k : `Bearer ${k}`;
          }
          mergedConfig.mcpServers[s.id] = {
            type: 'url',
            url: s.url,
            ...(Object.keys(mcpHeaders).length > 0 ? { headers: mcpHeaders } : {}),
          };
        }
        const tmpPath = path.join('/tmp', `mcp_${chatId || 'default'}_${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(mergedConfig));
        args.push('--mcp-config', tmpPath);
        setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch(e) {} }, 300000);
      } else {
        args.push('--mcp-config', mcpSettingsPath);
      }
    }
  }
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  return { args, prompt };
}

async function callAnthropic(modelId, messages, systemPrompt, allowMcp = true, chatId = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const { args, prompt } = buildClaudeCliArgs(modelId, messages, systemPrompt, allowMcp, chatId);

  return new Promise((resolve, reject) => {

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Claude CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) reject(new Error(stderr.trim() || `Claude CLI exit code ${code}`));
      else resolve({ text: stdout.trim() || 'Готово (без вывода)', usage: null });
    });
  });
}

async function callOpenAI(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.openai || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096 }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty response');
  return { text, usage: data.usage };
}

async function callGemini(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.google || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents, generationConfig: { maxOutputTokens: 4096 } };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text && data.candidates?.[0]?.finishReason === 'SAFETY') throw new Error('Заблокировано фильтром безопасности');
  return { text, usage: data.usageMetadata };
}

async function callGroqChat(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.groq || process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY не задан');
  const timeout = Math.min((uc.timeout || 120) * 1000, 60000); // Groq быстрый, макс 60с
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096 }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty response');
  return { text, usage: data.usage };
}

async function callAI(model, messages, systemPrompt, allowMcp = true, chatId = null) {
  const start = Date.now();
  const provider = getProvider(model);
  const modelId = MODEL_MAP[model] || model;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropic(modelId, messages, systemPrompt, allowMcp, chatId); break;
    case 'google-cli': result = await callGeminiCLI(modelId, messages, systemPrompt, allowMcp, chatId); break;
    case 'openai': result = await callOpenAI(modelId, messages, systemPrompt, chatId); break;
    case 'google': result = await callGemini(modelId, messages, systemPrompt, chatId); break;
    case 'groq': result = await callGroqChat(modelId, messages, systemPrompt, chatId); break;
    default: throw new Error(`Неизвестный провайдер: ${model}`);
  }
  return { ...result, ms: Date.now() - start, provider, model };
}

function buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs = []) {
  let prompt = buildContextString(messages);
  if (systemPrompt) {
      prompt = `System instructions:\n${systemPrompt}\n\nUser prompt:\n${prompt}`;
  }
  const args = ['-p', '-y', ...extraArgs];
  if (modelId === 'gemini-cli') {
    args.push('--model', 'gemini-2.5-pro');
  } else {
    args.push('--model', modelId);
  }
  return { args, prompt };
}

async function callGeminiCLI(modelId, messages, systemPrompt, allowMcp = true, chatId = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const { args, prompt } = buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId);

  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(GEMINI_CLI_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Gemini CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `Gemini CLI exit code ${code}`));
      else resolve({ text: stdout.trim() || 'Готово (без вывода)', usage: null });
    });
  });
}

async function callGeminiCLIStream(modelId, messages, systemPrompt, onChunk, allowMcp = true, chatId = null, onEvent = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const useStreamJson = !!onEvent;
  const extraArgs = useStreamJson ? ['-o', 'stream-json'] : [];
  const { args, prompt } = buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs);

  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(GEMINI_CLI_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Gemini CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let finalText = '';
    let stderr = '';
    let durationMs = null;
    let turns = 0;

    if (useStreamJson) {
      let lineBuf = '';
      child.stdout.on('data', (d) => {
        lineBuf += d.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim() || !line.startsWith('{')) continue;
          try {
            const event = JSON.parse(line);
            
            if (event.type === 'message' && event.role === 'assistant' && event.content) {
              if (onEvent) onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: event.content }] } });
              finalText += event.content;
              if (onChunk) onChunk(finalText);
            } else if (event.type === 'tool_use') {
              turns++;
              if (onEvent) onEvent({ 
                type: 'assistant', 
                message: { content: [{ type: 'tool_use', name: event.tool_name, input: event.parameters }] } 
              });
            } else if (event.type === 'tool_result') {
              if (onEvent) onEvent({
                type: 'tool_result',
                is_error: event.status === 'error'
              });
            } else if (event.type === 'result') {
              if (event.stats) {
                durationMs = event.stats.duration_ms || null;
              }
              if (onEvent) onEvent({ type: 'result', duration_ms: durationMs, num_turns: turns, cost_usd: 0 });
            }
          } catch (e) { /* skip malformed JSON */ }
        }
      });
    } else {
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d;
        if (onChunk) onChunk(stdout.trim());
        finalText = stdout;
      });
    }

    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !finalText.trim()) reject(new Error(stderr.trim() || `Код ${code}`));
      else resolve({
        text: finalText.trim() || 'Готово (без вывода)',
        usage: { duration_ms: durationMs, num_turns: turns, cost_usd: null }
      });
    });
  });
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

// === Helpers для парсинга stream-json от Claude CLI ===
function extractTextFromEvent(event) {
  if (event.type === 'assistant' && event.message?.content) {
    return event.message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return '';
}

function formatToolDetail(toolName, input) {
  if (!input) return '';
  if (toolName === 'Bash' && input.command) return input.command.length > 120 ? input.command.slice(0, 117) + '...' : input.command;
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && input.file_path) return input.file_path;
  if (toolName === 'Glob' && input.pattern) return input.pattern;
  if (toolName === 'Grep' && input.pattern) return `/${input.pattern}/`;
  if (toolName.startsWith('mcp_')) return toolName.replace(/^mcp__/, '').replace(/__/g, ' > ');
  if (typeof input === 'string') return input.slice(0, 120);
  return JSON.stringify(input).slice(0, 120);
}

async function callAnthropicStream(modelId, messages, systemPrompt, onChunk, allowMcp = true, chatId = null, onEvent = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const useStreamJson = !!onEvent;
  const extraArgs = useStreamJson ? ['--output-format', 'stream-json'] : [];
  const { args, prompt } = buildClaudeCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs);

  return new Promise((resolve, reject) => {

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Claude CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let finalText = '';
    let stderr = '';
    let costUsd = null;
    let durationMs = null;
    let numTurns = null;

    if (useStreamJson) {
      let lineBuf = '';
      child.stdout.on('data', (d) => {
        lineBuf += d.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (onEvent) onEvent(event);
            const text = extractTextFromEvent(event);
            if (text) {
              finalText += text;
              if (onChunk) onChunk(finalText);
            }
            if (event.type === 'result') {
              if (event.result) finalText = event.result;
              costUsd = event.cost_usd || null;
              durationMs = event.duration_ms || null;
              numTurns = event.num_turns || null;
            }
          } catch (e) { /* skip malformed JSON */ }
        }
      });
    } else {
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d;
        if (onChunk) onChunk(stdout.trim());
        finalText = stdout;
      });
    }

    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !finalText.trim()) reject(new Error(stderr.trim() || `Код ${code}`));
      else resolve({
        text: finalText.trim() || 'Готово (без вывода)',
        usage: costUsd !== null ? { cost_usd: costUsd, duration_ms: durationMs, num_turns: numTurns } : null
      });
    });
  });
}

async function callOpenAIStream(modelId, messages, systemPrompt, onChunk, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.openai || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096, stream: true }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.choices?.[0]?.delta?.content || '', onChunk);
  return { text: text || 'Готово (без вывода)', usage: null };
}

async function callGeminiStream(modelId, messages, systemPrompt, onChunk, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.google || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents, generationConfig: { maxOutputTokens: 4096 } };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.candidates?.[0]?.content?.parts?.[0]?.text || '', onChunk);
  if (!text) throw new Error('Пустой ответ от Gemini');
  return { text, usage: null };
}

async function callGroqStream(modelId, messages, systemPrompt, onChunk, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.groq || process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY не задан');
  const timeout = Math.min((uc.timeout || 120) * 1000, 60000);
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096, stream: true }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.choices?.[0]?.delta?.content || '', onChunk);
  return { text: text || 'Готово (без вывода)', usage: null };
}

async function callAIStream(model, messages, systemPrompt, onChunk, allowMcp = true, chatId = null, onEvent = null) {
  const start = Date.now();
  const provider = getProvider(model);
  const modelId = MODEL_MAP[model] || model;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropicStream(modelId, messages, systemPrompt, onChunk, allowMcp, chatId, onEvent); break;
    case 'google-cli': result = await callGeminiCLIStream(modelId, messages, systemPrompt, onChunk, allowMcp, chatId, onEvent); break;
    case 'openai': result = await callOpenAIStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    case 'google': result = await callGeminiStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    case 'groq': result = await callGroqStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    default: throw new Error(`Неизвестный провайдер: ${model}`);
  }
  return { ...result, ms: Date.now() - start, provider, model };
}

// === AI вызов с автоматическим fallback ===
async function callAIWithFallback(primaryModel, messages, systemPrompt, chatId, opts = {}) {
  const { allowMcp = true, onFallback = null } = opts;
  const chain = [primaryModel, ...getAvailableFallbackChain(chatId, primaryModel)];
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const result = await callAI(model, messages, systemPrompt, allowMcp, chatId);
      return {
        ...result,
        fallbackUsed: model !== primaryModel,
        originalModel: primaryModel,
        actualModel: model,
      };
    } catch (e) {
      lastError = e;
      const nextModel = i + 1 < chain.length ? chain[i + 1] : null;
      console.log(`⚠️ Fallback: ${model} → ${e.message.slice(0, 80)}${nextModel ? `, пробую ${nextModel}` : ', модели исчерпаны'}`);
      if (onFallback && nextModel) onFallback(model, nextModel, e.message);
    }
  }
  throw lastError || new Error('Все модели недоступны');
}

async function callAIStreamWithFallback(primaryModel, messages, systemPrompt, onChunk, chatId, opts = {}) {
  const { allowMcp = true, onFallback = null, onEvent = null } = opts;
  const chain = [primaryModel, ...getAvailableFallbackChain(chatId, primaryModel)];
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const result = await callAIStream(model, messages, systemPrompt, onChunk, allowMcp, chatId, onEvent);
      return {
        ...result,
        fallbackUsed: model !== primaryModel,
        originalModel: primaryModel,
        actualModel: model,
      };
    } catch (e) {
      lastError = e;
      const nextModel = i + 1 < chain.length ? chain[i + 1] : null;
      console.log(`⚠️ Stream Fallback: ${model} → ${e.message.slice(0, 80)}${nextModel ? `, пробую ${nextModel}` : ', модели исчерпаны'}`);
      if (onFallback && nextModel) onFallback(model, nextModel, e.message);
    }
  }
  throw lastError || new Error('Все модели недоступны');
}

// === Защита от двойного запуска ===
if (fs.existsSync(PID_FILE)) {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  if (!isNaN(oldPid) && oldPid > 0) {
    try { process.kill(oldPid, 0); console.log(`⛔ Убиваю старый бот (PID ${oldPid})`); process.kill(oldPid); } catch(e) {}
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch(e) {} });

// === Конфигурация ===
// Глобальный конфиг (API ключи, MTProto, polling — общие для всех)
const defaultGlobalConfig = { mtprotoSession: '', channels: [], monitorInterval: 60, reminders: [] };
let config = { ...defaultGlobalConfig };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...defaultGlobalConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch (e) { console.warn('Failed to parse config:', CONFIG_PATH, e.message); }
}
let _saveConfigTimer = null;
function saveConfig() {
  if (_saveConfigTimer) clearTimeout(_saveConfigTimer);
  _saveConfigTimer = setTimeout(() => {
    _saveConfigTimer = null;
    fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2)).catch(e => console.error('saveConfig error:', e));
  }, 1000);
}
function flushConfig() {
  if (_saveConfigTimer) { clearTimeout(_saveConfigTimer); _saveConfigTimer = null; fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
}

// Per-user конфиг (настройки, шаблоны, режимы — у каждого свои)
const USER_CONFIGS_PATH = path.join(__dirname, 'users.json');
const AUTO_MODEL_CATEGORIES = {
  image: { label: '🎨 Изображение', default: 'nano-banana' },
  video: { label: '🎬 Видео', default: 'veo-3.1-fast' },
  code: { label: '💻 Код', default: 'claude-sonnet' },
  math: { label: '🔢 Математика', default: 'gemini-2.5-pro' },
  translate: { label: '🌐 Перевод', default: 'gemini-2.5-flash' },
  analysis: { label: '🧠 Анализ', default: 'gemini-2.5-pro' },
  creative: { label: '✍️ Текст', default: 'claude-sonnet' },
  quick: { label: '⚡ Быстрый', default: 'llama-70b' },
  general: { label: '💬 Общий', default: 'gemini-2.5-flash' },
};
const defaultUserConfig = { model: 'claude-haiku', workDir: '/tmp', timeout: 300, historySize: 20, systemPrompt: '', language: '', skills: [], pins: [], autoModel: false, streaming: true, agentMode: true, agentMaxSteps: 10, multiAgent: true, role: 'user', banned: false, customAgents: [], apiKeys: {}, imageModel: 'nano-banana', imageAspect: '1:1', imageSize: '1K', videoModel: 'veo-3.1-fast', videoResolution: '720p', videoAspect: '16:9', videoDuration: '8', memory: [], memoryEnabled: true, memoryAutoExtract: true, autoModelMap: {}, modelStats: {}, categoryPerf: {}, mcpServers: [], activeMode: null };
const userConfigs = new Map(); // chatId -> config

const SKILL_CATEGORIES = [
  { id: 'code', label: '💻 Код' },
  { id: 'text', label: '✍️ Текст' },
  { id: 'analysis', label: '🔍 Анализ' },
  { id: 'other', label: '📦 Другое' },
];

// === Мульти-агентная система ===
const AGENT_ROLES = {
  orchestrator: { icon: '🎯', label: 'Оркестратор', desc: 'Координирует субагентов, декомпозирует задачи' },
  coder: { icon: '💻', label: 'Кодер', desc: 'Пишет и модифицирует код' },
  researcher: { icon: '🔍', label: 'Аналитик', desc: 'Исследует, анализирует, ищет информацию' },
  reviewer: { icon: '🔎', label: 'Ревьюер', desc: 'Проверяет качество, находит ошибки' },
  writer: { icon: '✍️', label: 'Писатель', desc: 'Создаёт тексты, документацию' },
  executor: { icon: '⚡', label: 'Исполнитель', desc: 'Выполняет bash-команды и системные действия' },
  python_dev: { icon: '🐍', label: 'Python-разработчик', desc: 'Пишет код на Python, скрипты, автоматизацию' },
  web_dev: { icon: '🌐', label: 'Веб-разработчик', desc: 'Frontend/Backend, HTML/CSS/JS, React, Node.js' },
  data_analyst: { icon: '📊', label: 'Аналитик данных', desc: 'Анализ данных, статистика, визуализации' },
  devops: { icon: '🔧', label: 'DevOps-инженер', desc: 'CI/CD, Docker, серверы, инфраструктура' },
  security: { icon: '🔒', label: 'Безопасник', desc: 'Аудит безопасности, OWASP, hardening, пентест' },
  technical_writer: { icon: '📝', label: 'Техписатель', desc: 'Документация, README, API docs, гайды' },
  seo: { icon: '🔍', label: 'SEO-специалист', desc: 'SEO-оптимизация, мета-теги, аудит сайта' },
  social_media: { icon: '📱', label: 'SMM-менеджер', desc: 'SMM, контент-планы, аналитика соцсетей' },
  content_creator: { icon: '✍️', label: 'Контент-мейкер', desc: 'Копирайтинг, сторителлинг, статьи' },
  translator: { icon: '🌍', label: 'Переводчик', desc: 'Мультиязычный перевод, локализация' },
  ux_ui_designer: { icon: '🎨', label: 'UX/UI дизайнер', desc: 'Прототипы, дизайн-системы, доступность' },
};

const PRESET_AGENTS = [
  { id: 'python_dev', icon: '🐍', label: 'Python-разработчик', desc: 'Пишет код на Python, скрипты, автоматизацию', prompt: 'Ты — Python-разработчик. Специализируешься на написании чистого, эффективного Python-кода. Создаёшь скрипты, автоматизацию, работаешь с API и данными. Всегда пишешь типизированный код с обработкой ошибок.', maxSteps: 3 },
  { id: 'web_dev', icon: '🌐', label: 'Веб-разработчик', desc: 'Frontend/Backend, HTML/CSS/JS, React, Node.js', prompt: 'Ты — веб-разработчик. Специализируешься на создании и модификации веб-приложений. Работаешь с HTML, CSS, JavaScript, React, Node.js. Пишешь адаптивный, доступный код.', maxSteps: 3 },
  { id: 'data_analyst', icon: '📊', label: 'Аналитик данных', desc: 'Анализирует данные, строит отчёты, визуализации', prompt: 'Ты — аналитик данных. Анализируешь данные, находишь паттерны и аномалии, строишь отчёты. Представляешь результаты структурированно с выводами и рекомендациями.', maxSteps: 3 },
  { id: 'devops', icon: '🔧', label: 'DevOps-инженер', desc: 'CI/CD, Docker, серверы, инфраструктура', prompt: 'Ты — DevOps-инженер. Настраиваешь серверы, CI/CD пайплайны, Docker-контейнеры. Оптимизируешь инфраструктуру, мониторинг и деплой. Приоритет — безопасность и надёжность.', maxSteps: 4 },
  { id: 'security', icon: '🔒', label: 'Безопасник', desc: 'Аудит безопасности, OWASP, hardening, шифрование, пентест', prompt: 'Ты — специалист по кибербезопасности. Проводишь аудит кода и инфраструктуры, находишь уязвимости (OWASP Top 10), настраиваешь hardening, шифрование, анализируешь угрозы. Предлагаешь конкретные исправления с приоритетом по критичности.', maxSteps: 3 },
  { id: 'technical_writer', icon: '📝', label: 'Техписатель', desc: 'Документация, README, API docs, гайды, спецификации', prompt: 'Ты — технический писатель. Создаёшь понятную документацию, README файлы, API документацию, гайды, туториалы, changelog и архитектурные решения (ADR). Пишешь структурированно с примерами кода.', maxSteps: 2 },
  { id: 'seo', icon: '🔍', label: 'SEO-специалист', desc: 'SEO-оптимизация, мета-теги, ключевые слова, аудит сайта', prompt: 'Ты — SEO-специалист. Оптимизируешь сайты для поисковых систем: мета-теги, структура, ключевые слова, технический SEO, Schema.org разметка, контент-план для органического трафика. Проводишь SEO-аудиты и даёшь конкретные рекомендации с приоритетами.', maxSteps: 3 },
  { id: 'social_media', icon: '📱', label: 'SMM-менеджер', desc: 'SMM, контент-планы, вовлечение, аналитика соцсетей', prompt: 'Ты — SMM-менеджер. Разрабатываешь стратегии для соцсетей (Telegram, Instagram, TikTok, YouTube), создаёшь контент-планы, анализируешь метрики вовлечения, оптимизируешь охват и конверсию. Работаешь с трендами и алгоритмами платформ.', maxSteps: 3 },
  { id: 'content_creator', icon: '✍️', label: 'Контент-мейкер', desc: 'Копирайтинг, сторителлинг, статьи, сценарии', prompt: 'Ты — контент-креатор. Создаёшь тексты, статьи, сценарии, промпты для генерации медиа, email-рассылки. Владеешь копирайтингом, сторителлингом, адаптируешь тон под аудиторию. Пишешь цепляющий контент с чёткой структурой.', maxSteps: 3 },
  { id: 'translator', icon: '🌍', label: 'Переводчик', desc: 'Мультиязычный перевод, локализация, адаптация', prompt: 'Ты — профессиональный переводчик и локализатор. Переводишь тексты между языками с сохранением стиля и контекста. Адаптируешь контент под культурные особенности целевой аудитории. Работаешь с технической, маркетинговой и художественной лексикой.', maxSteps: 2 },
  { id: 'ux_ui_designer', icon: '🎨', label: 'UX/UI дизайнер', desc: 'Прототипы, дизайн-системы, доступность, компоненты', prompt: 'Ты — UX/UI дизайнер. Проектируешь пользовательские интерфейсы, создаёшь wireframes и прототипы, разрабатываешь дизайн-системы. Следишь за доступностью (WCAG), юзабилити и консистентностью. Описываешь компоненты, стили и взаимодействия.', maxSteps: 3 },
];

// === Специализированные режимы (переключаемые пользователем) ===
const SPECIALIZED_MODES = {
  coder: {
    id: 'coder', icon: '💻', label: 'Кодер', category: 'dev',
    desc: 'Универсальный программист — архитектура, алгоритмы, отладка, оптимизация',
    prompt: `Ты — Senior-разработчик с 15+ лет опыта. Твоя специализация — написание чистого, эффективного, production-ready кода.

ПРИНЦИПЫ:
- Clean Code: понятные имена, малые функции, единственная ответственность (SRP)
- SOLID, DRY, KISS — не как догма, а как инструменты
- Defensive programming: валидация входов, обработка edge cases, graceful degradation
- Performance-first: O(n) важнее O(n²), но premature optimization — зло

СТИЛЬ РАБОТЫ:
1. Сначала проанализируй задачу — архитектура важнее кода
2. Предложи 2-3 подхода с trade-offs если задача неоднозначная
3. Пиши код с комментариями для нетривиальных решений
4. Всегда обрабатывай ошибки и edge cases
5. Предлагай тесты для критичной логики

ФОРМАТИРОВАНИЕ:
- Код в блоках с указанием языка
- Объяснения кратко и по делу
- Если нужен рефакторинг — покажи before/after`
  },
  python_dev: {
    id: 'python_dev', icon: '🐍', label: 'Python-разработчик', category: 'dev',
    desc: 'Python, скрипты, автоматизация, ML, API, FastAPI, Django',
    prompt: `Ты — Python-разработчик с глубоким знанием экосистемы. Специализация: автоматизация, API, data pipelines, ML.

СТЕК:
- Web: FastAPI, Flask, Django, aiohttp
- Data: pandas, numpy, polars, dask
- ML/AI: scikit-learn, PyTorch, transformers, langchain
- Async: asyncio, aiohttp, uvloop
- Testing: pytest, hypothesis, unittest
- Tools: poetry, ruff, mypy, black

ПРИНЦИПЫ:
- Type hints ВЕЗДЕ (Python 3.10+ syntax: X | None вместо Optional[X])
- Dataclasses/Pydantic для структурированных данных
- Context managers для ресурсов
- Generators для больших данных
- f-strings, not .format() or %

СТИЛЬ:
- PEP 8 + PEP 257 (docstrings)
- Pythonic idioms: list comprehensions, walrus operator, structural pattern matching
- Логирование через logging, не print()
- Всегда обрабатывай исключения конкретно (не except Exception)`
  },
  web_dev: {
    id: 'web_dev', icon: '🌐', label: 'Веб-разработчик', category: 'dev',
    desc: 'Frontend/Backend, React, Next.js, Node.js, TypeScript, API',
    prompt: `Ты — Full-stack веб-разработчик. Специализация: современные веб-приложения, SPA/SSR, API дизайн.

FRONTEND СТЕК:
- React 19+, Next.js 15+, TypeScript strict mode
- Tailwind CSS, CSS Modules, Styled Components
- Zustand/Jotai для стейта, React Query для серверного стейта
- Framer Motion для анимаций
- Zod для валидации

BACKEND СТЕК:
- Node.js, Express/Fastify, Hono
- PostgreSQL, Redis, Prisma/Drizzle ORM
- REST + OpenAPI / GraphQL / tRPC
- JWT, OAuth2, session-based auth

ПРИНЦИПЫ:
- Mobile-first, адаптивный дизайн
- Core Web Vitals: LCP < 2.5s, FID < 100ms, CLS < 0.1
- Accessibility (WCAG 2.1 AA минимум)
- SEO: семантический HTML, meta tags, structured data
- Security: CORS, CSP, XSS protection, SQL injection prevention

СТИЛЬ:
- Компоненты: маленькие, переиспользуемые, с TypeScript props
- API: версионирование, пагинация, error responses по RFC 7807
- Всегда показывай структуру файлов проекта`
  },
  data_analyst: {
    id: 'data_analyst', icon: '📊', label: 'Аналитик данных', category: 'analysis',
    desc: 'Анализ данных, визуализации, статистика, SQL, BI-отчёты',
    prompt: `Ты — Senior Data Analyst. Превращаешь сырые данные в actionable insights.

ИНСТРУМЕНТЫ:
- SQL (PostgreSQL, ClickHouse, BigQuery)
- Python: pandas, matplotlib, seaborn, plotly
- BI: Metabase, Superset, Looker, Tableau
- Статистика: scipy, statsmodels, A/B тестирование

ПОДХОД К АНАЛИЗУ:
1. Понимание бизнес-вопроса — что хотим узнать?
2. Аудит данных: качество, пропуски, выбросы, распределения
3. EDA: распределения, корреляции, тренды, сезонность
4. Гипотезы и проверка: статистическая значимость
5. Визуализация: правильный тип графика для типа данных
6. Выводы: конкретные рекомендации, не "нужно больше данных"

ПРАВИЛА ВИЗУАЛИЗАЦИИ:
- Bar chart для категорий, line chart для трендов
- Не pie charts (если >5 категорий — bar)
- Аннотации на графиках: подписи осей, заголовки, единицы
- Цветовая палитра: доступная для дальтоников

МЕТРИКИ:
- Retention, Churn, LTV, CAC, ARPU, DAU/MAU
- Когортный анализ, воронки, RFM-сегментация
- A/B тесты: размер выборки, p-value, confidence interval`
  },
  devops: {
    id: 'devops', icon: '🔧', label: 'DevOps-инженер', category: 'dev',
    desc: 'Docker, CI/CD, Kubernetes, мониторинг, инфраструктура',
    prompt: `Ты — DevOps/SRE-инженер. Автоматизация, надёжность, масштабирование.

СТЕК:
- Контейнеры: Docker, Docker Compose, Podman
- Оркестрация: Kubernetes, Helm, ArgoCD
- CI/CD: GitHub Actions, GitLab CI, Jenkins
- IaC: Terraform, Pulumi, Ansible
- Cloud: AWS, GCP, Hetzner, DigitalOcean
- Мониторинг: Prometheus, Grafana, Loki, AlertManager
- Reverse proxy: nginx, Traefik, Caddy

ПРИНЦИПЫ:
- Infrastructure as Code — всё в git
- GitOps flow: PR → review → merge → auto-deploy
- 12-factor app methodology
- Zero-downtime deployments (blue-green, canary)
- Security: least privilege, secrets management (Vault, SOPS)
- Observability: metrics, logs, traces (OpenTelemetry)

СТИЛЬ:
- Dockerfile: multi-stage builds, minimal base images (alpine/distroless)
- docker-compose для dev, K8s для prod
- Health checks, readiness/liveness probes
- Makefile для типичных операций
- Всегда показывай полные конфиги, не фрагменты`
  },
  security: {
    id: 'security', icon: '🔒', label: 'Безопасник', category: 'dev',
    desc: 'Аудит безопасности, OWASP, пентест, hardening, compliance',
    prompt: `Ты — специалист по кибербезопасности (AppSec/InfraSec). Находишь уязвимости и предлагаешь конкретные исправления.

ОБЛАСТИ:
- Application Security: OWASP Top 10, SANS Top 25
- Infrastructure: hardening Linux/containers, network segmentation
- Auth/AuthZ: OAuth2, OIDC, JWT security, RBAC/ABAC
- Crypto: TLS 1.3, AEAD ciphers, key management, hashing (bcrypt/argon2)
- Supply chain: dependency scanning, SBOM, Sigstore

ПОДХОД:
1. Threat modeling: STRIDE, attack surface analysis
2. Код: injection, XSS, CSRF, SSRF, deserialization, path traversal
3. Инфра: открытые порты, misconfiguration, default credentials
4. Данные: encryption at rest/in transit, PII handling, GDPR
5. Приоритизация: CVSS score + business impact

ФОРМАТ ОТЧЁТА:
- 🔴 Critical: немедленное исправление
- 🟠 High: исправить в течение 24ч
- 🟡 Medium: запланировать на спринт
- 🟢 Low: backlog
- Для каждой: описание → impact → remediation → proof of concept`
  },
  technical_writer: {
    id: 'technical_writer', icon: '📝', label: 'Техписатель', category: 'text',
    desc: 'Документация, README, API docs, гайды, ADR, changelog',
    prompt: `Ты — технический писатель. Создаёшь документацию, которую люди РЕАЛЬНО читают и используют.

ТИПЫ ДОКУМЕНТОВ:
- README: hook → quickstart → usage → API → contributing
- API docs: endpoints, request/response, errors, examples (curl + SDK)
- Guides: step-by-step с результатами каждого шага
- ADR (Architecture Decision Records): контекст → решение → последствия
- Changelog: semantic versioning, Keep a Changelog format
- Runbooks: troubleshooting, incident response

ПРИНЦИПЫ:
- "Docs as Code": Markdown, версионирование в git
- Progressive disclosure: от простого к сложному
- Каждый пример должен быть копипастабельным
- Визуальная иерархия: заголовки, списки, code blocks, callouts
- Целевая аудитория: кто читает? новичок? опытный dev?

СТИЛЬ:
- Активный залог: "Запустите команду" (не "Команда должна быть запущена")
- Конкретика: "через 2 минуты" (не "через некоторое время")
- Без жаргона без объяснения
- Примеры > абстрактные описания
- Структура: что → зачем → как → gotchas`
  },
  seo: {
    id: 'seo', icon: '🔍', label: 'SEO-специалист', category: 'marketing',
    desc: 'SEO-оптимизация, семантическое ядро, технический SEO, контент-стратегия',
    prompt: `Ты — SEO-специалист с опытом в техническом и контентном SEO.

ТЕХНИЧЕСКИЙ SEO:
- Core Web Vitals: LCP, FID/INP, CLS — конкретные метрики и фиксы
- Crawlability: robots.txt, sitemap.xml, internal linking
- Indexability: canonical URLs, noindex/nofollow, hreflang
- Schema.org разметка: JSON-LD для Article, Product, FAQ, HowTo, Organization
- Mobile-first indexing, page speed optimization

КОНТЕНТНЫЙ SEO:
- Семантическое ядро: кластеры тем, search intent (informational/transactional/navigational)
- Title tag: <60 символов, ключевое слово в начале
- Meta description: <155 символов, CTA, уникальность
- H1-H6 структура: один H1, иерархия заголовков
- Internal linking strategy: pillar pages + cluster content
- E-E-A-T: Experience, Expertise, Authoritativeness, Trustworthiness

ИНСТРУМЕНТЫ:
- Google Search Console, Ahrefs, Semrush, Screaming Frog
- PageSpeed Insights, Lighthouse, WebPageTest

ФОРМАТ АУДИТА:
- Технические ошибки с приоритетами
- Страницы с потенциалом роста
- Контент-план по кластерам
- Quick wins vs long-term strategy`
  },
  social_media: {
    id: 'social_media', icon: '📱', label: 'SMM-менеджер', category: 'marketing',
    desc: 'SMM-стратегия, контент-планы, Telegram, Instagram, TikTok, YouTube',
    prompt: `Ты — SMM-стратег. Разрабатываешь стратегии продвижения в соцсетях с фокусом на метрики.

ПЛАТФОРМЫ:
- Telegram: каналы, боты, чаты, Telegram Ads
- Instagram: Reels (приоритет), Stories, карусели, Guides
- TikTok: тренды, звуки, UGC-стиль, TikTok Shop
- YouTube: Shorts, длинные видео, Community
- X/Twitter: threads, spaces

СТРАТЕГИЯ:
1. Аудит: текущие метрики, конкуренты, аудитория
2. Позиционирование: TOV (tone of voice), визуальный стиль
3. Контент-микс: 40% value, 30% engagement, 20% promo, 10% UGC
4. Контент-план: 3-5 постов/неделю, рубрикатор, календарь
5. Рост: коллаборации, giveaways, paid promotion, viral hooks

МЕТРИКИ:
- Reach, Impressions, Engagement Rate (> 3% = хорошо)
- Click-through rate, Saves/Shares (ценнее лайков)
- Follower growth rate, Audience retention
- Конверсия: трафик → лид → продажа

ФОРМАТ:
- Контент-план: таблица (дата, формат, тема, hook, CTA, хештеги)
- Тексты: с emoji, line breaks, hooks в первой строке
- Хештеги: 5-15 релевантных, микс размеров (100K-1M)`
  },
  content_creator: {
    id: 'content_creator', icon: '✍️', label: 'Контент-мейкер', category: 'text',
    desc: 'Копирайтинг, сторителлинг, сценарии, промпты для медиа',
    prompt: `Ты — контент-креатор. Создаёшь тексты, которые цепляют, удерживают и конвертируют.

ФОРМАТЫ:
- Статьи/лонгриды: hook → проблема → решение → CTA
- Сценарии для видео: hook (3с) → value → CTA. Reels/Shorts/TikTok
- Email-рассылки: subject line (A/B) → preview text → body → CTA
- Landing pages: заголовок → подзаголовок → benefits → social proof → CTA
- Посты для соцсетей: hook → story → value → CTA

ПСИХОЛОГИЯ:
- AIDA: Attention → Interest → Desire → Action
- PAS: Problem → Agitate → Solution
- Storytelling: герой → конфликт → трансформация
- Social proof, urgency, scarcity, authority (без манипуляций)
- Power words: "бесплатно", "секрет", "мгновенно", "доказано"

ПРАВИЛА:
- Первая строка — hook. Если не цепляет за 2 секунды — переписывай
- Короткие предложения. Абзацы по 1-3 строки. Воздух.
- Конкретика > абстракция: "за 14 дней" > "быстро"
- Один CTA на текст (максимум два)
- Адаптация тона: B2B formal ≠ B2C casual ≠ Gen-Z мемы

TONE OF VOICE:
Адаптируйся под запрос. Спроси, если непонятно: экспертный, дружеский, провокационный, академический.`
  },
  translator: {
    id: 'translator', icon: '🌍', label: 'Переводчик', category: 'text',
    desc: 'Мультиязычный перевод, локализация, адаптация контента',
    prompt: `Ты — профессиональный переводчик и локализатор. Перевод — это не замена слов, а передача смысла.

ЯЗЫКИ: RU ↔ EN ↔ DE ↔ FR ↔ ES ↔ IT ↔ PT ↔ ZH ↔ JA ↔ KO ↔ AR ↔ TR

ПРИНЦИПЫ:
- Точность смысла > буквальный перевод
- Сохранение тона и стиля оригинала
- Культурная адаптация: единицы измерения, даты, валюты, идиомы
- Терминологическая консистентность (глоссарий)
- Гендерно-нейтральный язык где уместно

ТИПЫ ПЕРЕВОДА:
- Технический: документация, UI strings, API docs — точность превыше всего
- Маркетинговый: транскреация, адаптация слоганов, SEO-ключевые слова
- Литературный: стиль автора, ритм, аллитерации
- Юридический: точность терминов, формальный стиль

ФОРМАТ:
- Оригинал → Перевод (параллельно)
- Примечания переводчика [TN: ...] для неоднозначных мест
- Если несколько вариантов — показать с обоснованием
- Для UI: учитывать длину строк (немецкий +30%, японский -20%)`
  },
  ux_ui_designer: {
    id: 'ux_ui_designer', icon: '🎨', label: 'UX/UI дизайнер', category: 'design',
    desc: 'Прототипы, дизайн-системы, юзабилити, доступность, компоненты',
    prompt: `Ты — UX/UI дизайнер. Проектируешь интерфейсы, которые люди ХОТЯТ использовать.

UX ПРОЦЕСС:
1. Research: user personas, jobs-to-be-done, competitor audit
2. Information Architecture: sitemap, user flows, card sorting
3. Wireframes: low-fi → mid-fi → hi-fi
4. Prototyping: interactions, micro-animations, transitions
5. Usability testing: 5 пользователей находят 85% проблем
6. Iteration: на основе данных, не мнений

UI ПРИНЦИПЫ:
- Visual hierarchy: размер, цвет, контраст, whitespace
- Consistency: дизайн-система, токены, компоненты
- Feedback: hover, active, disabled, loading, error, success states
- Fitts's Law: важные элементы крупнее и ближе
- Hick's Law: меньше выбора = быстрее решение

ДОСТУПНОСТЬ (WCAG 2.1 AA):
- Контраст: 4.5:1 для текста, 3:1 для UI
- Keyboard navigation: Tab, Enter, Escape, Arrow keys
- Screen reader: ARIA labels, semantic HTML, alt text
- Touch targets: минимум 44x44px

ДИЗАЙН-СИСТЕМА:
- Токены: цвета, типографика, spacing, border-radius, shadows
- Компоненты: Button, Input, Card, Modal, Toast, Table
- Паттерны: формы, навигация, поиск, фильтры, пагинация

ФОРМАТ:
- ASCII wireframes для быстрых идей
- Описание компонентов: props, states, variants
- User flow: шаги с условиями и ответвлениями`
  },
  marketer: {
    id: 'marketer', icon: '📈', label: 'Маркетолог', category: 'marketing',
    desc: 'Стратегия, воронки, unit-экономика, позиционирование, growth hacking',
    prompt: `Ты — маркетолог-стратег. Превращаешь продукты в деньги через системный подход.

СТРАТЕГИЯ:
- Позиционирование: для кого → какую проблему решаем → чем отличаемся
- ICP (Ideal Customer Profile): демография, психография, боли, мотивы
- Competitor analysis: strengths, weaknesses, gaps, positioning map
- GTM (Go-to-Market): каналы, messaging, pricing, launch timeline

ВОРОНКИ:
- TOFU: awareness (контент, SEO, paid, PR, viral)
- MOFU: consideration (email nurturing, webinars, case studies)
- BOFU: decision (demos, trials, offers, social proof)
- Post-sale: onboarding, retention, upsell, referral

UNIT-ЭКОНОМИКА:
- CAC (Customer Acquisition Cost)
- LTV (Lifetime Value) — LTV:CAC > 3:1
- Payback period < 12 месяцев
- Churn rate, MRR, ARR
- ROAS, CPA, CPL, CPC, CTR

GROWTH:
- Product-led growth: free tier → activation → habit → monetization
- Viral loops: invite mechanics, referral programs
- Content marketing flywheel: create → distribute → engage → convert

ФОРМАТ:
- Стратегия: executive summary → analysis → plan → KPIs → timeline
- Медиаплан: канал, бюджет, KPI, timeline, ответственный`
  },
  researcher: {
    id: 'researcher', icon: '🔬', label: 'Исследователь', category: 'analysis',
    desc: 'Глубокий анализ, systematic review, факт-чекинг, синтез знаний',
    prompt: `Ты — исследователь-аналитик. Глубокий, системный анализ любых тем.

МЕТОДОЛОГИЯ:
1. Определение вопроса: что именно нужно узнать?
2. Сбор информации: множественные источники, cross-reference
3. Критический анализ: bias detection, source reliability, logical fallacies
4. Синтез: паттерны, противоречия, gaps в знаниях
5. Выводы: evidence-based, с уровнями уверенности

ПРИНЦИПЫ:
- Факты отделяй от мнений и интерпретаций
- Указывай уровень уверенности: высокий/средний/низкий
- Multiple perspectives: pro et contra
- Steel man arguments: самые сильные аргументы оппонента
- Эпистемическая скромность: "не знаю" лучше чем "наверное"

ФОРМАТ:
- Executive summary (3-5 предложений)
- Основной анализ с подразделами
- Ключевые находки (bulleted)
- Противоречия и неопределённости
- Рекомендации и следующие шаги
- Источники/ссылки где возможно`
  },
  creative_director: {
    id: 'creative_director', icon: '🎬', label: 'Креативный директор', category: 'marketing',
    desc: 'Рекламные концепции, брендинг, визуальные стратегии, кампании',
    prompt: `Ты — креативный директор. Создаёшь идеи, которые запоминаются и продают.

ПРОЦЕСС:
1. Brief: цель, аудитория, tone, ограничения, бюджет
2. Insight: потребительский инсайт — неочевидная правда об аудитории
3. Big Idea: одна концепция, которая объединяет всё
4. Execution: адаптация под форматы и каналы
5. Feedback: тестирование, итерация

ФОРМАТЫ:
- Рекламные кампании: 360° (digital + offline + PR)
- Видео: script → storyboard → shot list
- Баннеры: headline + visual + CTA (правило 3 секунд)
- Social media: визуальная стратегия, мудборд
- Брендинг: name → logo concept → visual identity → guidelines

ПРИНЦИПЫ:
- Инсайт > креатив > execution
- Простота: одна мысль на одну единицу контента
- Эмоция > логика (но нужны обе)
- "Show, don't tell" — визуальный сторителлинг
- Бренд-консистентность через все touchpoints

ФОРМАТ ПРЕЗЕНТАЦИИ:
- Бриф → Инсайт → Идея → Мудборд (описание) → Примеры → KPI`
  },
  prompt_engineer: {
    id: 'prompt_engineer', icon: '🧪', label: 'Промпт-инженер', category: 'dev',
    desc: 'Промпты для AI: LLM, Midjourney, DALL-E, Stable Diffusion, видео',
    prompt: `Ты — промпт-инженер. Мастер коммуникации с AI-моделями.

LLM ПРОМПТЫ:
- System prompts: роль → контекст → правила → формат → примеры
- Few-shot: 2-3 примера input → output
- Chain-of-thought: "Think step by step", "Let's work through this"
- Structured output: JSON schema, markdown tables
- Constraints: длина, тон, аудитория, запреты
- Meta-prompting: промпты для генерации промптов

IMAGE ПРОМПТЫ (Midjourney/DALL-E/Flux):
- Структура: Subject + Style + Lighting + Composition + Details + Parameters
- Фотореализм: "photo of..., Canon EOS R5, 85mm f/1.4, golden hour, shallow depth of field"
- Арт: "digital painting in the style of..., highly detailed, 8K"
- Негативные промпты: --no text, watermark, blurry, deformed

VIDEO ПРОМПТЫ (Sora/Runway/Veo):
- Описание действия: субъект + движение + среда
- Камера: pan, zoom, dolly, crane shot, tracking
- Настроение: lighting, color grading, atmosphere
- Длительность и ритм

ОПТИМИЗАЦИЯ:
- A/B тестирование промптов
- Temperature и top_p для разных задач
- Token efficiency: краткость без потери контекста
- Итеративное улучшение: начни просто → добавляй детали`
  },
  business_analyst: {
    id: 'business_analyst', icon: '💼', label: 'Бизнес-аналитик', category: 'analysis',
    desc: 'Бизнес-планы, финмодели, SWOT, BMC, стратегия, unit-экономика',
    prompt: `Ты — бизнес-аналитик. Превращаешь идеи в структурированные планы с числами.

ФРЕЙМВОРКИ:
- Business Model Canvas: 9 блоков
- Lean Canvas: для стартапов
- SWOT: Strengths, Weaknesses, Opportunities, Threats
- Porter's Five Forces: конкурентный анализ
- TAM/SAM/SOM: оценка рынка
- Jobs to Be Done: за что платят

ФИНМОДЕЛИРОВАНИЕ:
- P&L: выручка, себестоимость, операционные расходы, EBITDA
- Unit-экономика: CAC, LTV, payback, маржинальность
- Сценарии: pessimistic / base / optimistic
- Break-even point: когда выходим в ноль
- Cash flow: когда заканчиваются деньги

СТРАТЕГИЯ:
- OKR: цели + ключевые результаты (measurable)
- Roadmap: квартальное планирование
- Competitive moat: что не скопировать
- Pricing strategy: cost+, value-based, competitor-based

ФОРМАТ:
- Executive summary: 1 страница
- Цифры в таблицах, не в тексте
- Графики: revenue, costs, users, margins
- Риски: вероятность × impact, mitigation plan`
  },
};

const SPECIALIZED_MODES_LIST = Object.values(SPECIALIZED_MODES);
const MODE_CATEGORIES = [
  { id: 'dev', label: '💻 Разработка' },
  { id: 'text', label: '✍️ Тексты' },
  { id: 'analysis', label: '🔍 Анализ' },
  { id: 'marketing', label: '📈 Маркетинг' },
  { id: 'design', label: '🎨 Дизайн' },
];

const SUB_AGENT_PROMPT_TEMPLATE = (role, task, context, customAgent) => {
  if (customAgent && customAgent.prompt) {
    return `${customAgent.prompt}

ЗАДАЧА: ${task}
${context ? `\nКОНТЕКСТ ОТ ОРКЕСТРАТОРА:\n${context}` : ''}

ПРАВИЛА:
- Выполняй ТОЛЬКО свою задачу, не отвлекайся
- Будь конкретным и структурированным
- Если нужно выполнить действие, используй формат [ACTION: тип]...[/ACTION]
- В конце дай чёткий результат, начиная с [RESULT]
- Если не можешь выполнить — объясни почему, начиная с [ERROR]
- Отвечай кратко и по делу`;
  }
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

const sessionAgents = new Map(); // chatId -> [{id, label, icon, desc, prompt, maxSteps, model, enabled, isSession}]

function getEffectiveAgents(chatId) {
  const uc = getUserConfig(chatId);
  const agents = { ...AGENT_ROLES };
  const custom = uc.customAgents || [];
  for (const ca of custom) {
    if (ca.enabled !== false) {
      agents[ca.id] = { icon: ca.icon || '🤖', label: ca.label, desc: ca.desc || '', isCustom: true, prompt: ca.prompt, maxSteps: ca.maxSteps || 3, model: ca.model || '' };
    }
  }
  const session = sessionAgents.get(chatId) || [];
  for (const sa of session) {
    agents[sa.id] = { icon: sa.icon || '🤖', label: sa.label, desc: sa.desc || '', isSession: true, prompt: sa.prompt, maxSteps: sa.maxSteps || 3, model: sa.model || '' };
  }
  return agents;
}

// Трекер состояния мульти-агентных задач
const multiAgentTasks = new Map(); // chatId -> { orchestratorMsgId, agents: [...], log: [...], startTime }

function loadUserConfigs() {
  if (!fs.existsSync(USER_CONFIGS_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(USER_CONFIGS_PATH, 'utf8'));
    for (const [id, cfg] of Object.entries(data)) {
      userConfigs.set(Number(id), { ...defaultUserConfig, ...cfg });
    }
  } catch (e) { console.warn('Failed to parse user configs:', USER_CONFIGS_PATH, e.message); }
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
  // Миграция customAgents: добавляем поля если отсутствуют
  if (!cfg.customAgents) cfg.customAgents = [];
  for (const agent of cfg.customAgents) {
    if (agent.maxSteps === undefined) agent.maxSteps = 3;
    if (agent.model === undefined) agent.model = '';
    if (agent.enabled === undefined) agent.enabled = true;
    if (agent.uses === undefined) agent.uses = 0;
    if (agent.lastUsed === undefined) agent.lastUsed = null;
  }
  // Миграция памяти
  if (cfg.memory === undefined) cfg.memory = [];
  if (cfg.memoryEnabled === undefined) cfg.memoryEnabled = true;
  if (cfg.memoryAutoExtract === undefined) cfg.memoryAutoExtract = true;
  if (cfg.autoModelMap === undefined) cfg.autoModelMap = {};
  // Миграция агент-режима
  if (cfg.agentMode === undefined) cfg.agentMode = true;
  if (cfg.multiAgent === undefined) cfg.multiAgent = true;
}
let _saveUserConfigsTimer = null;
function saveUserConfigs() {
  if (_saveUserConfigsTimer) clearTimeout(_saveUserConfigsTimer);
  _saveUserConfigsTimer = setTimeout(() => {
    _saveUserConfigsTimer = null;
    const obj = {};
    for (const [id, cfg] of userConfigs) obj[id] = cfg;
    fs.promises.writeFile(USER_CONFIGS_PATH, JSON.stringify(obj, null, 2)).catch(e => console.error('saveUserConfigs error:', e));
  }, 3000);
}
function flushUserConfigs() {
  if (_saveUserConfigsTimer) {
    clearTimeout(_saveUserConfigsTimer);
    _saveUserConfigsTimer = null;
    const obj = {};
    for (const [id, cfg] of userConfigs) obj[id] = cfg;
    fs.writeFileSync(USER_CONFIGS_PATH, JSON.stringify(obj, null, 2));
  }
}
saveUserConfigs();

function getUserConfig(chatId) {
  if (!userConfigs.has(chatId)) {
    // Админы получают полный доступ и домашнюю директорию
    const isAdmin = adminIds.includes(chatId);
    userConfigs.set(chatId, { ...defaultUserConfig, role: isAdmin ? 'admin' : 'user', workDir: isAdmin ? (process.env.WORKING_DIR || os.homedir()) : '/tmp' });
    saveUserConfigs();
  }
  return userConfigs.get(chatId);
}

// TODO: chatId не используется, но 64+ call-sites передают его — оставлено для единообразия API
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
const chatHistoryAccess = new Map(); // chatId -> timestamp последнего доступа

function addToHistory(chatId, role, text) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);
  chatHistoryAccess.set(chatId, Date.now());
  const trimmed = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
  history.push({ role, text: trimmed });
  const maxSize = getUserConfig(chatId).historySize || 20;
  if (history.length > maxSize) history.splice(0, history.length - maxSize);
}

function clearHistory(chatId) {
  chatHistory.delete(chatId);
  chatHistoryAccess.delete(chatId);
  lastResponse.delete(chatId);
}

// === Долгосрочная память ===
const MEMORY_LIMIT = 100; // макс записей на пользователя

function generateMemoryId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getMemory(chatId) {
  const uc = getUserConfig(chatId);
  if (!uc.memory) uc.memory = [];
  return uc.memory;
}

function addMemoryEntry(chatId, fact, category = 'fact', importance = 0.5) {
  const uc = getUserConfig(chatId);
  if (!uc.memory) uc.memory = [];

  // Дедупликация: ищем похожие записи (только длинные подстроки)
  const factLower = fact.toLowerCase();
  const existing = uc.memory.find(m => {
    const mLower = m.fact.toLowerCase();
    const shorter = factLower.length < mLower.length ? factLower : mLower;
    const sim = shorter.length > 15 && (factLower.includes(mLower) || mLower.includes(factLower));
    return sim;
  });

  if (existing) {
    // Обновляем существующую запись
    existing.fact = fact;
    existing.importance = Math.min(1, Math.max(existing.importance, importance));
    existing.useCount = (existing.useCount || 0) + 1;
    existing.lastUsed = Date.now();
    saveUserConfig(chatId);
    return existing;
  }

  // Добавляем новую
  const entry = {
    id: generateMemoryId(),
    fact,
    category,
    importance,
    created: Date.now(),
    lastUsed: Date.now(),
    useCount: 0,
  };
  uc.memory.push(entry);

  // Лимит: удаляем наименее важные
  if (uc.memory.length > MEMORY_LIMIT) {
    uc.memory.sort((a, b) => b.importance - a.importance);
    uc.memory = uc.memory.slice(0, MEMORY_LIMIT);
  }

  saveUserConfig(chatId);
  return entry;
}

// AI-дедупликация через Gemini flash-lite
async function addMemoryEntryWithDedup(chatId, fact, category = 'fact', importance = 0.5) {
  const uc = getUserConfig(chatId);
  if (!uc.memory) uc.memory = [];

  // Быстрая проверка (подстрока) — как раньше
  const factLower = fact.toLowerCase();
  const quickMatch = uc.memory.find(m => {
    const mLower = m.fact.toLowerCase();
    const shorter = factLower.length < mLower.length ? factLower : mLower;
    return shorter.length > 15 && (factLower.includes(mLower) || mLower.includes(factLower));
  });
  if (quickMatch) {
    quickMatch.fact = fact;
    quickMatch.importance = Math.min(1, Math.max(quickMatch.importance, importance));
    quickMatch.useCount = (quickMatch.useCount || 0) + 1;
    quickMatch.lastUsed = Date.now();
    saveUserConfig(chatId);
    return quickMatch;
  }

  // AI-сравнение: находим семантически похожие через Gemini flash-lite
  const key = getGeminiKey(chatId);
  if (key && uc.memory.length > 0) {
    try {
      const candidates = uc.memory.slice(-30).map((m, i) => `${i}: ${m.fact}`).join('\n');
      const dedupPrompt = `Новый факт: "${fact}"\n\nСуществующие факты:\n${candidates}\n\nЕсть ли среди существующих факт с ТОЧНО ТЕМ ЖЕ смыслом (дубликат или обновление)? Если да — верни его номер. Если нет — верни -1.\nОтвет (только число):`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: dedupPrompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 10 } }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const numText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '-1').trim();
      const idx = parseInt(numText);
      if (idx >= 0 && idx < Math.min(30, uc.memory.length)) {
        const target = uc.memory[uc.memory.length - Math.min(30, uc.memory.length) + idx];
        if (target) {
          target.fact = fact;
          target.importance = Math.min(1, Math.max(target.importance, importance));
          target.useCount = (target.useCount || 0) + 1;
          target.lastUsed = Date.now();
          saveUserConfig(chatId);
          return target;
        }
      }
    } catch (e) {
      // AI-деdup failed — продолжаем добавление
    }
  }

  // Добавляем как новую запись
  return addMemoryEntry(chatId, fact, category, importance);
}

function deleteMemoryEntry(chatId, entryId) {
  const uc = getUserConfig(chatId);
  if (!uc.memory) return false;
  const idx = uc.memory.findIndex(m => m.id === entryId);
  if (idx === -1) return false;
  uc.memory.splice(idx, 1);
  saveUserConfig(chatId);
  return true;
}

function forgetMemory(chatId, searchText) {
  const uc = getUserConfig(chatId);
  if (!uc.memory) return 0;
  const lower = searchText.toLowerCase();
  const before = uc.memory.length;
  uc.memory = uc.memory.filter(m => !m.fact.toLowerCase().includes(lower));
  const removed = before - uc.memory.length;
  if (removed > 0) saveUserConfig(chatId);
  return removed;
}

function clearMemory(chatId) {
  const uc = getUserConfig(chatId);
  uc.memory = [];
  saveUserConfig(chatId);
}

function buildMemoryPrompt(chatId, currentQuery) {
  const uc = getUserConfig(chatId);
  if (!uc.memoryEnabled || !uc.memory || uc.memory.length === 0) return '';

  // Keyword-matching: слова из запроса повышают score
  const queryWords = currentQuery
    ? currentQuery.toLowerCase().replace(/[^\wа-яёА-ЯЁ\s]/g, '').split(/\s+/).filter(w => w.length > 2)
    : [];

  // Сортировка: importance * recency * keyword-match bonus
  const now = Date.now();
  const scored = uc.memory.map(m => {
    const daysSince = (now - (m.lastUsed || m.created)) / 86400000;
    const recency = Math.exp(-daysSince / 30); // затухание за 30 дней
    let keywordBonus = 1.0;
    if (queryWords.length > 0) {
      const factLower = m.fact.toLowerCase();
      const matches = queryWords.filter(w => factLower.includes(w)).length;
      keywordBonus = 1.0 + (matches / queryWords.length) * 1.5; // до 2.5x буста
    }
    return { ...m, score: m.importance * recency * keywordBonus };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 25);
  const catLabels = { preference: 'предпочтение', fact: 'факт', instruction: 'инструкция', context: 'контекст' };

  // Reinforcement: факты попавшие в промпт получают boost (useCount++, lastUsed обновляется)
  let needSave = false;
  for (const m of top) {
    const original = uc.memory.find(o => o.id === m.id);
    if (original) {
      original.useCount = (original.useCount || 0) + 1;
      original.lastUsed = now;
      // Мягкое усиление importance для часто используемых фактов
      if (original.useCount >= 5 && original.importance < 0.9) {
        original.importance = Math.min(1, original.importance + 0.05);
      }
      needSave = true;
    }
  }
  if (needSave) saveUserConfig(chatId);

  // Приоритет инструкций — показываем первыми
  const instructions = top.filter(m => m.category === 'instruction');
  const others = top.filter(m => m.category !== 'instruction');

  let prompt = '\n\n## Долгосрочная память о пользователе:\n';
  if (instructions.length > 0) {
    prompt += '### Постоянные инструкции (ВЫСШИЙ ПРИОРИТЕТ — всегда следуй):\n';
    for (const m of instructions) {
      prompt += `- ⚠️ ${m.fact}\n`;
    }
    prompt += '\n';
  }
  for (const m of others) {
    prompt += `- [${catLabels[m.category] || m.category}] ${m.fact}\n`;
  }
  prompt += '\nИспользуй эту информацию для персонализации ответов. Не упоминай наличие памяти, если пользователь не спрашивает.\nДля управления памятью: "забудь что..." → [ACTION: memory] forget, "что помнишь" → [ACTION: memory] list';
  return prompt;
}

async function extractMemoryFacts(chatId, userMsg, assistantMsg) {
  const uc = getUserConfig(chatId);
  if (!uc.memoryEnabled || !uc.memoryAutoExtract) return;

  const key = getGeminiKey(chatId);
  if (!key) return;

  const existingFacts = (uc.memory || []).slice(-40).map(m => m.fact).join('; ');

  // Определяем контекст коррекции
  const userLow = userMsg.toLowerCase();
  const isCorrection = /нет[,.]?\s|не так|неправильно|не то|я (имел|имела) в виду|ошибк|i meant|no,?\s?i/i.test(userLow);
  const isFeedback = /не делай так|всегда|никогда|запомни|remember|always|never|больше не|перестань/i.test(userLow);

  const extractPrompt = `Проанализируй диалог. Извлеки НОВЫЕ факты о пользователе для будущих диалогов.

Уже известные факты: ${existingFacts || 'нет'}

Пользователь: ${userMsg.slice(0, 1000)}
Ассистент: ${assistantMsg.slice(0, 1000)}
${isCorrection ? '\n⚠️ Пользователь ИСПРАВЛЯЕТ ассистента — извлеки коррекцию как instruction с importance 0.9+' : ''}
${isFeedback ? '\n⚠️ Пользователь даёт ПОСТОЯННУЮ ИНСТРУКЦИЮ — извлеки как instruction с importance 0.9+' : ''}

Категории:
- preference: предпочтения стиля общения, языка, инструментов, форматирования
- fact: личные факты — имя, работа, навыки, местоположение, интересы
- instruction: постоянные указания от пользователя (как делать/не делать что-то)
- context: контекст текущих проектов, задач, рабочего процесса

Обрати особое внимание на:
1. Коррекции и исправления пользователя (→ instruction, importance 0.9)
2. Стиль общения: формальный/неформальный, краткий/подробный (→ preference)
3. Технологические предпочтения: языки, фреймворки, инструменты (→ preference)
4. Негативные предпочтения: чего НЕ делать (→ instruction, importance 0.8+)

Если нет новых важных фактов — верни пустой массив [].
Верни ТОЛЬКО JSON массив (без markdown, без \`\`\`): [{"fact": "...", "category": "...", "importance": 0.0-1.0}]`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return;

    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts) || facts.length === 0) return;

    for (const f of facts) {
      if (f.fact && f.fact.length > 3 && f.fact.length < 300) {
        // Автоусиление коррекций и инструкций
        let importance = f.importance || 0.5;
        if ((isCorrection || isFeedback) && f.category === 'instruction') {
          importance = Math.max(importance, 0.9);
        }
        await addMemoryEntryWithDedup(chatId, f.fact, f.category || 'fact', importance);
      }
    }
  } catch (e) {
    console.error(`[chatId:${chatId}] Memory extract error:`, e.message);
  }
}

function formatMemoryList(chatId) {
  const uc = getUserConfig(chatId);
  if (!uc.memory || uc.memory.length === 0) return '🧠 Память пуста';

  const catLabels = { preference: '⭐ Предпочтения', fact: '📋 Факты', instruction: '📌 Инструкции', context: '📎 Контекст' };
  const grouped = {};
  for (const m of uc.memory) {
    const cat = m.category || 'fact';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }

  let text = `🧠 Память (${uc.memory.length}/${MEMORY_LIMIT})\n`;
  text += `Авто: ${uc.memoryAutoExtract ? '✅' : '❌'}\n\n`;

  for (const [cat, entries] of Object.entries(grouped)) {
    text += `${catLabels[cat] || cat}:\n`;
    for (const m of entries) {
      text += `• ${m.fact} [${m.importance}] #${m.id}\n`;
    }
    text += '\n';
  }
  return text;
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
async function tgApi(method, body, timeout = 30000) {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
    return await res.json();
  } catch (e) {
    if (method === 'getUpdates') return { ok: false };
    console.error(`tgApi(${method}):`, e.message);
    return { ok: false };
  }
}

// Загрузка файлов (multipart) через execFile curl (без shell — защита от injection)
function tgUpload(method, chatId, fieldName, filePath, caption) {
  return new Promise((resolve) => {
    const cap = caption ? cleanMarkdown(caption).slice(0, 1024) : '';
    const args = ['-s', '-X', 'POST', `${API}/${method}`, '-F', `chat_id=${chatId}`, '-F', `${fieldName}=@${filePath}`];
    if (cap) args.push('-F', `caption=${cap}`);
    execFile('curl', args, { encoding: 'utf8', timeout: 120000 }, (err, stdout) => {
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

const _lastEditText = new Map(); // msgId -> { text, ts }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _lastEditText) {
    if (now - v.ts > 300000) _lastEditText.delete(k); // TTL 5 min
  }
}, 60000);

async function editText(chatId, msgId, text, opts = {}) {
  if (text.length > 4000) text = text.slice(0, 4000);
  const cached = _lastEditText.get(msgId);
  if (cached && cached.text === text) return; // пропуск дублей
  _lastEditText.set(msgId, { text, ts: Date.now() });
  try { return await tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text, ...opts }); }
  catch (e) { /* Telegram "message not modified" — игнорируем */ }
}

function del(chatId, msgId) { tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {}); }

// === Получение Gemini API ключа для пользователя ===
function getGeminiKey(chatId) {
  return (chatId && getUserConfig(chatId).apiKeys?.google) || process.env.GEMINI_API_KEY;
}

// === Nano Banana: Генерация изображений ===
async function generateImage(chatId, prompt, opts = {}) {
  const key = getGeminiKey(chatId);
  if (!key) throw new Error('GEMINI_API_KEY не задан');
  const uc = getUserConfig(chatId);
  const modelKey = opts.model || uc.imageModel || 'nano-banana';
  const imgModel = IMAGE_MODELS[modelKey];
  if (!imgModel) throw new Error(`Неизвестная модель: ${modelKey}`);
  // Маршрутизация: Imagen 3/4 → predict API, Nano Banana → generateContent API
  if (modelKey.startsWith('imagen-')) {
    return generateImageImagen(chatId, prompt, { ...opts, model: modelKey });
  }
  const aspectRatio = opts.aspectRatio || uc.imageAspect || '1:1';
  const parts = [{ text: prompt }];
  if (opts.referenceImages && opts.referenceImages.length > 0) {
    for (const img of opts.referenceImages) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: img } });
    }
  }
  const body = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  };
  if (aspectRatio !== '1:1' || opts.imageSize) {
    body.generationConfig.imageConfig = {};
    if (aspectRatio !== '1:1') body.generationConfig.imageConfig.aspectRatio = aspectRatio;
  }
  if (opts.negativePrompt) {
    body.generationConfig.negativePrompt = opts.negativePrompt;
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${imgModel.id}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  if (data.candidates?.[0]?.finishReason === 'SAFETY') throw new Error('Заблокировано фильтром безопасности');
  const candidates = data.candidates || [];
  const results = [];
  for (const candidate of candidates) {
    const cParts = candidate.content?.parts || [];
    for (const p of cParts) {
      if (p.inline_data) {
        const ext = p.inline_data.mime_type === 'image/png' ? 'png' : 'jpg';
        const filePath = `/tmp/nanob_${Date.now()}_${tmpCounter++}.${ext}`;
        await fs.promises.writeFile(filePath, Buffer.from(p.inline_data.data, 'base64'));
        results.push({ type: 'image', path: filePath, model: modelKey });
      } else if (p.text) {
        results.push({ type: 'text', text: p.text });
      }
    }
  }
  if (results.length === 0) throw new Error('Пустой ответ от модели');
  return results;
}

// === Imagen 3/4: Генерация через predict API ===
async function generateImageImagen(chatId, prompt, opts = {}) {
  const key = getGeminiKey(chatId);
  if (!key) throw new Error('GEMINI_API_KEY не задан');
  const uc = getUserConfig(chatId);
  const modelKey = opts.model || uc.imageModel || 'imagen-3';
  const imgModel = IMAGE_MODELS[modelKey];
  if (!imgModel) throw new Error(`Неизвестная модель: ${modelKey}`);
  const aspectRatio = opts.aspectRatio || uc.imageAspect || '1:1';
  const count = Math.min(Math.max(opts.count || 1, 1), 4);
  const instance = { prompt };
  if (opts.referenceImages && opts.referenceImages.length > 0) {
    instance.referenceImages = opts.referenceImages.map(img => ({
      referenceImage: { bytesBase64Encoded: img },
      referenceType: 'STYLE'
    }));
  }
  const parameters = {
    sampleCount: count,
    aspectRatio,
    personGeneration: 'allow_all'
  };
  if (opts.negativePrompt) parameters.negativePrompt = opts.negativePrompt;
  const body = { instances: [instance], parameters };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${imgModel.id}:predict?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const predictions = data.predictions || [];
  if (predictions.length === 0) throw new Error('Пустой ответ от модели');
  const results = [];
  for (const pred of predictions) {
    if (pred.bytesBase64Encoded) {
      const filePath = `/tmp/imagen_${Date.now()}_${tmpCounter++}.png`;
      await fs.promises.writeFile(filePath, Buffer.from(pred.bytesBase64Encoded, 'base64'));
      results.push({ type: 'image', path: filePath, model: modelKey });
    }
  }
  if (results.length === 0) throw new Error('Нет изображений в ответе');
  return results;
}

async function editImage(chatId, imageBase64, instruction, opts = {}) {
  return generateImage(chatId, instruction, { ...opts, referenceImages: [imageBase64] });
}

// === Veo: Поллинг long-running операции ===
async function pollVideoOperation(operationName, key, prefix, onProgress) {
  const maxPolls = 120; // до 10 минут (5с * 120)
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${key}`, {
      signal: AbortSignal.timeout(15000),
    });
    const pollData = await pollRes.json();
    if (pollData.error) throw new Error(pollData.error.message);
    if (pollData.done) {
      const videos = pollData.response?.generateVideoResponse?.generatedSamples || pollData.response?.generatedSamples || [];
      if (videos.length === 0) throw new Error('Видео не сгенерировано');
      const videoUri = videos[0].video?.uri;
      if (!videoUri) throw new Error('Нет URI видео');
      const videoPath = `/tmp/${prefix}_${Date.now()}.mp4`;
      const dlUrl = videoUri.includes('?') ? `${videoUri}&key=${key}` : `${videoUri}?key=${key}`;
      await new Promise((resolve) => {
        execFile('curl', ['-s', '-L', '-o', videoPath, dlUrl], { timeout: 120000 }, (err) => {
          resolve(err ? null : videoPath);
        });
      });
      if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1000) throw new Error('Не удалось скачать видео');
      return { path: videoPath, polls: i + 1 };
    }
    if (onProgress) onProgress(i + 1);
  }
  throw new Error('Тайм-аут генерации видео');
}

// === Veo: Генерация видео ===
async function generateVideo(chatId, prompt, opts = {}) {
  const key = getGeminiKey(chatId);
  if (!key) throw new Error('GEMINI_API_KEY не задан');
  const uc = getUserConfig(chatId);
  const modelKey = opts.model || uc.videoModel || 'veo-3.1-fast';
  const vidModel = VIDEO_MODELS[modelKey];
  if (!vidModel) throw new Error(`Неизвестная модель: ${modelKey}`);
  const aspectRatio = opts.aspectRatio || uc.videoAspect || '16:9';
  const duration = opts.duration || parseInt(uc.videoDuration, 10) || 8;
  const resolution = opts.resolution || uc.videoResolution || '720p';
  const body = {
    instances: [{ prompt }],
    parameters: {
      aspectRatio,
      durationSeconds: duration,
      resolution,
      personGeneration: 'allow_all'
    }
  };
  if (opts.referenceImage) {
    body.instances[0].image = { bytesBase64Encoded: opts.referenceImage };
  }
  if (opts.negativePrompt) body.parameters.negativePrompt = opts.negativePrompt;
  // Запуск Long Running операции
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${vidModel.id}:predictLongRunning?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const operationName = data.name;
  if (!operationName) throw new Error('Не получено имя операции');
  return pollVideoOperation(operationName, key, 'veo', opts.onProgress);
}

// === Veo: Продление (расширение) видео ===
async function extendVideo(chatId, videoBase64, prompt, opts = {}) {
  const key = getGeminiKey(chatId);
  if (!key) throw new Error('GEMINI_API_KEY не задан');
  const uc = getUserConfig(chatId);
  const modelKey = opts.model || uc.videoModel || 'veo-3.1-fast';
  const vidModel = VIDEO_MODELS[modelKey];
  if (!vidModel) throw new Error(`Неизвестная модель: ${modelKey}`);
  const aspectRatio = opts.aspectRatio || uc.videoAspect || '16:9';
  const duration = opts.duration || parseInt(uc.videoDuration, 10) || 8;
  const resolution = opts.resolution || uc.videoResolution || '720p';
  const instance = { prompt };
  instance.video = { bytesBase64Encoded: videoBase64 };
  const body = {
    instances: [instance],
    parameters: { aspectRatio, durationSeconds: duration, resolution, personGeneration: 'allow_all' }
  };
  if (opts.negativePrompt) body.parameters.negativePrompt = opts.negativePrompt;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${vidModel.id}:predictLongRunning?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const operationName = data.name;
  if (!operationName) throw new Error('Не получено имя операции');
  return pollVideoOperation(operationName, key, 'veoext', opts.onProgress);
}

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

// Скачать файл по URL (async, execFile — защита от injection)
function downloadUrl(url, filename) {
  return new Promise((resolve) => {
    const dest = path.join('/tmp', filename);
    execFile('curl', ['-s', '-L', '-o', dest, url], { timeout: 120000 }, (err) => {
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
    if (!res.ok || !res.result?.file_path) return null;
    const filePath = res.result.file_path;
    const url = `${FILE_API}/${filePath}`;
    return new Promise((resolve) => {
      execFile('curl', ['-s', '-o', destPath, url], { timeout: 30000 }, (err) => {
        resolve(err ? null : destPath);
      });
    });
  } catch (e) {
    return null;
  }
}

// === Меню ===
const persistentKeyboard = { reply_markup: { remove_keyboard: true } };

function mainMenu(chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const admin = chatId ? isAdmin(chatId) : false;
  const agentIcon = uc.agentMode !== false ? '✅' : '❌';
  const multiIcon = uc.multiAgent !== false ? '✅' : '❌';
  const rows = [
    // Быстрые действия
    [{ text: `🤖 Агент: ${agentIcon}`, callback_data: 'toggle_agent' }, { text: `👥 Мульти: ${multiIcon}`, callback_data: 'toggle_multi' }],
    // Основные разделы
    [{ text: '⚡ Навыки', callback_data: 'skills_menu' }, { text: '🎭 Режимы', callback_data: 'modes_menu' }],
    [{ text: '🧠 Память', callback_data: 'mem_menu' }, { text: '🔗 Интеграции', callback_data: 'integrations' }],
    [{ text: '📓 NotebookLM', callback_data: 'nb_menu' }],
    [{ text: '⚙️ Настройки', callback_data: 'settings' }],
  ];
  if (admin) rows.push([{ text: '📡 Каналы', callback_data: 'channels' }, { text: '📈 Статистика', callback_data: 'stats' }]);
  if (MINIAPP_URL) rows.push([{ text: '🎮 Pixel Office', web_app: { url: MINIAPP_URL } }]);
  rows.push(
    [{ text: '📊 Статус', callback_data: 'status' }, { text: '❓ Помощь', callback_data: 'help' }],
    [{ text: '🗑 Очистить историю', callback_data: 'clear' }],
  );
  if (admin) rows.push([{ text: '👥 Пользователи', callback_data: 'users_panel' }]);
  return { reply_markup: { inline_keyboard: rows } };
}


function settingsMenu(chatId) { const uc = chatId ? getUserConfig(chatId) : defaultUserConfig; const admin = chatId ? isAdmin(chatId) : false; const rows = [
  [{ text: `🤖 Модель: ${uc.model}`, callback_data: 'set_model' }],
]; if (admin) rows.push([{ text: `📁 ${uc.workDir}`, callback_data: 'set_dir' }]); rows.push(
  [{ text: `⏱ Таймаут: ${uc.timeout}с`, callback_data: 'set_timeout' }],
  [{ text: `💬 Системный промпт: ${uc.systemPrompt ? '✅' : '❌'}`, callback_data: 'set_system' }],
  [{ text: `🧠 Авто-модель: ${uc.autoModel ? '✅' : '❌'}`, callback_data: 'toggle_auto' }],
  [{ text: `📡 Стриминг: ${uc.streaming ? '✅' : '❌'}`, callback_data: 'toggle_stream' }],
  [{ text: `👥 Мульти-агент: ${uc.multiAgent !== false ? '✅' : '❌'}`, callback_data: 'toggle_multi' }],
  [{ text: `🔢 Макс шагов: ${uc.agentMaxSteps || 10}`, callback_data: 'set_max_steps' }],
  [{ text: '🔑 API Ключи', callback_data: 'api_keys' }],
  [{ text: '🎨 Изображения', callback_data: 'img_settings' }, { text: '🎬 Видео', callback_data: 'video_settings' }],
  [{ text: '◀️ Назад', callback_data: 'back' }],
); return { reply_markup: { inline_keyboard: rows }}; }

function modelMenu() { return { reply_markup: { inline_keyboard: [
  [{ text: '🟣 Anthropic (Claude)', callback_data: 'modelgrp_anthropic' }, { text: '🟢 OpenAI (GPT)', callback_data: 'modelgrp_openai' }],
  [{ text: '🔵 Google (Gemini API)', callback_data: 'modelgrp_google' }, { text: '✨ Gemini CLI', callback_data: 'modelgrp_google-cli' }],
  [{ text: '⚡ Groq (Fast)', callback_data: 'modelgrp_groq' }],
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
const activeTasks = new Map();

// === Фоновые задачи ===
const backgroundTasks = new Map(); // chatId -> Map<taskId, taskInfo>
const MAX_BG_TASKS_PER_USER = 3;
let bgTaskCounter = 0;

function generateTaskId() {
  return `bg_${Date.now().toString(36)}_${(++bgTaskCounter).toString(36)}`;
}

function getTotalActiveCount(chatId) {
  const fg = activeTasks.has(chatId) ? 1 : 0;
  const bg = backgroundTasks.has(chatId) ? backgroundTasks.get(chatId).size : 0;
  return fg + bg;
}

function getUserBgTasks(chatId) {
  if (!backgroundTasks.has(chatId)) backgroundTasks.set(chatId, new Map());
  return backgroundTasks.get(chatId);
}
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
let waitingSkillName = new Set(); // chatId -> ожидание имени навыка
let waitingSkillPrompt = new Map(); // chatId -> skillName or {name, category}
let waitingSkillEditName = new Map(); // chatId -> skill index
let waitingSkillEditPrompt = new Map(); // chatId -> skill index
let waitingSkillEditDesc = new Map(); // chatId -> skill index
let waitingSkillCategory = new Map(); // chatId -> skillName (for wizard)
let waitingAgentName = new Set(); // chatId -> ожидание имени нового агента
let waitingAgentPrompt = new Map(); // chatId -> agentData ({id, icon, label, desc})
let waitingAgentEditPrompt = new Map(); // chatId -> agentIdx
let waitingAgentEditDesc = new Map(); // chatId -> agentIdx
let waitingAgentEditName = new Map(); // chatId -> agentIdx
let waitingAgentIcon = new Map(); // chatId -> agentData (wizard)
let waitingAgentDesc = new Map(); // chatId -> agentData (wizard)
let waitingApiKey = new Map(); // chatId -> provider
let waitingMcpUrl = new Set(); // chatId -> waiting for MCP server URL
let waitingMcpKey = new Map(); // chatId -> {url, name} waiting for optional API key
const mediaGroupBuffer = new Map(); // groupId -> { chatId, photos: [], caption, timer }
let offset = 0;
let polling = false;
let monitorTimer = null;

// Очистка всех waiting-состояний для пользователя (при старте нового wizard)
function clearAllWaiting(chatId) {
  const sets = [waitingDir, waitingSystemPrompt, waitingChannelAdd, waitingSmartSetup,
    waitingAuthPhone, waitingAuthCode, waitingAuthPassword, waitingNbCreate, waitingNbResearch,
    waitingSkillName, waitingAgentName, waitingMcpUrl];
  const maps = [waitingChannelKeywords, waitingChannelPrompt, waitingNbQuery, waitingNbUrl,
    waitingNbText, waitingNbRename, waitingNbReportCustom,
    waitingSkillPrompt, waitingSkillEditName, waitingSkillEditPrompt, waitingSkillEditDesc,
    waitingSkillCategory, waitingAgentPrompt, waitingAgentEditPrompt, waitingAgentEditDesc,
    waitingAgentEditName, waitingAgentIcon, waitingAgentDesc, waitingApiKey, waitingMcpKey];
  for (const s of sets) s.delete(chatId);
  for (const m of maps) m.delete(chatId);
}

// === Статистика ===
const stats = { startTime: Date.now(), messages: 0, claudeCalls: 0, errors: 0, voiceMessages: 0, files: 0, totalResponseTime: 0 };

// === Напоминания (персистентные, повторяющиеся) ===
const reminderTimers = new Map(); // id -> timerId
let nextReminderId = 1;

// Формат напоминания: { id, chatId, text, fireAt, repeat?, repeatInterval?, category?, priority? }
// repeat: null|'daily'|'weekly'|'hourly'|'custom'
// repeatInterval: ms (для custom)
// category: 'general'|'work'|'personal'|'urgent'
// priority: 1(low)-3(high)

function formatTimeLeft(ms) {
  if (ms < 0) return 'просрочено';
  if (ms < 60000) return `${Math.round(ms / 1000)} сек`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} мин`;
  if (ms < 86400000) {
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    return m > 0 ? `${h}ч ${m}мин` : `${h}ч`;
  }
  const d = Math.floor(ms / 86400000);
  const h = Math.round((ms % 86400000) / 3600000);
  return h > 0 ? `${d}д ${h}ч` : `${d}д`;
}

function formatFireTime(fireAt) {
  const d = new Date(fireAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PRIORITY_ICONS = { 1: '🔵', 2: '🟡', 3: '🔴' };
const CATEGORY_ICONS = { general: '📋', work: '💼', personal: '👤', urgent: '🚨' };

function fireReminder(id) {
  const reminder = (config.reminders || []).find(r => r.id === id);
  if (!reminder) return;
  const pIcon = PRIORITY_ICONS[reminder.priority] || '';
  const cIcon = CATEGORY_ICONS[reminder.category] || '';
  const prefix = [pIcon, cIcon].filter(Boolean).join(' ');
  const header = prefix ? `${prefix} ` : '';

  // Inline кнопки: snooze + done (+ repeat info)
  const buttons = [
    [
      { text: '⏰ +5мин', callback_data: `rsnooze_${id}_5` },
      { text: '⏰ +15мин', callback_data: `rsnooze_${id}_15` },
      { text: '⏰ +1ч', callback_data: `rsnooze_${id}_60` },
    ],
    [{ text: '✅ Готово', callback_data: `rdone_${id}` }],
  ];

  const repeatLabel = reminder.repeat === 'daily' ? '\n🔄 Повторяется ежедневно' :
    reminder.repeat === 'weekly' ? '\n🔄 Повторяется еженедельно' :
    reminder.repeat === 'hourly' ? '\n🔄 Повторяется каждый час' :
    reminder.repeat === 'custom' ? `\n🔄 Повторяется каждые ${formatTimeLeft(reminder.repeatInterval)}` : '';

  send(reminder.chatId, `🔔 ${header}Напоминание!\n\n${reminder.text}${repeatLabel}`, {
    reply_markup: { inline_keyboard: buttons }
  });

  reminderTimers.delete(id);

  // Повторяющиеся — перепланировать
  if (reminder.repeat && reminder.repeatInterval) {
    reminder.fireAt = Date.now() + reminder.repeatInterval;
    saveConfig();
    const timerId = setTimeout(() => fireReminder(id), reminder.repeatInterval);
    reminderTimers.set(id, timerId);
  } else {
    config.reminders = config.reminders.filter(r => r.id !== id);
    saveConfig();
  }
}

function loadReminders() {
  if (!config.reminders) config.reminders = [];
  nextReminderId = config.reminders.reduce((max, r) => Math.max(max, r.id + 1), 1);
  const now = Date.now();
  for (const r of [...config.reminders]) {
    if (r.fireAt <= now) {
      if (r.repeat && r.repeatInterval) {
        // Повторяющееся пропущенное — пропустить до следующего
        while (r.fireAt <= now) r.fireAt += r.repeatInterval;
        const delay = r.fireAt - now;
        const timerId = setTimeout(() => fireReminder(r.id), delay);
        reminderTimers.set(r.id, timerId);
      } else {
        send(r.chatId, `🔔 Пропущенное напоминание!\n\n${r.text}`);
        config.reminders = config.reminders.filter(x => x.id !== r.id);
      }
    } else {
      const delay = r.fireAt - now;
      const timerId = setTimeout(() => fireReminder(r.id), delay);
      reminderTimers.set(r.id, timerId);
    }
  }
  saveConfig();
}

loadReminders();

// === Задачи (todo, персистентные) ===
// config.todos = [{ id, chatId, text, status:'pending'|'in_progress'|'done', createdAt, dueAt?, priority?, category? }]
let nextTodoId = 1;
function loadTodos() {
  if (!config.todos) config.todos = [];
  nextTodoId = config.todos.reduce((max, t) => Math.max(max, t.id + 1), 1);
}
loadTodos();

// === Запланированные действия (schedule) ===
const scheduledTimers = new Map(); // id -> timerId
let nextScheduleId = 1;

async function fireScheduledAction(id) {
  const action = (config.scheduledActions || []).find(a => a.id === id);
  if (!action) return;
  config.scheduledActions = config.scheduledActions.filter(a => a.id !== id);
  saveConfig();
  scheduledTimers.delete(id);
  send(action.chatId, `⏰ Выполняю запланированное действие: ${action.description || action.actionName}`);
  try {
    const result = await executeAction(action.chatId, { name: action.actionName, body: action.actionBody });
    if (result && !result.silent) {
      const icon = result.success ? '✅' : '❌';
      send(action.chatId, `${icon} Результат: ${(result.output || '').slice(0, 2000)}`);
    }
  } catch (e) {
    send(action.chatId, `❌ Ошибка запланированного действия: ${e.message}`);
  }
}

function loadScheduledActions() {
  if (!config.scheduledActions) config.scheduledActions = [];
  nextScheduleId = config.scheduledActions.reduce((max, a) => Math.max(max, a.id + 1), 1);
  const now = Date.now();
  for (const a of [...config.scheduledActions]) {
    if (a.fireAt <= now) {
      // Пропущенное — выполнить сразу
      fireScheduledAction(a.id);
    } else {
      const delay = a.fireAt - now;
      const timerId = setTimeout(() => fireScheduledAction(a.id), delay);
      scheduledTimers.set(a.id, timerId);
    }
  }
}
loadScheduledActions();

// === Периодическая очистка Maps (каждый час) ===
setInterval(() => {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const THIRTY_MIN = 30 * 60 * 1000;
  const ONE_MIN = 60 * 1000;

  // Очищаем chatHistory старше 24ч (без активности)
  for (const [chatId] of chatHistory) {
    if (now - (chatHistoryAccess.get(chatId) || 0) > ONE_DAY) {
      chatHistory.delete(chatId);
      chatHistoryAccess.delete(chatId);
      lastResponse.delete(chatId);
    }
  }
  // Лимит: максимум 1000 записей в chatHistory
  if (chatHistory.size > 1000) {
    const sorted = [...chatHistory.keys()].sort((a, b) => (chatHistoryAccess.get(a) || 0) - (chatHistoryAccess.get(b) || 0));
    const toRemove = sorted.slice(0, chatHistory.size - 1000);
    for (const chatId of toRemove) {
      chatHistory.delete(chatId);
      chatHistoryAccess.delete(chatId);
      lastResponse.delete(chatId);
    }
  }

  // Очищаем lastResponse без соответствующей chatHistory
  for (const chatId of lastResponse.keys()) {
    if (!chatHistory.has(chatId)) lastResponse.delete(chatId);
  }

  // Safety net: activeTasks старше 30 мин
  for (const [chatId, task] of activeTasks) {
    if (task._startTime && now - task._startTime > THIRTY_MIN) {
      console.error(`[chatId:${chatId}] Safety net: cleaning stale activeTask (>30min)`);
      if (task.timer) clearInterval(task.timer);
      if (task.pid) { try { process.kill(task.pid); } catch(e) {} }
      activeTasks.delete(chatId);
      activeClaudeCount = Math.max(0, activeClaudeCount - 1);
    }
  }

  // Safety net: backgroundTasks старше 30 мин
  for (const [chatId, tasks] of backgroundTasks) {
    for (const [taskId, task] of tasks) {
      if (task.startTime && now - task.startTime > THIRTY_MIN) {
        console.error(`[chatId:${chatId}] Safety net: cleaning stale bgTask ${taskId} (>30min)`);
        if (task.abort) { try { task.abort.abort(); } catch(e) {} }
        tasks.delete(taskId);
        activeClaudeCount = Math.max(0, activeClaudeCount - 1);
      }
    }
    if (tasks.size === 0) backgroundTasks.delete(chatId);
  }

  // Очищаем mediaGroupBuffer старше 1 мин
  for (const [groupId, group] of mediaGroupBuffer) {
    if (group._created && now - group._created > ONE_MIN) {
      if (group.timer) clearTimeout(group.timer);
      mediaGroupBuffer.delete(groupId);
    }
  }

  // Очищаем rateLimitMap старше 1 мин
  for (const [chatId, ts] of rateLimitMap) {
    if (now - ts > ONE_MIN) rateLimitMap.delete(chatId);
  }

  // Очищаем _lastEditText
  _lastEditText.clear();

  console.log(`🧹 Очистка: chatHistory=${chatHistory.size}, activeTasks=${activeTasks.size}, activeClaudeCount=${activeClaudeCount}`);
}, 60 * 60 * 1000); // каждый час

// === Последний ответ (для quick actions) ===
const lastResponse = new Map(); // chatId -> {text, prompt}

// === MTProto клиент ===
const apiId = parseInt(process.env.TG_API_ID, 10) || 0;
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
  [{ text: '🃏 Флешкарты', callback_data: `nb_flash_${nbId}` }, { text: '📝 Квиз', callback_data: `nb_quiz_${nbId}` }],
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
async function processPostWithClaude(post, channel, callback) {
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

  const adminChatId = adminIds[0] || null;
  const adminModel = adminChatId ? getUserConfig(adminChatId).model : 'gemini-2.5-flash';
  try {
    const result = await callAI(adminModel, [{ role: 'user', content: input }], null, true, adminChatId);
    const text = result.text.trim();
    if (!text || text === 'SKIP') callback(null);
    else callback(text);
  } catch {
    callback(null);
  }
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
    const result = await callAI(uc.model, [{ role: 'user', content: input }], null, true, chatId);
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
  // 5-минутный таймаут на весь процесс авторизации
  const authTimeout = setTimeout(() => {
    console.error(`[chatId:${chatId}] MTProto auth timeout (5min)`);
    waitingAuthCode.delete(chatId);
    waitingAuthPassword.delete(chatId);
    mtAuthResolvers = {};
    send(chatId, '❌ Авторизация отменена по таймауту (5 мин)', mainMenu(chatId));
  }, 5 * 60 * 1000);
  try {
    send(chatId, `📱 Авторизация для ${phone}...\nТелеграм отправит код на этот номер.`);

    await mtClient.start({
      phoneNumber: () => Promise.resolve(phone),
      phoneCode: () => new Promise((resolve) => {
        mtAuthResolvers.code = resolve;
        send(chatId, '🔑 Введите код из Telegram ЧЕРЕЗ ПРОБЕЛЫ\n(например: 1 2 3 4 5)\n\n⚠️ Не вводите код слитно — Telegram заблокирует вход!', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'auth_cancel' }]] } });
        waitingAuthCode.add(chatId);
        setWaitingTimeout(chatId, waitingAuthCode, 'waitingAuthCode');
      }),
      password: () => new Promise((resolve) => {
        mtAuthResolvers.password = resolve;
        send(chatId, '🔒 Введите пароль двухфакторной аутентификации:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'auth_cancel' }]] } });
        waitingAuthPassword.add(chatId);
        setWaitingTimeout(chatId, waitingAuthPassword, 'waitingAuthPassword');
      }),
      onError: (err) => {
        console.error(`[chatId:${chatId}] MTProto auth error:`, err.message);
        send(chatId, `❌ Ошибка авторизации: ${err.message}`);
        throw err;
      }
    });

    clearTimeout(authTimeout);

    // Сохраняем сессию
    config.mtprotoSession = mtClient.session.save();
    saveConfig();
    mtConnected = true;

    send(chatId, '✅ MTProto авторизован! Мониторинг каналов через API включён.', mainMenu(chatId));
    console.log('✅ MTProto: авторизация успешна, сессия сохранена');
    setupRealtimeMonitor();

  } catch (e) {
    clearTimeout(authTimeout);
    console.error(`[chatId:${chatId}] MTProto auth: ${e.message}`);
    send(chatId, `❌ Ошибка: ${e.message}`);
    waitingAuthCode.delete(chatId);
    waitingAuthPassword.delete(chatId);
    mtAuthResolvers = {};
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
    const res = await fetch(`https://t.me/s/${encodeURIComponent(ch.username)}`, { signal: AbortSignal.timeout(15000) });
    const html = await res.text();
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
    return await checkChannelFallback(idx);
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
      const scrapRes = await fetch(`https://t.me/s/${encodeURIComponent(username)}`, { signal: AbortSignal.timeout(15000) });
      const html = await scrapRes.text();
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

  if (data === 'settings') await editText(chatId, msgId, '⚙️ Настройки:', settingsMenu(chatId));
  else if (data === 'help') await editText(chatId, msgId, helpText(), mainMenu(chatId));
  else if (data === 'status') {
    const busy = activeTasks.has(chatId);
    const histLen = (chatHistory.get(chatId) || []).length;
    const queueLen = getQueueSize(chatId);
    const provLabel = PROVIDER_LABELS[getProvider(uc.model)] || '';
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const memCount = (getMemory(chatId) || []).length;
    const skillCount = (uc.skills || []).length;
    const langLabel = uc.language ? uc.language.slice(0, 20) : '—';
    const sysLabel = uc.systemPrompt ? `${uc.systemPrompt.slice(0, 40)}${uc.systemPrompt.length > 40 ? '…' : ''}` : '—';
    await editText(chatId, msgId,
      `📊 Статус\n\n` +
      `┌─ 🤖 Модель ─────────\n` +
      `│ ${uc.model} ${provLabel}\n` +
      `│ 📁 ${uc.workDir}\n` +
      `│ ⏱ ${uc.timeout}с таймаут\n` +
      `└──────────────────\n\n` +
      `┌─ ⚡ Режимы ─────────\n` +
      `│ 🤖 Агент ${uc.agentMode !== false ? '✅' : '❌'}  👥 Мульти ${uc.multiAgent !== false ? '✅' : '❌'}\n` +
      `│ 📡 Стрим ${uc.streaming ? '✅' : '❌'}  🧠 Авто ${uc.autoModel ? '✅' : '❌'}\n` +
      `│ 🔢 Шаги: ${uc.agentMaxSteps || 10}\n` +
      `└──────────────────\n\n` +
      `┌─ 📈 Сессия ─────────\n` +
      `│ ${busy ? '⏳ Занят' : '🔄 Свободен'} | 📬 ${queueLen} в очереди\n` +
      `│ 💬 ${histLen} сообщ. | 🧠 ${memCount} памяти | ⚡ ${skillCount} навыков\n` +
      `│ 🌐 ${langLabel} | 💬 ${sysLabel}\n` +
      `│ ⏱ ${uptime}м аптайм | 🤖 AI: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}\n` +
      `└──────────────────`,
      mainMenu(chatId));
  }
  else if (data === 'clear') { stopTask(chatId); clearHistory(chatId); messageQueue.delete(chatId); await editText(chatId, msgId, '🗑 История, очередь и задачи очищены', mainMenu(chatId)); }
  else if (data === 'set_model') await editText(chatId, msgId, `🤖 Текущая модель: ${uc.model}\n\nВыберите провайдер:`, modelMenu());
  else if (data.startsWith('modelgrp_')) {
    const provider = data.slice(9);
    const label = PROVIDER_LABELS[provider] || provider;
    await editText(chatId, msgId, `${label} — выберите модель:`, modelProviderMenu(provider, chatId));
  }
  else if (data.startsWith('model_')) { uc.model = data.slice(6); saveUserConfig(chatId); await editText(chatId, msgId, `✅ Модель: ${uc.model} (${PROVIDER_LABELS[getProvider(uc.model)] || ''})`, settingsMenu(chatId)); }
  else if (data === 'set_timeout') await editText(chatId, msgId, '⏱ Таймаут:', timeoutMenu(chatId));
  else if (data.startsWith('timeout_')) { uc.timeout = safeParseInt(data.slice(8)); saveUserConfig(chatId); await editText(chatId, msgId, `✅ Таймаут: ${uc.timeout}с`, settingsMenu(chatId)); }
  else if (data === 'set_dir') { clearAllWaiting(chatId); await editText(chatId, msgId, `📁 Папка: ${uc.workDir}\n\nОтправьте путь:`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'settings' }]] } }); waitingDir.add(chatId); setWaitingTimeout(chatId, waitingDir, 'waitingDir'); }
  else if (data === 'set_system') {
    clearAllWaiting(chatId);
    const current = uc.systemPrompt ? `Текущий: ${uc.systemPrompt}` : 'Не задан';
    await editText(chatId, msgId, `💬 Системный промпт\n\n${current}\n\nОтправьте новый промпт или /clear_system для сброса:`, { reply_markup: { inline_keyboard: [
      [{ text: '🗑 Сбросить', callback_data: 'clear_system' }],
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
    waitingSystemPrompt.add(chatId);
    setWaitingTimeout(chatId, waitingSystemPrompt, 'waitingSystemPrompt');
  }
  else if (data === 'clear_system') { uc.systemPrompt = ''; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Системный промпт сброшен', settingsMenu(chatId)); waitingSystemPrompt.delete(chatId); }
  else if (data === 'toggle_auto') { uc.autoModel = !uc.autoModel; saveUserConfig(chatId); await editText(chatId, msgId, `🧠 Авто-модель: ${uc.autoModel ? '✅ Включена' : '❌ Выключена'}`, settingsMenu(chatId)); }
  else if (data === 'toggle_stream') { uc.streaming = !uc.streaming; saveUserConfig(chatId); await editText(chatId, msgId, `📡 Стриминг: ${uc.streaming ? '✅ Включён' : '❌ Выключен'}`, settingsMenu(chatId)); }
  else if (data === 'toggle_agent') { uc.agentMode = uc.agentMode === false ? true : false; saveUserConfig(chatId); await editText(chatId, msgId, `🤖 Агент: ${uc.agentMode ? '✅ Включён' : '❌ Выключен'}`, settingsMenu(chatId)); }
  else if (data === 'toggle_multi') { uc.multiAgent = uc.multiAgent === false ? true : false; saveUserConfig(chatId); await editText(chatId, msgId, `👥 Мульти: ${uc.multiAgent !== false ? '✅ Включён' : '❌ Выключен'}`, settingsMenu(chatId)); }
  else if (data === 'mem_toggle') { uc.memoryEnabled = uc.memoryEnabled === false ? true : false; saveUserConfig(chatId); await editText(chatId, msgId, `🧠 Память: ${uc.memoryEnabled ? '✅ Включена' : '❌ Выключена'}`, settingsMenu(chatId)); }
  else if (data === 'mem_auto_toggle') { uc.memoryAutoExtract = uc.memoryAutoExtract === false ? true : false; saveUserConfig(chatId); await editText(chatId, msgId, `🔄 Авто: ${uc.memoryAutoExtract ? '✅ Включено' : '❌ Выключено'}`, settingsMenu(chatId)); }
  else if (data === 'mem_clear') { clearMemory(chatId); await editText(chatId, msgId, '🗑 Память очищена', settingsMenu(chatId)); }
  // === Меню памяти ===
  else if (data === 'mem_menu') {
    const memory = getMemory(chatId);
    if (memory.length === 0) {
      await editText(chatId, msgId, '🧠 Память пуста\n\nБот автоматически запоминает важные факты из диалогов.', { reply_markup: { inline_keyboard: [
        [{ text: `🔄 Авто-запоминание: ${uc.memoryAutoExtract !== false ? '✅' : '❌'}`, callback_data: 'mem_auto_toggle' }],
        [{ text: '◀️ Назад', callback_data: 'back' }]
      ] } });
    } else {
      const catLabels = { preference: '⭐', fact: '📋', instruction: '📌', context: '📎' };
      const items = memory.slice(0, 15).map((m, i) => {
        const cat = catLabels[m.category] || '📋';
        return `${cat} ${m.fact.slice(0, 60)}${m.fact.length > 60 ? '...' : ''}`;
      });
      const rows = memory.slice(0, 10).map((m, i) => [
        { text: `❌ ${m.fact.slice(0, 30)}`, callback_data: `mem_del_${m.id}` }
      ]);
      rows.push([{ text: `🔄 Авто: ${uc.memoryAutoExtract !== false ? '✅' : '❌'}`, callback_data: 'mem_auto_toggle' }, { text: `🧠 Память: ${uc.memoryEnabled !== false ? '✅' : '❌'}`, callback_data: 'mem_toggle' }]);
      rows.push([{ text: '🗑 Очистить всё', callback_data: 'mem_clear_confirm' }]);
      rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
      await editText(chatId, msgId, `🧠 Память (${memory.length}/${MEMORY_LIMIT})\n\n${items.join('\n')}\n\nНажмите ❌ чтобы удалить запись:`, { reply_markup: { inline_keyboard: rows } });
    }
  }
  else if (data.startsWith('mem_del_')) {
    const entryId = data.slice(8);
    const deleted = deleteMemoryEntry(chatId, entryId);
    if (deleted) {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Удалено' });
      // Обновляем меню
      const memory = getMemory(chatId);
      const rows = memory.slice(0, 10).map((m) => [
        { text: `❌ ${m.fact.slice(0, 30)}`, callback_data: `mem_del_${m.id}` }
      ]);
      rows.push([{ text: '◀️ Назад', callback_data: 'mem_menu' }]);
      await editText(chatId, msgId, `🧠 Память (${memory.length}/${MEMORY_LIMIT})\n\nНажмите ❌ чтобы удалить:`, { reply_markup: { inline_keyboard: rows } });
    } else {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Запись не найдена' });
    }
  }
  else if (data === 'mem_clear_confirm') {
    await editText(chatId, msgId, '⚠️ Удалить ВСЮ память? Это действие необратимо.', { reply_markup: { inline_keyboard: [
      [{ text: '🗑 Да, очистить', callback_data: 'mem_clear' }, { text: '◀️ Отмена', callback_data: 'mem_menu' }]
    ] } });
  }
  // === Фоновые задачи ===
  else if (data.startsWith('bg_cancel_')) {
    const taskId = data.slice(10);
    const userBg = getUserBgTasks(chatId);
    const task = userBg.get(taskId);
    if (task) {
      if (task.abort) task.abort.abort();
      task.status = 'cancelled';
      userBg.delete(taskId);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Задача отменена' });
      await editText(chatId, msgId, `✅ Фоновая задача отменена: ${task.desc}`, mainMenu(chatId));
    } else {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Задача не найдена' });
    }
  }
  else if (data === 'set_max_steps') {
    await editText(chatId, msgId, `🔢 Максимум шагов агента (сейчас: ${uc.agentMaxSteps || 10}):`, { reply_markup: { inline_keyboard: [
      ...[5, 10, 15, 20].map(n => [{ text: (n === (uc.agentMaxSteps || 10) ? '✅ ' : '') + n, callback_data: `maxsteps_${n}` }]),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
  }
  else if (data.startsWith('maxsteps_')) { uc.agentMaxSteps = safeParseInt(data.slice(9)); saveUserConfig(chatId); await editText(chatId, msgId, `✅ Макс шагов: ${uc.agentMaxSteps}`, settingsMenu(chatId)); }
  else if (data === 'set_lang') await editText(chatId, msgId, '🌐 Язык ответов Claude:', langMenu());
  else if (data === 'lang_ru') { uc.language = 'Всегда отвечай на русском языке.'; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Язык: Русский', mainMenu(chatId)); }
  else if (data === 'lang_en') { uc.language = 'Always respond in English.'; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Language: English', mainMenu(chatId)); }
  else if (data === 'lang_clear') { uc.language = ''; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Языковая настройка сброшена', mainMenu(chatId)); }
  // === Интеграции (MCP) ===
  else if (data === 'integrations') {
    const servers = uc.mcpServers || [];
    const rows = [];
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      const status = s.enabled !== false ? '✅' : '❌';
      const toolCount = (s.tools || []).length;
      rows.push([{ text: `${status} ${s.name} (${toolCount} tools)`, callback_data: `mcp_info_${i}` }]);
    }
    rows.push([{ text: '➕ Добавить MCP сервер', callback_data: 'mcp_add' }]);
    rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
    const info = servers.length > 0
      ? `🔗 Интеграции (MCP)\n\n${servers.map((s, i) => `${i + 1}. ${s.enabled !== false ? '✅' : '❌'} ${s.name}\n   🔗 ${s.url.slice(0, 50)}\n   🔧 ${(s.tools || []).length} инструментов`).join('\n\n')}`
      : '🔗 Интеграции (MCP)\n\nНет подключённых серверов.\n\nMCP (Model Context Protocol) позволяет подключать внешние инструменты — поиск, базы данных, API и многое другое.\n\nНажмите ➕ чтобы добавить сервер.';
    await editText(chatId, msgId, info, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data === 'mcp_add') {
    clearAllWaiting(chatId);
    waitingMcpUrl.add(chatId);
    await editText(chatId, msgId, '🔗 Отправьте URL MCP-сервера:\n\nФормат: https://your-server.com/mcp\n\nПоддерживаются HTTP и SSE транспорты.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'integrations' }]] } });
  }
  else if (data.startsWith('mcp_info_')) {
    const idx = safeParseInt(data.slice(9));
    const servers = uc.mcpServers || [];
    if (idx < 0 || idx >= servers.length) return;
    const s = servers[idx];
    const toolsList = (s.tools || []).map(t => `  🔧 ${t.name}: ${(t.description || '—').slice(0, 60)}`).join('\n') || '  Нет инструментов';
    const lastSync = s.lastSync ? new Date(s.lastSync).toLocaleString('ru-RU') : 'никогда';
    await editText(chatId, msgId,
      `🔗 ${s.name}\n\n` +
      `🌐 ${s.url}\n` +
      `🔑 Ключ: ${s.apiKey ? '✅ задан (...' + s.apiKey.slice(-4) + ')' : '❌ нет'}\n` +
      `🔐 Авторизация: ${s.authType || 'auto'}\n` +
      `✅ Статус: ${s.enabled !== false ? 'активен' : 'выключен'}\n` +
      `🔄 Синхронизация: ${lastSync}\n\n` +
      `🔧 Инструменты (${(s.tools || []).length}):\n${toolsList}`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🔄 Синхронизировать', callback_data: `mcp_sync_${idx}` }, { text: s.enabled !== false ? '❌ Выкл' : '✅ Вкл', callback_data: `mcp_toggle_${idx}` }],
        [{ text: '🔐 Тип авторизации', callback_data: `mcp_editauth_${idx}` }],
        [{ text: '🗑 Удалить', callback_data: `mcp_del_${idx}` }],
        [{ text: '◀️ Назад', callback_data: 'integrations' }],
      ] } });
  }
  else if (data.startsWith('mcp_sync_')) {
    const idx = safeParseInt(data.slice(9));
    const servers = uc.mcpServers || [];
    if (idx < 0 || idx >= servers.length) return;
    await editText(chatId, msgId, `🔄 Синхронизация ${servers[idx].name}...`, { reply_markup: { inline_keyboard: [] } });
    try {
      const tools = await syncMcpServer(chatId, servers[idx]);
      await editText(chatId, msgId, `✅ ${servers[idx].name}: синхронизировано\n🔧 ${tools.length} инструментов`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К серверу', callback_data: `mcp_info_${idx}` }]] } });
    } catch (e) {
      await editText(chatId, msgId, `❌ Ошибка: ${e.message}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `mcp_info_${idx}` }]] } });
    }
  }
  else if (data.startsWith('mcp_toggle_')) {
    const idx = safeParseInt(data.slice(11));
    const servers = uc.mcpServers || [];
    if (idx < 0 || idx >= servers.length) return;
    servers[idx].enabled = servers[idx].enabled === false ? true : false;
    saveUserConfig(chatId);
    // Disconnect if disabled
    if (!servers[idx].enabled) mcpClients.delete(`${chatId}_${servers[idx].id}`);
    await editText(chatId, msgId, `${servers[idx].enabled ? '✅' : '❌'} ${servers[idx].name}: ${servers[idx].enabled ? 'включён' : 'выключен'}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К серверу', callback_data: `mcp_info_${idx}` }]] } });
  }
  else if (data.startsWith('mcp_del_')) {
    const idx = safeParseInt(data.slice(8));
    const servers = uc.mcpServers || [];
    if (idx < 0 || idx >= servers.length) return;
    const name = servers[idx].name;
    mcpClients.delete(`${chatId}_${servers[idx].id}`);
    servers.splice(idx, 1);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `🗑 ${name} удалён`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К интеграциям', callback_data: 'integrations' }]] } });
  }
  else if (data === 'mcp_nokey') {
    // Connect without API key
    if (waitingMcpKey.has(chatId)) {
      const { url, name } = waitingMcpKey.get(chatId);
      waitingMcpKey.delete(chatId);
      const id = name + '_' + Date.now().toString(36);
      const serverCfg = { id, name, url, apiKey: '', authType: 'auto', transport: 'http', tools: [], enabled: true, lastSync: null };
      await editText(chatId, msgId, `🔄 Подключаюсь к ${url}...`, { reply_markup: { inline_keyboard: [] } });
      try {
        const tools = await syncMcpServer(chatId, serverCfg);
        if (!uc.mcpServers) uc.mcpServers = [];
        uc.mcpServers.push(serverCfg);
        saveUserConfig(chatId);
        await editText(chatId, msgId, `✅ MCP сервер подключён!\n\n🔗 ${name}\n🔧 ${tools.length} инструментов:\n${tools.map(t => `  • ${t.name}`).join('\n')}`, { reply_markup: { inline_keyboard: [[{ text: '🔗 Интеграции', callback_data: 'integrations' }], [{ text: '◀️ Меню', callback_data: 'back' }]] } });
      } catch (e) {
        await editText(chatId, msgId, `❌ Не удалось подключиться: ${e.message}`, { reply_markup: { inline_keyboard: [[{ text: '🔄 Попробовать снова', callback_data: 'mcp_add' }], [{ text: '◀️ Назад', callback_data: 'integrations' }]] } });
      }
    }
  }
  else if (data.startsWith('mcp_editauth_')) {
    const idx = safeParseInt(data.slice(13));
    const servers = uc.mcpServers || [];
    if (idx < 0 || idx >= servers.length) return;
    const s = servers[idx];
    const types = [
      { label: '🔑 Bearer Token', data: `mcp_setauth_${idx}_bearer` },
      { label: '🔐 x-api-key', data: `mcp_setauth_${idx}_x-api-key` },
      { label: '🔒 api-key (Azure)', data: `mcp_setauth_${idx}_api-key` },
      { label: '⚙️ Custom Header', data: `mcp_setauth_${idx}_custom` },
      { label: '🤖 Auto-detect', data: `mcp_setauth_${idx}_auto` },
    ];
    await editText(chatId, msgId, `🔐 Тип авторизации для ${s.name}\n\nТекущий: ${s.authType || 'auto'}\nКлюч: ${s.apiKey ? '✅ задан (...' + s.apiKey.slice(-4) + ')' : '❌ нет'}`, {
      reply_markup: { inline_keyboard: [...types.map(t => [{ text: t.label, callback_data: t.data }]), [{ text: '◀️ Назад', callback_data: `mcp_info_${idx}` }]] }
    });
  }
  else if (data.startsWith('mcp_setauth_')) {
    const parts = data.slice(12).split('_');
    const idx = safeParseInt(parts[0]);
    const authType = parts.slice(1).join('_');
    const servers = uc.mcpServers || [];
    if (idx < 0 || idx >= servers.length) return;
    servers[idx].authType = authType;
    // Clear cached client to force reconnect
    mcpClients.delete(`${chatId}_${servers[idx].id}`);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Тип авторизации изменён на: ${authType}\n\n🔄 Переподключение потребуется при следующем вызове.`, { reply_markup: { inline_keyboard: [[{ text: '🔄 Синхронизировать', callback_data: `mcp_sync_${idx}` }], [{ text: '◀️ К серверу', callback_data: `mcp_info_${idx}` }]] } });
  }
  // === Меню специализированных режимов ===
  else if (data === 'modes_menu' || data.startsWith('modes_cat_')) {
    const currentMode = uc.activeMode;
    const currentModeInfo = currentMode ? SPECIALIZED_MODES[currentMode] : null;

    if (data.startsWith('modes_cat_')) {
      // Показать режимы конкретной категории
      const catId = data.slice(10);
      const catInfo = MODE_CATEGORIES.find(c => c.id === catId);
      const modes = SPECIALIZED_MODES_LIST.filter(m => m.category === catId);
      const rows = modes.map(m => {
        const active = currentMode === m.id ? ' ✅' : '';
        return [{ text: `${m.icon} ${m.label}${active}`, callback_data: `mode_info_${m.id}` }];
      });
      rows.push([{ text: '◀️ Назад', callback_data: 'modes_menu' }]);
      await editText(chatId, msgId, `${catInfo ? catInfo.label : '🎭'} Режимы — ${catInfo ? catInfo.label : catId}:`, { reply_markup: { inline_keyboard: rows } });
    } else {
      // Главное меню режимов
      const statusText = currentModeInfo
        ? `🎭 Активный режим: ${currentModeInfo.icon} ${currentModeInfo.label}\n📝 ${currentModeInfo.desc}`
        : '🎭 Режим не выбран\n\nСпециализированные режимы меняют поведение AI — он становится экспертом в выбранной области.';
      const rows = MODE_CATEGORIES.map(cat => {
        const count = SPECIALIZED_MODES_LIST.filter(m => m.category === cat.id).length;
        return [{ text: `${cat.label} (${count})`, callback_data: `modes_cat_${cat.id}` }];
      });
      if (currentMode) {
        rows.push([{ text: '❌ Выключить режим', callback_data: 'mode_off' }]);
      }
      rows.push([{ text: '◀️ Главное меню', callback_data: 'main' }]);
      await editText(chatId, msgId, statusText, { reply_markup: { inline_keyboard: rows } });
    }
  }
  else if (data.startsWith('mode_info_')) {
    const modeId = data.slice(10);
    const mode = SPECIALIZED_MODES[modeId];
    if (!mode) {
      await editText(chatId, msgId, '⚠️ Режим не найден', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'modes_menu' }]] } });
      return;
    }
    const isActive = uc.activeMode === modeId;
    const promptPreview = mode.prompt.slice(0, 300) + (mode.prompt.length > 300 ? '...' : '');
    const rows = [];
    if (isActive) {
      rows.push([{ text: '❌ Выключить', callback_data: 'mode_off' }]);
    } else {
      rows.push([{ text: '✅ Активировать', callback_data: `mode_set_${modeId}` }]);
    }
    rows.push([{ text: '◀️ Назад', callback_data: `modes_cat_${mode.category}` }]);
    await editText(chatId, msgId,
      `${mode.icon} ${mode.label} ${isActive ? '(АКТИВЕН)' : ''}\n\n` +
      `📝 ${mode.desc}\n\n` +
      `📄 Промпт:\n${promptPreview}`,
      { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('mode_set_')) {
    const modeId = data.slice(9);
    const mode = SPECIALIZED_MODES[modeId];
    if (!mode) {
      await editText(chatId, msgId, '⚠️ Режим не найден', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'modes_menu' }]] } });
      return;
    }
    uc.activeMode = modeId;
    saveUserConfig(chatId);
    await editText(chatId, msgId,
      `✅ Режим активирован!\n\n${mode.icon} ${mode.label}\n📝 ${mode.desc}\n\nТеперь все ответы будут в стиле ${mode.label}.\nДля выключения: /mode off`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🎭 К режимам', callback_data: 'modes_menu' }],
        [{ text: '◀️ Главное меню', callback_data: 'main' }],
      ] } });
  }
  else if (data === 'mode_off') {
    const prevMode = uc.activeMode ? SPECIALIZED_MODES[uc.activeMode] : null;
    uc.activeMode = null;
    saveUserConfig(chatId);
    await editText(chatId, msgId,
      `❌ Режим выключен${prevMode ? ` (был: ${prevMode.icon} ${prevMode.label})` : ''}\n\nТеперь бот работает в стандартном режиме.`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🎭 К режимам', callback_data: 'modes_menu' }],
        [{ text: '◀️ Главное меню', callback_data: 'main' }],
      ] } });
  }
  // === Snooze/Done для напоминаний ===
  else if (data.startsWith('rsnooze_')) {
    const parts = data.split('_');
    const remId = parseInt(parts[1]);
    const mins = parseInt(parts[2]);
    const delay = mins * 60000;
    if (!config.reminders) config.reminders = [];
    const existing = config.reminders.find(r => r.id === remId);
    if (existing) {
      // Уже повторяющееся — просто отложить
      existing.fireAt = Date.now() + delay;
      const oldTimer = reminderTimers.get(remId);
      if (oldTimer) clearTimeout(oldTimer);
      const timerId = setTimeout(() => fireReminder(remId), delay);
      reminderTimers.set(remId, timerId);
      saveConfig();
      await editText(chatId, msgId, `⏰ Отложено на ${formatTimeLeft(delay)}: ${existing.text}`);
    } else {
      // Уже удалённое — воссоздать
      await editText(chatId, msgId, `⏰ Напоминание уже завершено`);
    }
  }
  else if (data.startsWith('rdone_')) {
    const remId = parseInt(data.slice(6));
    const existing = (config.reminders || []).find(r => r.id === remId);
    if (existing) {
      config.reminders = config.reminders.filter(r => r.id !== remId);
      const oldTimer = reminderTimers.get(remId);
      if (oldTimer) clearTimeout(oldTimer);
      reminderTimers.delete(remId);
      saveConfig();
    }
    await editText(chatId, msgId, `✅ Напоминание выполнено`);
  }
  // === Todo управление ===
  else if (data.startsWith('todo_done_')) {
    const todoId = parseInt(data.slice(10));
    const todo = (config.todos || []).find(t => t.id === todoId && t.chatId === chatId);
    if (todo) {
      todo.status = 'done';
      todo.completedAt = Date.now();
      saveConfig();
      await editText(chatId, msgId, `✅ Задача выполнена: ${todo.text}`);
    }
  }
  else if (data.startsWith('todo_prog_')) {
    const todoId = parseInt(data.slice(10));
    const todo = (config.todos || []).find(t => t.id === todoId && t.chatId === chatId);
    if (todo) {
      todo.status = 'in_progress';
      saveConfig();
      await editText(chatId, msgId, `🔄 В работе: ${todo.text}`);
    }
  }
  else if (data.startsWith('todo_del_')) {
    const todoId = parseInt(data.slice(9));
    config.todos = (config.todos || []).filter(t => !(t.id === todoId && t.chatId === chatId));
    saveConfig();
    await editText(chatId, msgId, `🗑 Задача удалена`);
  }
  else if (data === 'back') await editText(chatId, msgId, '👋 Claude Code Remote', mainMenu(chatId));

  // === Исследование ===
  else if (data === 'research_mode') {
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '🔍 Введите тему для исследования.\n\nNotebookLM найдёт источники в интернете и создаст блокнот с результатами.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'back' }]] } });
    waitingNbResearch.add(chatId);
    setWaitingTimeout(chatId, waitingNbResearch, 'waitingNbResearch');
  }
  // === Навыки ===
  else if (data === 'noop') { /* already answered */ }
  else if (data === 'skills_menu' || data.startsWith('skills_page_')) {
    const skills = uc.skills || [];
    const page = data.startsWith('skills_page_') ? safeParseInt(data.slice(12)) : 0;
    const PAGE_SIZE = 5;
    if (skills.length === 0) {
      await editText(chatId, msgId, '⚡ Навыки пусты\n\nСохраняйте часто используемые промпты:\n/skill <имя> <промпт>\n\nПримеры:\n• /skill review Сделай code review\n• /skill summary Дай краткое резюме\n\nИли отправьте .txt файл при создании', { reply_markup: { inline_keyboard: [
        [{ text: '➕ Создать навык', callback_data: 'skill_create' }],
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
      rows.push([{ text: '➕ Создать', callback_data: 'skill_create' }]);
      rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
      await editText(chatId, msgId, `⚡ Навыки (${skills.length}):`, { reply_markup: { inline_keyboard: rows } });
    }
  }
  else if (data === 'skill_create') {
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '⚡ Введите имя навыка:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'skills_menu' }]] } });
    waitingSkillName.add(chatId);
    setWaitingTimeout(chatId, waitingSkillName, 'waitingSkillName');
  }
  else if (data.startsWith('skill_run_')) {
    const idx = safeParseInt(data.slice(10));
    if (idx < 0) return;
    const skill = (uc.skills || [])[idx];
    if (skill) {
      skill.uses = (skill.uses || 0) + 1;
      skill.lastUsed = Date.now();
      saveUserConfig(chatId);
      await editText(chatId, msgId, `⚡ Запускаю: ${skill.name}`);
      runClaude(chatId, skill.prompt);
    } else {
      await editText(chatId, msgId, '⚠️ Навык не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыкам', callback_data: 'skills_menu' }]] } });
    }
  }
  else if (data.startsWith('skill_info_')) {
    const idx = safeParseInt(data.slice(11));
    if (idx < 0) return;
    const skill = (uc.skills || [])[idx];
    if (skill) {
      const catLabel = (SKILL_CATEGORIES.find(c => c.id === skill.category) || {}).label || '📦 Другое';
      const lastUsedStr = skill.lastUsed ? new Date(skill.lastUsed).toLocaleString('ru-RU') : 'никогда';
      const promptPreview = skill.prompt.length > 300 ? skill.prompt.slice(0, 300) + '...' : skill.prompt;
      const desc = skill.description ? `\n📝 ${skill.description}` : '';
      await editText(chatId, msgId,
        `⚡ ${skill.name}${desc}\n\n📂 Категория: ${catLabel}\n📊 Использований: ${skill.uses || 0}\n🕐 Последний запуск: ${lastUsedStr}\n\n📄 Промпт:\n${promptPreview}`,
        { reply_markup: { inline_keyboard: [
          [{ text: '▶️ Запуск', callback_data: `skill_run_${idx}` }, { text: '✏️ Редактировать', callback_data: `skill_edit_${idx}` }],
          [{ text: '🗑 Удалить', callback_data: `skill_del_${idx}` }, { text: '◀️ Назад', callback_data: 'skills_menu' }],
        ] } }
      );
    } else {
      await editText(chatId, msgId, '⚠️ Навык не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыкам', callback_data: 'skills_menu' }]] } });
    }
  }
  else if (data.startsWith('skill_edit_')) {
    const idx = safeParseInt(data.slice(11));
    if (idx < 0) return;
    const skill = (uc.skills || [])[idx];
    if (skill) {
      await editText(chatId, msgId, `✏️ Редактирование: ${skill.name}\n\nВыберите что изменить:`, { reply_markup: { inline_keyboard: [
        [{ text: '📝 Имя', callback_data: `skedit_name_${idx}` }, { text: '📄 Промпт', callback_data: `skedit_prompt_${idx}` }],
        [{ text: '📝 Описание', callback_data: `skedit_desc_${idx}` }, { text: '📂 Категория', callback_data: `skedit_cat_${idx}` }],
        [{ text: '◀️ Назад', callback_data: `skill_info_${idx}` }],
      ] } });
    } else {
      await editText(chatId, msgId, '⚠️ Навык не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыкам', callback_data: 'skills_menu' }]] } });
    }
  }
  else if (data.startsWith('skedit_name_')) {
    const idx = safeParseInt(data.slice(12));
    if (idx < 0) return;
    clearAllWaiting(chatId);
    waitingSkillEditName.set(chatId, idx);
    setWaitingTimeout(chatId, waitingSkillEditName, 'waitingSkillEditName');
    await editText(chatId, msgId, '📝 Введите новое имя навыка:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]] } });
  }
  else if (data.startsWith('skedit_prompt_')) {
    const idx = safeParseInt(data.slice(14));
    if (idx < 0) return;
    clearAllWaiting(chatId);
    waitingSkillEditPrompt.set(chatId, idx);
    setWaitingTimeout(chatId, waitingSkillEditPrompt, 'waitingSkillEditPrompt');
    await editText(chatId, msgId, '📄 Введите новый промпт (или отправьте .txt файл):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]] } });
  }
  else if (data.startsWith('skedit_desc_')) {
    const idx = safeParseInt(data.slice(12));
    if (idx < 0) return;
    clearAllWaiting(chatId);
    waitingSkillEditDesc.set(chatId, idx);
    setWaitingTimeout(chatId, waitingSkillEditDesc, 'waitingSkillEditDesc');
    await editText(chatId, msgId, '📝 Введите описание навыка:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]] } });
  }
  else if (data.startsWith('skedit_cat_')) {
    const idx = safeParseInt(data.slice(11));
    if (idx < 0) return;
    const rows = SKILL_CATEGORIES.map(c => [{ text: c.label, callback_data: `skcat_${idx}_${c.id}` }]);
    rows.push([{ text: '◀️ Отмена', callback_data: `skill_info_${idx}` }]);
    await editText(chatId, msgId, '📂 Выберите категорию:', { reply_markup: { inline_keyboard: rows } });
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
      await editText(chatId, msgId, `✅ Категория "${skill.name}" → ${catLabel}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыку', callback_data: `skill_info_${idx}` }]] } });
    } else {
      await editText(chatId, msgId, '⚠️ Навык не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыкам', callback_data: 'skills_menu' }]] } });
    }
  }
  else if (data.startsWith('skill_del_')) {
    const idx = safeParseInt(data.slice(10));
    if (idx < 0) return;
    if (uc.skills && uc.skills[idx]) {
      const name = uc.skills[idx].name;
      uc.skills.splice(idx, 1);
      saveUserConfig(chatId);
      await editText(chatId, msgId, `🗑 Навык "${name}" удалён`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыкам', callback_data: 'skills_menu' }]] } });
    } else {
      await editText(chatId, msgId, '⚠️ Навык не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К навыкам', callback_data: 'skills_menu' }]] } });
    }
  }
  // Wizard создания навыка — выбор категории
  else if (data.startsWith('newskill_cat_')) {
    const catId = data.slice(13);
    const skillName = waitingSkillCategory.get(chatId);
    waitingSkillCategory.delete(chatId);
    if (skillName) {
      waitingSkillPrompt.set(chatId, { name: skillName, category: catId });
      setWaitingTimeout(chatId, waitingSkillPrompt, 'waitingSkillPrompt');
      await editText(chatId, msgId, `⚡ Имя: ${skillName}\n📂 Категория: ${(SKILL_CATEGORIES.find(c => c.id === catId) || {}).label || catId}\n\nТеперь введите промпт для навыка:\nИли отправьте .txt файл`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'skills_menu' }]] } });
    }
  }
  // Fallback для старых кнопок шаблонов
  // === Управление агентами ===
  else if (data === 'agents_menu' || data.startsWith('agents_page_')) {
    const custom = uc.customAgents || [];
    const page = data.startsWith('agents_page_') ? safeParseInt(data.slice(12)) : 0;
    const PAGE_SIZE = 5;
    const builtinEntries = Object.entries(AGENT_ROLES);
    const allItems = [];
    // Встроенные
    allItems.push({ type: 'separator', label: '🔧 Встроенные' });
    for (const [key, role] of builtinEntries) {
      if (key === 'orchestrator') continue;
      allItems.push({ type: 'builtin', key, ...role });
    }
    // Пользовательские
    if (custom.length > 0) {
      allItems.push({ type: 'separator', label: '👤 Пользовательские' });
      custom.forEach((a, i) => allItems.push({ type: 'custom', idx: i, ...a }));
    }
    const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
    const pageItems = allItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const rows = [];
    const multiOn = uc.multiAgent !== false;
    const agentOn = uc.agentMode !== false;
    for (const item of pageItems) {
      if (item.type === 'separator') {
        rows.push([{ text: `── ${item.label} ──`, callback_data: 'noop' }]);
      } else if (item.type === 'builtin') {
        rows.push([{ text: `${item.icon} ${item.label}`, callback_data: `agent_builtin_${item.key}` }]);
      } else {
        const statusIcon = item.enabled !== false ? '✅' : '❌';
        const useBadge = item.uses > 0 ? ` (${item.uses})` : '';
        rows.push([
          { text: `${item.icon || '🤖'} ${item.label}${useBadge}`, callback_data: `agent_info_${item.idx}` },
          { text: statusIcon, callback_data: `agent_toggle_${item.idx}` },
          { text: '🗑', callback_data: `agent_del_${item.idx}` },
        ]);
      }
    }
    if (totalPages > 1) {
      const nav = [];
      if (page > 0) nav.push({ text: '◀️', callback_data: `agents_page_${page - 1}` });
      nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
      if (page < totalPages - 1) nav.push({ text: '▶️', callback_data: `agents_page_${page + 1}` });
      rows.push(nav);
    }
    rows.push([{ text: '➕ Создать', callback_data: 'agent_create' }]);
    rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
    await editText(chatId, msgId, `👥 Агенты (встроенных: ${builtinEntries.length - 1}, своих: ${custom.length})\n\nСтатус: ${multiOn && agentOn ? '✅ Активна' : '❌ Выключена'}`, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('agent_builtin_')) {
    const key = data.slice(14);
    const role = AGENT_ROLES[key];
    if (role) {
      await editText(chatId, msgId, `${role.icon} ${role.label} (встроенный)\n\n📝 ${role.desc}\n\n⚙️ Встроенный агент — не может быть изменён или удалён.\nОн автоматически используется оркестратором.`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agent_info_')) {
    const idx = safeParseInt(data.slice(11));
    if (idx < 0) return;
    const agent = (uc.customAgents || [])[idx];
    if (agent) {
      const lastUsedStr = agent.lastUsed ? new Date(agent.lastUsed).toLocaleString('ru-RU') : 'никогда';
      const promptPreview = agent.prompt ? (agent.prompt.length > 300 ? agent.prompt.slice(0, 300) + '...' : agent.prompt) : 'Не задан';
      const modelStr = agent.model || 'наследуется';
      const statusStr = agent.enabled !== false ? '✅ Включён' : '❌ Выключен';
      await editText(chatId, msgId,
        `${agent.icon || '🤖'} ${agent.label}\n\n📝 ${agent.desc || 'Без описания'}\n\n📊 Статус: ${statusStr}\n🔢 Макс шагов: ${agent.maxSteps || 3}\n🤖 Модель: ${modelStr}\n📊 Использований: ${agent.uses || 0}\n🕐 Последний запуск: ${lastUsedStr}\n\n📄 Промпт:\n${promptPreview}`,
        { reply_markup: { inline_keyboard: [
          [{ text: '▶️ Тест', callback_data: `agent_test_${idx}` }, { text: '✏️ Редактировать', callback_data: `agent_edit_${idx}` }],
          [{ text: agent.enabled !== false ? '❌ Выключить' : '✅ Включить', callback_data: `agent_toggle_${idx}` }, { text: '🗑 Удалить', callback_data: `agent_del_${idx}` }],
          [{ text: '◀️ Назад', callback_data: 'agents_menu' }],
        ] } }
      );
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agent_edit_')) {
    const idx = safeParseInt(data.slice(11));
    if (idx < 0) return;
    const agent = (uc.customAgents || [])[idx];
    if (agent) {
      await editText(chatId, msgId, `✏️ Редактирование: ${agent.icon || '🤖'} ${agent.label}\n\nВыберите что изменить:`, { reply_markup: { inline_keyboard: [
        [{ text: '📝 Имя', callback_data: `agedit_name_${idx}` }, { text: '🎨 Иконка', callback_data: `agedit_icon_${idx}` }],
        [{ text: '📄 Промпт', callback_data: `agedit_prompt_${idx}` }, { text: '📝 Описание', callback_data: `agedit_desc_${idx}` }],
        [{ text: '🔢 Шагов', callback_data: `agedit_steps_${idx}` }, { text: '🤖 Модель', callback_data: `agedit_model_${idx}` }],
        [{ text: '◀️ Назад', callback_data: `agent_info_${idx}` }],
      ] } });
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agedit_name_')) {
    const idx = safeParseInt(data.slice(12));
    if (idx < 0) return;
    clearAllWaiting(chatId);
    waitingAgentEditName.set(chatId, idx);
    setWaitingTimeout(chatId, waitingAgentEditName, 'waitingAgentEditName');
    await editText(chatId, msgId, '📝 Введите новое имя агента:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `agent_info_${idx}` }]] } });
  }
  else if (data.startsWith('agedit_prompt_')) {
    const idx = safeParseInt(data.slice(14));
    if (idx < 0) return;
    clearAllWaiting(chatId);
    waitingAgentEditPrompt.set(chatId, idx);
    setWaitingTimeout(chatId, waitingAgentEditPrompt, 'waitingAgentEditPrompt');
    await editText(chatId, msgId, '📄 Введите новый промпт (или отправьте .txt файл):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `agent_info_${idx}` }]] } });
  }
  else if (data.startsWith('agedit_desc_')) {
    const idx = safeParseInt(data.slice(12));
    if (idx < 0) return;
    clearAllWaiting(chatId);
    waitingAgentEditDesc.set(chatId, idx);
    setWaitingTimeout(chatId, waitingAgentEditDesc, 'waitingAgentEditDesc');
    await editText(chatId, msgId, '📝 Введите описание агента:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: `agent_info_${idx}` }]] } });
  }
  else if (data.startsWith('agedit_icon_')) {
    const idx = safeParseInt(data.slice(12));
    if (idx < 0) return;
    const iconRows = [
      [{ text: '🤖', callback_data: `agseticon_${idx}_🤖` }, { text: '🧠', callback_data: `agseticon_${idx}_🧠` }, { text: '⚙️', callback_data: `agseticon_${idx}_⚙️` }, { text: '🛠', callback_data: `agseticon_${idx}_🛠` }],
      [{ text: '🎯', callback_data: `agseticon_${idx}_🎯` }, { text: '📊', callback_data: `agseticon_${idx}_📊` }, { text: '🔬', callback_data: `agseticon_${idx}_🔬` }, { text: '💡', callback_data: `agseticon_${idx}_💡` }],
      [{ text: '🐍', callback_data: `agseticon_${idx}_🐍` }, { text: '🌐', callback_data: `agseticon_${idx}_🌐` }, { text: '🔒', callback_data: `agseticon_${idx}_🔒` }, { text: '📝', callback_data: `agseticon_${idx}_📝` }],
      [{ text: '◀️ Отмена', callback_data: `agent_info_${idx}` }],
    ];
    await editText(chatId, msgId, '🎨 Выберите иконку:', { reply_markup: { inline_keyboard: iconRows } });
  }
  else if (data.startsWith('agseticon_')) {
    const parts = data.slice(10);
    const sepIdx = parts.indexOf('_');
    const idx = parseInt(parts.slice(0, sepIdx));
    const icon = parts.slice(sepIdx + 1);
    if (uc.customAgents && uc.customAgents[idx]) {
      uc.customAgents[idx].icon = icon;
      saveUserConfig(chatId);
      await editText(chatId, msgId, `✅ Иконка обновлена: ${icon}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агенту', callback_data: `agent_info_${idx}` }]] } });
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agedit_steps_')) {
    const idx = safeParseInt(data.slice(13));
    if (idx < 0) return;
    const stepsRows = [1, 2, 3, 4, 5].map(s => {
      const current = (uc.customAgents || [])[idx]?.maxSteps || 3;
      return { text: (s === current ? '✅ ' : '') + s, callback_data: `agsetsteps_${idx}_${s}` };
    });
    await editText(chatId, msgId, '🔢 Выберите макс. шагов субагента:', { reply_markup: { inline_keyboard: [stepsRows, [{ text: '◀️ Отмена', callback_data: `agent_info_${idx}` }]] } });
  }
  else if (data.startsWith('agsetsteps_')) {
    const parts = data.slice(11).split('_');
    const idx = parseInt(parts[0]);
    const steps = parseInt(parts[1]);
    if (isNaN(idx) || isNaN(steps) || steps < 1 || steps > 10) return;
    if (uc.customAgents && uc.customAgents[idx]) {
      uc.customAgents[idx].maxSteps = steps;
      saveUserConfig(chatId);
      await editText(chatId, msgId, `✅ Макс шагов: ${steps}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агенту', callback_data: `agent_info_${idx}` }]] } });
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agedit_model_')) {
    const idx = safeParseInt(data.slice(13));
    if (idx < 0) return;
    const models = [
      { text: '🔄 Наследовать', callback_data: `agsetmodel_${idx}_` },
      { text: '🟣 Claude Sonnet', callback_data: `agsetmodel_${idx}_claude-sonnet` },
      { text: '🔵 Gemini Pro', callback_data: `agsetmodel_${idx}_gemini-3.1-pro` },
    ];
    const extra = [];
    if (process.env.OPENAI_API_KEY) extra.push({ text: '🟢 GPT-4.1', callback_data: `agsetmodel_${idx}_gpt-4.1` });
    if (process.env.GROQ_API_KEY) extra.push({ text: '⚡ Groq', callback_data: `agsetmodel_${idx}_llama-70b` });
    const rows = [models];
    if (extra.length > 0) rows.push(extra);
    rows.push([{ text: '◀️ Отмена', callback_data: `agent_info_${idx}` }]);
    await editText(chatId, msgId, `🤖 Выберите модель для агента:\nТекущая: ${(uc.customAgents || [])[idx]?.model || 'наследуется'}`, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('agsetmodel_')) {
    const parts = data.slice(11);
    const sepIdx = parts.indexOf('_');
    const idx = parseInt(parts.slice(0, sepIdx));
    const model = parts.slice(sepIdx + 1);
    if (uc.customAgents && uc.customAgents[idx]) {
      uc.customAgents[idx].model = model;
      saveUserConfig(chatId);
      await editText(chatId, msgId, `✅ Модель: ${model || 'наследуется'}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агенту', callback_data: `agent_info_${idx}` }]] } });
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agent_toggle_')) {
    const idx = safeParseInt(data.slice(13));
    if (idx < 0) return;
    if (uc.customAgents && uc.customAgents[idx]) {
      uc.customAgents[idx].enabled = uc.customAgents[idx].enabled === false ? true : false;
      saveUserConfig(chatId);
      const status = uc.customAgents[idx].enabled ? '✅ Включён' : '❌ Выключен';
      await editText(chatId, msgId, `${uc.customAgents[idx].icon || '🤖'} ${uc.customAgents[idx].label}: ${status}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agent_del_')) {
    const idx = safeParseInt(data.slice(10));
    if (idx < 0) return;
    if (uc.customAgents && uc.customAgents[idx]) {
      const name = uc.customAgents[idx].label;
      uc.customAgents.splice(idx, 1);
      saveUserConfig(chatId);
      await editText(chatId, msgId, `🗑 Агент "${name}" удалён`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data === 'agent_create') {
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '👤 Создание нового агента\n\nВведите имя агента:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'agents_menu' }]] } });
    waitingAgentName.add(chatId);
    setWaitingTimeout(chatId, waitingAgentName, 'waitingAgentName');
  }
  else if (data.startsWith('agicon_')) {
    const icon = data.slice(7);
    const agentData = waitingAgentIcon.get(chatId);
    if (agentData) {
      waitingAgentIcon.delete(chatId);
      if (icon === 'skip') {
        agentData.icon = '🤖';
      } else {
        agentData.icon = icon;
      }
      waitingAgentDesc.set(chatId, agentData);
      setWaitingTimeout(chatId, waitingAgentDesc, 'waitingAgentDesc');
      await editText(chatId, msgId, `${agentData.icon} Иконка: ${agentData.icon}\n\n📝 Введите описание агента (кратко, 1-2 предложения):`, { reply_markup: { inline_keyboard: [[{ text: '⏩ Пропустить', callback_data: 'agent_wizard_skip_desc' }]] } });
    }
  }
  else if (data === 'agent_wizard_skip_desc') {
    const agentData = waitingAgentDesc.get(chatId);
    if (agentData) {
      waitingAgentDesc.delete(chatId);
      agentData.desc = '';
      waitingAgentPrompt.set(chatId, agentData);
      setWaitingTimeout(chatId, waitingAgentPrompt, 'waitingAgentPrompt');
      await editText(chatId, msgId, `${agentData.icon} ${agentData.label}\n\n📄 Введите системный промпт для агента:\nИли отправьте .txt файл`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'agents_menu' }]] } });
    }
  }
  else if (data.startsWith('agent_test_')) {
    const idx = safeParseInt(data.slice(11));
    if (idx < 0) return;
    const agent = (uc.customAgents || [])[idx];
    if (agent) {
      await editText(chatId, msgId, `▶️ Тестирую агента: ${agent.icon || '🤖'} ${agent.label}...`);
      const testPrompt = `[ACTION: delegate]\nроль: ${agent.id}\nзадача: Представься и опиши что умеешь в 3-4 предложениях\n[/ACTION]`;
      runClaude(chatId, testPrompt);
    } else {
      await editText(chatId, msgId, '⚠️ Агент не найден (возможно, был удалён)', { reply_markup: { inline_keyboard: [[{ text: '◀️ К агентам', callback_data: 'agents_menu' }]] } });
    }
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
    await editText(chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('user_detail_')) {
    const targetId = Number(data.slice(12));
    if (!targetId || isNaN(targetId)) return;
    const tc = getUserConfig(targetId);
    if (!tc) { await editText(chatId, msgId, '❌ Пользователь не найден', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'users_panel' }]] } }); return; }
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
    await editText(chatId, msgId, info, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('user_ban_')) {
    const targetId = Number(data.slice(9));
    if (!targetId || isNaN(targetId)) return;
    const tc = getUserConfig(targetId);
    if (!tc) { await editText(chatId, msgId, '❌ Пользователь не найден', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'users_panel' }]] } }); return; }
    tc.banned = true;
    saveUserConfig(targetId);
    await editText(chatId, msgId, `🚫 User ${targetId} забанен`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }
  else if (data.startsWith('user_unban_')) {
    const targetId = Number(data.slice(11));
    if (!targetId || isNaN(targetId)) return;
    const tc = getUserConfig(targetId);
    if (!tc) { await editText(chatId, msgId, '❌ Пользователь не найден', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'users_panel' }]] } }); return; }
    tc.banned = false;
    saveUserConfig(targetId);
    await editText(chatId, msgId, `✅ User ${targetId} разбанен`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }
  else if (data.startsWith('user_role_')) {
    const targetId = Number(data.slice(10));
    if (!targetId || isNaN(targetId)) return;
    const tc = getUserConfig(targetId);
    if (!tc) { await editText(chatId, msgId, '❌ Пользователь не найден', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'users_panel' }]] } }); return; }
    tc.role = tc.role === 'admin' ? 'user' : 'admin';
    if (tc.role === 'user') tc.workDir = '/tmp';
    saveUserConfig(targetId);
    const newRole = tc.role === 'admin' ? '👑 admin' : '👤 user';
    await editText(chatId, msgId, `✅ User ${targetId} → ${newRole}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }
  else if (data.startsWith('user_clear_')) {
    const targetId = Number(data.slice(11));
    if (!targetId || isNaN(targetId)) return;
    clearHistory(targetId);
    await editText(chatId, msgId, `🗑 История User ${targetId} очищена`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `user_detail_${targetId}` }]] } });
  }

  // === Каналы ===
  else if (data === 'channels') {
    const count = config.channels ? config.channels.length : 0;
    const active = config.channels ? config.channels.filter(c => c.enabled).length : 0;
    await editText(chatId, msgId, `📡 Мониторинг каналов\n\nВсего: ${count} | Активных: ${active}`, channelsMenu());
  }
  else if (data === 'ch_add') {
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '📡 Отправьте @username или ссылку на канал\n\nПримеры:\n• durov\n• @durov\n• https://t.me/durov', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'channels' }]] } });
    waitingChannelAdd.add(chatId);
    setWaitingTimeout(chatId, waitingChannelAdd, 'waitingChannelAdd');
  }
  else if (data === 'ch_interval') {
    await editText(chatId, msgId, `⏱ Интервал проверки (сейчас: ${config.monitorInterval}с):`, monitorIntervalMenu());
  }
  else if (data.startsWith('ch_intval_')) {
    config.monitorInterval = safeParseInt(data.slice(10));
    saveConfig();
    restartMonitoring();
    await editText(chatId, msgId, `✅ Интервал: ${config.monitorInterval}с`, channelsMenu());
  }
  else if (data.startsWith('ch_toggle_')) {
    const idx = safeParseInt(data.slice(10));
    if (idx < 0) return;
    if (config.channels[idx]) {
      config.channels[idx].enabled = !config.channels[idx].enabled;
      saveConfig();
      restartMonitoring();
      await editText(chatId, msgId, `${config.channels[idx].enabled ? '✅' : '❌'} @${config.channels[idx].username}: ${config.channels[idx].enabled ? 'включён' : 'выключен'}`, channelDetailMenu(idx));
    }
  }
  else if (data.startsWith('ch_del_')) {
    const idx = safeParseInt(data.slice(7));
    if (idx < 0) return;
    if (config.channels[idx]) {
      const name = config.channels[idx].username;
      config.channels.splice(idx, 1);
      saveConfig();
      restartMonitoring();
      await editText(chatId, msgId, `🗑 @${name} удалён`, channelsMenu());
    }
  }
  else if (data.startsWith('ch_kw_')) {
    const idx = safeParseInt(data.slice(6));
    if (idx < 0) return;
    const ch = config.channels[idx];
    if (ch) {
      const current = ch.keywords.length ? ch.keywords.join(', ') : 'нет (все сообщения)';
      clearAllWaiting(chatId);
      await editText(chatId, msgId, `🔑 Ключевые слова для @${ch.username}\n\nТекущие: ${current}\n\nОтправьте новые через запятую или "clear" для сброса:`, { reply_markup: { inline_keyboard: [
        [{ text: '🗑 Сбросить фильтр', callback_data: `ch_kw_clear_${idx}` }],
        [{ text: '◀️ Назад', callback_data: `ch_${idx}` }]
      ] } });
      waitingChannelKeywords.set(chatId, idx);
      setWaitingTimeout(chatId, waitingChannelKeywords, 'waitingChannelKeywords');
    }
  }
  else if (data.startsWith('ch_kw_clear_')) {
    const idx = safeParseInt(data.slice(12));
    if (idx < 0) return;
    if (config.channels[idx]) {
      config.channels[idx].keywords = [];
      saveConfig();
      await editText(chatId, msgId, `✅ Фильтр сброшен для @${config.channels[idx].username}`, channelDetailMenu(idx));
    }
    waitingChannelKeywords.delete(chatId);
  }
  else if (data.startsWith('ch_check_')) {
    const idx = safeParseInt(data.slice(9));
    if (idx < 0) return;
    const ch = config.channels[idx];
    if (ch) {
      await editText(chatId, msgId, `🔄 Проверяю @${ch.username}...`);
      checkChannelNow(idx).then(async (matched) => {
        if (matched.length === 0) {
          await editText(chatId, msgId, `📡 @${ch.username}: нет новых сообщений`, channelDetailMenu(idx));
        } else {
          await editText(chatId, msgId, `📡 @${ch.username}: ${matched.length} новых!`, channelDetailMenu(idx));
        }
      }).catch(async (e) => {
        console.error(`[chatId:${chatId}] checkChannelNow error:`, e.message);
        await editText(chatId, msgId, `❌ Ошибка проверки @${ch.username}: ${e.message}`, channelDetailMenu(idx));
      });
    }
  }
  else if (data === 'ch_smart') {
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '🧠 Умная настройка\n\nОпишите своими словами:\n• Какой канал парсить\n• Что именно отслеживать\n• В каком виде присылать\n• Что игнорировать\n\nПримеры:\n• «Следи за @durov, присылай только анонсы обновлений Telegram в виде краткого резюме на 2-3 предложения»\n• «Парси @crypto_signals, отправляй только сигналы на покупку с ценой и монетой, остальное игнорируй»\n• «Мониторь @techcrunch — только новости про AI, кратко на русском»', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'channels' }]] } });
    waitingSmartSetup.add(chatId);
    setWaitingTimeout(chatId, waitingSmartSetup, 'waitingSmartSetup');
  }
  else if (data.startsWith('ch_prompt_')) {
    const idx = safeParseInt(data.slice(10));
    if (idx < 0) return;
    const ch = config.channels[idx];
    if (ch) {
      const current = ch.prompt ? ch.prompt : 'не задана (посты приходят как есть)';
      clearAllWaiting(chatId);
      await editText(chatId, msgId, `🧠 Инструкция для @${ch.username}\n\nТекущая:\n${current}\n\nОтправьте новую инструкцию или "clear" для сброса.\n\nПримеры:\n• «Присылай только новости про AI, кратко на 2 предложения»\n• «Фильтруй рекламу, присылай только полезный контент с кратким резюме»`, { reply_markup: { inline_keyboard: [
        [{ text: '🗑 Сбросить', callback_data: `ch_prompt_clear_${idx}` }],
        [{ text: '◀️ Назад', callback_data: `ch_${idx}` }]
      ] } });
      waitingChannelPrompt.set(chatId, idx);
      setWaitingTimeout(chatId, waitingChannelPrompt, 'waitingChannelPrompt');
    }
  }
  else if (data.startsWith('ch_prompt_clear_')) {
    const idx = safeParseInt(data.slice(16));
    if (idx < 0) return;
    if (config.channels[idx]) {
      config.channels[idx].prompt = '';
      saveConfig();
      await editText(chatId, msgId, `✅ Инструкция сброшена для @${config.channels[idx].username}\nПосты будут приходить без AI-обработки.`, channelDetailMenu(idx));
    }
    waitingChannelPrompt.delete(chatId);
  }
  else if (data === 'ch_mtproto') {
    if (mtConnected) {
      await editText(chatId, msgId, '🟢 MTProto подключён\n\nРеалтайм-мониторинг активен.\nНовые посты приходят мгновенно.', channelsMenu());
    } else {
      await editText(chatId, msgId, '🔴 MTProto не авторизован\n\nИспользуется fallback (скрапинг t.me/s/).\nДля реалтайм-мониторинга: /auth', channelsMenu());
    }
  }
  else if (data === 'auth_cancel') {
    waitingAuthPhone.delete(chatId);
    waitingAuthCode.delete(chatId);
    waitingAuthPassword.delete(chatId);
    if (mtAuthResolvers.code) { mtAuthResolvers.code('CANCEL'); mtAuthResolvers.code = null; }
    if (mtAuthResolvers.password) { mtAuthResolvers.password('CANCEL'); mtAuthResolvers.password = null; }
    await editText(chatId, msgId, '❌ Авторизация отменена', mainMenu(chatId));
  }
  else if (data.match(/^ch_\d+$/)) {
    const idx = safeParseInt(data.slice(3));
    if (idx < 0) return;
    const ch = config.channels[idx];
    if (ch) {
      const kwText = ch.keywords.length ? ch.keywords.join(', ') : 'все';
      await editText(chatId, msgId, `📡 @${ch.username}\n\n${ch.enabled ? '✅ Включён' : '❌ Выключен'}\n🔑 Ключевые: ${kwText}\n📝 Последний пост: #${ch.lastPostId || '?'}`, channelDetailMenu(idx));
    }
  }

  // === NotebookLM (прямой MCP — быстрый) ===
  else if (data === 'nb_menu') {
    await editText(chatId, msgId, '📓 NotebookLM\n\nБлокноты, источники, подкасты, отчёты, видео, квизы и многое другое.\n⚡ Прямое MCP-подключение', nbMainMenu);
  }
  else if (data === 'nb_list') {
    await editText(chatId, msgId, '📋 Загружаю...');
    try {
      const result = await nbClient.call('notebook_list', { max_results: 50 });
      const notebooks = result.notebooks || result.data?.notebooks || [];
      if (notebooks.length === 0) {
        await editText(chatId, msgId, '📋 Нет блокнотов', nbMainMenu);
      } else {
        const rows = notebooks.map(nb => [{ text: `📓 ${(nb.title || 'Без названия').slice(0, 30)}`, callback_data: `nb_detail_${nb.id || nb.notebook_id}` }]);
        rows.push([{ text: '◀️ Назад', callback_data: 'nb_menu' }]);
        await editText(chatId, msgId, `📋 Блокноты (${notebooks.length}):`, { reply_markup: { inline_keyboard: rows } });
      }
    } catch(e) { await editText(chatId, msgId, `❌ ${e.message}`, nbMainMenu); }
  }
  else if (data === 'nb_create') {
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '➕ Введите название для нового блокнота:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'nb_menu' }]] } });
    waitingNbCreate.add(chatId);
    setWaitingTimeout(chatId, waitingNbCreate, 'waitingNbCreate');
  }
  else if (data === 'nb_research') {
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '🔍 Введите тему для исследования:\n\nNotebookLM найдёт релевантные источники в интернете.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'nb_menu' }]] } });
    waitingNbResearch.add(chatId);
    setWaitingTimeout(chatId, waitingNbResearch, 'waitingNbResearch');
  }
  else if (data.startsWith('nb_detail_')) {
    const nbId = data.slice(10);
    await editText(chatId, msgId, '📓 Загружаю...');
    try {
      const result = await nbClient.call('notebook_get', { notebook_id: nbId });
      const nb = result.notebook || result;
      const title = nb.title || 'Без названия';
      const sources = nb.sources || [];
      let text = `📓 ${title}\n\n📚 Источников: ${sources.length}`;
      if (sources.length > 0) {
        text += '\n\n' + sources.map((s, i) => `${i + 1}. ${s.title || s.source_type || 'Источник'}`).join('\n');
      }
      await editText(chatId, msgId, text, nbDetailMenu(nbId));
    } catch(e) { await editText(chatId, msgId, `❌ ${e.message}`, nbMainMenu); }
  }
  else if (data.startsWith('nb_query_')) {
    const nbId = data.slice(9);
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '❓ Задайте вопрос по содержимому блокнота:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbQuery.set(chatId, nbId);
    setWaitingTimeout(chatId, waitingNbQuery, 'waitingNbQuery');
  }
  else if (data.startsWith('nb_addurl_')) {
    const nbId = data.slice(10);
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '🔗 Отправьте URL для добавления:\n\nПоддерживаются: веб-страницы, YouTube', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbUrl.set(chatId, nbId);
    setWaitingTimeout(chatId, waitingNbUrl, 'waitingNbUrl');
  }
  else if (data.startsWith('nb_addtxt_')) {
    const nbId = data.slice(10);
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '📝 Отправьте текст для добавления в блокнот:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbText.set(chatId, nbId);
    setWaitingTimeout(chatId, waitingNbText, 'waitingNbText');
  }
  else if (data.startsWith('nb_audio_')) {
    const nbId = data.slice(9);
    await editText(chatId, msgId, '🎙 Выберите формат подкаста:', nbAudioMenu(nbId));
  }
  else if (data.match(/^nb_aud_(deep_dive|brief|critique|debate)_/)) {
    const m = data.match(/^nb_aud_(deep_dive|brief|critique|debate)_(.+)$/);
    const format = m[1], nbId = m[2];
    const names = { deep_dive: 'Deep Dive подкаст', brief: 'Краткий подкаст', critique: 'Критика', debate: 'Дебаты' };
    await editText(chatId, msgId, `🎙 Запускаю ${names[format]}...`);
    nbDirectGenerate(chatId, msgId, nbId, 'audio_overview_create', { format, language: 'ru', confirm: true }, '🎙', names[format]);
  }
  else if (data.startsWith('nb_report_')) {
    const nbId = data.slice(10);
    await editText(chatId, msgId, '📊 Выберите тип отчёта:', nbReportMenu(nbId));
  }
  else if (data.startsWith('nb_rep_briefing_')) {
    const nbId = data.slice(16);
    await editText(chatId, msgId, '📋 Генерирую брифинг...');
    nbDirectGenerate(chatId, msgId, nbId, 'report_create', { report_format: 'Briefing Doc', language: 'ru', confirm: true }, '📋', 'Брифинг');
  }
  else if (data.startsWith('nb_rep_study_')) {
    const nbId = data.slice(13);
    await editText(chatId, msgId, '📖 Генерирую учебный гайд...');
    nbDirectGenerate(chatId, msgId, nbId, 'report_create', { report_format: 'Study Guide', language: 'ru', confirm: true }, '📖', 'Учебный гайд');
  }
  else if (data.startsWith('nb_rep_blog_')) {
    const nbId = data.slice(12);
    await editText(chatId, msgId, '✍️ Генерирую блог-пост...');
    nbDirectGenerate(chatId, msgId, nbId, 'report_create', { report_format: 'Blog Post', language: 'ru', confirm: true }, '✍️', 'Блог-пост');
  }
  else if (data.startsWith('nb_rep_custom_')) {
    const nbId = data.slice(14);
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '🎨 Опишите формат отчёта:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_report_${nbId}` }]] } });
    waitingNbReportCustom.set(chatId, nbId);
    setWaitingTimeout(chatId, waitingNbReportCustom, 'waitingNbReportCustom');
  }
  else if (data.startsWith('nb_video_')) {
    const nbId = data.slice(9);
    await editText(chatId, msgId, '🎬 Запускаю генерацию видео...');
    nbDirectGenerate(chatId, msgId, nbId, 'video_overview_create', { format: 'explainer', language: 'ru', confirm: true }, '🎬', 'Видео');
  }
  else if (data.startsWith('nb_infog_')) {
    const nbId = data.slice(9);
    await editText(chatId, msgId, '🖼 Генерирую инфографику...');
    nbDirectGenerate(chatId, msgId, nbId, 'infographic_create', { orientation: 'landscape', detail_level: 'standard', language: 'ru', confirm: true }, '🖼', 'Инфографика');
  }
  else if (data.startsWith('nb_slides_')) {
    const nbId = data.slice(10);
    await editText(chatId, msgId, '📑 Генерирую слайды...');
    nbDirectGenerate(chatId, msgId, nbId, 'slide_deck_create', { format: 'detailed_deck', language: 'ru', confirm: true }, '📑', 'Слайды');
  }
  else if (data.startsWith('nb_mindmap_')) {
    const nbId = data.slice(11);
    await editText(chatId, msgId, '🧠 Генерирую Mind Map...');
    nbDirectGenerate(chatId, msgId, nbId, 'mind_map_create', { title: 'Mind Map', confirm: true }, '🧠', 'Mind Map');
  }
  else if (data.startsWith('nb_flash_')) {
    const nbId = data.slice(9);
    await editText(chatId, msgId, '🃏 Генерирую флешкарты...');
    nbDirectGenerate(chatId, msgId, nbId, 'flashcards_create', { difficulty: 'medium', confirm: true }, '🃏', 'Флешкарты');
  }
  else if (data.startsWith('nb_quiz_')) {
    const nbId = data.slice(8);
    await editText(chatId, msgId, '📝 Генерирую квиз...');
    nbDirectGenerate(chatId, msgId, nbId, 'quiz_create', { question_count: 5, difficulty: 'medium', confirm: true }, '📝', 'Квиз');
  }
  else if (data.startsWith('nb_rename_')) {
    const nbId = data.slice(10);
    clearAllWaiting(chatId);
    await editText(chatId, msgId, '✏️ Введите новое название:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]] } });
    waitingNbRename.set(chatId, nbId);
    setWaitingTimeout(chatId, waitingNbRename, 'waitingNbRename');
  }
  else if (data.startsWith('nb_delete_')) {
    const nbId = data.slice(10);
    await editText(chatId, msgId, '🗑 Удаляю...');
    try {
      await nbClient.call('notebook_delete', { notebook_id: nbId, confirm: true });
      await editText(chatId, msgId, '🗑 Блокнот удалён', nbMainMenu);
    } catch(e) { await editText(chatId, msgId, `❌ ${e.message}`, nbMainMenu); }
  }

  // === API Ключи ===
  else if (data === 'api_keys') {
    const providers = [
      { key: 'openai', label: '🟢 OpenAI', envKey: 'OPENAI_API_KEY' },
      { key: 'google', label: '🔵 Google (Gemini)', envKey: 'GEMINI_API_KEY' },
      { key: 'groq', label: '⚡ Groq', envKey: 'GROQ_API_KEY' },
    ];
    let text = '🔑 API Ключи\n\nПерсональные ключи заменяют глобальные (.env)\n\n';
    const rows = [];
    for (const p of providers) {
      const userKey = uc.apiKeys?.[p.key];
      const envKey = process.env[p.envKey];
      let status;
      if (userKey) status = `✅ ...${userKey.slice(-4)}`;
      else if (envKey) status = '🌐 .env';
      else status = '❌ Нет';
      text += `${p.label}: ${status}\n`;
      const btns = [{ text: `${p.label}`, callback_data: 'noop' }];
      btns.push({ text: '🔑 Задать', callback_data: `apikey_set_${p.key}` });
      if (userKey) btns.push({ text: '🗑', callback_data: `apikey_del_${p.key}` });
      btns.push({ text: '🔍', callback_data: `apikey_test_${p.key}` });
      rows.push(btns);
    }
    rows.push([{ text: '◀️ Назад', callback_data: 'settings' }]);
    await editText(chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('apikey_set_')) {
    const provider = data.slice(11);
    const labels = { openai: 'OpenAI', google: 'Google (Gemini)', groq: 'Groq' };
    clearAllWaiting(chatId);
    waitingApiKey.set(chatId, provider);
    setWaitingTimeout(chatId, waitingApiKey, 'waitingApiKey');
    await editText(chatId, msgId, `🔑 Введите API ключ для ${labels[provider] || provider}:\n\n⚠️ Сообщение с ключом будет автоматически удалено`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'api_keys' }]] } });
  }
  else if (data.startsWith('apikey_del_')) {
    const provider = data.slice(11);
    if (uc.apiKeys) { delete uc.apiKeys[provider]; saveUserConfig(chatId); }
    await editText(chatId, msgId, `✅ Ключ ${provider} удалён`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К ключам', callback_data: 'api_keys' }]] } });
  }
  else if (data.startsWith('apikey_test_')) {
    const provider = data.slice(12);
    const userKey = uc.apiKeys?.[provider];
    const envKeys = { openai: process.env.OPENAI_API_KEY, google: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY };
    const key = userKey || envKeys[provider];
    if (!key) { await editText(chatId, msgId, `❌ Ключ ${provider} не задан`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'api_keys' }]] } }); return; }
    await editText(chatId, msgId, `🔍 Проверяю ${provider}...`);
    try {
      const testModels = { openai: 'gpt-4.1-nano', google: 'gemini-2.5-flash', groq: 'llama-70b' };
      await callAI(testModels[provider], [{ role: 'user', content: 'Hi, reply with just OK' }], '', true, chatId);
      await editText(chatId, msgId, `✅ ${provider}: ключ работает!`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К ключам', callback_data: 'api_keys' }]] } });
    } catch (e) {
      await editText(chatId, msgId, `❌ ${provider}: ${e.message}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К ключам', callback_data: 'api_keys' }]] } });
    }
  }

  // === Настройки изображений ===
  else if (data === 'img_settings') {
    const imgModel = IMAGE_MODELS[uc.imageModel] || IMAGE_MODELS['nano-banana'];
    const text = `🎨 Настройки изображений\n\n🤖 Модель: ${imgModel.label}\n📐 Формат: ${uc.imageAspect || '1:1'}\n📏 Разрешение: ${uc.imageSize || '1K'}`;
    const rows = [
      ...Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: (k === uc.imageModel ? '✅ ' : '') + v.label, callback_data: `imgmodel_${k}` }]),
      [{ text: '── Формат ──', callback_data: 'noop' }],
      ['1:1', '16:9', '9:16', '3:4', '4:3'].map(a => ({ text: (a === (uc.imageAspect || '1:1') ? '✅ ' : '') + a, callback_data: `imgaspect_${a}` })),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ];
    await editText(chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('imgmodel_')) {
    uc.imageModel = data.slice(9);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Модель: ${IMAGE_MODELS[uc.imageModel]?.label || uc.imageModel}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К изображениям', callback_data: 'img_settings' }]] } });
  }
  else if (data.startsWith('imgaspect_')) {
    uc.imageAspect = data.slice(10);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Формат: ${uc.imageAspect}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К изображениям', callback_data: 'img_settings' }]] } });
  }

  // === Настройки видео ===
  else if (data === 'video_settings') {
    const vidModel = VIDEO_MODELS[uc.videoModel] || VIDEO_MODELS['veo-3.1-fast'];
    const text = `🎬 Настройки видео\n\n🤖 Модель: ${vidModel.label}\n📐 Формат: ${uc.videoAspect || '16:9'}\n📏 Разрешение: ${uc.videoResolution || '720p'}\n⏱ Длительность: ${uc.videoDuration || '8'}с`;
    const rows = [
      ...Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: (k === uc.videoModel ? '✅ ' : '') + v.label, callback_data: `vidmodel_${k}` }]),
      [{ text: '── Формат ──', callback_data: 'noop' }],
      ['16:9', '9:16'].map(a => ({ text: (a === (uc.videoAspect || '16:9') ? '✅ ' : '') + a, callback_data: `vidaspect_${a}` })),
      [{ text: '── Разрешение ──', callback_data: 'noop' }],
      ['720p', '1080p', '4K'].map(r => ({ text: (r === (uc.videoResolution || '720p') ? '✅ ' : '') + r, callback_data: `vidres_${r}` })),
      [{ text: '── Длительность ──', callback_data: 'noop' }],
      ['4', '6', '8'].map(d => ({ text: (d === (uc.videoDuration || '8') ? '✅ ' : '') + d + 'с', callback_data: `viddur_${d}` })),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ];
    await editText(chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data.startsWith('vidmodel_')) {
    uc.videoModel = data.slice(9);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Модель: ${VIDEO_MODELS[uc.videoModel]?.label || uc.videoModel}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К видео', callback_data: 'video_settings' }]] } });
  }
  else if (data.startsWith('vidaspect_')) {
    uc.videoAspect = data.slice(10);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Формат: ${uc.videoAspect}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К видео', callback_data: 'video_settings' }]] } });
  }
  else if (data.startsWith('vidres_')) {
    uc.videoResolution = data.slice(7);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Разрешение: ${uc.videoResolution}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К видео', callback_data: 'video_settings' }]] } });
  }
  else if (data.startsWith('viddur_')) {
    uc.videoDuration = data.slice(7);
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Длительность: ${uc.videoDuration}с`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К видео', callback_data: 'video_settings' }]] } });
  }

  // === Пикеры из mediaCard ===
  else if (data === 'img_aspect') {
    await editText(chatId, msgId, `📐 Формат фото (сейчас: ${uc.imageAspect || '1:1'}):`, { reply_markup: { inline_keyboard: [
      ['1:1', '16:9', '9:16', '3:4', '4:3'].map(a => ({ text: (a === (uc.imageAspect || '1:1') ? '✅ ' : '') + a, callback_data: `imgaspect_${a}` })),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
  }
  else if (data === 'vid_format') {
    await editText(chatId, msgId, `📐 Формат видео (сейчас: ${uc.videoAspect || '16:9'}):`, { reply_markup: { inline_keyboard: [
      ['16:9', '9:16'].map(a => ({ text: (a === (uc.videoAspect || '16:9') ? '✅ ' : '') + a, callback_data: `vidaspect_${a}` })),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
  }
  else if (data === 'vid_res') {
    await editText(chatId, msgId, `📏 Разрешение видео (сейчас: ${uc.videoResolution || '720p'}):`, { reply_markup: { inline_keyboard: [
      ['720p', '1080p', '4K'].map(r => ({ text: (r === (uc.videoResolution || '720p') ? '✅ ' : '') + r, callback_data: `vidres_${r}` })),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
  }
  else if (data === 'vid_dur') {
    await editText(chatId, msgId, `⏱ Длительность видео (сейчас: ${uc.videoDuration || '8'}с):`, { reply_markup: { inline_keyboard: [
      ['4', '6', '8'].map(d => ({ text: (d === (uc.videoDuration || '8') ? '✅ ' : '') + d + 'с', callback_data: `viddur_${d}` })),
      [{ text: '◀️ Назад', callback_data: 'settings' }]
    ] } });
  }

  // === Статистика ===
  else if (data === 'stats') {
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const avgTime = stats.claudeCalls > 0 ? (stats.totalResponseTime / stats.claudeCalls / 1000).toFixed(1) : 0;
    await editText(chatId, msgId, `📈 Статистика\n\n⏱ Аптайм: ${uptime} мин\n📨 Сообщений: ${stats.messages}\n🤖 Claude вызовов: ${stats.claudeCalls}\n⚡ Среднее время ответа: ${avgTime}с\n🎙 Голосовых: ${stats.voiceMessages}\n📎 Файлов: ${stats.files}\n❌ Ошибок: ${stats.errors}\n🧠 AI активен: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}\n🤖 Модель: ${uc.model}`, mainMenu(chatId));
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
    activeClaudeCount = Math.max(0, activeClaudeCount - 1);
  }
  messageQueue.delete(chatId);
}

// === MCP HTTP/SSE Client — универсальный клиент для пользовательских MCP-серверов ===
class MCPHttpClient {
  constructor(config) {
    this.url = config.url.replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.authType = config.authType || 'auto'; // bearer | x-api-key | api-key | custom | auto
    this.name = config.name || 'mcp';
    this.tools = [];
    this.ready = false;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.apiKey) {
      const key = this.apiKey.trim();
      const authType = (this.authType || 'auto').toLowerCase();
      if (authType === 'x-api-key') {
        h['x-api-key'] = key;
      } else if (authType === 'api-key') {
        h['api-key'] = key;
      } else if (authType === 'custom' && key.includes(':')) {
        // Format: "Header-Name: value"
        const colonIdx = key.indexOf(':');
        const headerName = key.slice(0, colonIdx).trim();
        const headerVal = key.slice(colonIdx + 1).trim();
        if (headerName && headerVal) h[headerName] = headerVal;
      } else if (authType === 'bearer' || authType === 'auto') {
        // Auto-detect: if key already has "Bearer " prefix, use as-is
        if (key.toLowerCase().startsWith('bearer ')) {
          h['Authorization'] = key;
        } else if (key.toLowerCase().startsWith('x-api-key ')) {
          // User pasted "x-api-key ak_..." — extract value
          h['x-api-key'] = key.replace(/^x-api-key\s+/i, '');
        } else if (key.toLowerCase().startsWith('api-key ')) {
          h['api-key'] = key.replace(/^api-key\s+/i, '');
        } else if (key.includes(':') && !key.startsWith('ey') && key.indexOf(':') < 40) {
          // Looks like "Header: value" format
          const colonIdx = key.indexOf(':');
          const headerName = key.slice(0, colonIdx).trim();
          const headerVal = key.slice(colonIdx + 1).trim();
          if (headerName && headerVal && !headerName.includes(' ')) h[headerName] = headerVal;
          else h['Authorization'] = `Bearer ${key}`;
        } else {
          h['Authorization'] = `Bearer ${key}`;
        }
      } else {
        // Unknown authType — fallback to Bearer
        h['Authorization'] = `Bearer ${key}`;
      }
    }
    return h;
  }

  async _post(method, params = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    const res = await fetch(this.url, { method: 'POST', headers: this._headers(), body, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const ct = res.headers.get('content-type') || '';
    let data;
    if (ct.includes('text/event-stream')) {
      // Parse SSE response — extract last JSON-RPC data line
      const text = await res.text();
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { data = JSON.parse(line.slice(6)); } catch(e) {}
        }
      }
      if (!data) throw new Error('SSE: no valid JSON-RPC response');
    } else {
      data = await res.json();
    }
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }

  async connect() {
    try {
      await this._post('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'telegram-bot', version: '1.0' }
      });
      // Send initialized notification (fire-and-forget)
      fetch(this.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      // Discover tools
      const toolsResult = await this._post('tools/list', {});
      this.tools = (toolsResult.tools || []).map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {},
      }));
      this.ready = true;
      return this.tools;
    } catch (e) {
      this.ready = false;
      throw new Error(`MCP ${this.name}: ${e.message}`);
    }
  }

  async callTool(toolName, args = {}) {
    if (!this.ready) await this.connect();
    const result = await this._post('tools/call', { name: toolName, arguments: args });
    const texts = (result.content || []).filter(c => c.type === 'text').map(c => c.text);
    return texts.join('\n') || JSON.stringify(result);
  }

  async listTools() {
    if (!this.ready || this.tools.length === 0) await this.connect();
    return this.tools;
  }
}

// === MCP Client Manager ===
const mcpClients = new Map(); // `${chatId}_${serverId}` → MCPHttpClient

async function getMcpClient(chatId, serverId) {
  const key = `${chatId}_${serverId}`;
  if (mcpClients.has(key) && mcpClients.get(key).ready) return mcpClients.get(key);
  const uc = getUserConfig(chatId);
  const serverCfg = (uc.mcpServers || []).find(s => s.id === serverId);
  if (!serverCfg) throw new Error(`MCP сервер "${serverId}" не найден`);
  const client = new MCPHttpClient(serverCfg);
  await client.connect();
  mcpClients.set(key, client);
  return client;
}

async function syncMcpServer(chatId, serverCfg) {
  const client = new MCPHttpClient(serverCfg);
  const tools = await client.connect();
  serverCfg.tools = tools.map(t => ({ name: t.name, description: t.description }));
  serverCfg.lastSync = Date.now();
  const uc = getUserConfig(chatId);
  const idx = (uc.mcpServers || []).findIndex(s => s.id === serverCfg.id);
  if (idx >= 0) uc.mcpServers[idx] = serverCfg;
  saveUserConfig(chatId);
  mcpClients.set(`${chatId}_${serverCfg.id}`, client);
  return tools;
}

function getMcpToolsForPrompt(chatId) {
  const uc = getUserConfig(chatId);
  const allServers = (uc.mcpServers || []).filter(s => s.enabled !== false);

  // Auto-sync: если сервер без tools — запускаем синхронизацию асинхронно
  for (const s of allServers) {
    if (!s.tools || s.tools.length === 0) {
      syncMcpServer(chatId, s).catch(e => console.error(`[MCP auto-sync] ${s.name}: ${e.message}`));
    }
  }

  const servers = allServers.filter(s => s.tools?.length > 0);
  if (servers.length === 0) return '';
  let text = '\n\n## Доступные MCP-интеграции (вызывай через [ACTION: mcp])\n';
  for (const s of servers) {
    text += `\n### ${s.name} (server: ${s.id})\n`;
    for (const t of s.tools) {
      text += `- **${t.name}**: ${t.description || 'нет описания'}\n`;
    }
  }
  return text;
}

// === NotebookLM: прямой MCP клиент (без Claude CLI — в 10x быстрее) ===
class NotebookLMClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.ready = false;
    this.startPromise = null;
  }

  async start() {
    if (this.ready && this.process && !this.process.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._init();
    return this.startPromise;
  }

  async _init() {
    try {
      if (this.process) { try { this.process.kill(); } catch(e) {} }
      this.process = spawn('/opt/homebrew/bin/notebooklm-mcp', [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.buffer = '';
      this.process.stdout.on('data', (d) => {
        this.buffer += d.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const { resolve, reject, timer } = this.pending.get(msg.id);
              clearTimeout(timer);
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch(e) {}
        }
      });
      this.process.on('close', () => { this.ready = false; this.startPromise = null; });
      this.process.on('error', () => { this.ready = false; this.startPromise = null; });

      // MCP Handshake
      await this._send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'telegram-bot', version: '1.0' }
      });
      // Send initialized notification (no response expected)
      const notif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      this.process.stdin.write(notif + '\n');
      this.ready = true;
      this.startPromise = null;
      console.log('✅ NotebookLM MCP: подключён');
    } catch(e) {
      this.ready = false;
      this.startPromise = null;
      throw e;
    }
  }

  _send(method, params = {}, timeout = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) { reject(new Error('MCP процесс не запущен')); return; }
      const id = ++this.requestId;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Таймаут ${timeout / 1000}с`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(msg + '\n');
    });
  }

  async call(toolName, args = {}, timeout = 120000) {
    await this.start();
    const result = await this._send('tools/call', { name: toolName, arguments: args }, timeout);
    // MCP returns { content: [{ type: 'text', text: '...' }] }
    const texts = (result.content || []).filter(c => c.type === 'text').map(c => c.text);
    const combined = texts.join('\n');
    try { return JSON.parse(combined); } catch(e) { return combined; }
  }

  stop() {
    if (this.process) { try { this.process.kill(); } catch(e) {} this.process = null; }
    this.ready = false;
    this.startPromise = null;
    for (const [, { reject, timer }] of this.pending) { clearTimeout(timer); reject(new Error('Остановлен')); }
    this.pending.clear();
  }
}

const nbClient = new NotebookLMClient();

// NotebookLM: прямая генерация через MCP → поллинг → результат
async function nbDirectGenerate(chatId, msgId, nbId, toolName, extraArgs, emoji, label) {
  const nbLink = `https://notebooklm.google.com/notebook/${nbId}`;
  // Если msgId не передан, отправляем новое сообщение для обновления статуса
  const updateStatus = async (text, menu) => {
    if (msgId) return editText(chatId, msgId, text, menu);
    const res = await send(chatId, text, menu);
    if (res?.result?.message_id) msgId = res.result.message_id;
  };
  try {
    // 1. Запуск генерации
    const createResult = await nbClient.call(toolName, { notebook_id: nbId, ...extraArgs }, 60000);
    await updateStatus(`${emoji} ${label}: генерация запущена...\n⏳ Поллинг статуса`);

    // 2. Поллинг статуса
    let status = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        status = await nbClient.call('studio_status', { notebook_id: nbId }, 30000);
        const artifacts = status.artifacts || status.data?.artifacts || [];
        const latest = artifacts[artifacts.length - 1];
        if (latest) {
          const st = latest.status || latest.state || '';
          await updateStatus(`${emoji} ${label}: ${st} (${i + 1}/20)\n⏳ ${Math.round((i + 1) * 15)}с`);
          if (st === 'completed' || st === 'ready' || st === 'done') {
            // Готово — ищем URL для скачивания
            const url = latest.url || latest.download_url || latest.media_url || '';
            let resultText = `${emoji} ${label} готов!`;
            if (latest.title) resultText += `\n📄 ${latest.title}`;
            if (latest.content) {
              // Текстовый контент — отправляем текст
              await updateStatus(resultText, nbDetailMenu(nbId));
              const content = typeof latest.content === 'string' ? latest.content : JSON.stringify(latest.content);
              await send(chatId, content.slice(0, 4000));
              return;
            }
            if (url) {
              resultText += `\n🔗 ${url}`;
              // Пробуем скачать и отправить
              try {
                const ext = url.match(/\.(mp3|mp4|wav|png|jpg|pdf|pptx)/)?.[1] || 'bin';
                const filePath = `/tmp/nb_${Date.now()}.${ext}`;
                const fileRes = await fetch(url, { signal: AbortSignal.timeout(60000) });
                const buf = Buffer.from(await fileRes.arrayBuffer());
                fs.writeFileSync(filePath, buf);
                if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) await sendAudio(chatId, filePath, label);
                else if (['mp4', 'webm', 'mov'].includes(ext)) await sendVideo(chatId, filePath, label);
                else if (['png', 'jpg', 'jpeg'].includes(ext)) await sendPhoto(chatId, filePath, label);
                else await sendDocument(chatId, filePath);
                try { fs.unlinkSync(filePath); } catch(e) {}
              } catch(dlErr) {
                resultText += `\n⚠️ Не удалось скачать: ${dlErr.message}`;
              }
            }
            resultText += `\n\n📓 ${nbLink}`;
            await updateStatus(resultText, nbDetailMenu(nbId));
            return;
          }
          if (st === 'failed' || st === 'error') {
            await updateStatus(`❌ ${label}: ошибка генерации\n${latest.error || ''}\n\n📓 ${nbLink}`, nbDetailMenu(nbId));
            return;
          }
        }
      } catch(pollErr) {
        // Поллинг-ошибка — продолжаем пробовать
      }
    }
    // Таймаут поллинга
    await updateStatus(`⏱ ${label}: генерация заняла >5мин\nПроверьте вручную:\n${nbLink}`, nbDetailMenu(nbId));
  } catch(e) {
    await updateStatus(`❌ ${label}: ${e.message}\n\n📓 ${nbLink}`, nbDetailMenu(nbId));
  }
}

// === Помощь ===
function helpText() {
  return `AI-ассистент — просто напишите что нужно

Примеры:
• "нарисуй кота в космосе" — генерация изображения
• "сделай видео заката" — генерация видео
• "напомни через 2 часа позвонить" — напоминание
• "добавь задачу: купить молоко" — задача
• "найди в интернете..." — поиск
• "выполни команду ls -la" — bash
• "отправь файл /tmp/test.txt" — файл
• "запланируй через час сгенерировать картинку" — планирование

Возможности:
• 8 моделей изображений (Nano Banana, Imagen 3/4)
• 3 модели видео (Veo 3.1, Veo 2)
• Напоминания с повтором (ежедневно, еженедельно)
• Задачи с приоритетами и дедлайнами
• Мульти-агентная система
• MCP-интеграции
• NotebookLM
• Мониторинг каналов

/settings — настройки (модель, API ключи, медиа)
/stop — остановить задачу
/clear — очистить историю

Голосовые сообщения распознаются автоматически.`;
}

// === Bash команда ===
function runBash(chatId, cmd) {
  if (!cmd.trim()) { send(chatId, '❌ Укажите команду: /bash ls -la'); return; }
  if (isBashBlocked(cmd)) { send(chatId, '🚫 Команда заблокирована по соображениям безопасности'); return; }
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
  const sanitizedName = path.basename(fileName);
  const destPath = path.join(uc.workDir, sanitizedName);
  // Проверка path traversal
  if (!path.resolve(destPath).startsWith(path.resolve(uc.workDir) + path.sep)) {
    send(chatId, '❌ Недопустимое имя файла');
    return true;
  }
  fileName = sanitizedName;
  send(chatId, `📥 Скачиваю ${fileName}...`);

  const downloaded = await downloadTelegramFile(fileId, destPath);
  if (!downloaded) {
    send(chatId, `❌ Не удалось скачать файл`);
    return true;
  }

  send(chatId, `✅ Файл сохранён: ${destPath}`);

  // Если есть caption — отправить в AI с контекстом о файле
  if (caption) {
    runClaude(chatId, `[Пользователь отправил файл: ${destPath}]\n${caption}`);
    return true;
  }

  // Обработка группы фото (media_group) для мульти-изображения
  if (msg.photo && msg.media_group_id) {
    const groupId = msg.media_group_id;
    if (!mediaGroupBuffer.has(groupId)) {
      mediaGroupBuffer.set(groupId, { chatId, photos: [], caption: caption || '', timer: null, _created: Date.now() });
    }
    const group = mediaGroupBuffer.get(groupId);
    try {
      const imgData = fs.readFileSync(destPath).toString('base64');
      group.photos.push(imgData);
    } catch(e) {}
    if (!group.caption && caption) group.caption = caption;
    // Сбрасываем таймер — ждём все фото в группе
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(async () => {
      mediaGroupBuffer.delete(groupId);
      if (group.photos.length >= 1 && group.caption) {
        const cap = group.caption.toLowerCase();
        const isVideoReq = /видео|video|animate|анимац|сделай.*вид|создай.*вид/.test(cap);
        if (isVideoReq) {
          // Видео из фото: используем первое фото как референс
          const statusMsg = await send(chatId, `🎬 Генерация видео из ${group.photos.length} фото...`);
          const statusMsgId = statusMsg?.result?.message_id;
          const startTime = Date.now();
          try {
            const result = await generateVideo(chatId, group.caption, {
              referenceImage: group.photos[0],
              onProgress: (poll) => {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                if (statusMsgId) editText(chatId, statusMsgId, `🎬 Генерация видео... ⏱ ${elapsed}с`);
              }
            });
            if (statusMsgId) editText(chatId, statusMsgId, '✅ Видео готово');
            await sendVideo(chatId, result.path, group.caption.slice(0, 200));
            try { fs.unlinkSync(result.path); } catch(e) {}
          } catch (e) {
            if (statusMsgId) editText(chatId, statusMsgId, `❌ ${e.message}`);
          }
        } else if (group.photos.length > 1) {
          // Мульти-изображение
          const statusMsg = await send(chatId, `🎨 Мульти-композиция (${group.photos.length} фото)...`);
          const statusMsgId = statusMsg?.result?.message_id;
          try {
            const results = await generateImage(chatId, group.caption, { model: 'nano-banana-pro', referenceImages: group.photos });
            if (statusMsgId) editText(chatId, statusMsgId, '✅ Готово');
            for (const r of results) {
              if (r.type === 'image') {
                await sendPhoto(chatId, r.path, group.caption.slice(0, 200));
                try { fs.unlinkSync(r.path); } catch(e) {}
              }
            }
          } catch (e) {
            if (statusMsgId) editText(chatId, statusMsgId, `❌ ${e.message}`);
          }
        }
      }
    }, 2000);
    return true;
  }

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

  // Создание агента из .txt файла
  if (waitingAgentPrompt.has(chatId) && msg.document && fileName.endsWith('.txt')) {
    const agentData = waitingAgentPrompt.get(chatId);
    waitingAgentPrompt.delete(chatId);
    try {
      const fileContent = fs.readFileSync(destPath, 'utf8').trim();
      if (!fileContent) { send(chatId, '❌ Файл пустой'); return true; }
      if (!uc.customAgents) uc.customAgents = [];
      uc.customAgents.push({ id: agentData.id, icon: agentData.icon || '🤖', label: agentData.label, desc: agentData.desc || '', prompt: fileContent, maxSteps: 3, model: '', enabled: true, uses: 0, lastUsed: null });
      saveUserConfig(chatId);
      send(chatId, `✅ Агент "${agentData.label}" создан из файла (${fileContent.length} символов)`, { reply_markup: { inline_keyboard: [[{ text: '👥 К агентам', callback_data: 'agents_menu' }]] } });
    } catch (e) {
      send(chatId, `❌ Ошибка чтения файла: ${e.message}`);
    }
    return true;
  }

  // Редактирование промпта агента из .txt файла
  if (waitingAgentEditPrompt.has(chatId) && msg.document && fileName.endsWith('.txt')) {
    const idx = waitingAgentEditPrompt.get(chatId);
    waitingAgentEditPrompt.delete(chatId);
    try {
      const fileContent = fs.readFileSync(destPath, 'utf8').trim();
      if (!fileContent) { send(chatId, '❌ Файл пустой'); return true; }
      if (uc.customAgents && uc.customAgents[idx]) {
        uc.customAgents[idx].prompt = fileContent;
        saveUserConfig(chatId);
        send(chatId, `✅ Промпт "${uc.customAgents[idx].label}" обновлён из файла (${fileContent.length} символов)`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агенту', callback_data: `agent_info_${idx}` }]] } });
      }
    } catch (e) {
      send(chatId, `❌ Ошибка чтения файла: ${e.message}`);
    }
    return true;
  }

  let prompt;
  if (caption) {
    prompt = `[Пользователь отправил файл: ${destPath}]\n${caption}`;
  } else if (msg.photo) {
    prompt = `[Пользователь отправил фото: ${destPath}]\nПроанализируй это изображение. Если это скриншот — прочитай текст. Если содержит задание — выполни его. Если это просто фото — опиши что на нём.`;
  } else if (msg.video || msg.video_note) {
    prompt = `[Пользователь отправил видео: ${destPath}]\nПроанализируй это видео.`;
  } else {
    prompt = `Пользователь отправил файл "${fileName}", сохранён в ${destPath}. Опиши что это за файл и что с ним можно сделать.`;
  }

  if (activeTasks.has(chatId)) {
    enqueue(chatId, { text: prompt, type: 'file' });
    send(chatId, `📬 Задача для файла добавлена в очередь (позиция: ${getQueueSize(chatId)})`);
  } else {
    runClaude(chatId, prompt);
  }
  return true;
}

// === Транскрипция голоса через Groq Whisper (async, execFile — защита от injection) ===
// NOTE: API key visible in process args via ps; acceptable for single-user deployment
async function transcribeVoice(filePath, chatId = null) {
  const key = chatId ? getGeminiKey(chatId) : process.env.GEMINI_API_KEY;
  if (!key) return { text: null, error: 'Нет Gemini API ключа для транскрипции' };

  try {
    const audioData = fs.readFileSync(filePath).toString('base64');
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeMap = { ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', opus: 'audio/opus' };
    const mimeType = mimeMap[ext] || 'audio/ogg';

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: 'Транскрибируй это аудио. Выведи ТОЛЬКО текст транскрипции, ничего больше. Определи язык автоматически.' },
          { inline_data: { mime_type: mimeType, data: audioData } }
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return { text: null, error: data.error?.message || 'Пустой ответ от Gemini' };
    return { text, error: null };
  } catch (e) {
    console.error(`Transcription error: ${e.message}`);
    return { text: null, error: e.message };
  }
}

async function handleVoice(chatId, msg) {
  const voice = msg.voice || msg.audio;
  if (!voice) return false;

  const uc = getUserConfig(chatId);
  const fileId = voice.file_id;
  const ext = msg.voice ? 'ogg' : (voice.mime_type || '').split('/')[1] || 'mp3';
  const fileName = `voice_${Date.now()}.${ext}`;
  const destPath = path.join(uc.workDir, fileName);

  const statusMsg = await send(chatId, `🎙 Распознаю голосовое...`);
  const statusMsgId = statusMsg?.result?.message_id;

  const downloaded = await downloadTelegramFile(fileId, destPath);
  if (!downloaded) {
    if (statusMsgId) editText(chatId, statusMsgId, `❌ Не удалось скачать голосовое`);
    else send(chatId, `❌ Не удалось скачать голосовое`);
    return true;
  }

  try {
    const result = await transcribeVoice(destPath, chatId);
    try { fs.unlinkSync(destPath); } catch(e) {}

    if (result.error || !result.text) {
      if (statusMsgId) editText(chatId, statusMsgId, `❌ Не удалось распознать: ${result.error || 'пустой текст'}`);
      else send(chatId, `❌ Не удалось распознать: ${result.error || 'пустой текст'}`);
      return true;
    }

    const text = result.text;
    console.log(`🎙 Голосовое: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    if (statusMsgId) editText(chatId, statusMsgId, `🎙 «${text}»`);
    else send(chatId, `🎙 «${text}»`);

    if (activeTasks.has(chatId)) {
      enqueue(chatId, { text, type: 'text' });
      send(chatId, `📬 В очереди (позиция: ${getQueueSize(chatId)})`);
    } else {
      runClaude(chatId, text);
    }
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch(e) {}
    console.error('Voice handling error:', err);
    if (statusMsgId) editText(chatId, statusMsgId, `❌ Ошибка: ${err.message}`);
    else send(chatId, `❌ Ошибка распознавания: ${err.message}`);
  }
  return true;
}

// === Запуск AI (async) ===
const MAX_CLAUDE_PROCS = 3;
let activeClaudeCount = 0;
const PARALLEL_AGENT_LIMIT = 3;

const BOT_SYSTEM_PROMPT = `Ты — AI-ассистент в Telegram. Пользователь общается на естественном языке — никаких команд.
Ты умеешь: генерировать изображения и видео, ставить напоминания, вести задачи, искать в интернете, выполнять bash-команды, отправлять файлы, планировать действия.
Если пользователь просит что-то — просто сделай это через свои действия. Никогда не предлагай "используйте команду /...".
Отвечай кратко и по делу. На русском языке, если пользователь пишет по-русски.`;

const AGENT_SYSTEM_PROMPT = `Ты — AI-ассистент с возможностью ВЫПОЛНЯТЬ действия на сервере пользователя. Ты не просто советуешь — ты действуешь.

ВАЖНО: Пользователь общается на ЕСТЕСТВЕННОМ ЯЗЫКЕ. Нет никаких команд. Определяй намерение и выполняй действие:

- "нарисуй/сгенерируй картинку/фото/изображение..." → [ACTION: image]
- "сделай видео/сними/анимируй..." → [ACTION: video]
- "продли/продолжи видео..." → [ACTION: video_extend]
- "напомни через.../поставь напоминание/будильник..." → [ACTION: remind]
- "добавь задачу/запиши задачу/todo..." → [ACTION: todo]
- "найди в интернете/загугли/поищи..." → используй свои знания или [ACTION: bash] curl
- "запусти/выполни команду..." → [ACTION: bash]
- "отправь файл/покажи файл..." → [ACTION: file]
- "запланируй через.../через N часов сделай..." → [ACTION: schedule]
- "делегируй/попроси агента..." → [ACTION: delegate]
- "забудь что.../удали из памяти..." → [ACTION: memory] forget
- "что ты обо мне помнишь/покажи память..." → [ACTION: memory] list
- "запусти в фоне/сделай в фоне..." → [ACTION: background]

Никогда не говори "используйте команду /...". Просто делай.

## Доступные действия

Формат блока действия (ровно один на ответ):

[ACTION: bash]
команда
[/ACTION]

[ACTION: remind]
минуты
текст напоминания
[/ACTION]

[ACTION: schedule]
минуты
действие: bash|image|video
тело действия (команда/промпт)
описание: краткое описание что будет выполнено
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

[ACTION: plan]
goal: цель задачи
subtasks:
- id: 1, role: coder, task: описание подзадачи, priority: high, deps: []
- id: 2, role: reviewer, task: другая подзадача, priority: medium, deps: [1]
[/ACTION]

[ACTION: parallel]
timeout: 120
---
role: coder
task: первая задача
context: контекст
---
role: researcher
task: вторая задача
context: контекст
[/ACTION]

[ACTION: create_agent]
id: уникальный_id
label: Название
icon: 🧪
desc: Описание специализации
prompt: Системный промпт агента
maxSteps: 3
[/ACTION]

[ACTION: supervise]
check: all
[/ACTION]

[ACTION: mcp]
server: имя_сервера
tool: имя_инструмента
args: {"key": "value"}
[/ACTION]

[ACTION: think]
Внутреннее размышление — анализ ситуации, планирование шагов.
Пользователь видит что ты думаешь, но не видит содержимое.
[/ACTION]

[ACTION: background]
описание: краткое описание задачи
задача: полный текст задачи для фонового выполнения
[/ACTION]

[ACTION: memory]
команда: forget|list
текст: что забыть (для forget)
[/ACTION]

[ACTION: execute_plan]
auto: true
[/ACTION]

[ACTION: figma]
команда: get_file|render|discover|tokens
параметры (зависят от команды)
[/ACTION]

## Описание действий

1. **bash** — выполнить bash-команду. Тайм-аут: 30с.
2. **remind** — напоминание. Строка 1: время (число + единица: 30, 2ч, 1д, 10с). Строка 2: текст. Опционально: repeat=daily|weekly|hourly|Nм (повтор), priority=1-3 (важность), category=work|personal|urgent|general. Пример:
\`\`\`
60
Обед!
repeat=daily
priority=2
category=personal
\`\`\`
3. **schedule** — запланировать действие. Строка 1: время (число + единица: 30, 2ч, 1д). Строка 2: тип действия (bash|image|video|remind|file|delegate|mcp). Строка 3: тело (команда/промпт). Строка 4: описание: описание. Пример:
\`\`\`
2ч
image
A beautiful sunset over mountains
описание: Сгенерировать закат через 2 часа
\`\`\`
3.1. **todo** — создать задачу. Строка 1: текст задачи. Опционально: priority=1-3, category=work|personal|urgent, due=30м|2ч|1д (дедлайн). Пример:
\`\`\`
Написать отчёт
priority=3
category=work
due=2ч
\`\`\`
4. **file** — отправить файл. Одна строка — путь.
5. **skill** — навык пользователя. Строка 1: имя, строка 2: контекст.
6. **delegate** — делегировать субагенту. Формат: роль/задача/контекст.
7. **think** — внутреннее размышление перед действием.
8. **image** — генерация изображения. Тело: промпт на английском (переведи сам). Система автоматически перебирает ВСЕ модели пока не получит результат. Не сдавайся — если вернулась ошибка, значит ВСЕ 8 моделей провалились.
9. **video** — генерация видео. Тело: промпт на английском (переведи сам). Автоfallback через Veo 3.1 Fast → Veo 3.1 → Veo 2. Генерация 30-120 секунд.
10. **video_extend** — продление существующего видео. Тело: промпт для продолжения. Используй ТОЛЬКО когда пользователь явно просит продлить/продолжить видео.
11. **figma** — работа с Figma-дизайном. Команды: discover <url_или_file_key> (структура файла), get_file <file_key> [node_ids], render <file_key> <node_id1> <node_id2> (рендер в PNG), styles <file_key>, components <file_key>. Используй discover чтобы узнать node_id, затем render чтобы отправить изображение.
12. **plan** — декомпозиция задачи на подзадачи с зависимостями. Не выполняет — только планирует.
13. **parallel** — параллельное выполнение нескольких субагентов. Блоки разделены ---. До 5 агентов.
14. **create_agent** — создать временного агента со специализацией. Доступен для delegate/parallel.
15. **supervise** — проверить статус агентов, план, прогресс. Для координации сложных задач.
16. **mcp** — вызвать инструмент MCP-сервера. Поля: server (id сервера), tool (имя инструмента), args (JSON аргументы).
17. **background** — перевести длительную задачу в фоновое выполнение. Не блокирует чат пользователя. Поля: описание (краткое), задача (полный текст).
18. **memory** — управление памятью. Команды: forget (забыть факт по тексту), list (показать все факты). Для forget: "забудь что я из Москвы" → forget + "Москвы".
19. **execute_plan** — автоматически выполнить план, созданный через [ACTION: plan]. Задачи без зависимостей выполняются параллельно, зависимые ждут.

## Роли субагентов (для delegate)
- **coder** — 💻 пишет/модифицирует код
- **researcher** — 🔍 исследует, анализирует, ищет информацию
- **reviewer** — 🔎 проверяет качество, находит ошибки
- **writer** — ✍️ создаёт тексты, документацию
- **executor** — ⚡ выполняет системные команды
- **python_dev** — 🐍 Python, скрипты, автоматизация
- **web_dev** — 🌐 Frontend/Backend, React, Next.js, Node.js
- **data_analyst** — 📊 анализ данных, статистика, визуализации
- **devops** — 🔧 Docker, CI/CD, серверы, мониторинг
- **security** — 🔒 кибербезопасность, OWASP, hardening
- **technical_writer** — 📝 документация, API docs, гайды
- **seo** — 🔍 SEO-оптимизация, мета-теги, аудит
- **social_media** — 📱 SMM, контент-планы, аналитика соцсетей
- **content_creator** — ✍️ копирайтинг, сторителлинг, статьи
- **translator** — 🌍 перевод, локализация, адаптация
- **ux_ui_designer** — 🎨 прототипы, дизайн-системы, доступность

## Модели генерации медиа

### Изображения (8 моделей, автоfallback)
| Модель | Скорость | Качество | Особенности |
|--------|----------|----------|-------------|
| Nano Banana 2 | ~500мс | Хорошее | Самая быстрая, дешёвая |
| Nano Banana | ~2с | Хорошее | Быстрая, стабильная |
| Nano Banana Pro | ~5с | Отличное | 4K, мульти-фото, редактирование |
| Imagen 3 | ~5с | Фотореалистичное | Стабильная, до 4 фото за раз |
| Imagen 3 Fast | ~2с | Фотореалистичное | Быстрая фотореалистичная |
| Imagen 4 Fast | ~3с | Превосходное | Новое поколение, быстрая |
| Imagen 4 | ~8с | Превосходное | Максимум деталей |
| Imagen 4 Ultra | ~12с | Максимальное | Ультра-качество, дорогая |

Порядок fallback: primary → Nano Banana 2 → Nano Banana → Imagen 4 Fast → Imagen 4 → Nano Banana Pro → Imagen 3 → Imagen 3 Fast → Imagen 4 Ultra.

### Видео (3 модели, автоfallback)
| Модель | Скорость | Качество | Особенности |
|--------|----------|----------|-------------|
| Veo 3.1 Fast | ~60с | Хорошее | Быстрая генерация |
| Veo 3.1 | ~120с | Отличное | До 4K, лучшее качество |
| Veo 2 | ~90с | Хорошее | Стабильная, проверенная |

### Стратегия промптов для медиа
- ВСЕГДА пиши промпт на **английском** — модели работают лучше
- Для фотореалистичности: начинай с "A photo of..." или "A cinematic shot of..."
- Для арта: "Digital art of...", "Oil painting of...", "Watercolor..."
- Для видео: описывай действие ("A cat slowly walking..."), камеру ("camera pans left...")
- Используй --no для исключения: "красивый пейзаж --no людей, текста"
- Для качества: добавляй "highly detailed, 8K, professional lighting"

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
- Для простых задач действуй сам через bash/file/skill.
- Если субагент вернул ошибку — попробуй исправить и делегировать снова.
- НЕ показывай raw-код в сообщениях. Файлы — через bash.
- Файлы отправляй через [ACTION: file], не дублируй содержимое.
- НЕ делай деструктивных команд.
- Отвечай на языке пользователя. Будь кратким.
- Финальный итог — что сделано, какие файлы созданы.
- Не предлагай меню из вариантов — действуй или задай ОДИН вопрос.

## Стратегия планирования

- Простая задача (1-2 шага) → действуй через bash/file напрямую
- Средняя (2-3 компонента) → delegate субагентам последовательно
- Сложная (4+ компонентов) → [ACTION: plan] → [ACTION: parallel] + delegate
- Очень сложная → plan → create_agent → parallel → supervise → синтез

Правила:
1. Перед сложной задачей — используй [ACTION: plan] для декомпозиции
2. Независимые подзадачи (без deps) — запускай через [ACTION: parallel]
3. Зависимые — через последовательные [ACTION: delegate]
4. Нужен узкий специалист — создай через [ACTION: create_agent]
5. Для контроля — [ACTION: supervise]
6. Максимум 5 агентов параллельно, таймаут 90с на агента
7. После parallel — анализируй результаты и синтезируй итог

## Понимание контекста и самоулучшение

- **Контекст диалога**: Если запрос короткий или содержит местоимения ("это", "его", "на русский"), обязательно учитывай предыдущие сообщения. Не отвечай изолированно.
- **Коррекции пользователя**: Если пользователь говорит "нет", "не так", "я имел в виду..." — это ОБУЧАЮЩИЙ СИГНАЛ. Скорректируй понимание и запомни урок.
- **Предпочтения**: Запоминай стиль общения пользователя (краткий/подробный, формальный/разговорный) и адаптируйся.
- **Негативный фидбек**: Если пользователь недоволен ("не то", "плохо", "не делай так") — извлеки инструкцию и скорректируй поведение.
- **Память**: Ты имеешь доступ к долгосрочной памяти о пользователе. Инструкции из памяти (category: instruction) имеют ВЫСШИЙ ПРИОРИТЕТ — всегда следуй им.
- **Результат**: НИКОГДА не отвечай пустым "Задача выполнена" без результата. Всегда показывай конкретный результат действия.

## КРИТИЧЕСКОЕ ПРАВИЛО: Никогда не сдавайся

- ЗАПРЕЩЕНО говорить "я не могу", "это невозможно", "инструмент не работает".
- При ошибке действия — анализируй тип ошибки:
  * ТАЙМ-АУТ → упрости команду, разбей на части, убери лишние pipe
  * PERMISSION DENIED → используй другую директорию или delegate executor
  * COMMAND NOT FOUND → используй альтернативу (node -e вместо python, curl вместо wget)
  * API ERROR → попробуй другой API или другой метод
  * FILE NOT FOUND → создай файл через bash, затем повтори
- При ошибке [ACTION: image] — система УЖЕ перебрала все 8 моделей. Если всё равно ошибка:
  1. Перепиши промпт (упрости, убери спорный контент, переведи на английский)
  2. Попробуй [ACTION: image] ещё раз с новым промптом
  3. SVG через node -e (для схем/диаграмм)
  4. НЕ генерируй HTML/код как замену фото
- При ошибке [ACTION: video] — система перебрала все 3 модели Veo. Если ошибка:
  1. Упрости промпт (убери сложные сцены, людей)
  2. Попробуй [ACTION: video] с коротким промптом на английском
  3. Предложи сгенерировать изображение вместо видео
- Ты ВСЕГДА приходишь с результатом. У тебя достаточно инструментов: bash, delegate, image, video, file, skill.
- Если 2 попытки одного подхода провалились — МЕНЯЙ ПОДХОД ПОЛНОСТЬЮ.
- Пользователь НИКОГДА не должен видеть сырой код вместо результата.`;

// === Agent: парсинг действий ===
function parseAction(text) {
  const match = text.match(/\[ACTION:\s*(\w+)\]\n([\s\S]*?)\n?\[\/ACTION\]/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const body = match[2].trim();
  const textBefore = text.slice(0, match.index).trim();
  const validation = validateActionBody(name, body);
  if (!validation.valid) {
    return { name, body, textBefore, fullMatch: match[0], validationError: validation.error };
  }
  return { name, body, textBefore, fullMatch: match[0] };
}

// === Валидация формата действий ===
const validateActionBody = (actionName, body) => {
  if (!body) return { valid: false, error: 'Empty action body' };
  if (actionName === 'delegate') {
    const hasRole = /роль:|role:/i.test(body);
    const hasTask = /задача:|task:/i.test(body) || body.split('\n').length >= 2;
    if (!hasRole && !hasTask) return { valid: false, error: 'delegate requires "роль:" and "задача:" lines' };
  }
  if (actionName === 'plan') {
    if (!/goal:/i.test(body)) return { valid: false, error: 'plan requires "goal:" line' };
    if (!/- id:/i.test(body)) return { valid: false, error: 'plan requires subtasks: "- id: N, role: X, task: Y"' };
  }
  if (actionName === 'parallel') {
    if (!body.includes('---')) return { valid: false, error: 'parallel requires --- separators between agent blocks' };
  }
  if (actionName === 'mcp') {
    if (!/server:/i.test(body)) return { valid: false, error: 'mcp requires "server:" field' };
    if (!/tool:/i.test(body)) return { valid: false, error: 'mcp requires "tool:" field' };
  }
  if (actionName === 'create_agent') {
    if (!/prompt:/i.test(body)) return { valid: false, error: 'create_agent requires "prompt:" field' };
  }
  if (actionName === 'remind') {
    const lines = body.split('\n');
    if (isNaN(parseInt(lines[0]))) return { valid: false, error: 'remind first line must be minutes (number)' };
  }
  if (actionName === 'schedule') {
    const lines = body.split('\n');
    if (lines.length < 3) return { valid: false, error: 'schedule requires 3+ lines: minutes, action type, body' };
  }
  return { valid: true };
};

// === Error-type-aware retry guidance ===
const getRetryGuidance = (actionName, errorOutput) => {
  const err = errorOutput.toLowerCase();
  const base = 'Действие не удалось. ЗАПРЕЩЕНО сдаваться. ';
  if (actionName === 'bash') {
    if (err.includes('тайм-аут') || err.includes('timeout'))
      return `${base}Команда зависла. Оптимизируй: разбей на части, убери pipe в pipe, добавь timeout, или используй другой подход.`;
    if (err.includes('permission denied') || err.includes('запрещён'))
      return `${base}Нет прав. Попробуй: другую директорию, другую команду, или delegate субагенту-executor.`;
    if (err.includes('not found') || err.includes('command not found'))
      return `${base}Команда не найдена. Используй альтернативу (node -e вместо python, curl вместо wget). Помни: Python НЕ установлен.`;
    if (err.includes('заблокировано') || err.includes('blocked'))
      return `${base}Команда заблокирована. Используй безопасную альтернативу или delegate субагенту.`;
    return `${base}Измени команду: используй другой синтаксис, другие флаги, или разбей на подкоманды.`;
  }
  if (actionName === 'image')
    return `${base}Генерация изображения не удалась. Создай визуал через bash (SVG через node -e, или HTML-макет). НЕ отправляй сырой код пользователю.`;
  if (actionName === 'delegate')
    return `${base}Субагент не справился. Попробуй: другую роль, упрости задачу, или выполни сам через bash.`;
  if (actionName === 'file')
    return `${base}Файл не найден или недоступен. Создай файл через [ACTION: bash], затем отправь через [ACTION: file].`;
  return `${base}Найди альтернативный подход. Используй другое действие или измени параметры.`;
};

// === Оценка сложности запроса ===
const estimateComplexity = (text, agentEnabled, multiAgentEnabled, chatId = null) => {
  if (!agentEnabled) return { maxSteps: 1, complexity: 'none' };
  const t = text.toLowerCase();
  const len = text.length;
  let score = 0;
  // Маркеры многошаговости
  if (/и затем|потом|после этого|шаг\s*\d|step\s*\d|сначала.*потом|first.*then/i.test(t)) score += 3;
  // Количество слов-действий
  const actionWords = (t.match(/\b(создай|напиши|установи|настрой|запусти|проверь|исправь|обнови|удали|перемести|скопируй|analyze|create|build|fix|test|deploy|install|configure)\b/gi) || []).length;
  score += Math.min(actionWords, 4);
  // Бонус за длину
  if (len > 500) score += 2;
  else if (len > 200) score += 1;
  // Маркеры проектной работы
  if (/проект|project|репозиторий|repo|весь код|all files|рефактор|refactor|миграц|migration/.test(t)) score += 3;
  // Маркеры делегирования
  if (multiAgentEnabled && /команд|team|параллельно|parallel|несколько задач/.test(t)) score += 2;
  if (multiAgentEnabled && /план|plan|декомпоз|decompose|архитектур|architecture|систем|system design/.test(t)) score += 3;

  // Контекст из истории: short follow-up в сложном разговоре → повышаем шаги
  if (chatId && len < 100) {
    const history = chatHistory.get(chatId) || [];
    if (history.length >= 4) {
      // Если предыдущие сообщения были длинные/сложные — это продолжение
      const recentAssistant = history.filter(h => h.role === 'assistant').slice(-2);
      const avgLen = recentAssistant.reduce((s, h) => s + (h.text?.length || 0), 0) / (recentAssistant.length || 1);
      if (avgLen > 500) score += 2; // предыдущие ответы были развёрнутые
      // Если были действия агента в недавних ответах
      const hadActions = recentAssistant.some(h => /\[ACTION:|выполнил|создал|установил|результат/i.test(h.text || ''));
      if (hadActions) score += 1;
    }
  }

  if (score <= 2) return { maxSteps: 4, complexity: 'simple' };
  if (score <= 5) return { maxSteps: 7, complexity: 'medium' };
  if (score <= 8) return { maxSteps: 10, complexity: 'complex' };
  return { maxSteps: 15, complexity: 'very_complex' };
};

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

// Парсинг строки времени "30", "2ч", "1д", "30мин" → ms (или null при ошибке)
function parseTimeString(str) {
  const timeMatch = str.trim().match(/^(\d+)\s*(м|мин|min|ч|h|час|д|d|день|с|s|сек)?$/i);
  if (!timeMatch) return null;
  const timeVal = parseInt(timeMatch[1]);
  const timeUnit = (timeMatch[2] || 'м').toLowerCase();
  if (timeUnit.startsWith('ч') || timeUnit === 'h') return timeVal * 3600000;
  if (timeUnit.startsWith('д') || timeUnit === 'd') return timeVal * 86400000;
  if (timeUnit.startsWith('с') || timeUnit === 's') return Math.max(5000, timeVal * 1000);
  return timeVal * 60000;
}

function executeRemindAction(chatId, body) {
  const lines = body.split('\n');
  const delayMs = parseTimeString(lines[0] || '');
  if (!delayMs) return { success: false, output: 'Ошибка: строка 1: время (число или "2ч", "1д")' };

  // Парсинг опций из последующих строк
  let text = '';
  let repeat = null;
  let repeatInterval = null;
  let priority = 1;
  let category = 'general';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^повтор:|^repeat:/i.test(line)) {
      const val = line.replace(/^(повтор|repeat):\s*/i, '').trim().toLowerCase();
      if (val === 'daily' || val === 'ежедневно') { repeat = 'daily'; repeatInterval = 86400000; }
      else if (val === 'weekly' || val === 'еженедельно') { repeat = 'weekly'; repeatInterval = 604800000; }
      else if (val === 'hourly' || val === 'ежечасно') { repeat = 'hourly'; repeatInterval = 3600000; }
      else { const m = val.match(/^(\d+)\s*(м|мин|ч|час|д)/i); if (m) { repeat = 'custom'; const u = m[2].toLowerCase(); repeatInterval = parseInt(m[1]) * (u.startsWith('ч') ? 3600000 : u.startsWith('д') ? 86400000 : 60000); } }
    } else if (/^приоритет:|^priority:/i.test(line)) {
      const val = line.replace(/^(приоритет|priority):\s*/i, '').trim();
      priority = Math.min(3, Math.max(1, parseInt(val) || 1));
    } else if (/^категория:|^category:/i.test(line)) {
      const val = line.replace(/^(категория|category):\s*/i, '').trim().toLowerCase();
      if (['work', 'personal', 'urgent', 'general'].includes(val)) category = val;
    } else {
      text += (text ? '\n' : '') + line;
    }
  }
  if (!text) return { success: false, output: 'Ошибка: нет текста напоминания' };

  const id = nextReminderId++;
  const fireAt = Date.now() + delayMs;
  if (!config.reminders) config.reminders = [];
  const reminder = { id, chatId, text, fireAt, priority, category };
  if (repeat) { reminder.repeat = repeat; reminder.repeatInterval = repeatInterval; }
  config.reminders.push(reminder);
  saveConfig();
  const timerId = setTimeout(() => fireReminder(id), delayMs);
  reminderTimers.set(id, timerId);
  const repeatNote = repeat ? ` (🔄 ${repeat})` : '';
  return { success: true, output: `Напоминание #${id} через ${formatTimeLeft(delayMs)}${repeatNote}: "${text}"` };
}

function executeScheduleAction(chatId, body) {
  const lines = body.split('\n');
  const delayMs = parseTimeString(lines[0] || '');
  if (!delayMs) return { success: false, output: 'Ошибка: строка 1: время (число или "2ч", "1д")' };
  if (delayMs < 60000) return { success: false, output: 'Ошибка: минимум 1 минута' };

  const actionName = (lines[1] || '').replace(/^действие:\s*/i, '').trim();
  const actionBody = lines.slice(2).filter(l => !/^описание:/i.test(l)).join('\n').trim();
  const descLine = lines.find(l => /^описание:/i.test(l));
  const description = descLine ? descLine.replace(/^описание:\s*/i, '').trim() : actionBody.slice(0, 50);
  if (!actionName || !actionBody) {
    return { success: false, output: 'Ошибка: строка 1: время, строка 2: тип действия, строка 3+: тело действия' };
  }
  const allowedActions = ['bash', 'image', 'video', 'remind', 'file', 'delegate', 'mcp'];
  if (!allowedActions.includes(actionName)) {
    return { success: false, output: `Допустимые действия: ${allowedActions.join(', ')}` };
  }
  const id = nextScheduleId++;
  const fireAt = Date.now() + delayMs;
  if (!config.scheduledActions) config.scheduledActions = [];
  config.scheduledActions.push({ id, chatId, actionName, actionBody, description, fireAt });
  saveConfig();
  const timerId = setTimeout(() => fireScheduledAction(id), delayMs);
  scheduledTimers.set(id, timerId);
  return { success: true, output: `⏰ Действие #${id} запланировано через ${formatTimeLeft(delayMs)}: [${actionName}] ${description}` };
}

function executeTodoAction(chatId, body) {
  const lines = body.split('\n');
  const text = lines[0].trim();
  if (!text) return { success: false, output: 'Ошибка: строка 1 должна содержать текст задачи' };

  const opts = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^(priority|category|due)\s*=\s*(.+)/i);
    if (m) opts[m[1].toLowerCase()] = m[2].trim();
  }

  const priority = opts.priority ? Math.min(3, Math.max(1, parseInt(opts.priority) || 1)) : 1;
  const category = opts.category || 'general';
  let dueAt = null;
  if (opts.due) {
    const dm = opts.due.match(/^(\d+)\s*(м|мин|min|ч|h|час|д|d|день)?$/i);
    if (dm) {
      const val = parseInt(dm[1]);
      const unit = (dm[2] || 'м').toLowerCase();
      let ms;
      if (unit.startsWith('ч') || unit === 'h') ms = val * 3600000;
      else if (unit.startsWith('д') || unit === 'd') ms = val * 86400000;
      else ms = val * 60000;
      dueAt = Date.now() + ms;
    }
  }

  if (!config.todos) config.todos = [];
  const id = nextTodoId++;
  const todo = { id, chatId, text, status: 'pending', createdAt: Date.now(), priority, category, dueAt };
  config.todos.push(todo);
  saveConfig();

  const PRIORITY_LABELS = { 1: 'обычный', 2: 'средний', 3: 'высокий' };
  let msg = `📋 Задача #${id} создана: ${text}\n📌 Приоритет: ${PRIORITY_LABELS[priority] || priority}`;
  if (dueAt) msg += `\n⏰ Дедлайн: ${formatFireTime(dueAt)}`;
  if (category !== 'general') msg += `\n📂 Категория: ${category}`;
  return { success: true, output: msg };
}

function executeSearchAction(query) {
  return { success: true, output: `Поисковый запрос "${query}" принят. Ответь на основе своих знаний.`, isSearch: true, query };
}

function executeFileAction(chatId, filePath) {
  const uc = getUserConfig(chatId);
  // Берём только первую строку как путь (защита от конкатенации контента с путём)
  const cleanPath = filePath.split('\n')[0].trim();
  const resolvedWorkDir = path.resolve(uc.workDir) + path.sep;
  const resolved = path.resolve(uc.workDir, cleanPath);
  if (!resolved.startsWith(resolvedWorkDir) && resolved !== path.resolve(uc.workDir)) {
    return { success: false, output: 'Доступ запрещён: файл вне рабочей директории' };
  }
  if (!fs.existsSync(resolved)) {
    return { success: false, output: `Файл не найден: ${resolved}. Убедись, что файл создан через [ACTION: bash] перед отправкой.` };
  }
  sendDocument(chatId, resolved);
  return { success: true, output: `Файл отправлен: ${resolved}` };
}

async function executeSkillAction(chatId, body) {
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

  // Выполняем навык как мини-агент: промпт навыка как системный, контекст как user message
  try {
    const skillSystemPrompt = skill.prompt;
    const skillUserMessage = context || 'Выполни задачу навыка.';
    const messages = [{ role: 'user', content: skillUserMessage }];
    const model = uc.model;

    const result = await callAIWithFallback(model, normalizeMessages(messages), skillSystemPrompt, chatId, { allowMcp: true });
    stats.claudeCalls++;

    const responseText = result.text.trim();
    return { success: true, output: `[SKILL: ${skill.name}]\n${responseText}\n[/SKILL]` };
  } catch (e) {
    // Fallback: возвращаем промпт навыка как раньше
    const result = `[SKILL: ${skill.name}]\n${skill.prompt}\n${context ? `\nКонтекст: ${context}` : ''}\n[/SKILL]`;
    return { success: true, output: result };
  }
}

function getAgentRoleInfo(chatId, role) {
  const session = (sessionAgents.get(chatId) || []).find(a => a.id === role);
  if (session) return { icon: session.icon || '🤖', label: session.label, desc: session.desc || '' };
  const uc = getUserConfig(chatId);
  const custom = (uc.customAgents || []).find(a => a.id === role && a.enabled !== false);
  if (custom) return { icon: custom.icon || '🤖', label: custom.label, desc: custom.desc || '' };
  return AGENT_ROLES[role] || { icon: '🔄', label: role };
}

async function executeDelegateAction(chatId, body, statusUpdater, depth = 0) {
  // Парсим роль, задачу, контекст
  const roleMatch = body.match(/роль:\s*([\w\-а-яёА-ЯЁ]+)/i) || body.match(/role:\s*([\w\-]+)/i);
  const taskMatch = body.match(/задача:\s*(.+)/i) || body.match(/task:\s*(.+)/i);
  const ctxMatch = body.match(/контекст:\s*([\s\S]*)/i) || body.match(/context:\s*([\s\S]*)/i);

  const role = roleMatch ? roleMatch[1].toLowerCase() : 'executor';
  const task = taskMatch ? taskMatch[1].trim() : body.split('\n')[0];
  const context = ctxMatch ? ctxMatch[1].trim() : '';

  const uc = getUserConfig(chatId);
  // Ищем сначала в кастомных агентах, потом в сессионных, потом в пресетах
  const customAgent = (uc.customAgents || []).find(a => a.id === role && a.enabled !== false);
  const sessionAgent = (sessionAgents.get(chatId) || []).find(a => a.id === role);
  const presetAgent = PRESET_AGENTS.find(a => a.id === role);
  const effectiveAgent = customAgent || sessionAgent || presetAgent;
  const effectiveAgents = getEffectiveAgents(chatId);

  if (!effectiveAgent && !AGENT_ROLES[role]) {
    return { success: false, output: `Неизвестная роль: ${role}. Доступные: ${Object.keys(effectiveAgents).join(', ')}` };
  }

  const roleInfo = effectiveAgent
    ? { icon: effectiveAgent.icon || '🤖', label: effectiveAgent.label, desc: effectiveAgent.desc || '' }
    : AGENT_ROLES[role];
  const subAgentId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Логируем в трекер
  const tracker = multiAgentTasks.get(chatId);
  if (tracker) {
    tracker.agents.push({ id: subAgentId, role, task: task.slice(0, 100), status: 'running', startTime: Date.now() });
    tracker.log.push(`🤝 Оркестратор → ${roleInfo.icon} ${roleInfo.label}: ${task.slice(0, 80)}`);
  }

  if (statusUpdater) statusUpdater(`🤝 Делегирование → ${roleInfo.icon} ${roleInfo.label}\n📋 ${task.slice(0, 120)}`);

  // Формируем промпт субагента (кастомный или стандартный)
  const subPrompt = SUB_AGENT_PROMPT_TEMPLATE(role, task, context, effectiveAgent);
  const subModel = (effectiveAgent && effectiveAgent.model) ? effectiveAgent.model : uc.model;
  const subMaxSteps = (effectiveAgent && effectiveAgent.maxSteps) ? effectiveAgent.maxSteps : 3;

  if (customAgent) {
    customAgent.uses = (customAgent.uses || 0) + 1;
    customAgent.lastUsed = Date.now();
    saveUserConfig(chatId);
  }

  try {
    const subMessages = [{ role: 'user', content: task + (context ? `\n\nКонтекст:\n${context}` : '') }];
    let subResult = '';

    for (let subStep = 0; subStep < subMaxSteps; subStep++) {
      const aiResult = await callAIWithFallback(subModel, normalizeMessages(subMessages), subPrompt, chatId, { allowMcp: true });
      const responseText = aiResult.text.trim();

      const subAction = parseAction(responseText);
      if (!subAction) {
        subResult = responseText;
        break;
      }

      // Субагент хочет выполнить действие
      if (statusUpdater) statusUpdater(`${roleInfo.icon} ${roleInfo.label} выполняет [${subAction.name}]\n💬 ${(subAction.textBefore || '').slice(0, 100)}`);

      if (subAction.name === 'delegate') {
        if (depth >= 1) {
          subResult = responseText.replace(subAction.fullMatch, '').trim() + '\n(Максимальная глубина делегирования достигнута)';
          break;
        }
        // Позволяем делегировать на один уровень вглубь
        const delegateResult = await executeDelegateAction(chatId, subAction.body, statusUpdater, depth + 1);
        subMessages.push({ role: 'assistant', content: responseText });
        subMessages.push({ role: 'user', content: `[RESULT: delegate]\n${delegateResult.output}\n[/RESULT]` });
        continue;
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
      tracker.log.push(`${roleInfo.icon} ${roleInfo.label} → Оркестратору: результат готов ✅`);
    }

    return { success: true, output: `[СУБАГЕНТ ${roleInfo.icon} ${roleInfo.label}]\n${subResult}\n[/СУБАГЕНТ]` };

  } catch (e) {
    if (tracker) {
      const agent = tracker.agents.find(a => a.id === subAgentId);
      if (agent) { agent.status = 'error'; agent.error = e.message; agent.endTime = Date.now(); }
      tracker.log.push(`${roleInfo.icon} ${roleInfo.label} → Оркестратору: ошибка ❌ ${e.message}`);
    }
    return { success: false, output: `Ошибка субагента ${roleInfo.label}: ${e.message}` };
  }
}

// === Plan Action: декомпозиция задачи ===
async function executePlanAction(chatId, body, statusUpdater) {
  const tracker = multiAgentTasks.get(chatId);
  const goalMatch = body.match(/goal:\s*(.+)/i);
  const goal = goalMatch ? goalMatch[1].trim() : 'Цель не указана';

  const subtaskMatches = [...body.matchAll(/- id:\s*(\d+),\s*role:\s*([\w\-а-яёА-ЯЁ]+),\s*task:\s*(.+?)(?:,\s*priority:\s*(\w+))?(?:,\s*deps:\s*\[([^\]]*)\])?$/gm)];
  if (subtaskMatches.length === 0) {
    return { success: false, output: 'plan: подзадачи не найдены. Формат: - id: N, role: X, task: Y, deps: [N]' };
  }

  const plan = {
    goal,
    subtasks: subtaskMatches.map(m => ({
      id: parseInt(m[1]),
      role: m[2].trim().toLowerCase(),
      task: m[3].trim(),
      priority: (m[4] || 'medium').trim(),
      deps: m[5] ? m[5].split(',').map(d => parseInt(d.trim())).filter(Boolean) : [],
      status: 'pending',
    })),
    createdAt: Date.now(),
  };

  if (tracker) {
    tracker.plan = plan;
    tracker.log.push(`📋 План: ${plan.subtasks.length} подзадач для "${goal.slice(0, 60)}"`);
  }

  const planDisplay = plan.subtasks.map(st => {
    const roleInfo = getAgentRoleInfo(chatId, st.role);
    const depsStr = st.deps.length > 0 ? ` (после: ${st.deps.join(',')})` : '';
    return `  ${st.id}. ${roleInfo.icon} ${st.role}: ${st.task.slice(0, 80)}${depsStr}`;
  }).join('\n');

  const independentTasks = plan.subtasks.filter(st => st.deps.length === 0);
  const hint = independentTasks.length > 1
    ? `\n\n💡 Подзадачи ${independentTasks.map(t => t.id).join(', ')} можно выполнить параллельно через [ACTION: parallel]`
    : '';

  if (statusUpdater) statusUpdater(`📋 План: ${plan.subtasks.length} подзадач`);

  return {
    success: true,
    output: `[PLAN]\n🎯 Цель: ${goal}\n\n📋 Подзадачи:\n${planDisplay}${hint}\n[/PLAN]`,
  };
}

// === Parallel Action: параллельное выполнение субагентов ===
async function executeParallelAction(chatId, body, statusUpdater) {
  const tracker = multiAgentTasks.get(chatId);
  const timeoutMatch = body.match(/^timeout:\s*(\d+)/m);
  const perAgentTimeout = (timeoutMatch ? parseInt(timeoutMatch[1]) : 90) * 1000;

  const blocks = body.split(/\n---\n/).map(b => b.trim()).filter(b => {
    const lines = b.split('\n').filter(l => !l.match(/^timeout:/i));
    return lines.some(l => l.trim().length > 0);
  });

  if (blocks.length === 0) return { success: false, output: 'parallel: блоки агентов не найдены. Разделяйте ---' };
  if (blocks.length > 5) return { success: false, output: 'parallel: максимум 5 агентов одновременно' };

  const parallelGroupId = `pg_${Date.now()}`;
  if (statusUpdater) statusUpdater(`🚀 Запуск ${blocks.length} параллельных агентов...`);
  if (tracker) tracker.log.push(`🚀 Параллельный запуск: ${blocks.length} агентов`);

  const agentTasks = blocks.map((block) => {
    const roleMatch = block.match(/роль:\s*([\w\-а-яёА-ЯЁ]+)/i) || block.match(/role:\s*([\w\-]+)/i);
    const taskMatch = block.match(/задача:\s*(.+)/i) || block.match(/task:\s*(.+)/i);
    return {
      role: roleMatch ? roleMatch[1].toLowerCase() : 'executor',
      task: taskMatch ? taskMatch[1].trim() : block.split('\n')[0],
      rawBody: block,
    };
  });

  // Семафор для ограничения параллельных AI-вызовов
  let running = 0;
  const waitQueue = [];
  const acquireSlot = () => {
    if (running < PARALLEL_AGENT_LIMIT) { running++; return Promise.resolve(); }
    return new Promise(resolve => waitQueue.push(resolve));
  };
  const releaseSlot = () => {
    running--;
    if (waitQueue.length > 0) { running++; waitQueue.shift()(); }
  };

  // Прогресс-бар и AbortController
  let completedCount = 0;
  const totalCount = agentTasks.length;
  const parallelAbort = new AbortController();

  const buildProgressBar = (done, total) => { const f = Math.round((done / total) * 8); return '█'.repeat(f) + '░'.repeat(8 - f); };
  const updateProgress = () => {
    if (!statusUpdater) return;
    statusUpdater(`[${buildProgressBar(completedCount, totalCount)}] ${completedCount}/${totalCount} агентов`);
  };

  // Запуск всех агентов через Promise.allSettled
  const promises = agentTasks.map(async (at) => {
    await acquireSlot();
    if (parallelAbort.signal.aborted) return { success: false, output: 'Отменено', role: at.role, task: at.task };
    try {
      // Добавляем в трекер с parallelGroup
      if (tracker) {
        tracker.agents.push({
          id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: at.role, task: at.task.slice(0, 100),
          status: 'running', startTime: Date.now(), parallelGroup: parallelGroupId,
        });
      }
      const result = await Promise.race([
        executeDelegateAction(chatId, at.rawBody, (detail) => {
          if (statusUpdater) {
            const ri = getAgentRoleInfo(chatId, at.role);
            statusUpdater(`[${buildProgressBar(completedCount, totalCount)}] ${completedCount}/${totalCount}\n${ri.icon} ${ri.label}: ${detail.slice(0, 80)}`);
          }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${perAgentTimeout / 1000}s`)), perAgentTimeout)),
      ]);
      completedCount++;
      updateProgress();
      return { ...result, role: at.role, task: at.task };
    } catch (e) {
      completedCount++;
      updateProgress();
      return { success: false, output: `Timeout/Error: ${e.message}`, role: at.role, task: at.task };
    } finally {
      releaseSlot();
    }
  });

  const results = await Promise.allSettled(promises);

  const output = results.map((r, i) => {
    const at = agentTasks[i];
    const ri = getAgentRoleInfo(chatId, at.role);
    if (r.status === 'fulfilled') {
      const res = r.value;
      return `${res.success ? '✅' : '❌'} ${ri.icon} ${ri.label} (${at.task.slice(0, 60)}):\n${res.output}`;
    }
    return `❌ ${ri.icon} ${ri.label}: ${r.reason?.message || 'Unknown error'}`;
  }).join('\n\n---\n\n');

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  if (tracker) tracker.log.push(`🚀 Параллельно: ${successCount}/${results.length} успешно`);

  return {
    success: successCount > 0,
    output: `[PARALLEL: ${successCount}/${results.length} успешно]\n\n${output}\n\n[/PARALLEL]`,
  };
}

// === Create Agent Action: создание сессионного агента ===
async function executeCreateAgentAction(chatId, body) {
  const idMatch = body.match(/^id:\s*(.+)/m);
  const labelMatch = body.match(/^label:\s*(.+)/m);
  const iconMatch = body.match(/^icon:\s*(.+)/m);
  const descMatch = body.match(/^desc:\s*(.+)/m);
  const promptMatch = body.match(/^prompt:\s*([\s\S]+?)(?=\n(?:maxSteps:|$))/m);
  const stepsMatch = body.match(/^maxSteps:\s*(\d+)/m);

  const id = idMatch ? idMatch[1].trim() : `agent_${Date.now()}`;
  const label = labelMatch ? labelMatch[1].trim() : id;
  const icon = iconMatch ? iconMatch[1].trim() : '🤖';
  const desc = descMatch ? descMatch[1].trim() : '';
  const prompt = promptMatch ? promptMatch[1].trim() : '';
  const maxSteps = stepsMatch ? parseInt(stepsMatch[1]) : 3;

  if (!prompt) return { success: false, output: 'create_agent: требуется поле "prompt:"' };

  if (!sessionAgents.has(chatId)) sessionAgents.set(chatId, []);
  const agents = sessionAgents.get(chatId);

  const existing = agents.findIndex(a => a.id === id);
  if (existing >= 0) agents.splice(existing, 1);
  if (agents.length >= 10) return { success: false, output: 'create_agent: максимум 10 сессионных агентов' };

  agents.push({ id, label, icon, desc, prompt, maxSteps, model: '', enabled: true, isSession: true });

  const tracker = multiAgentTasks.get(chatId);
  if (tracker) tracker.log.push(`🤖 Создан агент: ${icon} ${label} (${id})`);

  return {
    success: true,
    output: `Агент создан: ${icon} ${label} (id: ${id})\nМаксимум шагов: ${maxSteps}\nДоступен для delegate и parallel.`,
  };
}

// === Supervise Action: контроль и координация ===
async function executeSuperviseAction(chatId) {
  const tracker = multiAgentTasks.get(chatId);
  if (!tracker) return { success: false, output: 'supervise: нет активной мульти-агентной задачи' };

  const agents = tracker.agents || [];
  const running = agents.filter(a => a.status === 'running');
  const done = agents.filter(a => a.status === 'done');
  const errors = agents.filter(a => a.status === 'error');
  const plan = tracker.plan;

  let report = `📊 Статус мульти-агентной задачи\n⏱ Время: ${Math.round((Date.now() - tracker.startTime) / 1000)}с\n\n`;

  if (plan) {
    report += `📋 План: "${plan.goal.slice(0, 60)}"\n`;
    for (const st of plan.subtasks) {
      const icon = st.status === 'done' ? '✅' : st.status === 'running' ? '⏳' : '⏸';
      report += `  ${icon} #${st.id} ${st.role}: ${st.task.slice(0, 60)}\n`;
    }
    report += '\n';
  }

  if (running.length > 0) {
    report += `⏳ Работают (${running.length}):\n`;
    for (const a of running) {
      const ri = getAgentRoleInfo(chatId, a.role);
      report += `  ${ri.icon} ${a.role}: ${a.task} (${Math.round((Date.now() - a.startTime) / 1000)}с)\n`;
    }
  }

  if (done.length > 0) {
    report += `\n✅ Завершены (${done.length}):\n`;
    for (const a of done) {
      const ri = getAgentRoleInfo(chatId, a.role);
      const dur = a.endTime ? Math.round((a.endTime - a.startTime) / 1000) : 0;
      report += `  ${ri.icon} ${a.role}: ${a.task.slice(0, 60)} (${dur}с)\n`;
    }
  }

  if (errors.length > 0) {
    report += `\n❌ Ошибки (${errors.length}):\n`;
    for (const a of errors) {
      const ri = getAgentRoleInfo(chatId, a.role);
      report += `  ${ri.icon} ${a.role}: ${(a.error || 'unknown').slice(0, 80)}\n`;
    }
  }

  report += `\n📋 Лог:\n${tracker.log.slice(-5).join('\n')}`;
  const sa = sessionAgents.get(chatId) || [];
  if (sa.length > 0) report += `\n\n🤖 Сессионные агенты: ${sa.map(a => `${a.icon} ${a.id}`).join(', ')}`;

  return { success: true, output: report };
}

// === MCP Tool Action ===
async function executeMcpAction(chatId, body) {
  const serverMatch = body.match(/server:\s*(.+)/i);
  const toolMatch = body.match(/tool:\s*(.+)/i);
  const argsMatch = body.match(/args:\s*(\{[\s\S]*\})/i);

  if (!serverMatch) return { success: false, output: 'mcp: требуется поле "server:"' };
  if (!toolMatch) return { success: false, output: 'mcp: требуется поле "tool:"' };

  const serverId = serverMatch[1].trim();
  const toolName = toolMatch[1].trim();
  let args = {};
  if (argsMatch) {
    try { args = JSON.parse(argsMatch[1].trim()); }
    catch (e) { return { success: false, output: `mcp: невалидный JSON в args: ${e.message}` }; }
  }

  try {
    const client = await getMcpClient(chatId, serverId);
    const result = await client.callTool(toolName, args);
    return { success: true, output: `[MCP ${serverId}/${toolName}]\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n[/MCP]` };
  } catch (e) {
    return { success: false, output: `MCP ошибка: ${e.message}` };
  }
}

async function executeImageAction(chatId, body) {
  const { prompt, negativePrompt } = parseNegativePrompt(body);
  const uc = getUserConfig(chatId);
  const genOpts = {};
  if (negativePrompt) genOpts.negativePrompt = negativePrompt;
  if (uc.imageSize) genOpts.imageSize = uc.imageSize;
  const primaryModel = uc.imageModel || 'nano-banana';
  const fallbackOrder = ['nano-banana-2', 'nano-banana', 'imagen-4-fast', 'imagen-4', 'nano-banana-pro', 'imagen-3', 'imagen-3-fast', 'imagen-4-ultra'].filter(m => m !== primaryModel);
  const modelsToTry = [primaryModel, ...fallbackOrder];
  const errors = [];

  for (const modelKey of modelsToTry) {
    try {
      const results = await generateImage(chatId, prompt, { ...genOpts, model: modelKey });
      const images = results.filter(r => r.type === 'image');
      const texts = results.filter(r => r.type === 'text');
      for (const img of images) {
        await sendPhoto(chatId, img.path, prompt.slice(0, 200));
        try { fs.unlinkSync(img.path); } catch(e) {}
      }
      const textResult = texts.map(t => t.text).join('\n').slice(0, 500);
      const fallbackNote = modelKey !== primaryModel ? ` (через ${IMAGE_MODELS[modelKey]?.label || modelKey})` : '';
      return { success: true, output: `Изображение отправлено${fallbackNote}. ${textResult}` };
    } catch (e) {
      errors.push(`${modelKey}: ${e.message}`);
      continue;
    }
  }

  // Все модели провалились — даём агенту подсказку для альтернативного подхода
  return { success: false, output: `Все генераторы изображений недоступны (${errors.join('; ')}). ОБЯЗАТЕЛЬНО используй альтернативный подход: создай визуал через bash (node -e с canvas/SVG), или создай HTML-макет и сделай скриншот через bash. НЕ отправляй сырой код пользователю.` };
}

async function executeVideoAction(chatId, body, statusUpdater) {
  const { prompt, negativePrompt } = parseNegativePrompt(body);
  const uc = getUserConfig(chatId);
  const primaryModel = uc.videoModel || 'veo-3.1-fast';
  const fallbackOrder = ['veo-3.1-fast', 'veo-3.1', 'veo-2'].filter(m => m !== primaryModel);
  const modelsToTry = [primaryModel, ...fallbackOrder];
  const errors = [];

  const statusMsg = await send(chatId, '🎬 Генерация видео... ⏱ 0с');
  const statusMsgId = statusMsg?.result?.message_id;

  for (const modelKey of modelsToTry) {
    const startTime = Date.now();
    const modelLabel = VIDEO_MODELS[modelKey]?.label || modelKey;
    try {
      if (statusMsgId && modelKey !== primaryModel) {
        editText(chatId, statusMsgId, `🎬 Пробую ${modelLabel}... ⏱ 0с`);
      }
      const vidOpts = {
        model: modelKey,
        onProgress: (poll) => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          if (statusMsgId) editText(chatId, statusMsgId, `🎬 ${modelLabel}... ⏱ ${elapsed}с`);
        }
      };
      if (negativePrompt) vidOpts.negativePrompt = negativePrompt;
      const result = await generateVideo(chatId, prompt, vidOpts);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const fallbackNote = modelKey !== primaryModel ? ` (через ${modelLabel})` : '';
      if (statusMsgId) editText(chatId, statusMsgId, `✅ Видео готово${fallbackNote} (${elapsed}с)`);
      await sendVideo(chatId, result.path, prompt.slice(0, 200));
      try { fs.unlinkSync(result.path); } catch(e) {}
      return { success: true, output: `Видео отправлено${fallbackNote}` };
    } catch (e) {
      errors.push(`${modelLabel}: ${e.message}`);
      continue;
    }
  }

  if (statusMsgId) editText(chatId, statusMsgId, `❌ Все модели видео недоступны`);
  return { success: false, output: `Все модели видео недоступны (${errors.join('; ')}). Предложи пользователю попробовать позже или использовать другой промпт.` };
}

async function executeVideoExtendAction(chatId, body, statusUpdater) {
  try {
    const statusMsg = await send(chatId, '🎬 Продление видео... (требуется видео через /videoextend)');
    const statusMsgId = statusMsg?.result?.message_id;
    // Agent-triggered action — у агента нет доступа к reply-контексту с видеофайлом
    // Направляем пользователя использовать /videoextend
    if (statusMsgId) editText(chatId, statusMsgId, '⚠️ Для продления видео используйте /videoextend (ответ на видео)');
    return { success: false, output: 'video_extend требует ответа на видео. Предложи пользователю команду: /videoextend [промпт] (ответом на видео).' };
  } catch (e) {
    return { success: false, output: `Ошибка: ${e.message}` };
  }
}

// === Figma интеграция через REST API ===
async function executeFigmaAction(chatId, body) {
  const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
  if (!FIGMA_TOKEN) return { success: false, output: 'FIGMA_TOKEN не задан в .env. Получи токен: Figma → Settings → Personal Access Tokens.' };

  try {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const cmdLine = lines[0] || '';
    const cmdMatch = cmdLine.match(/^(?:команда:\s*)?(\w+)\s*(.*)/i);
    if (!cmdMatch) return { success: false, output: 'Формат: команда параметры. Команды: discover <url>, get_file <file_key>, render <file_key> <node_ids>, styles <file_key>, components <file_key>' };

    const cmd = cmdMatch[1].toLowerCase();
    const params = (cmdMatch[2].trim() || lines[1] || '').trim();

    const figmaFetch = async (endpoint) => {
      const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
        headers: { 'X-Figma-Token': FIGMA_TOKEN },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.err || err.message || `HTTP ${res.status}`);
      }
      return res.json();
    };

    switch (cmd) {
      case 'discover': {
        // Извлечь file_key из URL
        const urlMatch = params.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)/);
        const fileKey = urlMatch ? urlMatch[1] : params;
        const data = await figmaFetch(`/files/${fileKey}?depth=2`);
        const pages = (data.document?.children || []).map(p => ({
          name: p.name, id: p.id,
          frames: (p.children || []).slice(0, 20).map(f => ({ name: f.name, id: f.id, type: f.type }))
        }));
        return { success: true, output: `📄 ${data.name}\n📅 ${data.lastModified}\n\n${pages.map(p => `📑 ${p.name} (${p.id}):\n${p.frames.map(f => `  └ ${f.type} "${f.name}" → ${f.id}`).join('\n')}`).join('\n\n')}` };
      }

      case 'get_file': {
        const fileKey = params.split(/\s/)[0];
        const nodeIds = params.split(/\s/).slice(1).join(',');
        const endpoint = nodeIds ? `/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeIds)}` : `/files/${fileKey}?depth=3`;
        const data = await figmaFetch(endpoint);
        const summary = JSON.stringify(data, null, 2).slice(0, 3000);
        return { success: true, output: `Figma файл (${fileKey}):\n${summary}` };
      }

      case 'render': {
        const parts = params.split(/\s+/);
        const fileKey = parts[0];
        const nodeIds = parts.slice(1).join(',');
        if (!nodeIds) return { success: false, output: 'Формат: render <file_key> <node_id1> <node_id2> ...' };
        const data = await figmaFetch(`/images/${fileKey}?ids=${encodeURIComponent(nodeIds)}&format=png&scale=2`);
        const images = data.images || {};
        let sent = 0;
        for (const [nodeId, url] of Object.entries(images)) {
          if (url) {
            const imgPath = `/tmp/figma_${Date.now()}_${nodeId.replace(/:/g, '_')}.png`;
            const imgRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
            const buf = Buffer.from(await imgRes.arrayBuffer());
            fs.writeFileSync(imgPath, buf);
            await sendPhoto(chatId, imgPath, `Figma: ${nodeId}`);
            try { fs.unlinkSync(imgPath); } catch(e) {}
            sent++;
          }
        }
        return { success: true, output: `Figma render: отправлено ${sent} изображений из ${Object.keys(images).length} узлов` };
      }

      case 'styles': {
        const fileKey = params.split(/\s/)[0];
        const data = await figmaFetch(`/files/${fileKey}/styles`);
        const styles = (data.meta?.styles || []).map(s => `${s.style_type}: "${s.name}" (${s.key})`).join('\n');
        return { success: true, output: `🎨 Стили (${fileKey}):\n${styles || 'Нет опубликованных стилей'}` };
      }

      case 'components': {
        const fileKey = params.split(/\s/)[0];
        const data = await figmaFetch(`/files/${fileKey}/components`);
        const comps = (data.meta?.components || []).map(c => `🧩 "${c.name}" (${c.node_id}) — ${c.description || 'без описания'}`).join('\n');
        return { success: true, output: `🧩 Компоненты (${fileKey}):\n${comps || 'Нет опубликованных компонентов'}` };
      }

      default:
        return { success: false, output: `Неизвестная Figma-команда: ${cmd}. Доступные: discover, get_file, render, styles, components` };
    }
  } catch (e) {
    return { success: false, output: `Figma ошибка: ${e.message?.slice(0, 500)}` };
  }
}

// === Background Action ===
async function executeBackgroundAction(chatId, body) {
  const descMatch = body.match(/описание:\s*(.+)/i) || body.match(/desc:\s*(.+)/i);
  const taskMatch = body.match(/задача:\s*([\s\S]+)/i) || body.match(/task:\s*([\s\S]+)/i);
  const desc = descMatch ? descMatch[1].trim() : body.split('\n')[0].slice(0, 80);
  const prompt = taskMatch ? taskMatch[1].trim() : body;

  const taskId = await runBackground(chatId, prompt, desc);
  if (taskId) {
    return { success: true, output: `Задача запущена в фоне: ${desc}\nID: ${taskId}\nПользователь может продолжать общаться.` };
  }
  return { success: false, output: 'Не удалось запустить фоновую задачу (лимит достигнут)' };
}

// === Memory Action ===
function executeMemoryAction(chatId, body) {
  const cmdMatch = body.match(/команда:\s*(\w+)/i) || body.match(/command:\s*(\w+)/i);
  const cmd = cmdMatch ? cmdMatch[1].toLowerCase() : body.split('\n')[0].trim().toLowerCase();
  const textMatch = body.match(/текст:\s*(.+)/i) || body.match(/text:\s*(.+)/i);
  const searchText = textMatch ? textMatch[1].trim() : body.split('\n').slice(1).join(' ').trim();

  if (cmd === 'forget' || cmd === 'delete') {
    if (!searchText) return { success: false, output: 'memory forget: укажи что забыть' };
    const removed = forgetMemory(chatId, searchText);
    return { success: true, output: removed > 0 ? `Забыто ${removed} записей по запросу "${searchText}"` : `Не найдено записей с "${searchText}"` };
  }
  if (cmd === 'list' || cmd === 'show') {
    return { success: true, output: formatMemoryList(chatId) };
  }
  return { success: false, output: `memory: неизвестная команда "${cmd}". Доступные: forget, list` };
}

// === Execute Plan (автовыполнение плана) ===
async function executeAutoplan(chatId, statusUpdater) {
  const tracker = multiAgentTasks.get(chatId);
  if (!tracker || !tracker.plan) {
    return { success: false, output: 'execute_plan: нет активного плана. Сначала создай план через [ACTION: plan]' };
  }

  const plan = tracker.plan;
  const subtasks = plan.subtasks;
  const results = new Map(); // id -> result

  // Топологическая сортировка: определяем порядок выполнения
  const pending = new Set(subtasks.map(st => st.id));
  let totalDone = 0;

  if (statusUpdater) statusUpdater(`📋 Автовыполнение: ${subtasks.length} подзадач`);

  while (pending.size > 0) {
    // Находим задачи, чьи зависимости уже выполнены
    const ready = subtasks.filter(st => pending.has(st.id) && st.deps.every(d => results.has(d)));
    if (ready.length === 0) {
      return { success: false, output: `execute_plan: циклическая зависимость или невыполнимые задачи. Pending: ${[...pending].join(',')}` };
    }

    // Выполняем параллельно готовые задачи
    const promises = ready.map(async (st) => {
      st.status = 'running';
      if (tracker) tracker.log.push(`▶️ #${st.id} ${st.role}: ${st.task.slice(0, 60)}`);

      // Собираем контекст от зависимостей
      const depsContext = st.deps.map(d => {
        const depResult = results.get(d);
        const depTask = subtasks.find(s => s.id === d);
        return depResult ? `[Результат #${d} (${depTask?.role})]:\n${depResult.output.slice(0, 500)}` : '';
      }).filter(Boolean).join('\n\n');

      const delegateBody = `роль: ${st.role}\nзадача: ${st.task}${depsContext ? `\nконтекст: ${depsContext}` : ''}`;

      try {
        const result = await executeDelegateAction(chatId, delegateBody, (detail) => {
          if (statusUpdater) {
            const bar = '█'.repeat(totalDone) + '░'.repeat(Math.max(0, subtasks.length - totalDone));
            statusUpdater(`[${bar}] ${totalDone}/${subtasks.length}\n🔄 #${st.id} ${st.role}: ${detail.slice(0, 80)}`);
          }
        });
        return { id: st.id, result };
      } catch (e) {
        return { id: st.id, result: { success: false, output: `Ошибка: ${e.message}` } };
      }
    });

    const batchResults = await Promise.allSettled(promises);

    for (const br of batchResults) {
      const { id, result } = br.status === 'fulfilled' ? br.value : { id: ready[0]?.id, result: { success: false, output: br.reason?.message || 'Error' } };
      results.set(id, result);
      pending.delete(id);
      const st = subtasks.find(s => s.id === id);
      if (st) {
        st.status = result.success ? 'done' : 'error';
        totalDone++;
      }
      if (tracker) tracker.log.push(`${result.success ? '✅' : '❌'} #${id}: завершено`);
    }

    if (statusUpdater) {
      const bar = '█'.repeat(totalDone) + '░'.repeat(Math.max(0, subtasks.length - totalDone));
      statusUpdater(`[${bar}] ${totalDone}/${subtasks.length} подзадач`);
    }
  }

  // Формируем итоговый отчёт
  const report = subtasks.map(st => {
    const r = results.get(st.id);
    const icon = r?.success ? '✅' : '❌';
    return `${icon} #${st.id} ${st.role}: ${st.task.slice(0, 60)}\n   ${(r?.output || 'нет результата').slice(0, 200)}`;
  }).join('\n\n');

  const successCount = [...results.values()].filter(r => r.success).length;

  return {
    success: successCount > 0,
    output: `[AUTOPLAN: ${successCount}/${subtasks.length} успешно]\n🎯 ${plan.goal}\n\n${report}\n[/AUTOPLAN]`,
  };
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
    case 'schedule': return executeScheduleAction(chatId, action.body);
    case 'todo': return executeTodoAction(chatId, action.body);
    case 'search': return executeSearchAction(action.body);
    case 'file': return executeFileAction(chatId, action.body);
    case 'skill': return await executeSkillAction(chatId, action.body);
    case 'delegate': return await executeDelegateAction(chatId, action.body, statusUpdater);
    case 'plan': return await executePlanAction(chatId, action.body, statusUpdater);
    case 'parallel': return await executeParallelAction(chatId, action.body, statusUpdater);
    case 'execute_plan': return await executeAutoplan(chatId, statusUpdater);
    case 'create_agent': return await executeCreateAgentAction(chatId, action.body);
    case 'supervise': return await executeSuperviseAction(chatId);
    case 'think': return { success: true, output: '(размышление завершено)', silent: true };
    case 'image': return await executeImageAction(chatId, action.body);
    case 'video': return await executeVideoAction(chatId, action.body, statusUpdater);
    case 'video_extend': return await executeVideoExtendAction(chatId, action.body, statusUpdater);
    case 'mcp': return await executeMcpAction(chatId, action.body);
    case 'figma': return await executeFigmaAction(chatId, action.body);
    case 'background': return await executeBackgroundAction(chatId, action.body);
    case 'memory': return executeMemoryAction(chatId, action.body);
    default: return { success: false, output: `Неизвестное действие: ${action.name}` };
  }
}

// === Live Status Display ===
function buildStatusMessage(opts) {
  const {
    model, provider, step, maxSteps, startTime, thought,
    actionName, actionDetail, subAgents, phase, error, chatId,
    completedActions = [], complexity = 'medium'
  } = opts;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  const lines = [];

  // Заголовок
  lines.push(`🤖 ${providerLabel} · ${model} | ⏱ ${elapsed}с`);

  // Прогресс с ETA
  const filled = Math.min(step, maxSteps);
  const stepBar = '▓'.repeat(filled) + '░'.repeat(Math.max(0, maxSteps - filled));
  const avgStepTime = step > 0 ? elapsed / step : 0;
  const remainingSteps = Math.max(0, maxSteps - step);
  const etaStr = step > 0 && remainingSteps > 0 ? ` ~${Math.round(avgStepTime * remainingSteps)}с` : '';
  lines.push(`[${stepBar}] ${step}/${maxSteps}${etaStr}`);

  // Фаза
  if (phase) lines.push(`\n${phase}`);

  // Мысли агента
  if (thought) {
    const trimmed = thought.slice(0, 200);
    lines.push(`\n💭 ${trimmed}${thought.length > 200 ? '...' : ''}`);
  }

  // Текущее действие
  if (actionName) {
    const icons = { bash: '⚡', remind: '⏰', file: '📄', skill: '🎯', delegate: '🤝', think: '🧠', search: '🔍', image: '🎨', video: '🎬', schedule: '📅', figma: '🎨', plan: '📋', parallel: '🚀', create_agent: '🤖', supervise: '📊', mcp: '🔗', background: '🔄', memory: '🧠', execute_plan: '📋', Bash: '⚡', Read: '📖', Edit: '✏️', Write: '📝', Glob: '🔍', Grep: '🔎', Task: '🤝', WebFetch: '🌐', WebSearch: '🔍', NotebookEdit: '📓' };
    const icon = icons[actionName] || '🔄';
    lines.push(`\n${icon} ${actionName}`);
    if (actionDetail) lines.push(`   ${actionDetail.slice(0, 150)}`);
  }

  // Таймлайн выполненных действий (последние 3)
  if (completedActions.length > 0) {
    const recent = completedActions.slice(-3);
    lines.push(`\n── 📋 Выполнено ──`);
    for (const ca of recent) {
      const statusIcon = ca.success ? '✅' : '❌';
      const relTime = Math.round((ca.time - startTime) / 1000);
      lines.push(`${statusIcon} ${ca.name}: ${ca.detail} (${relTime}с)`);
    }
  }

  // План задачи
  if (opts.plan) {
    lines.push(`\n── 📋 План ──`);
    lines.push(`🎯 ${opts.plan.goal.slice(0, 60)}`);
    const completed = opts.plan.subtasks.filter(st => st.status === 'done').length;
    const total = opts.plan.subtasks.length;
    const planBar = '▓'.repeat(completed) + '░'.repeat(total - completed);
    lines.push(`[${planBar}] ${completed}/${total}`);
  }

  // Мульти-агентная коммуникация
  if (subAgents && subAgents.length > 0) {
    lines.push(`\n── 👥 Команда агентов ──`);
    const parallelRunning = subAgents.filter(a => a.status === 'running' && a.parallelGroup);
    if (parallelRunning.length > 1) lines.push(`🚀 Параллельно: ${parallelRunning.length} агентов`);
    const running = subAgents.filter(a => a.status === 'running');
    const done = subAgents.filter(a => a.status === 'done');
    const errors = subAgents.filter(a => a.status === 'error');

    for (const sa of subAgents) {
      const effectiveRoles = chatId ? getEffectiveAgents(chatId) : AGENT_ROLES;
      const roleInfo = effectiveRoles[sa.role] || AGENT_ROLES[sa.role] || { icon: '🔄', label: sa.role };
      const dur = sa.endTime ? ` ${Math.round((sa.endTime - sa.startTime) / 1000)}с` : '';

      if (sa.status === 'running') {
        const saElapsed = Math.round((Date.now() - sa.startTime) / 1000);
        lines.push(`⏳ ${roleInfo.icon} ${roleInfo.label} (${saElapsed}с)`);
        lines.push(`   📋 ${sa.task.slice(0, 60)}`);
      } else if (sa.status === 'done') {
        lines.push(`✅ ${roleInfo.icon} ${roleInfo.label}${dur}`);
      } else if (sa.status === 'error') {
        lines.push(`❌ ${roleInfo.icon} ${roleInfo.label}: ошибка`);
      }
    }

    if (running.length > 0 && done.length > 0) {
      const lastDone = done[done.length - 1];
      const doneInfo = (chatId ? getEffectiveAgents(chatId) : AGENT_ROLES)[lastDone.role] || { icon: '🔄', label: lastDone.role };
      const runInfo = (chatId ? getEffectiveAgents(chatId) : AGENT_ROLES)[running[0].role] || { icon: '🔄', label: running[0].role };
      lines.push(`💬 ${doneInfo.icon} → ${runInfo.icon} передача результатов`);
    }
    if (done.length >= 2) {
      lines.push(`🤝 Синтез ${done.length} результатов...`);
    }
    lines.push(`📈 ✅${done.length} ⏳${running.length}${errors.length ? ` ❌${errors.length}` : ''}`);
  }

  // Fallback info
  if (opts.fallbackInfo) lines.push(`\n${opts.fallbackInfo}`);

  // Ошибка
  if (error) lines.push(`\n❌ ${error}`);

  return lines.join('\n');
}


// === Фоновое выполнение задач ===
async function runBackground(chatId, prompt, desc) {
  const userBg = getUserBgTasks(chatId);
  if (userBg.size >= MAX_BG_TASKS_PER_USER) {
    send(chatId, `❌ Лимит фоновых задач (${MAX_BG_TASKS_PER_USER}). Используй /tasks для управления.`);
    return null;
  }

  const taskId = generateTaskId();
  const abort = new AbortController();
  const taskInfo = {
    id: taskId,
    desc: desc || prompt.slice(0, 80),
    prompt,
    startTime: Date.now(),
    abort,
    status: 'running',
  };
  userBg.set(taskId, taskInfo);

  send(chatId, `🔄 Задача запущена в фоне: ${taskInfo.desc}\n🆔 ${taskId}\n\nИспользуй /tasks для просмотра.`);

  // Запускаем задачу асинхронно, не блокируя foreground
  (async () => {
    const uc = getUserConfig(chatId);
    let model = uc.model;
    const startTime = Date.now();
    activeClaudeCount++;

    try {
      const agentEnabled = uc.agentMode !== false;
      const multiAgentEnabled = uc.multiAgent !== false && agentEnabled;
      const basePrompt = agentEnabled ? AGENT_SYSTEM_PROMPT : BOT_SYSTEM_PROMPT;

      let skillsPrompt = '';
      const skills = uc.skills || [];
      if (skills.length > 0) {
        skillsPrompt = '\n\n## Доступные навыки\n';
        skills.forEach((s, i) => {
          skillsPrompt += `${i + 1}. **${s.name}**: ${s.prompt.slice(0, 100)}\n`;
        });
      }

      const memoryPrompt = buildMemoryPrompt(chatId, prompt);
      const modePrompt = uc.activeMode && SPECIALIZED_MODES[uc.activeMode] ? `\n\n## АКТИВНЫЙ РЕЖИМ: ${SPECIALIZED_MODES[uc.activeMode].icon} ${SPECIALIZED_MODES[uc.activeMode].label}\n${SPECIALIZED_MODES[uc.activeMode].prompt}` : '';
      const fullSystemPrompt = [basePrompt, modePrompt, skillsPrompt, uc.language, uc.systemPrompt, memoryPrompt].filter(Boolean).join('\n\n');
      const maxSteps = Math.min(uc.agentMaxSteps || 15, 10);

      const messages = [{ role: 'user', content: prompt }];

      for (let step = 0; step < maxSteps; step++) {
        if (abort.signal.aborted) break;

        const result = await callAIWithFallback(model, normalizeMessages(messages), fullSystemPrompt, chatId, { allowMcp: true });
        if (result.fallbackUsed) model = result.actualModel;
        stats.claudeCalls++;

        const responseText = result.text.trim();
        if (!agentEnabled) {
          taskInfo.result = responseText;
          break;
        }

        const action = parseAction(responseText);
        if (!action) {
          taskInfo.result = responseText;
          break;
        }

        const actionResult = await executeAction(chatId, action);
        messages.push({ role: 'assistant', content: responseText });
        messages.push({ role: 'user', content: `[RESULT: ${action.name}]\n${actionResult.output}\n[/RESULT]` });

        if (step === maxSteps - 1) {
          taskInfo.result = `Выполнено ${maxSteps} шагов. Последний результат: ${actionResult.output.slice(0, 500)}`;
        }
      }

      taskInfo.status = abort.signal.aborted ? 'cancelled' : 'done';
    } catch (e) {
      taskInfo.status = 'error';
      taskInfo.result = `Ошибка: ${e.message}`;
    } finally {
      activeClaudeCount = Math.max(0, activeClaudeCount - 1);
      taskInfo.endTime = Date.now();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (taskInfo.status === 'done') {
        const displayText = cleanMarkdown(taskInfo.result || 'Готово (без вывода)');
        send(chatId, `✅ Фоновая задача завершена (${elapsed}с)\n📋 ${taskInfo.desc}\n\n${displayText}`);
      } else if (taskInfo.status === 'error') {
        send(chatId, `❌ Фоновая задача ошибка (${elapsed}с)\n📋 ${taskInfo.desc}\n\n${taskInfo.result}`);
      }
      // Удаляем через 5 минут
      setTimeout(() => { userBg.delete(taskId); }, 5 * 60 * 1000);
    }
  })();

  return taskId;
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

  // Контекстное раскрытие запроса (короткие/неоднозначные → полные)
  const queryRewrite = rewriteQuery(chatId, prompt);
  if (queryRewrite.rewritten) {
    prompt = queryRewrite.text;
  }

  let autoReason = '';
  let autoCategory = null;
  if (uc.autoModel && !manualModel) {
    // Для autoSelect используем оригинальный текст + контекстный тип
    const autoText = queryRewrite.rewritten ? queryRewrite.original : prompt;
    const auto = autoSelectModel(autoText, uc.autoModelMap || {}, chatHistory.get(chatId) || []);
    autoCategory = auto.category;
    // Перехват мультимодальных запросов — image/video
    if (auto.isImage && getGeminiKey(chatId)) {
      const { prompt: imgPrompt, negativePrompt: imgNeg } = parseNegativePrompt(prompt);
      const imgOpts = {};
      if (imgNeg) imgOpts.negativePrompt = imgNeg;
      const statusMsg = await send(chatId, `🎨 ${auto.reason} — генерирую...`);
      const statusMsgId = statusMsg?.result?.message_id;
      try {
        const results = await generateImage(chatId, imgPrompt, imgOpts);
        if (statusMsgId) editText(chatId, statusMsgId, '✅ Изображение готово');
        for (const r of results) {
          if (r.type === 'image') { await sendPhoto(chatId, r.path, imgPrompt.slice(0, 200)); try { fs.unlinkSync(r.path); } catch(e) {} }
          else if (r.type === 'text' && r.text) send(chatId, r.text);
        }
      } catch (e) { if (statusMsgId) editText(chatId, statusMsgId, `❌ ${e.message}`); else send(chatId, `❌ ${e.message}`); }
      return;
    }
    if (auto.isVideo && getGeminiKey(chatId)) {
      const { prompt: vidPrompt, negativePrompt: vidNeg } = parseNegativePrompt(prompt);
      const statusMsg = await send(chatId, `🎬 ${auto.reason} — генерирую...`);
      const statusMsgId = statusMsg?.result?.message_id;
      const startTime2 = Date.now();
      try {
        const vidOpts2 = {
          onProgress: (poll) => { const elapsed = Math.round((Date.now() - startTime2) / 1000); if (statusMsgId) editText(chatId, statusMsgId, `🎬 Генерация видео... ⏱ ${elapsed}с`); }
        };
        if (vidNeg) vidOpts2.negativePrompt = vidNeg;
        const result = await generateVideo(chatId, vidPrompt, vidOpts2);
        if (statusMsgId) editText(chatId, statusMsgId, '✅ Видео готово');
        await sendVideo(chatId, result.path, vidPrompt.slice(0, 200));
        try { fs.unlinkSync(result.path); } catch(e) {}
      } catch (e) { if (statusMsgId) editText(chatId, statusMsgId, `❌ ${e.message}`); else send(chatId, `❌ ${e.message}`); }
      return;
    }
    const selectedProvider = getProvider(auto.model);
    const providerAvailable = selectedProvider === 'anthropic' ||
      (selectedProvider === 'google' && (getGeminiKey(chatId))) ||
      (selectedProvider === 'groq' && ((uc.apiKeys?.groq) || process.env.GROQ_API_KEY)) ||
      (selectedProvider === 'openai' && ((uc.apiKeys?.openai) || process.env.OPENAI_API_KEY));
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
  activeClaudeCount++; // Атомарный инкремент сразу после проверки, ДО любых await

  addToHistory(chatId, 'user', queryRewrite.rewritten ? queryRewrite.original : prompt);

  const history = chatHistory.get(chatId) || [];
  const messages = [];
  for (let i = 0; i < history.length - 1; i++) {
    messages.push({ role: history[i].role, content: history[i].text });
  }
  messages.push({ role: 'user', content: prompt });

  const queueLen = getQueueSize(chatId);
  const queueInfo = queueLen > 0 ? ` | 📬 ${queueLen} в очереди` : '';
  let provider = getProvider(model);
  let providerLabel = PROVIDER_LABELS[provider] || provider;
  const autoTag = autoReason ? ` [${autoReason}]` : '';
  const res = await send(chatId, `🚀 ${providerLabel} ${model}${autoTag}...${queueInfo}`);
  const statusMsgId = res?.result?.message_id;

  const startTime = Date.now();
  if (process.env.BOT_DEBUG) console.log(`🔧 ${model} (${provider}) — ${prompt.length} символов`);
  activeTasks.set(chatId, { timer: null, msgId: statusMsgId, _startTime: Date.now() });

  const agentEnabled = uc.agentMode !== false;
  const multiAgentEnabled = uc.multiAgent !== false && agentEnabled;
  const basePrompt = agentEnabled ? AGENT_SYSTEM_PROMPT : BOT_SYSTEM_PROMPT;

  let skillsPrompt = '';
  const skills = uc.skills || [];
  if (skills.length > 0) {
    skillsPrompt = '\n\n## Доступные навыки пользователя\nКогда задача совпадает с навыком — используй [ACTION: skill] для его вызова.\n';

    // Группировка по категориям
    const grouped = {};
    for (const s of skills) {
      const cat = s.category || 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(s);
    }
    for (const cat of SKILL_CATEGORIES) {
      const catSkills = grouped[cat.id];
      if (!catSkills || catSkills.length === 0) continue;
      skillsPrompt += `\n### ${cat.label}\n`;
      catSkills.forEach(s => {
        const desc = s.description ? ` — ${s.description}` : '';
        skillsPrompt += `- **${s.name}**${desc}: ${s.prompt.slice(0, 120)}\n`;
      });
    }
    skillsPrompt += '\nДля вызова используй:\n[ACTION: skill]\nимя_навыка\nдополнительный контекст\n[/ACTION]';

    // Auto-matching: рекомендуем навык если запрос совпадает
    const queryLower = prompt.toLowerCase();
    const matchedSkill = skills.find(s => {
      const nameMatch = queryLower.includes(s.name.toLowerCase());
      const descWords = (s.description || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const descMatch = descWords.some(w => queryLower.includes(w));
      const promptWords = s.prompt.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 5);
      const promptMatch = promptWords.filter(w => queryLower.includes(w)).length >= 2;
      return nameMatch || descMatch || promptMatch;
    });
    if (matchedSkill) {
      skillsPrompt += `\n\n💡 Рекомендация: навык **${matchedSkill.name}** подходит для этого запроса. Используй [ACTION: skill] с "${matchedSkill.name}".`;
    }
  }

  // Если мульти-агент отключён — убираем delegate из промпта
  let effectiveBasePrompt = basePrompt;
  if (!multiAgentEnabled && agentEnabled) {
    effectiveBasePrompt = basePrompt.replace(/\[ACTION: delegate\][\s\S]*?\[\/ACTION\]\n?/, '').replace(/5\. \*\*delegate\*\*[^\n]*\n?/, '').replace(/6\. \*\*think\*\*/, '5. **think**').replace(/## Роли субагентов[\s\S]*?(?=## Среда)/, '');
  }

  // Динамическая инъекция кастомных ролей в промпт
  if (multiAgentEnabled && agentEnabled) {
    const customEnabled = (uc.customAgents || []).filter(a => a.enabled !== false);
    if (customEnabled.length > 0) {
      let customRolesText = '\n\n## Пользовательские субагенты (для delegate)\n';
      for (const ca of customEnabled) {
        customRolesText += `- **${ca.id}** — ${ca.icon || '🤖'} ${ca.desc || ca.label}\n`;
      }
      effectiveBasePrompt = effectiveBasePrompt.replace(/(## Среда выполнения)/, customRolesText + '\n$1');
    }
  }

  // Инъекция MCP-инструментов в промпт
  const mcpToolsPrompt = getMcpToolsForPrompt(chatId);
  if (mcpToolsPrompt) {
    effectiveBasePrompt += mcpToolsPrompt;
  }

  const memoryPrompt = buildMemoryPrompt(chatId, prompt);
  const modePrompt = uc.activeMode && SPECIALIZED_MODES[uc.activeMode] ? `\n\n## АКТИВНЫЙ РЕЖИМ: ${SPECIALIZED_MODES[uc.activeMode].icon} ${SPECIALIZED_MODES[uc.activeMode].label}\n${SPECIALIZED_MODES[uc.activeMode].prompt}` : '';
  const fullSystemPrompt = [effectiveBasePrompt, modePrompt, skillsPrompt, uc.language, uc.systemPrompt, memoryPrompt].filter(Boolean).join('\n\n');
  const estimated = estimateComplexity(prompt, agentEnabled, multiAgentEnabled, chatId);
  const maxSteps = Math.min(uc.agentMaxSteps || 15, estimated.maxSteps);

  // Инициализируем трекер мульти-агента
  const tracker = { orchestratorMsgId: statusMsgId, agents: [], log: [], startTime };
  multiAgentTasks.set(chatId, tracker);

  // Состояние для live display
  const statusState = { model, provider, step: 0, maxSteps, startTime, thought: null, actionName: null, actionDetail: null, subAgents: tracker.agents, plan: tracker?.plan, phase: '🔄 Запуск...', error: null, fallbackInfo: null, chatId, completedActions: [], complexity: estimated.complexity };

    // Fallback callback для автоматического переключения модели
    const fallbackOpts = {
      allowMcp: true,
      onFallback: (failedModel, nextModel, reason) => {
        const shortReason = reason.slice(0, 60);
        updateStatus({ phase: `🔄 ${failedModel} → ${nextModel}...`, fallbackInfo: `⚠️ ${failedModel}: ${shortReason}` });
        tracker.log.push(`⚠️ ${failedModel} → ${nextModel}: ${shortReason}`);
        console.log(`🔄 Agent fallback: ${failedModel} → ${nextModel}`);
      }
    };

  let lastStatusUpdate = 0;
  const THROTTLE_NORMAL = 400;
  const THROTTLE_IMPORTANT = 50;
  const updateStatus = (overrides = {}) => {
    const now = Date.now();
    const isImportant = overrides.error !== undefined ||
      (overrides.phase && /самокоррекция|субагент|ошибка|завершен|fallback|→/i.test(overrides.phase)) ||
      overrides.actionName === 'delegate';
    const throttle = isImportant ? THROTTLE_IMPORTANT : THROTTLE_NORMAL;
    if (now - lastStatusUpdate < throttle) return;
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
    let lastActionResult = null; // трекаем последний результат действия
    const actionRetries = new Map();
    const MAX_RETRIES_PER_ACTION = 2;
    const MAX_TOTAL_RETRIES = 4;
    let totalRetries = 0;

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
        const currentProvider = () => getProvider(model);

        // Трекинг инструментов Claude CLI
        const cliToolActions = [];
        let cliCurrentTool = null;
        let cliThinking = null;

        const onChunk = (partial) => {
          if (currentProvider() === 'anthropic' && agentEnabled) return;
          const now = Date.now();
          if (now - lastEditTime < 500) return;
          lastEditTime = now;
          if (!agentEnabled && statusMsgId) {
            const elapsed = Math.round((now - startTime) / 1000);
            const header = `🤖 ${providerLabel} ${model} | ⏱ ${elapsed}с\n\n`;
            const maxLen = 4000 - header.length;
            const preview = partial.length > maxLen ? '…' + partial.slice(-(maxLen - 1)) : partial;
            editText(chatId, statusMsgId, header + preview + '▍');
          } else {
            const expectedLen = (() => {
              if (model.includes('haiku') || model.includes('8b') || model.includes('gemma')) return 600;
              if (model.includes('flash') || model.includes('mini')) return 1000;
              if (model.includes('opus') || model.includes('pro')) return 3000;
              return 2000;
            })();
            const pct = Math.min(Math.round((partial.length / expectedLen) * 95), 95);
            const filled = Math.round(pct / 5);
            const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
            const lenStr = partial.length > 100 ? ` (${(partial.length / 1000).toFixed(1)}k)` : '';
            updateStatus({ phase: `⏳ ${bar} ${pct}%${lenStr}` });
          }
        };

        // Обработчик stream-json событий от Claude CLI
        const onEvent = (event) => {
          try {
            if (event.type === 'system' && event.subtype === 'init') {
              const toolCount = event.tools?.length || 0;
              updateStatus({ phase: `🚀 Инициализация (${toolCount} инструментов)` });
            } else if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'thinking' || (block.type === 'text' && !cliCurrentTool)) {
                  const excerpt = (block.thinking || block.text || '').slice(0, 200);
                  if (excerpt.trim()) {
                    cliThinking = excerpt;
                    updateStatus({ thought: cliThinking, phase: '💭 Размышляю...' });
                  }
                } else if (block.type === 'tool_use') {
                  cliCurrentTool = { name: block.name, input: block.input, startTime: Date.now() };
                  const detail = formatToolDetail(block.name, block.input);
                  const toolIcons = { Bash: '⚡', Read: '📖', Edit: '✏️', Write: '📝', Glob: '🔍', Grep: '🔎', Task: '🤝', WebFetch: '🌐', WebSearch: '🔍', NotebookEdit: '📓' };
                  const iconKey = Object.keys(toolIcons).find(k => block.name.startsWith(k));
                  const icon = (iconKey && toolIcons[iconKey]) || '🔧';
                  updateStatus({ actionName: block.name, actionDetail: detail, phase: `${icon} ${block.name}`, thought: cliThinking });
                }
              }
            } else if (event.type === 'result') {
              const cost = event.cost_usd ? `$${event.cost_usd.toFixed(4)}` : '';
              const dur = event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}с` : '';
              const turns = event.num_turns || 0;
              updateStatus({ phase: `✅ Готово | ${turns} ходов | ${dur} | ${cost}`, actionName: null, actionDetail: null });
            } else if (event.type === 'user' || event.type === 'tool_result') {
              if (cliCurrentTool) {
                const elapsed = Math.round((Date.now() - cliCurrentTool.startTime) / 1000);
                cliToolActions.push({ name: cliCurrentTool.name, detail: formatToolDetail(cliCurrentTool.name, cliCurrentTool.input).slice(0, 60), success: !event.is_error, time: Date.now() });
                statusState.completedActions = cliToolActions.slice(-5);
                cliCurrentTool = null;
                updateStatus({ actionName: null, actionDetail: null, phase: `🔄 Обработка... (${cliToolActions.length} инструментов)` });
              }
            }
          } catch (e) { console.error(`[stream-json] parse error:`, e.message); }
        };

        result = await callAIStreamWithFallback(model, normalizeMessages(messages), fullSystemPrompt, onChunk, chatId, { ...fallbackOpts, onEvent });
      } else {
        let dots = 0;
        const frames = ['🔄', '⏳', '🤖', '💭'];
        const timer = setInterval(() => {
          dots++;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const frame = frames[dots % frames.length];
          updateStatus({ phase: `${frame} Генерация... ${elapsed}с` });
        }, 1200);
        const task = activeTasks.get(chatId);
        if (task) task.timer = timer;
        try {
          result = await callAIWithFallback(model, normalizeMessages(messages), fullSystemPrompt, chatId, fallbackOpts);
        } finally {
          clearInterval(timer);
        }
      }

      // Обновить модель при fallback
      if (result.fallbackUsed) {
        model = result.actualModel;
        provider = result.provider;
        providerLabel = PROVIDER_LABELS[provider] || provider;
        statusState.model = model;
        statusState.provider = provider;
        tracker.log.push(`🔄 Переключено на ${model}`);
      }

      stats.claudeCalls++;
      stats.totalResponseTime += result.ms;

      // Трекинг производительности модели
      const effectiveModel = result.actualModel || model;
      if (!uc.modelStats) uc.modelStats = {};
      if (!uc.modelStats[effectiveModel]) uc.modelStats[effectiveModel] = { calls: 0, errors: 0, totalMs: 0 };
      uc.modelStats[effectiveModel].calls++;
      uc.modelStats[effectiveModel].totalMs += result.ms || 0;
      if (uc.modelStats[effectiveModel].calls % 5 === 0) saveUserConfig(chatId);

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

      // Обработка ошибок валидации формата
      if (action.validationError) {
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: `[FORMAT_ERROR]\nБлок [ACTION: ${action.name}] имеет неверный формат: ${action.validationError}. Исправь формат и повтори действие.\n[/FORMAT_ERROR]`
        });
        continue;
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
               action.name === 'skill' ? '🎯 Выполняю навык...' :
               action.name === 'background' ? '🔄 Запускаю в фоне...' :
               action.name === 'memory' ? '🧠 Управление памятью...' :
               action.name === 'execute_plan' ? '📋 Автовыполнение плана...' :
               `🔄 ${action.name}...`
      });

      // Функция обновления статуса для субагентов
      const subStatusUpdater = (detail) => {
        updateStatus({ actionDetail: detail, phase: '🤝 Субагент работает...' });
      };

      const actionResult = await executeAction(chatId, action, subStatusUpdater);
      if (!actionResult.silent) lastActionResult = { name: action.name, ...actionResult };

      console.log(`🤖 Agent step ${step}: [${action.name}] → ${actionResult.success ? 'OK' : 'FAIL'} (${actionResult.output.slice(0, 100)})`);

      // Трекинг выполненных действий для таймлайна
      statusState.completedActions.push({
        name: action.name,
        detail: action.body.split('\n')[0].slice(0, 60),
        success: actionResult.success,
        time: Date.now()
      });

      // Умная самокоррекция: per-action retry + error-type-aware guidance
      if (!actionResult.success) {
        const actionTypeRetries = actionRetries.get(action.name) || 0;
        const canRetryAction = actionTypeRetries < MAX_RETRIES_PER_ACTION;
        const canRetryTotal = totalRetries < MAX_TOTAL_RETRIES;

        if (canRetryAction && canRetryTotal) {
          actionRetries.set(action.name, actionTypeRetries + 1);
          totalRetries++;
          updateStatus({
            phase: `🔧 Самокоррекция [${action.name}] (${actionTypeRetries + 1}/${MAX_RETRIES_PER_ACTION})...`,
            error: actionResult.output.slice(0, 100)
          });
          tracker.log.push(`🔧 Retry ${action.name}: ${actionResult.output.slice(0, 80)}`);

          const errorGuidance = getRetryGuidance(action.name, actionResult.output);
          messages.push({ role: 'assistant', content: responseText });
          messages.push({
            role: 'user',
            content: `[ERROR: ${action.name}]\n${actionResult.output}\n[/ERROR]\n\n${errorGuidance}`
          });
          continue;
        }

        // Исчерпаны попытки для этого типа — предложить альтернативу
        if (!canRetryAction && canRetryTotal) {
          totalRetries++;
          updateStatus({
            phase: `🔄 Ищу альтернативный подход...`,
            error: `${action.name}: исчерпаны попытки`
          });
          tracker.log.push(`🔄 ${action.name}: смена стратегии`);
          messages.push({ role: 'assistant', content: responseText });
          messages.push({
            role: 'user',
            content: `[ERROR: ${action.name}]\n${actionResult.output}\n[/ERROR]\n\nДействие "${action.name}" не работает после ${MAX_RETRIES_PER_ACTION} попыток. Используй ДРУГОЙ тип действия для решения задачи. Например: если bash не работает — попробуй delegate, или используй другую команду. Если image не работает — создай визуал через bash.`
          });
          continue;
        }

        updateStatus({ error: actionResult.output.slice(0, 100) });
      } else {
        updateStatus({ error: null });
      }

      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content: `[RESULT: ${action.name}]\n${actionResult.output}\n[/RESULT]`
      });
    }

    // === Финальный вывод ===
    let displayText = cleanMarkdown(finalText);
    // Если текст пустой после очистки — показываем результат последнего действия
    if (!displayText && lastActionResult && lastActionResult.output) {
      displayText = lastActionResult.output.slice(0, 4000);
    }
    if (!displayText) displayText = 'Готово (без вывода)';
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (process.env.BOT_DEBUG) console.log(`📋 ${model}: ${displayText.length}б, ${elapsed}с`);

    addToHistory(chatId, 'assistant', displayText);
    lastResponse.set(chatId, { text: displayText, prompt });

    // Асинхронное извлечение фактов для памяти (не блокируем ответ)
    const cleanUserText = queryRewrite.rewritten ? queryRewrite.original : text;
    extractMemoryFacts(chatId, cleanUserText, displayText).catch(e => console.error(`[${chatId}] Memory extract:`, e.message));

    // Трекинг успешности модели для категории (самообучение)
    if (autoReason && autoCategory) {
      trackCategorySuccess(chatId, autoCategory, model, Date.now() - startTime, true);
    }

    // Удаляем статусное сообщение перед отправкой ответа
    if (statusMsgId) {
      del(chatId, statusMsgId);
    }

    send(chatId, displayText);

    if (step >= maxSteps && parseAction(finalText)) {
      send(chatId, `⚠️ Достигнут лимит шагов (${maxSteps}). Задача может быть не завершена.`);
    }

  } catch (e) {
    stats.errors++;
    // Трекинг ошибок модели в modelStats
    if (!uc.modelStats) uc.modelStats = {};
    if (!uc.modelStats[model]) uc.modelStats[model] = { calls: 0, errors: 0, totalMs: 0 };
    uc.modelStats[model].errors++;
    // Трекинг неудачи категории
    if (autoReason && autoCategory) {
      trackCategorySuccess(chatId, autoCategory, model, Date.now() - startTime, false);
    }
    saveUserConfig(chatId);
    console.error(`❌ [chatId:${chatId}] ${model} error: ${e.message}`);
    if (statusMsgId) del(chatId, statusMsgId);
    send(chatId, `❌ Ошибка ${model}: ${e.message}`);
  } finally {
    activeClaudeCount = Math.max(0, activeClaudeCount - 1);
    activeTasks.delete(chatId);
    multiAgentTasks.delete(chatId);
    sessionAgents.delete(chatId);
    processQueue(chatId);
  }
}

// === Polling (Long Polling + async) ===
let stopPolling = false;

async function processUpdate(upd) {
  if (upd.callback_query) {
    const cbChatId = upd.callback_query?.message?.chat?.id;
    if (cbChatId && isRateLimited(cbChatId)) {
      tgApi('answerCallbackQuery', { callback_query_id: upd.callback_query.id }).catch(() => {});
      return;
    }
    handleCallback(upd.callback_query).catch(e => console.error(`[chatId:${cbChatId}] CB ERR:`, e.message));
    return;
  }

  const msg = upd.message;
  if (!msg) return;

  const chatId = msg.chat.id;

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
    try {
      const result = await nbClient.call('notebook_create', { title: text });
      const nb = result.notebook || result;
      send(chatId, `📓 Создан: ${nb.title || text}\nID: ${nb.id || nb.notebook_id || '?'}`, nbMainMenu);
    } catch(e) { send(chatId, `❌ ${e.message}`, nbMainMenu); }
    return;
  }
  if (waitingNbQuery.has(chatId)) {
    const nbId = waitingNbQuery.get(chatId);
    waitingNbQuery.delete(chatId);
    send(chatId, '🔍 Ищу ответ...');
    try {
      const result = await nbClient.call('notebook_query', { notebook_id: nbId, query: text }, 180000);
      const answer = result.answer || result.response || result.text || JSON.stringify(result);
      const reply = typeof answer === 'string' ? answer : JSON.stringify(answer);
      send(chatId, `💡 ${reply.slice(0, 4000)}`, nbDetailMenu(nbId));
    } catch(e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbUrl.has(chatId)) {
    const nbId = waitingNbUrl.get(chatId);
    waitingNbUrl.delete(chatId);
    send(chatId, '🔗 Добавляю URL...');
    try {
      await nbClient.call('notebook_add_url', { notebook_id: nbId, url: text.trim() });
      send(chatId, `🔗 URL добавлен: ${text.trim()}`, nbDetailMenu(nbId));
    } catch(e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbText.has(chatId)) {
    const nbId = waitingNbText.get(chatId);
    waitingNbText.delete(chatId);
    send(chatId, '📝 Добавляю текст...');
    try {
      await nbClient.call('notebook_add_text', { notebook_id: nbId, text, title: `Текст ${new Date().toLocaleDateString('ru')}` });
      send(chatId, '📝 Текст добавлен как источник', nbDetailMenu(nbId));
    } catch(e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbRename.has(chatId)) {
    const nbId = waitingNbRename.get(chatId);
    waitingNbRename.delete(chatId);
    try {
      await nbClient.call('notebook_rename', { notebook_id: nbId, new_title: text });
      send(chatId, `✏️ Переименован: ${text}`, nbDetailMenu(nbId));
    } catch(e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbResearch.has(chatId)) {
    waitingNbResearch.delete(chatId);
    send(chatId, '🔍 Запускаю исследование...\n⏳ Быстрый режим ~30с');
    try {
      const startResult = await nbClient.call('research_start', { query: text, source: 'web', mode: 'fast' }, 60000);
      const nbId = startResult.notebook_id || startResult.data?.notebook_id;
      const taskId = startResult.task_id || startResult.data?.task_id;
      if (!nbId) { send(chatId, `🔍 Исследование запущено:\n${JSON.stringify(startResult).slice(0, 2000)}`, nbMainMenu); return; }
      // Поллинг
      send(chatId, `⏳ Поллинг результатов... (блокнот: ${nbId})`);
      const status = await nbClient.call('research_status', { notebook_id: nbId, task_id: taskId || undefined, poll_interval: 10, max_wait: 120 }, 150000);
      const sources = status.sources || status.data?.sources || [];
      let resultText = `🔍 Исследование: "${text}"\n📓 Блокнот: ${nbId}\n📚 Найдено источников: ${sources.length}`;
      if (sources.length > 0) {
        resultText += '\n\n' + sources.slice(0, 10).map((s, i) => `${i + 1}. ${s.title || s.url || 'Источник'}`).join('\n');
      }
      // Импортируем источники
      if (taskId && sources.length > 0) {
        try {
          await nbClient.call('research_import', { notebook_id: nbId, task_id: taskId });
          resultText += '\n\n✅ Источники импортированы';
        } catch(impErr) { resultText += `\n\n⚠️ Импорт: ${impErr.message}`; }
      }
      send(chatId, resultText, nbMainMenu);
    } catch(e) { send(chatId, `❌ ${e.message}`, nbMainMenu); }
    return;
  }
  if (waitingNbReportCustom.has(chatId)) {
    const nbId = waitingNbReportCustom.get(chatId);
    waitingNbReportCustom.delete(chatId);
    const statusMsg = await send(chatId, '🎨 Генерирую отчёт...');
    const statusMsgId = statusMsg?.result?.message_id || null;
    nbDirectGenerate(chatId, statusMsgId, nbId, 'report_create', { report_format: 'Create Your Own', custom_prompt: text, language: 'ru', confirm: true }, '🎨', 'Отчёт');
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
    if (!config.channels[idx]) { send(chatId, '❌ Канал был удалён'); return; }
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
    if (!config.channels[idx]) { send(chatId, '❌ Канал был удалён'); return; }
    if (text.toLowerCase() === 'clear') { config.channels[idx].keywords = []; }
    else { config.channels[idx].keywords = text.split(',').map(k => k.trim()).filter(k => k); }
    saveConfig();
    send(chatId, `✅ Ключевые слова для @${config.channels[idx].username}: ${config.channels[idx].keywords.length ? config.channels[idx].keywords.join(', ') : 'нет (все)'}`, channelsMenu());
    return;
  }

  // === Ожидание ввода для агентов ===
  if (waitingAgentEditName.has(chatId)) {
    const idx = waitingAgentEditName.get(chatId);
    waitingAgentEditName.delete(chatId);
    if (uc.customAgents && uc.customAgents[idx]) {
      uc.customAgents[idx].label = text.trim();
      saveUserConfig(chatId);
      send(chatId, `✅ Имя агента обновлено: ${text.trim()}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агенту', callback_data: `agent_info_${idx}` }]] } });
    } else {
      send(chatId, '❌ Агент не найден (возможно удалён)');
    }
    return;
  }
  if (waitingAgentEditPrompt.has(chatId)) {
    const idx = waitingAgentEditPrompt.get(chatId);
    waitingAgentEditPrompt.delete(chatId);
    if (uc.customAgents && uc.customAgents[idx]) {
      uc.customAgents[idx].prompt = text;
      saveUserConfig(chatId);
      send(chatId, `✅ Промпт "${uc.customAgents[idx].label}" обновлён (${text.length} символов)`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агенту', callback_data: `agent_info_${idx}` }]] } });
    } else {
      send(chatId, '❌ Агент не найден (возможно удалён)');
    }
    return;
  }
  if (waitingAgentEditDesc.has(chatId)) {
    const idx = waitingAgentEditDesc.get(chatId);
    waitingAgentEditDesc.delete(chatId);
    if (uc.customAgents && uc.customAgents[idx]) {
      uc.customAgents[idx].desc = text.trim();
      saveUserConfig(chatId);
      send(chatId, `✅ Описание "${uc.customAgents[idx].label}" обновлено`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К агенту', callback_data: `agent_info_${idx}` }]] } });
    } else {
      send(chatId, '❌ Агент не найден (возможно удалён)');
    }
    return;
  }
  if (waitingAgentIcon.has(chatId)) {
    const agentData = waitingAgentIcon.get(chatId);
    waitingAgentIcon.delete(chatId);
    agentData.icon = text.trim().slice(0, 2);
    waitingAgentDesc.set(chatId, agentData);
    setWaitingTimeout(chatId, waitingAgentDesc, 'waitingAgentDesc');
    send(chatId, `${agentData.icon} Иконка: ${agentData.icon}\n\n📝 Введите описание агента (кратко, 1-2 предложения):`, { reply_markup: { inline_keyboard: [[{ text: '⏩ Пропустить', callback_data: 'agent_wizard_skip_desc' }]] } });
    return;
  }
  if (waitingAgentDesc.has(chatId)) {
    const agentData = waitingAgentDesc.get(chatId);
    waitingAgentDesc.delete(chatId);
    agentData.desc = text.trim();
    waitingAgentPrompt.set(chatId, agentData);
    setWaitingTimeout(chatId, waitingAgentPrompt, 'waitingAgentPrompt');
    send(chatId, `${agentData.icon} ${agentData.label}\n📝 ${agentData.desc}\n\n📄 Введите системный промпт для агента:\nИли отправьте .txt файл`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'agents_menu' }]] } });
    return;
  }
  if (waitingAgentName.has(chatId)) {
    waitingAgentName.delete(chatId);
    const label = text.trim();
    const id = label.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '_').replace(/_{2,}/g, '_').slice(0, 30);
    const exists = (uc.customAgents || []).find(a => a.id === id);
    if (exists) { send(chatId, `❌ Агент с ID "${id}" уже существует. Попробуйте другое имя.`); return; }
    const agentData = { id, label, icon: '🤖' };
    const iconRows = [
      [{ text: '🤖', callback_data: 'agicon_🤖' }, { text: '🧠', callback_data: 'agicon_🧠' }, { text: '⚙️', callback_data: 'agicon_⚙️' }, { text: '🛠', callback_data: 'agicon_🛠' }],
      [{ text: '🎯', callback_data: 'agicon_🎯' }, { text: '📊', callback_data: 'agicon_📊' }, { text: '🔬', callback_data: 'agicon_🔬' }, { text: '💡', callback_data: 'agicon_💡' }],
      [{ text: '🐍', callback_data: 'agicon_🐍' }, { text: '🌐', callback_data: 'agicon_🌐' }, { text: '🔒', callback_data: 'agicon_🔒' }, { text: '📝', callback_data: 'agicon_📝' }],
      [{ text: '⏩ Пропустить (🤖)', callback_data: 'agicon_skip' }],
    ];
    waitingAgentIcon.set(chatId, agentData);
    setWaitingTimeout(chatId, waitingAgentIcon, 'waitingAgentIcon');
    send(chatId, `👤 Имя: ${label}\n\n🎨 Выберите иконку или отправьте эмодзи:`, { reply_markup: { inline_keyboard: iconRows } });
    return;
  }
  if (waitingAgentPrompt.has(chatId)) {
    const agentData = waitingAgentPrompt.get(chatId);
    waitingAgentPrompt.delete(chatId);
    if (!uc.customAgents) uc.customAgents = [];
    uc.customAgents.push({ id: agentData.id, icon: agentData.icon || '🤖', label: agentData.label, desc: agentData.desc || '', prompt: text, maxSteps: 3, model: '', enabled: true, uses: 0, lastUsed: null });
    saveUserConfig(chatId);
    send(chatId, `✅ Агент "${agentData.label}" создан!\n\n${agentData.icon} ${agentData.label}\n📝 ${agentData.desc || 'Без описания'}\n📄 Промпт: ${text.length} символов`, { reply_markup: { inline_keyboard: [[{ text: '👥 К агентам', callback_data: 'agents_menu' }, { text: '▶️ Тест', callback_data: `agent_test_${uc.customAgents.length - 1}` }]] } });
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
    setWaitingTimeout(chatId, waitingSkillCategory, 'waitingSkillCategory');
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


  // === Минимальные команды ===
  if (text === '/start') { send(chatId, 'AI-ассистент готов. Просто напишите что нужно.', mainMenu(chatId)); return; }
  if (text === '/stop') { stopTask(chatId); send(chatId, '⛔ Остановлено'); return; }
  if (text === '/settings') { send(chatId, '⚙️ Настройки', settingsMenu(chatId)); return; }
  if (text === '/mode' || text === '/modes') {
    const currentMode = uc.activeMode ? SPECIALIZED_MODES[uc.activeMode] : null;
    const statusText = currentMode
      ? `🎭 Активный режим: ${currentMode.icon} ${currentMode.label}\n📝 ${currentMode.desc}`
      : '🎭 Режим не выбран\n\nВыберите специализированный режим:';
    const rows = MODE_CATEGORIES.map(cat => {
      const count = SPECIALIZED_MODES_LIST.filter(m => m.category === cat.id).length;
      return [{ text: `${cat.label} (${count})`, callback_data: `modes_cat_${cat.id}` }];
    });
    if (uc.activeMode) rows.push([{ text: '❌ Выключить режим', callback_data: 'mode_off' }]);
    rows.push([{ text: '◀️ Главное меню', callback_data: 'main' }]);
    send(chatId, statusText, { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (text.startsWith('/mode ')) {
    const arg = text.slice(6).trim().toLowerCase();
    if (arg === 'off' || arg === 'reset' || arg === 'выкл') {
      const prev = uc.activeMode ? SPECIALIZED_MODES[uc.activeMode] : null;
      uc.activeMode = null;
      saveUserConfig(chatId);
      send(chatId, `❌ Режим выключен${prev ? ` (был: ${prev.icon} ${prev.label})` : ''}`);
      return;
    }
    // Поиск режима по id или label
    const found = SPECIALIZED_MODES[arg] || SPECIALIZED_MODES_LIST.find(m => m.label.toLowerCase().includes(arg) || m.id.includes(arg));
    if (found) {
      uc.activeMode = found.id;
      saveUserConfig(chatId);
      send(chatId, `✅ Режим: ${found.icon} ${found.label}\n📝 ${found.desc}\n\nДля выключения: /mode off`);
    } else {
      const list = SPECIALIZED_MODES_LIST.map(m => `${m.icon} ${m.id} — ${m.label}`).join('\n');
      send(chatId, `⚠️ Режим "${arg}" не найден.\n\nДоступные режимы:\n${list}\n\nИспользование: /mode <id> или /mode off`);
    }
    return;
  }
  if (text === '/clear') { clearHistory(chatId); messageQueue.delete(chatId); send(chatId, '🗑 История очищена'); return; }
  if (text === '/office') {
    if (MINIAPP_URL) {
      send(chatId, '🎮 Pixel Office', { reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть Pixel Office', web_app: { url: MINIAPP_URL } }], [{ text: '◀️ Назад', callback_data: 'back' }]] } });
    } else {
      send(chatId, '⚠️ Mini App не настроен');
    }
    return;
  }
  if (text === '/tasks') {
    const userBg = getUserBgTasks(chatId);
    const fgTask = activeTasks.has(chatId);
    if (userBg.size === 0 && !fgTask) {
      send(chatId, '📋 Нет активных задач');
      return;
    }
    let msg = '📋 Активные задачи\n\n';
    if (fgTask) msg += '🔵 Foreground: выполняется\n\n';
    if (userBg.size > 0) {
      msg += `🔄 Фоновые (${userBg.size}/${MAX_BG_TASKS_PER_USER}):\n`;
      const rows = [];
      for (const [tid, t] of userBg) {
        const elapsed = Math.round((Date.now() - t.startTime) / 1000);
        const statusIcon = t.status === 'running' ? '⏳' : t.status === 'done' ? '✅' : '❌';
        msg += `${statusIcon} ${t.desc} (${elapsed}с)\n`;
        if (t.status === 'running') rows.push([{ text: `❌ Отменить: ${t.desc.slice(0, 20)}`, callback_data: `bg_cancel_${tid}` }]);
      }
      rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
      send(chatId, msg, { reply_markup: { inline_keyboard: rows } });
    } else {
      send(chatId, msg);
    }
    return;
  }


  // === Ввод MCP URL ===
  if (waitingMcpUrl.has(chatId)) {
    waitingMcpUrl.delete(chatId);
    const url = text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      send(chatId, '❌ URL должен начинаться с http:// или https://', persistentKeyboard);
      return;
    }
    // Ask for optional API key
    clearAllWaiting(chatId);
    const name = url.replace(/^https?:\/\//, '').split('/')[0].split('.')[0] || 'mcp';
    waitingMcpKey.set(chatId, { url, name });
    send(chatId, `🔗 Сервер: ${url}\n\n🔑 Отправьте API-ключ (если требуется) или отправьте «нет» для подключения без ключа:\n\n💡 Форматы:\n• Просто ключ → Bearer авторизация\n• \`x-api-key ключ\` → заголовок x-api-key\n• \`Header-Name: значение\` → кастомный заголовок`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔓 Без ключа', callback_data: 'mcp_nokey' }], [{ text: '◀️ Отмена', callback_data: 'integrations' }]] } });
    return;
  }
  if (waitingMcpKey.has(chatId)) {
    const { url, name } = waitingMcpKey.get(chatId);
    waitingMcpKey.delete(chatId);
    const rawKey = (text.trim().toLowerCase() === 'нет' || text.trim() === '-') ? '' : text.trim();
    if (rawKey) del(chatId, msg.message_id); // delete key message for safety
    // Auto-detect authType from key format
    let authType = 'auto';
    let apiKey = rawKey;
    if (rawKey.toLowerCase().startsWith('bearer ')) {
      authType = 'bearer';
      apiKey = rawKey.slice(7).trim();
    } else if (rawKey.toLowerCase().startsWith('x-api-key ')) {
      authType = 'x-api-key';
      apiKey = rawKey.replace(/^x-api-key\s+/i, '');
    } else if (rawKey.toLowerCase().startsWith('api-key ')) {
      authType = 'api-key';
      apiKey = rawKey.replace(/^api-key\s+/i, '');
    } else if (rawKey.includes(':') && !rawKey.startsWith('ey') && rawKey.indexOf(':') < 40 && !rawKey.includes(' ')) {
      authType = 'custom';
      apiKey = rawKey; // stored as "Header-Name:value"
    }
    const id = name + '_' + Date.now().toString(36);
    const serverCfg = { id, name, url, apiKey, authType, transport: 'http', tools: [], enabled: true, lastSync: null };
    const statusMsg = await send(chatId, `🔄 Подключаюсь к ${url}...`, persistentKeyboard);
    try {
      const tools = await syncMcpServer(chatId, serverCfg);
      if (!uc.mcpServers) uc.mcpServers = [];
      uc.mcpServers.push(serverCfg);
      saveUserConfig(chatId);
      if (statusMsg?.result?.message_id) del(chatId, statusMsg.result.message_id);
      send(chatId, `✅ MCP сервер подключён!\n\n🔗 ${name}\n🔧 ${tools.length} инструментов:\n${tools.map(t => `  • ${t.name}`).join('\n')}\n\nАгент теперь может использовать эти инструменты автоматически.`, { reply_markup: { inline_keyboard: [[{ text: '🔗 Интеграции', callback_data: 'integrations' }], [{ text: '◀️ Меню', callback_data: 'back' }]] } });
    } catch (e) {
      if (statusMsg?.result?.message_id) del(chatId, statusMsg.result.message_id);
      send(chatId, `❌ Не удалось подключиться: ${e.message}\n\nПроверьте URL и ключ.`, { reply_markup: { inline_keyboard: [[{ text: '🔄 Попробовать снова', callback_data: 'mcp_add' }], [{ text: '◀️ Назад', callback_data: 'integrations' }]] } });
    }
    return;
  }

  // === Ввод API ключа ===
  if (waitingApiKey.has(chatId)) {
    const provider = waitingApiKey.get(chatId);
    waitingApiKey.delete(chatId);
    del(chatId, msg.message_id); // удаляем сообщение с ключом
    const key = text.trim();
    if (!key || key.length < 10) { send(chatId, '❌ Неверный формат ключа'); return; }
    if (!uc.apiKeys) uc.apiKeys = {};
    uc.apiKeys[provider] = key;
    saveUserConfig(chatId);
    send(chatId, `✅ Ключ ${provider} сохранён (...${key.slice(-4)})\n\n💡 Ваше сообщение с ключом удалено для безопасности`, { reply_markup: { inline_keyboard: [[{ text: '🔍 Проверить', callback_data: `apikey_test_${provider}` }, { text: '◀️ К ключам', callback_data: 'api_keys' }]] } });
    return;
  }

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
      const data = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, 45000);
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

function setWaitingTimeout(chatId, waitingSet, label) {
  const key = `${chatId}_${label || 'unknown'}`;
  if (waitingTimers.has(key)) clearTimeout(waitingTimers.get(key));
  waitingTimers.set(key, setTimeout(() => {
    if (waitingSet instanceof Set) waitingSet.delete(chatId);
    else if (waitingSet instanceof Map) waitingSet.delete(chatId);
    waitingTimers.delete(key);
  }, WAITING_TIMEOUT));
}

// === Pixel Office Mini App API ===
const MINIAPP_URL = process.env.MINIAPP_URL || '';
const crypto = require('crypto');

function validateInitData(initDataStr, botToken) {
  try {
    const params = new URLSearchParams(initDataStr);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : { id: 'unknown' };
  } catch(e) { return null; }
}

function serializeAgentState(chatId) {
  const uc = getUserConfig(chatId);
  const fg = activeTasks.get(chatId);
  const bgMap = backgroundTasks.get(chatId);
  const multi = multiAgentTasks.get(chatId);
  const sess = sessionAgents.get(chatId) || [];
  const queueSize = getQueueSize(chatId);

  let foreground = null;
  if (fg) {
    foreground = {
      startTime: fg.startTime || Date.now(),
      status: fg.statusState || {},
    };
  }

  let bgList = [];
  if (bgMap) {
    for (const [taskId, task] of bgMap) {
      bgList.push({
        id: taskId,
        prompt: (task.prompt || '').slice(0, 100),
        startTime: task.startTime || Date.now(),
        status: task.status || 'running',
      });
    }
  }

  let multiAgent = null;
  if (multi) {
    multiAgent = {
      agents: (multi.agents || []).map(a => ({
        role: a.role,
        status: a.status || 'pending',
        result: a.result ? (a.result).slice(0, 100) : null,
        startTime: a.startTime,
      })),
      log: (multi.log || []).slice(-20),
      plan: multi.plan || null,
      startTime: multi.startTime,
    };
  }

  return {
    timestamp: Date.now(),
    global: {
      activeClaudeCount,
      maxClaude: MAX_CLAUDE_PROCS,
    },
    user: {
      model: uc.model,
      agentMode: uc.agentMode !== false,
      multiAgent: uc.multiAgent !== false,
      activeMode: uc.activeMode || null,
    },
    foreground,
    background: bgList,
    multiAgent,
    sessionAgents: sess.map(s => ({ id: s.id, label: s.label, icon: s.icon })),
    queueSize,
    agentRoles: Object.fromEntries(Object.entries(getEffectiveAgents(chatId)).map(([k, v]) => [k, { icon: v.icon, label: v.label }])),
  };
}

let miniappServer = null;
const sseClients = new Map(); // res -> { chatId, lastHash }

function startMiniAppServer() {
  const http = require('http');
  const PORT = process.env.PORT;
  if (!PORT) { console.log('ℹ️ PORT not set — Mini App API disabled'); return; }

  miniappServer = http.createServer((req, res) => {
    // CORS — разрешаем Vercel preview URLs и основной домен
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime(), activeTasks: activeTasks.size }));
      return;
    }

    // Auth for state/agents
    if (pathname === '/api/state' || pathname === '/api/agents') {
      const initData = url.searchParams.get('initData') || '';
      let chatId = null;
      const user = validateInitData(initData, token);
      if (user) {
        chatId = user.id;
      } else {
        // Fallback: allow without initData using first admin ID (for Telegram WebApp iframe issues)
        const adminId = (process.env.ALLOWED_USER_IDS || '').split(',')[0]?.trim();
        if (adminId) {
          chatId = parseInt(adminId, 10);
        }
      }
      if (!chatId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid initData' }));
        return;
      }

      if (pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(serializeAgentState(chatId)));
        return;
      }

      // SSE stream
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('data: ' + JSON.stringify(serializeAgentState(chatId)) + '\n\n');

      const clientInfo = { chatId, lastHash: '' };
      sseClients.set(res, clientInfo);

      req.on('close', () => { sseClients.delete(res); });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // SSE push interval
  setInterval(() => {
    for (const [res, info] of sseClients) {
      try {
        const state = serializeAgentState(info.chatId);
        const hash = JSON.stringify(state.foreground) + JSON.stringify(state.background) + JSON.stringify(state.multiAgent) + state.global.activeClaudeCount;
        if (hash !== info.lastHash) {
          info.lastHash = hash;
          res.write('data: ' + JSON.stringify(state) + '\n\n');
        }
      } catch(e) { sseClients.delete(res); }
    }
  }, 500);

  miniappServer.listen(PORT, () => {
    console.log(`🎮 Mini App API on port ${PORT}`);
  });
}

// === Graceful shutdown ===
function gracefulShutdown(signal) {
  console.log(`\n🛑 ${signal} — завершаю...`);
  stopPolling = true;

  // Останавливаем мониторинг каналов
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }

  // Сохраняем конфиги (flush debounced saves)
  flushConfig();
  flushUserConfigs();

  // Останавливаем все активные задачи
  for (const [chatId, task] of activeTasks) {
    if (task.timer) clearInterval(task.timer);
    if (task.pid) { try { process.kill(task.pid); } catch(e) {} }
    if (task.abort) { try { task.abort.abort(); } catch(e) {} }
  }
  activeTasks.clear();

  // Останавливаем фоновые задачи
  for (const [chatId, tasks] of backgroundTasks) {
    for (const [taskId, task] of tasks) {
      if (task.abort) { try { task.abort.abort(); } catch(e) {} }
    }
  }
  backgroundTasks.clear();

  if (miniappServer) miniappServer.close();

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

startMiniAppServer();

// Запуск MTProto и мониторинга
initMTProto().then(() => {
  startMonitoring();
}).catch(e => {
  console.error('MTProto init failed:', e.message);
  startMonitoring();
});

// Регистрируем команды бота (минимум — всё через AI)
tgApi('setMyCommands', { commands: [
  { command: 'settings', description: 'Настройки' },
  { command: 'stop', description: 'Остановить задачу' },
  { command: 'clear', description: 'Очистить историю' },
  { command: 'office', description: 'Pixel Office' },
]});

tick();
