// ############################################################
// # 1. ИМПОРТЫ И КОНФИГУРАЦИЯ
// ############################################################
require('dotenv').config();
const { execSync, execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// === Zep Cloud Memory ===
const zepMemory = require('./zep_memory');
const { MODEL_MAP, PROVIDER_MODELS, PROVIDER_LABELS, IMAGE_MODELS, VIDEO_MODELS } = require("./config/models");
const { AGENT_ROLES, PRESET_AGENTS } = require("./config/agents");
const { SPECIALIZED_MODES, SPECIALIZED_MODES_LIST, MODE_CATEGORIES } = require("./config/modes");
const { ConcurrencyPool, ProgressAggregator, detectDomain, detectRolesForTask, autoDelegate, BUSINESS_DOMAINS, shouldGenerateSkill, generateSkillDefinition, TaskChain } = require("./modules/parallelEngine");
const { AutonomousExecutor, ToolRouter } = require('./modules/autonomousExecutor');
const { MediaPromptEngine } = require('./modules/mediaPromptEngine');
const { DynamicAgentCreator } = require('./modules/dynamicAgentCreator');
const { SkillManager } = require('./modules/skillManager');
const { IntegrationHub } = require('./modules/integrationHub');
const { Orchestrator } = require('./modules/orchestrator');
const { BrowserManager } = require('./modules/browserManager');

// === Browser automation ===
const browserManager = new BrowserManager();

// === Parallel Engine: глобальный пул конкурентности ===
const globalPool = new ConcurrencyPool(4); // макс 4 параллельных AI-вызова
globalPool.events.on('completed', (record) => {
  console.log(`[Pool] Completed: ${record.id} (${record.meta?.role || 'unknown'}) in ${record.duration}ms`);
});
globalPool.events.on('failed', (record) => {
  console.log(`[Pool] Failed: ${record.id}: ${record.error}`);
});

// === Глобальный обработчик необработанных rejected промисов ===
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('🚨 UNCAUGHT EXCEPTION:', err);
  // Даем время логам записаться перед выходом
  setTimeout(() => process.exit(1), 1000);
});

// === Rate limiter для callback queries ===
const rateLimitMap = new Map();
function isRateLimited(chatId) {
  const now = Date.now();
  if (now - (rateLimitMap.get(chatId) || 0) < 500) return true;
  rateLimitMap.set(chatId, now);
  return false;
}
// Cleanup rateLimitMap every 10 min to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [chatId, ts] of rateLimitMap) {
    if (now - ts > 600000) rateLimitMap.delete(chatId);
  }
}, 600000);

// ############################################################
// # 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (UTILITIES)
// ############################################################
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

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAMBOTTOKEN;
if (!token) {
  console.error('CRITICAL: TELEGRAM_BOT_TOKEN (or TELEGRAMBOTTOKEN) is not set');
  process.exit(1);
}
const adminIds = (process.env.ALLOWED_USER_IDS || '').split(',').map(Number).filter(Boolean);
const API = `https://api.telegram.org/bot${token}`;
const FILE_API = `https://api.telegram.org/file/bot${token}`;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PID_FILE = path.join(__dirname, 'bot.pid');
const PLUGINS_DIR = path.join(__dirname, 'plugins');
const CLAUDE_PATH = process.env.CLAUDE_PATH || '/opt/homebrew/bin/claude';
const GEMINI_CLI_PATH = process.env.GEMINI_CLI_PATH || '/opt/homebrew/bin/gemini';
const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || '/opt/homebrew/bin/codex';
let tmpCounter = 0;
const CODEX_OPENAI_MODELS = new Set(['codex', 'codex-mini', 'codex-latest', 'codex-mini-latest', 'gpt-5-codex', 'gpt-5.3-codex']);
let codexCliAvailableCache = null;

// === AGENT EXPERIENCE (через Zep Cloud) ===

// Тонкие обёртки — experience синхронизируется в Zep Cloud
function recordAgentFailure(action, body, error, model = '') {
  zepMemory.syncAgentExperience('failure', `action=${action} model=${model} error="${(error || '').slice(0, 200)}"`);
}
function recordAgentSuccess(action, body, output, model = '', ms = 0) {
  zepMemory.syncAgentExperience('success', `action=${action} model=${model || 'unknown'} ms=${ms} output="${(output || '').slice(0, 100)}"`);
}
// Legacy stubs removed — Zep Cloud handles all experience/memory


// === Мультимодельный AI провайдер ===

function getProvider(model) {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model === 'gemini-cli') return 'google-cli';
  if (model.startsWith('codex-cli')) return 'codex-cli';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('deepseek-r1-distill-') || model === 'deepseek-r1-llama-70b') return 'groq';
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (model.startsWith('llama-3.1-') || model.startsWith('llama-3.2-') || model.startsWith('llama-3.3-') || model.startsWith('llama3-') || model.startsWith('mixtral-') || model.startsWith('gemma2-') || model.startsWith('qwen-qwq-')) return 'groq';
  if (model.includes('/') || model.startsWith('llama-4-') || model.startsWith('qwen3-') || model.startsWith('gpt-oss-') || model.startsWith('groq-compound') || model.startsWith('kimi-') || model.startsWith('orpheus-') || model.startsWith('allam-') || model.startsWith('gemma-3-') || model.startsWith('llama-guard-')) return 'openrouter';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('codex')) return 'openai';
  if (model.startsWith('ollama-')) return 'ollama';
  return 'anthropic';
}

function hasOpenAIKey(chatId = null) {
  const uc = chatId ? getUserConfig(chatId) : null;
  return !!(uc?.apiKeys?.openai || process.env.OPENAI_API_KEY);
}

function hasCodexCli() {
  if (codexCliAvailableCache !== null) return codexCliAvailableCache;
  try {
    fs.accessSync(CODEX_CLI_PATH, fs.constants.X_OK);
    codexCliAvailableCache = true;
  } catch (_) {
    codexCliAvailableCache = false;
  }
  return codexCliAvailableCache;
}

function isOpenAICodexModel(model) {
  if (!model) return false;
  const modelId = MODEL_MAP[model] || model;
  return CODEX_OPENAI_MODELS.has(String(model).toLowerCase()) || CODEX_OPENAI_MODELS.has(String(modelId).toLowerCase());
}

function mapOpenAICodexToCliModel(model) {
  const modelId = String(MODEL_MAP[model] || model || '').toLowerCase();
  if (modelId === 'gpt-5-codex' || modelId === 'gpt-5.3-codex') return 'codex-cli-o4';
  return 'codex-cli';
}

function resolveCodexRoute(model, chatId = null) {
  if (!isOpenAICodexModel(model)) return { model, routed: false };
  if (hasOpenAIKey(chatId)) return { model, routed: false };
  if (!hasCodexCli()) return { model, routed: false };
  return { model: mapOpenAICodexToCliModel(model), routed: true };
}

function isModelAvailableForUser(model, chatId = null) {
  const uc = chatId ? getUserConfig(chatId) : null;
  const prov = getProvider(model);
  if (prov === 'anthropic' || prov === 'google-cli') return true;
  if (prov === 'codex-cli') return hasCodexCli();
  if (prov === 'google') return !!(uc?.apiKeys?.google || process.env.GEMINI_API_KEY);
  if (prov === 'openai') return hasOpenAIKey(chatId) || (isOpenAICodexModel(model) && hasCodexCli());
  if (prov === 'groq') return !!(uc?.apiKeys?.groq || process.env.GROQ_API_KEY);
  if (prov === 'openrouter') return !!(uc?.apiKeys?.openrouter || process.env.OPENROUTER_API_KEY);
  if (prov === 'deepseek') return !!(uc?.apiKeys?.deepseek || process.env.DEEPSEEK_API_KEY);
  if (prov === 'ollama') return true; // Ollama всегда доступен если запущен локально
  return false;
}

// === Автоматический fallback моделей ===
const MODEL_FALLBACK_CHAIN = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'llama-3.3-70b-versatile',
  'deepseek-chat',
  'llama-4-maverick',
  'claude-haiku',
  'gpt-4.1-mini',
];

function getAvailableFallbackChain(chatId, excludeModel = null) {
  let chain = [...MODEL_FALLBACK_CHAIN];

  // Если модель - от Google (Gemini), добавляем надежные модели Gemini в начало fallback цепочки
  if (excludeModel && excludeModel.startsWith('gemini-') && isModelAvailableForUser('gemini-3.1-pro-preview', chatId)) {
    chain = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', ...chain];
  }

  // Для codex-* без OpenAI ключа сначала пробуем локальный Codex CLI
  if (excludeModel && isOpenAICodexModel(excludeModel) && !hasOpenAIKey(chatId) && hasCodexCli()) {
    chain = [mapOpenAICodexToCliModel(excludeModel), ...chain];
  }

  // Дедупликация
  chain = [...new Set(chain)];

  return chain.filter(m => m !== excludeModel && isModelAvailableForUser(m, chatId));
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
  if (/сценарий.*видео|видео.*сценарий|storyboard|раскадровк|видео.*по.*кадр|покадров|multi.?frame.*video|video.*story|видео.?истори|создай.*сцен.*кадр/.test(t))
    return { model: m('creative'), reason: '🎬 Видео-сценарий', isScenario: true };
  if (/создай.*видео|сгенерируй.*видео|generate.*video|анимац|animate|сделай.*видео|видеоролик/.test(t))
    return { model: m('video'), reason: '🎬 Видео', isVideo: true };

  // Scoring system — каждая категория набирает очки, побеждает максимум
  const scores = { code: 0, math: 0, translate: 0, analysis: 0, creative: 0, quick: 0, general: 1 };

  // Код — расширенные паттерны
  if (/\```|`[^`]+`|=>|console\.|print\(|\.then\(|async\s|await\s/.test(text)) scores.code += 5;
  if (/function\s|class\s|const\s|let\s|var\s|import\s|def\s|return\s|\.(js|ts|py|jsx|tsx|html|css|sql|sh|json|yaml|go|rs|cpp|java|rb|php|swift|kt)\b|npm\s|git\s|docker|api\s|endpoint|база данн|database|сервер|бэкенд|фронтенд|backend|frontend|webpack|vite|next\.?js|react|vue|angular|express|django|flask|fastapi/.test(t)) scores.code += 3;
  if (/напиши код|напиши скрипт|напиши функ|write code|write a function|create a script|debug|отлад|исправь (баг|ошибк|код)|fix (bug|code)|реализуй|implement|refactor|рефактор|оптимизируй код|деплой|deploy|собери проект|build project/.test(t)) scores.code += 4;
  // Код: паттерны файлов/путей
  if (/[\/\\]\w+\.(js|ts|py|go|rs|json|yaml|md|html|css)/.test(text)) scores.code += 2;

  // Математика — расширенные паттерны
  if (/посчитай|вычисли|калькул|формул|уравнен|интеграл|производн|матриц|математик|логическ|алгоритм|статистик|вероятност|теорем|доказа|regression|корреляц|дисперси/.test(t)) scores.math += 5;
  if (/\d+[\s]*[+\-*/^]\s*\d+/.test(t)) scores.math += 3;
  if (/процент|percentage|средн.*арифм|медиан|мода|sigma|дельта/.test(t)) scores.math += 2;

  // Перевод — расширенные языки
  if (/^(переведи|translate|перевод|переведите|переведём)/i.test(t)) scores.translate += 6;
  if (/на (английский|русский|немецкий|французский|испанский|китайский|японский|корейский|арабский|итальянский|португальский|турецкий|хинди|иврит)|to (english|russian|german|french|spanish|chinese|japanese|korean|arabic|italian|portuguese|turkish)/i.test(t)) scores.translate += 3;
  if (/локализ|localize|i18n|l10n/.test(t)) scores.translate += 3;

  // Анализ — градиентный бонус за длину + расширенные триггеры
  if (/проанализируй|анализ|разбери|объясни подробно|детально|сравни|исследуй|рассмотри|оцени|review|analyze|explain in detail|breakdown|декомпозиц|аудит|audit|отчёт|report|обзор|overview|дайджест|digest/.test(t)) scores.analysis += 5;
  if (len > 800) scores.analysis += 3;
  else if (len > 500) scores.analysis += 2;
  else if (len > 300) scores.analysis += 1;
  // Анализ: вставленный текст/данные (цитаты, логи, таблицы)
  if (/\n.*\n.*\n.*\n/.test(text) && len > 200) scores.analysis += 2;

  // Креатив — disambiguate с кодом, расширенные триггеры
  if (/напиши|сочини|придумай|создай текст|статью|пост|рассказ|стих|сценарий|письмо|резюме|эссе|story|write|compose|копирайт|copywriting|заголов|headline|слоган|контент.?план/.test(t)) scores.creative += 4;
  if (scores.code >= 3 && /напиши/.test(t)) scores.creative -= 2;
  // Креатив: уточнение — если есть "код" рядом с "напиши", это код
  if (/напиши.{0,20}(код|скрипт|функц|класс|компонент|api|бот|сервер|програм)/.test(t)) { scores.creative -= 3; scores.code += 2; }

  // Быстрый — обнуляется при наличии код/мат сигналов
  if (/^(привет|здравствуй|хай|ку|хей|спасибо|ок|да|нет|понял|ладно|hi|hello|hey|thanks|ok|yes|no|good|хорошо|отлично|го|пок|бб|bye)$/i.test(t.trim())) scores.quick += 6;
  if (len < 30) scores.quick += 3;
  else if (len < 80) scores.quick += 1;
  if (scores.code >= 3 || scores.math >= 3 || scores.analysis >= 3) scores.quick = 0;

  // Усиленный контекст из истории диалога (до +3 за категорию)
  if (conversationHistory.length > 0) {
    const last2 = conversationHistory.slice(-2).map(h => (h.content || h.text || '')).join(' ').toLowerCase();
    const last6 = conversationHistory.slice(-6).map(h => (h.content || h.text || '')).join(' ').toLowerCase();
    // Недавние (последние 2) дают +2, более ранние (6) дают +1
    if (/\```|function\s|class\s|const\s|import\s|def\s|=>|console\.|npm\s|git\s/.test(last2)) scores.code += 2;
    else if (/\```|function|class|const |import |def /.test(last6)) scores.code += 1;
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
        if (/\```|function|class|const |def |import |npm|git/.test(ht)) histCats.code++;
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

/**
 * analyzeRequest — дедуктивный анализ запроса пользователя.
 * Определяет намерение, нужные инструменты, роли субагентов и оптимальный стек моделей.
 * Возвращает: { category, intent, requiredTools, suggestedRoles, modelStack, needsPlanning, turboReady }
 */
function analyzeRequest(chatId, text, complexity = 'medium') {
  const t = text.toLowerCase().trim();
  const len = text.length;
  const uc = getUserConfig(chatId);

  // --- Намерение (что хочет сделать пользователь) ---
  let intent = 'general';
  if (/создай|напиши|сделай|реализуй|разработай|создать|написать|build|create|implement|develop/.test(t)) intent = 'create';
  else if (/исправь|починись|фикс|отлад|debug|fix|repair|solve|resolve/.test(t)) intent = 'fix';
  else if (/объясни|расскажи|что такое|как работает|почему|explain|what is|how does|why/.test(t)) intent = 'explain';
  else if (/найди|поищи|исследуй|search|find|research|проанализируй|analyze/.test(t)) intent = 'research';
  else if (/план|декомпоз|разбей|раздели|plan|decompose|break down/.test(t)) intent = 'plan';
  else if (/оптимизируй|улучши|рефактор|refactor|optimize|improve/.test(t)) intent = 'refactor';
  else if (/проверь|протестируй|test|check|verify|validate/.test(t)) intent = 'test';

  // --- Нужные инструменты ---
  const requiredTools = [];

  // bash: системные задачи
  if (/установи|запусти|выполни|команда|скрипт|install|run|execute|command|shell|npm|git|docker|файл|папк|путь|path/.test(t))
    requiredTools.push('bash');

  // plan: многошаговые или сложные задачи
  if (complexity === 'complex' || complexity === 'very_complex' ||
    /шаги|этапы|сначала.*потом|первым делом|step by step|breakdown|декомпоз/.test(t))
    requiredTools.push('plan');

  // notebook (NotebookLM): исследования, глубокий анализ, отчёты, аналитика
  const needsNotebook = intent === 'research' ||
    /исследуй|изучи|собери инфо|deep research|найди (данные|информ|факты|источники)|проанализируй|аналитик|отчёт|доклад|обзор|дайджест|конкурент|рынок|тренд|стратег/.test(t) ||
    (intent === 'explain' && complexity !== 'simple') ||
    (intent === 'create' && /отчёт|аналитика|обзор|доклад|презентац|инфографик|интеллект.карт|mindmap/.test(t));
  if (needsNotebook) requiredTools.push('notebook');

  // think: всегда для неочевидных запросов сложнее simple
  if (complexity !== 'simple' && len > 80) requiredTools.push('think');

  // --- Рекомендуемые роли субагентов (через parallelEngine) ---
  const detectedDomain = detectDomain(text);
  const suggestedRoles = detectRolesForTask(text, detectedDomain);

  // --- Модельный стек (2-3 модели, ordered fallback) ---
  const autoResult = autoSelectModel(text.slice(0, 300), uc.autoModelMap || {}, chatHistory.get(chatId) || []);
  const category = autoResult.category || 'general';

  const MODEL_STACKS = {
    code: ['claude-sonnet', 'gemini-2.5-pro', 'gpt-4.1'],
    math: ['gemini-2.5-pro', 'claude-sonnet', 'gpt-4.1'],
    analysis: ['claude-sonnet', 'gemini-2.5-pro', 'gpt-4.1'],
    creative: ['claude-sonnet', 'gpt-4.1', 'gemini-2.5-flash'],
    translate: ['gemini-2.5-flash', 'claude-haiku', 'gpt-4.1-mini'],
    quick: ['claude-haiku', 'gemini-2.5-flash', 'llama-3.3-70b-versatile'],
    general: ['claude-sonnet', 'gemini-2.5-flash', 'gpt-4.1'],
  };

  const rawStack = MODEL_STACKS[category] || MODEL_STACKS.general;
  const modelStack = rawStack.filter(m => isModelAvailableForUser(m, chatId)).slice(0, 3);
  if (modelStack.length === 0) modelStack.push('claude-sonnet');

  // --- Нужно ли обязательное планирование ---
  const needsPlanning = complexity === 'complex' || complexity === 'very_complex' ||
    requiredTools.includes('plan') ||
    (intent === 'create' && suggestedRoles.length >= 2) ||
    (intent === 'fix' && complexity === 'medium' && /проект|весь|все файлы|project/.test(t));

  // autonomous: для very_complex задач с множеством шагов
  if (complexity === 'very_complex' || (complexity === 'complex' && suggestedRoles.length >= 3))
    requiredTools.push('autonomous');

  // --- Можно ли использовать параллельное выполнение (turbo) ---
  const turboReady = complexity === 'very_complex' ||
    (complexity === 'complex' && requiredTools.includes('parallel')) ||
    suggestedRoles.length >= 3;

  return { category, intent, requiredTools, suggestedRoles, modelStack, needsPlanning, turboReady, detectedDomain };
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
function buildClaudeCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs = [], opts = {}) {
  const cliModelMap = {
    'claude-sonnet-4-6-20250514': 'sonnet',
    'claude-opus-4-6': 'opus',
    'claude-haiku-4-5-20251001': 'haiku',
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-20250929',
    'claude-opus-4-20250514': 'claude-opus-4-20250514',
    'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
  };
  const cliModel = cliModelMap[modelId] || modelId;

  const isResume = opts.resumeSessionId;
  const prompt = isResume ? (typeof messages === 'string' ? messages : buildContextString(messages)) : buildContextString(messages);

  // Разрешаем все инструменты через dangerously-skip-permissions (CLI v4.6+ убрал --allow-*)
  const args = ['-p', ...extraArgs, '--model', cliModel, '--dangerously-skip-permissions'];

  // Session continuation: resume = skip system prompt + MCP (already in session)
  if (isResume) {
    args.push('--resume', opts.resumeSessionId);
    // Dynamic effort
    const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
    if (uc.thinking || opts.effort === 'high') args.push('--effort', 'high');
    else if (opts.effort) args.push('--effort', opts.effort);
    return { args, prompt };
  }

  // New session
  if (opts.sessionId) args.push('--session-id', opts.sessionId);

  // Dynamic effort level: user thinking toggle OR complexity-based
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  if (uc.thinking || opts.effort === 'high') {
    args.push('--effort', 'high');
  } else if (opts.effort) {
    args.push('--effort', opts.effort);
  }

  const mcpSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (allowMcp) {
    const userMcpServers = chatId ? (getUserConfig(chatId).mcpServers || []).filter(s => s.enabled !== false) : [];
    if (userMcpServers.length > 0 || fs.existsSync(mcpSettingsPath)) {
      let mergedConfig = {};
      if (fs.existsSync(mcpSettingsPath)) {
        try { mergedConfig = JSON.parse(fs.readFileSync(mcpSettingsPath, 'utf8')); } catch (e) { console.warn('MCP config parse failed:', e.message); }
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
        setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch (e) { } }, 300000);
      } else {
        args.push('--mcp-config', mcpSettingsPath);
      }
    }
  }
  if (systemPrompt) {
    // Sanitize: strip null bytes and control chars (except newline/tab) to prevent prompt injection via control sequences
    const sanitized = systemPrompt.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    args.push('--system-prompt', sanitized);
  }
  return { args, prompt };
}

async function callAnthropic(modelId, messages, systemPrompt, allowMcp = true, chatId = null, cliOpts = {}) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const { args, prompt } = buildClaudeCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, [], cliOpts);

  return new Promise((resolve, reject) => {

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Claude CLI: ${err.message}`)));
    child.stdin.on('error', (err) => reject(new Error(`Claude CLI stdin: ${err.message}`)));
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { reject(new Error(`stdin write: ${e.message}`)); return; }

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { } }, timeoutMs);

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
  const settings = uc.modelSettings?.[modelId] || {};
  const isReasoningModel = /^(o[134]|o[134]-mini)/.test(modelId);
  const defaultMaxTokens = isReasoningModel ? 16384 : 8192;
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : defaultMaxTokens;
  const body = { model: modelId, messages: msgs };
  if (isReasoningModel) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty response');
  return { text, usage: data.usage };
}

const GEMINI_THINKING_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-3-flash-preview'];

// ############################################################
// # 4. ИНТЕГРАЦИИ С AI ПРОВАЙДЕРАМИ (GEMINI, CLAUDE, OPENAI)
// ############################################################
async function callGemini(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.google || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const settings = uc.modelSettings?.[modelId] || {};
  const isThinking = GEMINI_THINKING_MODELS.includes(modelId);
  const isFlashThinking = isThinking && modelId.includes('flash');
  const thinkingBudget = isFlashThinking ? 2048 : 8192;
  const defaultMaxTokens = isThinking ? (isFlashThinking ? 8192 : 16384) : 8192;
  const genConfig = { maxOutputTokens: settings.maxTokens !== undefined ? settings.maxTokens : defaultMaxTokens };
  if (settings.temperature !== undefined) genConfig.temperature = settings.temperature;
  if (isThinking) {
    genConfig.thinkingConfig = { thinkingBudget };
  }
  const body = { contents, generationConfig: genConfig };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const maxRetries = 2;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        let errText = `HTTP error! status: ${res.status}`;
        let errCode = res.status;
        try {
          const errData = await res.json();
          if (errData.error && errData.error.message) {
            errText = `Gemini API Error (${res.status}): ${errData.error.message}`;
          }
        } catch (e) { /* ignore parse error */ }
        const retryable = errCode === 429 || errCode === 503;
        if (retryable && attempt < maxRetries) {
          const waitMs = errCode === 429 ? 3000 * (attempt + 1) : 1500 * (attempt + 1);
          console.log(`⚠️ Gemini ${modelId} ${errCode}, retry ${attempt + 1}/${maxRetries} after ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          lastError = new Error(errText);
          continue;
        }
        throw new Error(errText);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => !p.thought).map(p => p.text).join('') || '';
      if (!text && data.candidates?.[0]?.finishReason === 'SAFETY') {
        throw new Error('Заблокировано фильтром безопасности');
      }
      return { text, usage: data.usageMetadata };
    } catch (error) {
      if (attempt < maxRetries && (error.message?.includes('429') || error.message?.includes('503') || error.message?.includes('UNAVAILABLE') || error.message?.includes('exhausted'))) {
        const waitMs = 2000 * (attempt + 1);
        console.log(`⚠️ Gemini ${modelId} error, retry ${attempt + 1}/${maxRetries}: ${error.message.slice(0, 60)}`);
        await new Promise(r => setTimeout(r, waitMs));
        lastError = error;
        continue;
      }
      console.error('Gemini error:', error.message);
      throw error;
    }
  }
  throw lastError;
}

async function callGroqChat(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.groq || process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY не задан');
  const timeout = Math.min((uc.timeout || 120) * 1000, 90000); // Groq, макс 90с
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 8192;
  const body = { model: modelId, messages: msgs, max_tokens: maxTokens };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty response');
  return { text, usage: data.usage };
}

async function callOpenRouter(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.openrouter || process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 8192;
  const body = { model: modelId, messages: msgs, max_tokens: maxTokens };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned empty response');
  return { text, usage: data.usage };
}

async function callDeepSeek(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.deepseek || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 8192;
  const body = { model: modelId, messages: msgs, max_tokens: maxTokens };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek returned empty response');
  return { text, usage: data.usage };
}

async function callOllama(modelId, messages, systemPrompt, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const host = uc.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const timeout = Math.min((uc.timeout || 120) * 1000, 120000);
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const body = { model: modelId, messages: msgs, stream: false };
  if (settings.temperature !== undefined) body.options = { ...body.options, temperature: settings.temperature };
  if (settings.maxTokens !== undefined) body.options = { ...body.options, num_predict: settings.maxTokens };

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.message?.content;
  if (!text) throw new Error('Ollama returned empty response');
  return { text, usage: { total_duration: data.total_duration, eval_count: data.eval_count } };
}

async function callOllamaStream(modelId, messages, systemPrompt, onChunk, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const host = uc.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const timeout = Math.min((uc.timeout || 120) * 1000, 120000);
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const body = { model: modelId, messages: msgs, stream: true };
  if (settings.temperature !== undefined) body.options = { ...body.options, temperature: settings.temperature };
  if (settings.maxTokens !== undefined) body.options = { ...body.options, num_predict: settings.maxTokens };

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  let full = '';
  const reader = res.body;
  const decoder = new TextDecoder();
  for await (const chunk of reader) {
    const lines = decoder.decode(chunk, { stream: true }).split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.message?.content) {
          full += j.message.content;
          if (onChunk) onChunk(full);
        }
      } catch (_) { }
    }
  }
  return { text: full || 'Готово (без вывода)', usage: null };
}

async function callAI(model, messages, systemPrompt, allowMcp = true, chatId = null, cliOpts = {}) {
  const start = Date.now();
  const routed = resolveCodexRoute(model, chatId);
  const effectiveModel = routed.model;
  const provider = getProvider(effectiveModel);
  const modelId = MODEL_MAP[effectiveModel] || effectiveModel;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropic(modelId, messages, systemPrompt, allowMcp, chatId, cliOpts); break;
    case 'google': result = await callGemini(modelId, messages, systemPrompt, chatId); break;
    case 'google-cli': result = await callGeminiCLI(modelId, messages, systemPrompt, allowMcp, chatId); break;
    case 'codex-cli': result = await callCodexCLI(modelId, messages, systemPrompt, chatId); break;
    case 'groq': result = await callGroqChat(modelId, messages, systemPrompt, chatId); break;
    case 'openrouter': result = await callOpenRouter(modelId, messages, systemPrompt, chatId); break;
    case 'deepseek': result = await callDeepSeek(modelId, messages, systemPrompt, chatId); break;
    case 'openai': result = await callOpenAI(modelId, messages, systemPrompt, chatId); break;
    case 'ollama': result = await callOllama(modelId, messages, systemPrompt, chatId); break;
    default: return { text: `[Fallback] Неизвестный провайдер: ${provider}` };
  }
  return { ...result, ms: Date.now() - start, provider, model: effectiveModel, requestedModel: model, codexRouted: routed.routed };
}

// === MediaPromptEngine: AI-powered prompt enhancement ===
const mediaPromptEngine = new MediaPromptEngine((...args) => callAI(...args));

function buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs = []) {
  let prompt = buildContextString(messages);
  if (systemPrompt) {
    prompt = `System instructions:\n${systemPrompt}\n\nUser prompt:\n${prompt}`;
  }
  const model = modelId === 'gemini-cli' ? 'gemini-2.5-pro' : modelId;
  // Обрезаем если >200KB (лимит ARG_MAX на macOS 256KB)
  if (Buffer.byteLength(prompt) > 200000) {
    prompt = prompt.slice(0, 200000) + '\n...(обрезано)';
  }
  const args = ['--prompt', prompt, '--yolo', '--model', model, ...extraArgs];
  return { args, prompt };
}

async function callGeminiCLI(modelId, messages, systemPrompt, allowMcp = true, chatId = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const { args, prompt } = buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId);

  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(GEMINI_CLI_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Gemini CLI: ${err.message}`)));
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { } }, timeoutMs);

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
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { } }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !finalText.trim()) {
        // Фильтруем информационный преамбул gemini-cli из stderr (не является ошибкой)
        const filteredErr = stderr.split('\n').filter(l => {
          const t = l.trim();
          return t && !/^(YOLO mode is enabled|All tool calls will be automatically approved|Loaded cach|Loading MCP|Initialized\.|Gemini CLI|^Debug:|^\[)/i.test(t);
        }).join('\n').trim();
        reject(new Error(filteredErr || stderr.trim() || `Код ${code}`));
      } else resolve({
        text: finalText.trim() || 'Готово (без вывода)',
        usage: { duration_ms: durationMs, num_turns: turns, cost_usd: null }
      });
    });
  });
}

// === Codex CLI интеграция ===

function getCodexModel(modelId) {
  // codex-cli-o3 и codex-cli → null = дефолт из ~/.codex/config.toml
  if (modelId === 'codex-cli-o4') return process.env.CODEX_CLI_O4_MODEL || 'gpt-5.3-codex';
  return null;
}

function buildCodexCliArgs(modelId, messages, systemPrompt, chatId, extraArgs = []) {
  let prompt = buildContextString(messages);
  if (systemPrompt) {
    prompt = `System instructions:\n${systemPrompt}\n\nUser request:\n${prompt}`;
  }
  // Ограничение размера (ARG_MAX на macOS)
  if (Buffer.byteLength(prompt) > 200000) {
    prompt = prompt.slice(0, 200000) + '\n...(truncated)';
  }
  const model = getCodexModel(modelId);
  // Всегда используем homedir — codex может паниковать в нестандартных путях
  const workDir = os.homedir();
  const args = ['exec'];
  if (model) args.push('-m', model);
  args.push('--full-auto', '--skip-git-repo-check', '-C', workDir, ...extraArgs, prompt);
  return { args, prompt, workDir };
}

// Удаляем ANSI-escape коды из вывода Codex CLI
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function extractCodexTextFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return [];
  const type = String(ev.type || '').toLowerCase();
  const out = [];
  const push = (v) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t) out.push(t);
  };

  // Common Codex event payloads
  push(ev.item?.type === 'agent_message' ? ev.item?.text : null);
  push(ev.message?.type === 'assistant' ? ev.message?.text : null);
  push(ev.last_agent_message);
  push(type.includes('output_text') || type.includes('assistant') ? ev.delta : null);
  push(type.includes('output_text') || type.includes('assistant') || type.includes('message') ? ev.text : null);
  push(ev.response?.output_text);

  const blocks = [
    ...(Array.isArray(ev.message?.content) ? ev.message.content : []),
    ...(Array.isArray(ev.item?.content) ? ev.item.content : []),
    ...(Array.isArray(ev.response?.output) ? ev.response.output : []),
  ];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    push(b.type === 'text' ? b.text : null);
    push(b.type === 'output_text' ? b.text : null);
    if (Array.isArray(b.content)) {
      for (const c of b.content) {
        if (c && typeof c === 'object') {
          push(c.type === 'text' || c.type === 'output_text' ? c.text : null);
        }
      }
    }
  }

  return out;
}

async function callCodexCLI(modelId, messages, systemPrompt, chatId = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const { args } = buildCodexCliArgs(modelId, messages, systemPrompt, chatId, ['--json']);

  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CODEX_CLI_PATH, args, { cwd: uc.workDir || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Codex CLI: ${err.message}`)));
    child.stdin.end();

    let stderr = '';
    let lineBuf = '';
    let parsedText = '';
    let rawOut = '';
    const appendText = (t) => {
      if (!t) return;
      if (!parsedText) parsedText = t;
      else if (!parsedText.includes(t)) parsedText += '\n' + t;
    };
    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('{')) {
        rawOut += line + '\n';
        return;
      }
      try {
        const ev = JSON.parse(trimmed);
        for (const t of extractCodexTextFromEvent(ev)) appendText(t);
      } catch (_) {
        rawOut += line + '\n';
      }
    };
    child.stdout.on('data', (d) => {
      lineBuf += d.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 180) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { } }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (lineBuf.trim()) consumeLine(lineBuf);
      const text = parsedText.trim() || stripAnsi(rawOut).trim();
      const errText = stripAnsi(stderr).trim();
      if (code !== 0) reject(new Error(errText || text || `Codex CLI exit code ${code}`));
      else if (!text) reject(new Error(errText || 'Codex CLI returned empty output'));
      else if (text.startsWith('ERROR:') || text.includes('"detail":')) reject(new Error(text));
      else resolve({ text, usage: null });
    });
  });
}

async function callCodexCLIStream(modelId, messages, systemPrompt, onChunk, chatId = null, onEvent = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const useJson = !!onEvent;
  const extraArgs = useJson ? ['--json'] : [];
  const { args } = buildCodexCliArgs(modelId, messages, systemPrompt, chatId, extraArgs);

  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CODEX_CLI_PATH, args, { cwd: uc.workDir || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Codex CLI: ${err.message}`)));
    child.stdin.end();

    let finalText = '';
    let stderr = '';
    let turns = 0;
    let codexErrorMsg = ''; // сообщение об ошибке из JSON-событий Codex

    let rawStdout = ''; // сырой stdout для диагностики ошибок
    if (useJson) {
      let lineBuf = '';
      const appendText = (t) => {
        if (!t) return;
        if (!finalText) finalText = t;
        else if (!finalText.includes(t)) finalText += '\n' + t;
      };
      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        rawStdout += chunk;
        lineBuf += chunk;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim() || !line.startsWith('{')) continue;
          try {
            const ev = JSON.parse(line);
            // Сообщение агента: item.completed с type=agent_message
            if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
              appendText(ev.item.text);
              if (onChunk) onChunk(finalText);
              if (onEvent) onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: ev.item.text }] } });
            }
            // Универсальный парсинг текста для новых/альтернативных форматов событий Codex CLI
            const textChunks = extractCodexTextFromEvent(ev);
            for (const t of textChunks) {
              const prev = finalText;
              appendText(t);
              if (onChunk && finalText !== prev) onChunk(finalText);
            }
            // Начало выполнения команды
            if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
              turns++;
              if (onEvent) onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'shell', input: { command: ev.item.command } }] } });
            }
            // Завершение команды
            if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
              if (onEvent) onEvent({ type: 'tool_result', is_error: (ev.item.exit_code !== 0) });
            }
            // Конец сессии
            if (ev.type === 'turn.completed') {
              const usage = ev.usage || {};
              if (onEvent) onEvent({ type: 'result', duration_ms: null, num_turns: turns, cost_usd: 0 });
            }
            // Ошибка от Codex CLI
            if (ev.type === 'error' && ev.message) {
              codexErrorMsg = ev.message;
            }
          } catch (e) { /* skip malformed JSON */ }
        }
      });
    } else {
      child.stdout.on('data', (d) => {
        rawStdout += d;
        const clean = stripAnsi(rawStdout).trim();
        if (onChunk && clean) onChunk(clean);
        finalText = clean;
      });
    }

    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 180) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { } }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const text = finalText.trim();
      const errText = stripAnsi(stderr).trim();
      // Фильтруем JSON-строки из stdout — оставляем только читаемые сообщения об ошибках
      const rawLines = stripAnsi(rawStdout).split('\n').filter(l => { const t = l.trim(); return t && !t.startsWith('{') && !t.startsWith('['); });
      const rawText = rawLines.join('\n').trim();
      const errorSource = codexErrorMsg || errText || rawText || `exit code ${code}`;
      if (code !== 0) reject(new Error(errorSource));
      else if (!text) reject(new Error(rawText || codexErrorMsg || errText || 'Пустой ответ от Codex CLI'));
      else resolve({ text, usage: { num_turns: turns } });
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

async function callAnthropicStream(modelId, messages, systemPrompt, onChunk, allowMcp = true, chatId = null, onEvent = null, cliOpts = {}) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const useStreamJson = !!onEvent;
  const extraArgs = useStreamJson ? ['--output-format', 'stream-json'] : [];
  const { args, prompt } = buildClaudeCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs, cliOpts);

  return new Promise((resolve, reject) => {

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(CLAUDE_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Claude CLI: ${err.message}`)));
    child.stdin.on('error', (err) => reject(new Error(`Claude CLI stdin: ${err.message}`)));
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { reject(new Error(`stdin write: ${e.message}`)); return; }

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
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { } }, timeoutMs);

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
  const settings = uc.modelSettings?.[modelId] || {};
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 4096;
  const body = { model: modelId, messages: msgs, max_tokens: maxTokens, stream: true };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
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
  const settings = uc.modelSettings?.[modelId] || {};
  const isThinking = GEMINI_THINKING_MODELS.includes(modelId);
  const isFlashThinking = isThinking && modelId.includes('flash');
  const thinkingBudget = isFlashThinking ? 2048 : 8192;
  const defaultMaxTokens = isThinking ? (isFlashThinking ? 8192 : 16384) : 8192;
  const genConfig = { maxOutputTokens: settings.maxTokens !== undefined ? settings.maxTokens : defaultMaxTokens };
  if (settings.temperature !== undefined) genConfig.temperature = settings.temperature;
  if (isThinking) {
    genConfig.thinkingConfig = { thinkingBudget };
  }
  const body = { contents, generationConfig: genConfig };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const maxRetries = 2;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const errMsg = err.error?.message || `HTTP ${res.status}`;
        const retryable = res.status === 429 || res.status === 503;
        if (retryable && attempt < maxRetries) {
          const waitMs = res.status === 429 ? 3000 * (attempt + 1) : 1500 * (attempt + 1);
          console.log(`⚠️ Gemini stream ${modelId} ${res.status}, retry ${attempt + 1}/${maxRetries} after ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          lastError = new Error(errMsg);
          continue;
        }
        throw new Error(errMsg);
      }
      const text = await parseSSEStream(res, j => {
        const parts = j.candidates?.[0]?.content?.parts || [];
        return parts.filter(p => !p.thought).map(p => p.text).join('') || '';
      }, onChunk);
      if (!text) throw new Error('Пустой ответ от Gemini');
      return { text, usage: null };
    } catch (error) {
      if (attempt < maxRetries && (error.message?.includes('429') || error.message?.includes('503') || error.message?.includes('UNAVAILABLE') || error.message?.includes('exhausted'))) {
        const waitMs = 2000 * (attempt + 1);
        console.log(`⚠️ Gemini stream ${modelId} error, retry ${attempt + 1}/${maxRetries}: ${error.message.slice(0, 60)}`);
        await new Promise(r => setTimeout(r, waitMs));
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function callGroqStream(modelId, messages, systemPrompt, onChunk, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.groq || process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY не задан');
  const timeout = Math.min((uc.timeout || 120) * 1000, 90000);
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 4096;
  const body = { model: modelId, messages: msgs, max_tokens: maxTokens, stream: true };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.choices?.[0]?.delta?.content || '', onChunk);
  return { text: text || 'Готово (без вывода)', usage: null };
}

async function callOpenRouterStream(modelId, messages, systemPrompt, onChunk, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.openrouter || process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 4096;
  const body = { model: modelId, messages: msgs, max_tokens: maxTokens, stream: true };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.choices?.[0]?.delta?.content || '', onChunk);
  return { text: text || 'Готово (без вывода)', usage: null };
}

async function callDeepSeekStream(modelId, messages, systemPrompt, onChunk, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const key = uc.apiKeys?.deepseek || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY не задан');
  const timeout = (uc.timeout || 120) * 1000;
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const settings = uc.modelSettings?.[modelId] || {};
  const maxTokens = settings.maxTokens !== undefined ? settings.maxTokens : 8192;
  const body = { model: modelId, messages: msgs, max_tokens: maxTokens, stream: true };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const text = await parseSSEStream(res, j => j.choices?.[0]?.delta?.content || '', onChunk);
  return { text: text || 'Готово (без вывода)', usage: null };
}

async function callAIStream(model, messages, systemPrompt, onChunk, allowMcp = true, chatId = null, onEvent = null, cliOpts = {}) {
  const start = Date.now();
  const routed = resolveCodexRoute(model, chatId);
  const effectiveModel = routed.model;
  const provider = getProvider(effectiveModel);
  const modelId = MODEL_MAP[effectiveModel] || effectiveModel;
  let result;
  switch (provider) {
    case 'anthropic': result = await callAnthropicStream(modelId, messages, systemPrompt, onChunk, allowMcp, chatId, onEvent, cliOpts); break;
    case 'google': result = await callGeminiStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    case 'google-cli': result = await callGeminiCLIStream(modelId, messages, systemPrompt, onChunk, allowMcp, chatId, onEvent); break;
    case 'codex-cli': result = await callCodexCLIStream(modelId, messages, systemPrompt, onChunk, chatId, onEvent); break;
    case 'groq': result = await callGroqStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    case 'openrouter': result = await callOpenRouterStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    case 'deepseek': result = await callDeepSeekStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    case 'openai': result = await callOpenAIStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    case 'ollama': result = await callOllamaStream(modelId, messages, systemPrompt, onChunk, chatId); break;
    default:
      if (onEvent) onEvent({ type: 'error', message: `Unknown provider: ${provider}` });
      return { text: `[Fallback] Неизвестный провайдер: ${provider}` };
  }
  return { ...result, ms: Date.now() - start, provider, model: effectiveModel, requestedModel: model, codexRouted: routed.routed };
}

// === AI вызов с автоматическим fallback ===
async function callAIWithFallback(primaryModel, messages, systemPrompt, chatId, opts = {}) {
  const { allowMcp = true, onFallback = null, cliOpts = {} } = opts;
  const chain = [primaryModel, ...getAvailableFallbackChain(chatId, primaryModel)];
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const result = await callAI(model, messages, systemPrompt, allowMcp, chatId, i === 0 ? cliOpts : {});
      return {
        ...result,
        fallbackUsed: model !== primaryModel,
        originalModel: primaryModel,
        actualModel: result.model || model,
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
  const { allowMcp = true, onFallback = null, onEvent = null, cliOpts = {} } = opts;
  const chain = [primaryModel, ...getAvailableFallbackChain(chatId, primaryModel)];
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const result = await callAIStream(model, messages, systemPrompt, onChunk, allowMcp, chatId, onEvent, i === 0 ? cliOpts : {});
      return {
        ...result,
        fallbackUsed: model !== primaryModel,
        originalModel: primaryModel,
        actualModel: result.model || model,
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
    try {
      if (oldPid === process.pid) {
        console.warn(`⚠️ bot.pid указывает на текущий PID ${oldPid}, пропускаю остановку`);
      } else {
        process.kill(oldPid, 0);
        let oldCmd = '';
        try {
          oldCmd = String(execSync(`ps -p ${oldPid} -o command=`, { encoding: 'utf8' })).trim();
        } catch (e) {
          oldCmd = '';
        }
        if (oldCmd.includes('bot.js')) {
          console.log(`⛔ Убиваю старый бот (PID ${oldPid})`);
          process.kill(oldPid, 'SIGTERM');
        } else {
          console.warn(`⚠️ PID ${oldPid} занят другим процессом (${oldCmd || 'unknown'}), пропускаю остановку`);
        }
      }
    } catch (e) { }
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => {
  try {
    const pidInFile = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (pidInFile === process.pid) fs.unlinkSync(PID_FILE);
  } catch (e) { }
});

// === Конфигурация ===
// Глобальный конфиг (API ключи, MTProto, polling — общие для всех)
const defaultGlobalConfig = { mtprotoSession: '', channels: [], monitorInterval: 60, reminders: [], todos: [], scheduledActions: [] };
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
  quick: { label: '⚡ Быстрый', default: 'llama3-70b' },
  general: { label: '💬 Общий', default: 'gemini-2.5-flash' },
};
const defaultUserConfig = { model: 'claude-haiku', workDir: '/tmp', timeout: 300, historySize: 20, systemPrompt: '', language: '', skills: [], pins: [], autoModel: false, agentMode: true, agentMaxSteps: 10, thinking: false, role: 'user', banned: false, customAgents: [], apiKeys: {}, imageModel: 'nano-banana', imageAspect: '1:1', imageSize: '1K', videoModel: 'veo-3.1-fast', videoResolution: '720p', videoAspect: '16:9', videoDuration: '8', autoModelMap: {}, modelStats: {}, categoryPerf: {}, mcpServers: [], activeMode: null, modelSettings: {} };
const userConfigs = new Map(); // chatId -> config
const cancellableOperations = new Map(); // chatId -> { isCancelled: false }

const SKILL_CATEGORIES = [
  { id: 'code', label: '💻 Код' },
  { id: 'text', label: '✍️ Текст' },
  { id: 'analysis', label: '🔍 Анализ' },
  { id: 'other', label: '📦 Другое' },
];



const SUB_AGENT_PROMPT_TEMPLATE = (role, task, context, customAgent) => {
  const rules = `
ПРАВИЛА ВЫПОЛНЕНИЯ:
- Выполняй ТОЛЬКО свою задачу — не отвлекайся
- СКОРОСТЬ: начинай действовать сразу, минимум размышлений
- Будь конкретным: цифры > абстракции, примеры > теория
- Структурируй ответ: заголовки, списки, таблицы
- Если нужно действие на сервере — используй [ACTION: тип]...[/ACTION]
- НЕ пиши "я думаю", "возможно" — пиши утверждения
- ЗАПРЕЩЕНО сдаваться — предложи альтернативу
- Если видишь 💬 ОБСУЖДЕНИЕ ДРУГИХ АГЕНТОВ — учитывай их выводы, дополняй или опровергай

ФОРМАТ:
- Начни с 1-2 предложений резюме
- Основная часть: структурированный ответ
- ОБЯЗАТЕЛЬНО в конце: [RESULT] краткий итог
- При ошибке: [ERROR] + решение
- Язык: русский`;

  if (customAgent && customAgent.prompt) {
    return `${customAgent.prompt}

ЗАДАЧА: ${task}
${context ? `\nКОНТЕКСТ ОТ ОРКЕСТРАТОРА:\n${context}` : ''}
${rules}`;
  }
  const roleInfo = AGENT_ROLES[role] || AGENT_ROLES.executor;
  return `Ты — ${roleInfo.icon} ${roleInfo.label} (${roleInfo.desc}) в мульти-агентной системе.
Эксперт с 10+ лет опыта. Ответы практичны и actionable. Действуй быстро.

ЗАДАЧА: ${task}
${context ? `\nКОНТЕКСТ ОТ ОРКЕСТРАТОРА:\n${context}` : ''}
${rules}`;
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

// Stub: multiAgentTasks Map removed (council/parallel deleted), kept as empty Map for compatibility
const multiAgentTasks = new Map();

// === PROGRESS BAR CLASS ===
class ProgressBar {
  constructor(total = 100, width = 20) { this.total = total; this.width = width; this.current = 0; }
  update(current) { this.current = Math.min(current, this.total); }
  render() {
    const percent = Math.round((this.current / this.total) * 100);
    const filled = Math.round((this.current / this.total) * this.width);
    const empty = this.width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + '] ' + percent + '%';
  }
  advance(delta = 1) { this.update(this.current + delta); }
  getPercent() { return Math.round((this.current / this.total) * 100); }
}

// === TASK HISTORY CLASS ===
class TaskHistory {
  constructor(maxSize = 100) { this.maxSize = maxSize; this.entries = []; }
  add(action, status = 'started', duration = 0, agent = 'system', error = null) {
    const entry = { ts: Date.now(), action, status, duration, agent, ...(error && { error }) };
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) this.entries.shift();
  }
  getRecent(count = 10) { return this.entries.slice(-count).reverse(); }
  formatForDisplay() {
    return this.getRecent(5).map(e => {
      const time = new Date(e.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const status = e.status === 'completed' ? '✅' : e.status === 'error' ? '❌' : '⏳';
      const dur = e.duration > 0 ? ' (' + e.duration + 'мс)' : '';
      return status + ' ' + time + ' | ' + e.action + dur;
    }).join('\n');
  }
  clear() { this.entries = []; }
}


// === RESOURCE MONITOR CLASS ===
class ResourceMonitor {
  constructor() { this.samples = []; this.maxSamples = 60; }
  sample() {
    const mem = process.memoryUsage();
    this.samples.push({
      ts: Date.now(),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024)
    });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
  getStats() {
    if (this.samples.length === 0) return null;
    const latest = this.samples[this.samples.length - 1];
    const oldest = this.samples[0];
    const trendHeap = latest.heapUsed - oldest.heapUsed;
    return {
      heapUsed: latest.heapUsed, heapTotal: latest.heapTotal, external: latest.external,
      trend: trendHeap > 0 ? '📈' : '📉', percent: Math.round((latest.heapUsed / latest.heapTotal) * 100)
    };
  }
  formatForDisplay() {
    const stats = this.getStats();
    if (!stats) return 'N/A';
    return '💾 ' + stats.heapUsed + '/' + stats.heapTotal + 'MB (' + stats.percent + '%) ' + stats.trend;
  }
  clear() { this.samples = []; }
}

// === PHASE TRACKER CLASS ===
class PhaseTracker {
  constructor(phases = []) {
    this.phases = phases.map((p, i) => ({
      name: p, index: i, started: null, completed: null, duration: 0, status: 'pending'
    }));
    this.currentPhaseIdx = 0;
    this.startTime = Date.now();
  }
  startPhase(phaseName) {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) { phase.status = 'running'; phase.started = Date.now(); this.currentPhaseIdx = this.phases.indexOf(phase); }
  }
  completePhase(phaseName) {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) { phase.status = 'done'; phase.completed = Date.now(); phase.duration = phase.completed - phase.started; }
  }
  failPhase(phaseName, error = '') {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) { phase.status = 'error'; phase.completed = Date.now(); phase.duration = phase.completed - phase.started; phase.error = error; }
  }
  getCurrentPhase() { return this.phases[this.currentPhaseIdx]; }
  getETAms() {
    const completed = this.phases.filter(p => p.status === 'done');
    if (completed.length === 0) return null;
    const avgDuration = completed.reduce((sum, p) => sum + p.duration, 0) / completed.length;
    const remaining = this.phases.filter(p => p.status !== 'done').length;
    return avgDuration * remaining;
  }
  formatForDisplay() {
    const lines = [];
    this.phases.forEach((p, i) => {
      const icon = p.status === 'done' ? '✅' : p.status === 'running' ? '⛏️' : p.status === 'error' ? '❌' : '⏳';
      const dur = p.duration > 0 ? ' ' + p.duration + 'мс' : '';
      const marker = i === this.currentPhaseIdx ? ' ➜ ' : '   ';
      lines.push(marker + icon + ' ' + p.name + dur);
    });
    const eta = this.getETAms();
    if (eta) lines.push('\n⏱ ETA: ' + Math.round(eta / 1000) + 'с');
    return lines.join('\n');
  }
  clear() { this.phases = []; }
}


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
  // Миграция: удаляем устаревшие поля локальной памяти
  delete cfg.memory; delete cfg.memoryEnabled; delete cfg.memoryAutoExtract;
  if (cfg.autoModelMap === undefined) cfg.autoModelMap = {};
  // Миграция агент-режима
  if (cfg.agentMode === undefined) cfg.agentMode = true;
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

const DEPRECATED_MODELS = { 'claude-3-5-haiku': 'claude-haiku', 'claude-3-5-sonnet': 'claude-sonnet', 'claude-3-7-sonnet': 'claude-sonnet' };
function getUserConfig(chatId) {
  if (!userConfigs.has(chatId)) {
    const isAdmin = adminIds.includes(chatId);
    userConfigs.set(chatId, { ...defaultUserConfig, role: isAdmin ? 'admin' : 'user', workDir: isAdmin ? (process.env.WORKING_DIR || os.homedir()) : '/tmp' });
    saveUserConfigs();
  }
  const cfg = userConfigs.get(chatId);
  if (cfg.model && DEPRECATED_MODELS[cfg.model]) { cfg.model = DEPRECATED_MODELS[cfg.model]; saveUserConfigs(); }
  return cfg;
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
    if (config.agentMode !== undefined) migrated.agentMode = config.agentMode;
    if (config.agentMaxSteps) migrated.agentMaxSteps = config.agentMaxSteps;
    userConfigs.set(firstAdmin, migrated);
    saveUserConfigs();
  }
  // Очистить per-user поля из глобального конфига
  delete config.model; delete config.workDir; delete config.timeout;
  delete config.historySize; delete config.systemPrompt; delete config.templates;
  delete config.pins; delete config.autoModel;
  delete config.agentMode; delete config.agentMaxSteps;
  saveConfig();
}

// === История диалогов ===
// ############################################################
// # 5. MTPROTO / МОНИТОРИНГ КАНАЛОВ
// ############################################################
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
  // Sync to Zep Cloud (fire-and-forget)
  zepMemory.syncMessage(chatId, role, trimmed);
}

function clearHistory(chatId) {
  chatHistory.delete(chatId);
  chatHistoryAccess.delete(chatId);
  lastResponse.delete(chatId);
  // Also clear Zep session (async)
  zepMemory.deleteSession(chatId).catch(() => { });
}

// === Память полностью через Zep Cloud (zep_memory.js) ===





// === Очередь сообщений ===
const messageQueue = new Map(); // chatId -> [{text, type, filePath}]

function enqueue(chatId, item) {
  if (!messageQueue.has(chatId)) messageQueue.set(chatId, []);
  messageQueue.get(chatId).push(item);
}

function processQueue(chatId) {
  const queue = messageQueue.get(chatId);
  if (!queue || queue.length === 0) return;

  // Проверяем лимит параллельных задач
  if (getActiveFgTasksCount(chatId) >= MAX_CONCURRENT_TASKS_PER_USER) return;

  // Запускаем несколько элементов параллельно (без await в основном потоке)
  while (getActiveFgTasksCount(chatId) < MAX_CONCURRENT_TASKS_PER_USER && queue.length > 0) {
    const item = queue.shift();
    // Запускаем асинхронно, не блокируя основной loop
    runClaude(chatId, item.text).catch(e => {
      console.error(`[processQueue] runClaude failed: ${e.message}`);
    });
  }

  if (queue.length === 0) messageQueue.delete(chatId);
}

function getQueueSize(chatId) {
  const queue = messageQueue.get(chatId);
  return queue ? queue.length : 0;
}

// === Telegram API (async через native fetch + retry + keep-alive) ===
const { Agent: UndiciAgent } = require('undici');
const tgDispatcher = new UndiciAgent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connect: { timeout: 15000 },  // 15s connect timeout для медленных сетей
  pipelining: 1,
});

async function tgApi(method, body, timeout = 30000) {
  const maxRetries = method === 'getUpdates' ? 1 : 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (method !== 'getUpdates' && process.env.BOT_DEBUG) console.log(`[tgApi] CALL: ${method}, chat_id=${body.chat_id || 'N/A'}`);
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        dispatcher: tgDispatcher
      });
      const json = await res.json();
      if (method !== 'getUpdates' && process.env.BOT_DEBUG) console.log(`[tgApi] RESULT: ${method}, ok=${json.ok}`);
      if (!json.ok && json.error_code) {
        if (json.error_code === 429 && json.parameters?.retry_after) {
          await new Promise(r => setTimeout(r, json.parameters.retry_after * 1000));
          continue;
        }
      }
      return json;
    } catch (e) {
      const cause = e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
      if (method === 'getUpdates') {
        if (attempt === 0 && e.name !== 'AbortError') {
          console.error(`tgApi(getUpdates): ${e.message}${cause}`);
        }
        return { ok: false };
      }
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      console.error(`tgApi(${method}): ${e.message}${cause}`);
      return { ok: false };
    }
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
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ ok: false }); }
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
  catch (e) { if (!e.message?.includes('not modified')) console.error(`[editText] ${chatId}:`, e.message); }
}

function del(chatId, msgId) { tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => { }); }

// === Автоудаление технических сообщений через N мс ===
const AUTO_DELETE_DELAY = 10000; // 10 секунд

function autoDeleteMsg(chatId, msgId, delay = AUTO_DELETE_DELAY) {
  if (!msgId) return;
  setTimeout(() => del(chatId, msgId), delay);
}

async function sendTemp(chatId, text, opts = {}, delay = AUTO_DELETE_DELAY) {
  const res = await send(chatId, text, opts);
  const msgId = res?.result?.message_id;
  if (msgId) autoDeleteMsg(chatId, msgId, delay);
  return res;
}

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
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${imgModel.id}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
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
  // Imagen 4 не поддерживает negativePrompt
  if (opts.negativePrompt && !modelKey.startsWith('imagen-4')) parameters.negativePrompt = opts.negativePrompt;
  const body = { instances: [instance], parameters };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${imgModel.id}:predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
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
    const pollRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName}`, {
      headers: { 'x-goog-api-key': key },
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
      const dlUrl = videoUri.includes('?') ? `${videoUri}&key=${key}` : `${videoUri}?key=${key}`; // key in URL required for binary download
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
      ...(!(opts.startFrame || opts.referenceImage) && { personGeneration: 'allow_all' })
    }
  };
  // startFrame / referenceImage → image (начальный кадр или референс)
  const startImg = opts.startFrame || opts.referenceImage;
  if (startImg) {
    body.instances[0].image = { bytesBase64Encoded: startImg, mimeType: opts.mimeType || 'image/jpeg' };
  }
  // endFrame → lastFrame (поддерживается только veo-2)
  if (opts.endFrame) {
    if (modelKey === 'veo-2') {
      body.instances[0].lastFrame = { bytesBase64Encoded: opts.endFrame, mimeType: opts.endMimeType || 'image/jpeg' };
    }
  }
  if (opts.negativePrompt) body.parameters.negativePrompt = opts.negativePrompt;
  // Запуск Long Running операции
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${vidModel.id}:predictLongRunning`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
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
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${vidModel.id}:predictLongRunning`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const operationName = data.name;
  if (!operationName) throw new Error('Не получено имя операции');
  return pollVideoOperation(operationName, key, 'veoext', opts.onProgress);
}

// === Извлечение последнего кадра из видео (для сценариев) ===
async function extractLastFrame(videoPath) {
  const outPath = `/tmp/lastframe_${Date.now()}.jpg`;
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-sseof', '-0.5', '-i', videoPath, '-frames:v', '1', '-q:v', '2', '-y', outPath],
      { timeout: 15000 }, (err) => {
        if (err || !fs.existsSync(outPath)) return resolve(null);
        try {
          const data = fs.readFileSync(outPath).toString('base64');
          fs.unlinkSync(outPath);
          resolve(data);
        } catch (e) { resolve(null); }
      });
  });
}

// === Очистка markdown из ответов Claude ===
function cleanMarkdown(text) {
  return text
    .replace(/\```[\s\S]*?\```/g, '')        // блоки кода
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

async function sendMedia(chatId, filePath, caption, method, field) {
  const resolved = path.resolve(getUserConfig(chatId).workDir, filePath);
  if (!fs.existsSync(resolved)) { await sendDocument(chatId, filePath, caption); return; }
  const res = await tgUpload(method, chatId, field, resolved, caption);
  if (!res.ok) await sendDocument(chatId, filePath, caption);
}

async function sendPhoto(chatId, filePath, caption = '') { return sendMedia(chatId, filePath, caption, 'sendPhoto', 'photo'); }
async function sendVideo(chatId, filePath, caption = '') { return sendMedia(chatId, filePath, caption, 'sendVideo', 'video'); }
async function sendAudio(chatId, filePath, caption = '') { return sendMedia(chatId, filePath, caption, 'sendAudio', 'audio'); }

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
  try { fs.unlinkSync(dest); } catch (e) { }
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

  const on = '✅', off = '❌';
  const agentOn = uc.agentMode !== false;

  // Счётчики
  const bgTasks = backgroundTasks.has(chatId) ? backgroundTasks.get(chatId).size : 0;
  const todos = (config.todos || []).filter(t => t.chatId === chatId);
  const totalTasks = bgTasks + todos.length;
  const tasksBadge = totalTasks > 0 ? `(${totalTasks})` : '';

  // Активный режим
  const modeInfo = uc.activeMode && SPECIALIZED_MODES[uc.activeMode]
    ? `${SPECIALIZED_MODES[uc.activeMode].icon} Режим: ${SPECIALIZED_MODES[uc.activeMode].label}`
    : null;

  const rows = [];

  // Текущий режим (если выбран)
  if (modeInfo) rows.push([{ text: modeInfo, callback_data: 'modes_menu' }]);

  // Быстрые переключатели: агент + модель в 1 ряд
  const modelShort = uc.model.length > 20 ? uc.model.slice(0, 18) + '…' : uc.model;
  rows.push([
    { text: `🤖 Агент ${agentOn ? on : off}`, callback_data: 'mt_agent' },
    { text: `🧠 ${modelShort} — ⟳`, callback_data: 'set_model' },
  ]);

  // Quick Actions — самые частые операции без подменю
  rows.push([
    { text: '🎨 Нарисовать', callback_data: 'quick_image' },
    { text: '🎬 Видео', callback_data: 'quick_video' },
    { text: '📝 Текст', callback_data: 'quick_text' },
  ]);

  // Основные разделы
  rows.push([
    { text: '🎭 Режимы', callback_data: 'modes_menu' },
    { text: '🛠 Инструменты', callback_data: 'tools_menu' },
  ]);
  rows.push([
    { text: '🤖 Агенты', callback_data: 'agents_menu' },
    { text: '⚡ Навыки', callback_data: 'skills_menu' },
  ]);

  // Задачи + Настройки
  rows.push([
    { text: `📋 Задачи ${tasksBadge}`, callback_data: 'tasks_menu' },
    { text: '⚙️ Настройки', callback_data: 'settings' },
  ]);

  // Админ-панель (все admin-функции в одном месте)
  if (admin) rows.push([{ text: '🔧 Админ-панель', callback_data: 'admin_panel' }]);

  // Mini App
  if (MINIAPP_URL && MINIAPP_URL.startsWith('https://')) rows.push([{ text: '🏛 Открыть офис', web_app: { url: MINIAPP_URL } }]);

  return { reply_markup: { inline_keyboard: rows } };
}

function mediaMenu(chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const imgModel = uc.imageModel || 'nano-banana';
  const imgRatio = uc.imageAspect || '1:1';
  const vidModel = uc.videoModel || 'veo-3.1-fast';
  const vidRatio = uc.videoAspect || '16:9';
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎨 Создать изображение', callback_data: 'media_gen_image' }],
        [{ text: '✏️ Редактировать фото', callback_data: 'media_edit_image' }],
        [{ text: '🎬 Создать видео', callback_data: 'media_gen_video' }],
        [{ text: '🎬 Продолжить видео', callback_data: 'media_extend_video' }],
        [{ text: '📐 Сценарий (раскадровка)', callback_data: 'media_scenario' }],
        [
          { text: `🖼 ${imgModel} | ${imgRatio}`, callback_data: 'img_settings' },
          { text: `📹 ${vidModel} | ${vidRatio}`, callback_data: 'video_settings' },
        ],
        [{ text: '◀️ Назад', callback_data: 'back' }],
      ]
    }
  };
}

function toolsMenu(chatId) {
  // Считаем активные напоминания
  const reminders = [];
  if (reminderTimers.has(chatId)) {
    for (const [id, r] of reminderTimers.get(chatId)) reminders.push(r);
  }
  const remBadge = reminders.length > 0 ? ` (${reminders.length})` : '';

  // Считаем задачи
  const todos = (config.todos || []).filter(t => t.chatId === chatId);
  const todoBadge = todos.length > 0 ? ` (${todos.length})` : '';

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📓 База знаний (NotebookLM)', callback_data: 'nb_menu' }],
        [{ text: '🔗 Интеграции (MCP)', callback_data: 'integrations' }],
        [
          { text: '📤 Экспорт чата', callback_data: 'export_chat' },
          { text: '🔍 Веб-поиск', callback_data: 'quick_search' },
        ],
        [
          { text: `✅ Задачи${todoBadge}`, callback_data: 'plug_todo' },
          { text: `⏰ Напоминания${remBadge}`, callback_data: 'reminders_list' },
        ],
        [
          { text: '🎨 Медиа', callback_data: 'media_menu' },
        ],
        [{ text: '◀️ Назад', callback_data: 'back' }],
      ]
    }
  };
}

function adminPanel(chatId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📡 Каналы', callback_data: 'channels' },
          { text: '👥 Пользователи', callback_data: 'users_panel' },
        ],
        [
          { text: '📈 Статистика', callback_data: 'stats' },
          { text: '📁 Рабочая папка', callback_data: 'set_dir' },
        ],
        [{ text: '◀️ Назад', callback_data: 'back' }],
      ]
    }
  };
}


function settingsMenu(chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const provLabel = PROVIDER_LABELS[getProvider(uc.model)] || '';
  const on = '✅', off = '❌';
  const agentOn = uc.agentMode !== false;
  const rows = [
    // Модель
    [{ text: `🧠 ${uc.model} ${provLabel}`, callback_data: 'set_model' }],
    [{ text: '⚙️ Параметры модели', callback_data: 'model_settings' }],
    // 3 toggle в ряд
    [
      { text: `🤖 Агент ${agentOn ? on : off}`, callback_data: 'mt_agent' },
      { text: `🧠 Авто ${uc.autoModel ? on : off}`, callback_data: 'toggle_auto' },
      { text: `💭 Think ${uc.thinking ? on : off}`, callback_data: 'toggle_thinking' },
    ],
    // Язык, промпт, шаги в 1 ряд
    [
      { text: '🌐 Язык', callback_data: 'set_lang' },
      { text: '💬 Промпт', callback_data: 'set_system' },
      { text: `🔢 Шаги: ${uc.agentMaxSteps || 10}`, callback_data: 'set_max_steps' },
    ],
    [{ text: `⏱ Таймаут: ${uc.timeout}с`, callback_data: 'set_timeout' }],
    [{ text: '🔑 API Ключи', callback_data: 'api_keys' }],
    [{ text: '🎨 Изображения', callback_data: 'img_settings' }, { text: '🎬 Видео', callback_data: 'video_settings' }],
    // Перенесённые из главного меню
    [
      { text: '🧠 Память', callback_data: 'mem_menu' },
      { text: '🗑 Очистить', callback_data: 'clear' },
      { text: '❓ Помощь', callback_data: 'help' },
    ],
    [{ text: '◀️ Назад', callback_data: 'back' }],
  ];
  return { reply_markup: { inline_keyboard: rows } };
}

function modelSettingsMenu(chatId, modelId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const settings = uc.modelSettings?.[modelId] || {};
  const temp = settings.temperature !== undefined ? settings.temperature : 'Авто';
  const tokens = settings.maxTokens !== undefined ? settings.maxTokens : 'Авто';
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🌡 Температура: ${temp}`, callback_data: 'set_modeltemp' }],
        [{ text: `📏 Max Tokens: ${tokens}`, callback_data: 'set_modeltokens' }],
        [{ text: '🔄 Сбросить параметры', callback_data: 'reset_modelsettings' }],
        [{ text: '◀️ Назад к настройкам', callback_data: 'settings' }]
      ]
    }
  };
}

function modelMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🟣 Anthropic', callback_data: 'modelgrp_anthropic' }, { text: '🟢 OpenAI', callback_data: 'modelgrp_openai' }],
        [{ text: '🔵 Google', callback_data: 'modelgrp_google' }, { text: '✨ Gemini CLI', callback_data: 'modelgrp_google-cli' }],
        [{ text: '⚡ Groq', callback_data: 'modelgrp_groq' }, { text: '🐳 DeepSeek', callback_data: 'modelgrp_deepseek' }],
        [{ text: '🌌 OpenRouter', callback_data: 'modelgrp_openrouter' }, { text: '🛠️ Codex CLI', callback_data: 'modelgrp_codex-cli' }],
        [{ text: '◀️ Назад', callback_data: 'settings' }]
      ]
    }
  };
}

function modelProviderMenu(provider, chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const models = PROVIDER_MODELS[provider] || [];
  return {
    reply_markup: {
      inline_keyboard: [
        ...models.map(m => [{ text: (m.id === uc.model ? '✅ ' : '') + m.label, callback_data: `model_${m.id}` }]),
        [{ text: '◀️ Назад к провайдерам', callback_data: 'set_model' }]
      ]
    }
  };
}

function timeoutMenu(chatId) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const timeouts = [
    { val: 30, label: '30с — быстрые вопросы' },
    { val: 60, label: '1 мин — обычные задачи' },
    { val: 120, label: '2 мин — стандарт' },
    { val: 300, label: '5 мин — сложные задачи' },
    { val: 600, label: '10 мин — длинные операции' },
  ];
  return {
    reply_markup: {
      inline_keyboard: [
        ...timeouts.map(t => [{ text: (t.val === uc.timeout ? '✅ ' : '') + t.label, callback_data: `timeout_${t.val}` }]),
        [{ text: '◀️ Назад', callback_data: 'settings' }]
      ]
    }
  };
}

function langMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🇷🇺 Русский', callback_data: 'lang_ru' }, { text: '🇬🇧 English', callback_data: 'lang_en' }],
        [{ text: '🇺🇦 Українська', callback_data: 'lang_uk' }, { text: '🇪🇸 Español', callback_data: 'lang_es' }],
        [{ text: '🔄 Сбросить', callback_data: 'lang_clear' }],
        [{ text: '◀️ Назад', callback_data: 'settings' }]
      ]
    }
  };
}

// === Состояние ===
// === Переделанная система очереди: параллельная обработка ===
// activeTasks: Map<chatId, Map<taskId, taskInfo>> - поддержка нескольких параллельных задач
const activeTasks = new Map(); // chatId -> Map<taskId, taskInfo>
let fgTaskCounter = 0; // счетчик для генерации уникальных taskId

function generateFgTaskId() {
  return `fg_${Date.now().toString(36)}_${(++fgTaskCounter).toString(36)}`;
}

function getActiveFgTasks(chatId) {
  if (!activeTasks.has(chatId)) activeTasks.set(chatId, new Map());
  return activeTasks.get(chatId);
}

function getActiveFgTasksCount(chatId) {
  return getActiveFgTasks(chatId).size;
}

// Lock per chatId: prevents concurrent runClaude for same user
const chatLocks = new Map(); // chatId -> Promise
function acquireChatLock(chatId) {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  let release;
  const lock = new Promise(r => { release = r; });
  chatLocks.set(chatId, prev.then(() => lock));
  return prev.then(() => release);
}

// === Фоновые задачи ===
const backgroundTasks = new Map(); // chatId -> Map<taskId, taskInfo>
const MAX_BG_TASKS_PER_USER = 3;
const MAX_CONCURRENT_TASKS_PER_USER = 5; // макс параллельных fg-задач на пользователя
let bgTaskCounter = 0;

function generateTaskId() {
  return `bg_${Date.now().toString(36)}_${(++bgTaskCounter).toString(36)}`;
}

function getTotalActiveCount(chatId) {
  const fg = getActiveFgTasksCount(chatId);
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
let waitingModelSetting = new Map(); // chatId -> settingName
let waitingMcpUrl = new Set(); // chatId -> waiting for MCP server URL
let waitingMcpKey = new Map(); // chatId -> {url, name} waiting for optional API key
let waitingImagePrompt = new Set(); // chatId -> ожидание промпта для изображения
let waitingVideoPrompt = new Set(); // chatId -> ожидание промпта для видео
let waitingWeatherCity = new Set(); // chatId -> ожидание города для погоды
let waitingExchangeQuery = new Set(); // chatId -> ожидание запроса курса
let waitingCryptoQuery = new Set(); // chatId -> ожидание запроса крипто
let waitingTranslateQuery = new Set(); // chatId -> ожидание текста для перевода
let waitingQRText = new Set(); // chatId -> ожидание текста для QR
let waitingTextPrompt = new Set(); // chatId -> ожидание задания для текста
let waitingSearchQuery = new Set(); // chatId -> ожидание поискового запроса
const mediaGroupBuffer = new Map(); // groupId -> { chatId, photos: [], caption, timer }
const sessionFrames = new Map(); // chatId -> { startFrame, endFrame, referenceImage, lastPhoto, lastPhotos: [], startPath, endPath, refPath, lastPhotoPath, lastPhotosPaths: [], savedAt }
let offset = 0;
let polling = false;
let monitorTimer = null;

// Очистка всех waiting-состояний для пользователя (при старте нового wizard)
function clearAllWaiting(chatId) {
  const sets = [waitingDir, waitingSystemPrompt, waitingChannelAdd, waitingSmartSetup,
    waitingAuthPhone, waitingAuthCode, waitingAuthPassword, waitingNbCreate, waitingNbResearch,
    waitingSkillName, waitingAgentName, waitingMcpUrl,
    waitingImagePrompt, waitingVideoPrompt, waitingWeatherCity, waitingExchangeQuery,
    waitingCryptoQuery, waitingTranslateQuery, waitingQRText,
    waitingTextPrompt, waitingSearchQuery];
  const maps = [waitingChannelKeywords, waitingChannelPrompt, waitingNbQuery, waitingNbUrl,
    waitingNbText, waitingNbRename, waitingNbReportCustom,
    waitingSkillPrompt, waitingSkillEditName, waitingSkillEditPrompt, waitingSkillEditDesc,
    waitingSkillCategory, waitingAgentPrompt, waitingAgentEditPrompt, waitingAgentEditDesc,
    waitingAgentEditName, waitingAgentIcon, waitingAgentDesc, waitingApiKey, waitingMcpKey, waitingModelSetting];
  for (const s of sets) s.delete(chatId);
  for (const m of maps) m.delete(chatId);
}

// === Статистика ===
const stats = { startTime: Date.now(), messages: 0, claudeCalls: 0, errors: 0, voiceMessages: 0, files: 0, totalResponseTime: 0 };

// === Напоминания (персистентные, повторяющиеся) ===
const reminderTimers = new Map();

// === STATUS TRACKING MAPS ===
const taskHistories = new Map();
const resourceMonitors = new Map();
const phaseTrackers = new Map();

function getTaskHistory(chatId) {
  if (!taskHistories.has(chatId)) taskHistories.set(chatId, new TaskHistory(150));
  return taskHistories.get(chatId);
}
function getResourceMonitor(chatId) {
  if (!resourceMonitors.has(chatId)) resourceMonitors.set(chatId, new ResourceMonitor());
  return resourceMonitors.get(chatId);
}
function getPhaseTracker(chatId, taskId = 'main') {
  if (!phaseTrackers.has(chatId)) phaseTrackers.set(chatId, new Map());
  const map = phaseTrackers.get(chatId);
  if (!map.has(taskId)) map.set(taskId, new PhaseTracker());
  return map.get(taskId);
}
function clearStatusTracking(chatId) {
  if (chatId) { taskHistories.delete(chatId); resourceMonitors.delete(chatId); phaseTrackers.delete(chatId); }
  else { taskHistories.clear(); resourceMonitors.clear(); phaseTrackers.clear(); }
}

// === BACKGROUND RESOURCE MONITORING ===
let resourceMonitorInterval = null;
function startResourceMonitoring() {
  if (resourceMonitorInterval) return;
  resourceMonitorInterval = setInterval(() => {
    for (const [chatId, monitor] of resourceMonitors) { monitor.sample(); }
  }, 5000);
}
function stopResourceMonitoring() {
  if (resourceMonitorInterval) { clearInterval(resourceMonitorInterval); resourceMonitorInterval = null; }
}
startResourceMonitoring();

// === CLEANUP OLD LOGS ===
function cleanupOldStatusData() {
  const MAX_HISTORY_AGE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [chatId, history] of taskHistories) {
    const recentEntries = history.entries.filter(e => now - e.ts < MAX_HISTORY_AGE_MS);
    if (recentEntries.length < history.entries.length) history.entries = recentEntries;
  }
  for (const [chatId, monitor] of resourceMonitors) {
    if (monitor.samples.length > 120) monitor.samples = monitor.samples.slice(-60);
  }
  for (const [chatId, trackersMap] of phaseTrackers) {
    for (const [taskId, tracker] of trackersMap) {
      const isComplete = tracker.phases.every(p => p.status === 'done' || p.status === 'error');
      const createdAgo = now - tracker.startTime;
      if (isComplete && createdAgo > 60 * 60 * 1000) trackersMap.delete(taskId);
    }
    if (trackersMap.size === 0) phaseTrackers.delete(chatId);
  }
}
setInterval(cleanupOldStatusData, 60 * 60 * 1000);

// === TASK ACTION LOGGING ===
function logTaskAction(chatId, action, status = 'completed', duration = 0, agent = 'system', error = null) {
  const history = getTaskHistory(chatId);
  history.add(action, status, duration, agent, error);
  const tracker = multiAgentTasks.get(chatId);
  if (tracker && tracker.log) {
    tracker.log.push({
      ts: Date.now(),
      text: (status === 'completed' ? '✅' : status === 'error' ? '❌' : '⏳') + ' ' + action + ' (' + duration + 'мс)'
    });
  }
}
// id -> timerId
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

// === Экспорт истории чата ===
async function exportChatHistory(chatId) {
  const history = chatHistory.get(chatId);
  if (!history || history.length === 0) {
    send(chatId, '📭 История чата пуста. Напишите что-нибудь, чтобы она появилась.');
    return;
  }
  const lines = [];
  lines.push(`=== Экспорт чата ===`);
  lines.push(`Дата: ${new Date().toLocaleString('ru-RU')}`);
  lines.push(`Сообщений: ${history.length}`);
  lines.push('');
  for (const msg of history) {
    const role = msg.role === 'user' ? '👤 Вы' : '🤖 AI';
    lines.push(`${role}:`);
    lines.push(msg.text || msg.content || '');
    lines.push('');
  }
  const tmpFile = `/tmp/chat_export_${chatId}_${Date.now()}.txt`;
  fs.writeFileSync(tmpFile, lines.join('\n'), 'utf8');
  try {
    await sendDocument(chatId, tmpFile, `📤 Экспорт чата (${history.length} сообщений)`);
  } catch (e) {
    send(chatId, `❌ Ошибка экспорта: ${e.message}`);
  }
  try { fs.unlinkSync(tmpFile); } catch {}
}

// === Меню напоминаний ===
function remindersMenu(chatId) {
  const userReminders = (config.reminders || []).filter(r => r.chatId === chatId);
  if (userReminders.length === 0) {
    send(chatId, '⏰ У вас нет активных напоминаний.\n\nНапишите: «напомни через 2 часа позвонить»');
    return;
  }
  const rows = [];
  for (const r of userReminders) {
    const timeLeft = r.fireAt - Date.now();
    const mins = Math.max(0, Math.round(timeLeft / 60000));
    const timeStr = mins >= 60 ? `${Math.floor(mins / 60)}ч ${mins % 60}м` : `${mins}м`;
    const repeat = r.repeat ? ' 🔄' : '';
    rows.push([{ text: `⏰ ${r.text.slice(0, 30)}${r.text.length > 30 ? '…' : ''} — ${timeStr}${repeat}`, callback_data: `noop_${r.id}` }]);
    rows.push([{ text: '❌ Отменить', callback_data: `cancel_reminder_${r.id}` }]);
  }
  rows.push([{ text: '◀️ Назад', callback_data: 'tools_menu' }]);
  send(chatId, `⏰ Активные напоминания (${userReminders.length}):`, { reply_markup: { inline_keyboard: rows } });
}

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
    if (action.actionName === 'agent') {
      // Полный агентный цикл через runClaude — доступ ко всем 39+ экшенам
      const taskPrompt = action.actionBody || action.description;
      const contextNote = action.context ? `\n\nКонтекст: ${action.context}` : '';
      await runClaude(action.chatId, `[SCHEDULED TASK] ${taskPrompt}${contextNote}`, { scheduled: true });
    } else {
      const result = await executeAction(action.chatId, { name: action.actionName, body: action.actionBody });
      if (result && !result.silent) {
        const icon = result.success ? '✅' : '❌';
        send(action.chatId, `${icon} Результат: ${(result.output || '').slice(0, 2000)}`);
      }
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
  for (const [chatId, fgTasks] of activeTasks) {
    for (const [taskId, task] of fgTasks) {
      if (task._startTime && now - task._startTime > THIRTY_MIN) {
        console.error(`[chatId:${chatId}] Safety net: cleaning stale activeTask ${taskId} (>30min)`);
        if (task.timer) clearInterval(task.timer);
        if (task.pid) { try { process.kill(task.pid); } catch (e) { } }
        if (task._claudeSlot) releaseClaudeSlot(task._claudeSlot);
        fgTasks.delete(taskId);
      }
    }
    if (fgTasks.size === 0) activeTasks.delete(chatId);
  }

  // Safety net: backgroundTasks старше 30 мин
  for (const [chatId, tasks] of backgroundTasks) {
    for (const [taskId, task] of tasks) {
      if (task.startTime && now - task.startTime > THIRTY_MIN) {
        console.error(`[chatId:${chatId}] Safety net: cleaning stale bgTask ${taskId} (>30min)`);
        if (task.abort) { try { task.abort.abort(); } catch (e) { } }
        if (task._claudeSlot) releaseClaudeSlot(task._claudeSlot);
        tasks.delete(taskId);
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
  return {
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [{ text: '➕ Добавить канал', callback_data: 'ch_add' }, { text: '🧠 Умная настройка', callback_data: 'ch_smart' }],
        [{ text: `⏱ Интервал: ${config.monitorInterval}с`, callback_data: 'ch_interval' }, { text: mtStatus, callback_data: 'ch_mtproto' }],
        [{ text: '◀️ Назад', callback_data: 'back' }]
      ]
    }
  };
}

function channelDetailMenu(idx) {
  const ch = config.channels[idx];
  if (!ch) return channelsMenu();
  const kwText = ch.keywords.length ? ch.keywords.join(', ') : 'все';
  const hasPrompt = ch.prompt ? '✅' : '❌';
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: ch.enabled ? '⏸ Выключить' : '▶️ Включить', callback_data: `ch_toggle_${idx}` }],
        [{ text: `🧠 Инструкция: ${hasPrompt}`, callback_data: `ch_prompt_${idx}` }],
        [{ text: `🔑 Ключевые: ${kwText}`, callback_data: `ch_kw_${idx}` }],
        [{ text: '🔄 Проверить сейчас', callback_data: `ch_check_${idx}` }],
        [{ text: '🗑 Удалить', callback_data: `ch_del_${idx}` }],
        [{ text: '◀️ Назад', callback_data: 'channels' }]
      ]
    }
  };
}

function monitorIntervalMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        ...[30, 60, 120, 300].map(t => [{ text: (t === config.monitorInterval ? '✅ ' : '') + t + 'с', callback_data: `ch_intval_${t}` }]),
        [{ text: '◀️ Назад', callback_data: 'channels' }]
      ]
    }
  };
}

// === NotebookLM меню ===
const nbMainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📋 Мои блокноты', callback_data: 'nb_list' }],
      [{ text: '➕ Создать блокнот', callback_data: 'nb_create' }],
      [{ text: '🔍 Исследование', callback_data: 'nb_research' }],
      [{ text: '◀️ Назад', callback_data: 'back' }]
    ]
  }
};

function nbDetailMenu(nbId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '❓ Задать вопрос', callback_data: `nb_query_${nbId}` }],
        [{ text: '🔗 Добавить URL', callback_data: `nb_addurl_${nbId}` }, { text: '📝 Добавить текст', callback_data: `nb_addtxt_${nbId}` }],
        [{ text: '🎙 Подкаст', callback_data: `nb_audio_${nbId}` }, { text: '📊 Отчёт', callback_data: `nb_report_${nbId}` }],
        [{ text: '🎬 Видео', callback_data: `nb_video_${nbId}` }, { text: '🖼 Инфографика', callback_data: `nb_infog_${nbId}` }],
        [{ text: '📑 Слайды', callback_data: `nb_slides_${nbId}` }, { text: '🧠 Ментальная карта', callback_data: `nb_mindmap_${nbId}` }],
        [{ text: '🃏 Флешкарты', callback_data: `nb_flash_${nbId}` }, { text: '📝 Квиз', callback_data: `nb_quiz_${nbId}` }],
        [{ text: '✏️ Переименовать', callback_data: `nb_rename_${nbId}` }, { text: '🗑 Удалить', callback_data: `nb_delete_${nbId}` }],
        [{ text: '◀️ Назад', callback_data: 'nb_list' }]
      ]
    }
  };
}

function nbAudioMenu(nbId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎧 Глубокий разбор', callback_data: `nb_aud_deep_dive_${nbId}` }],
        [{ text: '⚡ Краткий обзор', callback_data: `nb_aud_brief_${nbId}` }],
        [{ text: '🔬 Критический анализ', callback_data: `nb_aud_critique_${nbId}` }],
        [{ text: '⚔️ Дебаты', callback_data: `nb_aud_debate_${nbId}` }],
        [{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]
      ]
    }
  };
}

function nbReportMenu(nbId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Брифинг', callback_data: `nb_rep_briefing_${nbId}` }],
        [{ text: '📖 Учебный материал', callback_data: `nb_rep_study_${nbId}` }],
        [{ text: '✍️ Блог-пост', callback_data: `nb_rep_blog_${nbId}` }],
        [{ text: '🎨 Свой формат', callback_data: `nb_rep_custom_${nbId}` }],
        [{ text: '◀️ Назад', callback_data: `nb_detail_${nbId}` }]
      ]
    }
  };
}

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
    const text = (result?.text || '').trim();
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
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch (e) { throw new Error('Invalid JSON from AI: ' + e.message); }

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
    if (process.env.BOT_DEBUG) console.log('📡 MTProto: Инициализация клиента...');
    mtClient = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      baseLogger: { log: () => { }, warn: console.warn, error: console.error, debug: () => { }, info: () => { }, canSend: () => false, _log: () => { }, setLevel: () => { } }
    });
    if (process.env.BOT_DEBUG) console.log('📡 MTProto: Подключение к Telegram...');
    await mtClient.connect();
    if (process.env.BOT_DEBUG) console.log('📡 MTProto: Подключено. Проверка авторизации...');

    if (await mtClient.isUserAuthorized()) {
      mtConnected = true;
      console.log('✅ MTProto: подключён и авторизован');
      setupRealtimeMonitor();
    } else {
      if (process.env.BOT_DEBUG) console.log('⚠️ MTProto: подключён, но не авторизован. Используйте /auth в боте');
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
  try {
    if (!mtClient || !mtConnected) return;

    // Убираем старые обработчики (при рестарте)
    mtClient.removeEventHandler(handleNewMessage, new NewMessage({}));

    // Слушаем все новые сообщения
    mtClient.addEventHandler(handleNewMessage, new NewMessage({}));
    console.log('📡 MTProto: реалтайм-мониторинг запущен');
  } catch (e) {
    console.error('❌ setupRealtimeMonitor error:', e);
  }
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
  const adminOnlyCallbacks = ['channels', 'ch_add', 'ch_interval', 'ch_smart', 'ch_mtproto', 'set_dir', 'stats', 'users_panel', 'admin_panel'];
  const isAdminOnly = adminOnlyCallbacks.includes(data) || data.startsWith('ch_') || data.startsWith('user_');
  if (isAdminOnly && !isAdmin(chatId)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Только для администраторов', show_alert: true });
    return;
  }

  if (data === 'settings') await editText(chatId, msgId, '⚙️ Настройки:', settingsMenu(chatId));
  else if (data === 'media_menu') await editText(chatId, msgId, '🎨 Медиа-генерация:', mediaMenu(chatId));
  else if (data === 'tools_menu') await editText(chatId, msgId, '🛠 Инструменты и плагины:', toolsMenu(chatId));
  else if (data === 'admin_panel') await editText(chatId, msgId, '🔧 Админ-панель:', adminPanel(chatId));
  else if (data === 'media_gen_image') {
    clearAllWaiting(chatId);
    waitingImagePrompt.add(chatId);
    setWaitingTimeout(chatId, waitingImagePrompt, 'waitingImagePrompt');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🎨 Опишите что нарисовать:\n\nНапример: «кот в космосе, стиль аниме»', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'media_gen_video') {
    clearAllWaiting(chatId);
    waitingVideoPrompt.add(chatId);
    setWaitingTimeout(chatId, waitingVideoPrompt, 'waitingVideoPrompt');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🎬 Опишите видео:\n\nНапример: «закат над океаном, камера пролетает над волнами»', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'media_extend_video') {
    clearAllWaiting(chatId);
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🎬 Для продолжения видео ответьте на видео-сообщение командой /videoextend [описание продолжения]', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'back' }]] } });
  }
  else if (data === 'media_scenario') {
    clearAllWaiting(chatId);
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '📐 Опишите сценарий для раскадровки.\n\nАгент создаст последовательность кадров с описаниями.\n\nНапример: «рекламный ролик кофейни, 5 кадров»');
    // Сценарий обрабатывается через обычный runClaude — агент сам определит ACTION: scenario
  }
  else if (data === 'plug_weather') {
    clearAllWaiting(chatId);
    waitingWeatherCity.add(chatId);
    setWaitingTimeout(chatId, waitingWeatherCity, 'waitingWeatherCity');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🌤 Введите название города:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'plug_exchange') {
    clearAllWaiting(chatId);
    waitingExchangeQuery.add(chatId);
    setWaitingTimeout(chatId, waitingExchangeQuery, 'waitingExchangeQuery');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '💱 Введите валюту (напр. USD, EUR) или пару (USD/RUB):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'plug_crypto') {
    clearAllWaiting(chatId);
    waitingCryptoQuery.add(chatId);
    setWaitingTimeout(chatId, waitingCryptoQuery, 'waitingCryptoQuery');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '₿ Введите криптовалюту (напр. BTC, ETH, SOL):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'plug_translate') {
    clearAllWaiting(chatId);
    waitingTranslateQuery.add(chatId);
    setWaitingTimeout(chatId, waitingTranslateQuery, 'waitingTranslateQuery');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🌍 Введите текст для перевода:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'plug_qr') {
    clearAllWaiting(chatId);
    waitingQRText.add(chatId);
    setWaitingTimeout(chatId, waitingQRText, 'waitingQRText');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🔗 Введите текст или URL для QR-кода:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'plug_pomodoro') {
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    // Запуск помодоро через runClaude
    runClaude(chatId, 'Запусти помодоро-таймер на 25 минут');
  }
  else if (data === 'plug_notes') {
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    runClaude(chatId, 'Покажи мои заметки');
  }
  else if (data === 'plug_todo') {
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    runClaude(chatId, 'Покажи мой список задач');
  }
  // === Quick Actions из главного меню ===
  else if (data === 'quick_image') {
    clearAllWaiting(chatId);
    waitingImagePrompt.add(chatId);
    setWaitingTimeout(chatId, waitingImagePrompt, 'waitingImagePrompt');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🎨 Опишите что нарисовать:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'quick_video') {
    clearAllWaiting(chatId);
    waitingVideoPrompt.add(chatId);
    setWaitingTimeout(chatId, waitingVideoPrompt, 'waitingVideoPrompt');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🎬 Опишите видео:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'quick_text') {
    clearAllWaiting(chatId);
    waitingTextPrompt.add(chatId);
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '📝 Опишите что написать:\n\nНапример: «пост про AI для Instagram» или «письмо клиенту»', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'quick_search') {
    clearAllWaiting(chatId);
    waitingSearchQuery.add(chatId);
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '🔍 Что найти в интернете?', { reply_markup: { inline_keyboard: [[{ text: '◀️ Отмена', callback_data: 'back' }]] } });
  }
  else if (data === 'export_chat') {
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    exportChatHistory(chatId);
  }
  else if (data === 'reminders_list') {
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    remindersMenu(chatId);
  }
  else if (data.startsWith('cancel_reminder_')) {
    const remId = parseInt(data.replace('cancel_reminder_', ''));
    const timer = reminderTimers.get(remId);
    if (timer) { clearTimeout(timer); reminderTimers.delete(remId); }
    config.reminders = (config.reminders || []).filter(r => r.id !== remId);
    saveConfig();
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '✅ Напоминание отменено');
    remindersMenu(chatId);
  }
  else if (data === 'media_edit_image') {
    clearAllWaiting(chatId);
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '✏️ Отправьте фото и опишите что изменить.\n\nНапример: отправьте фото + «убери фон» или «сделай ярче»');
  }
  else if (data === 'help') await editText(chatId, msgId, helpText(), mainMenu(chatId));
  else if (data === 'stats') {
    const uc = getUserConfig(chatId);
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const avgTime = stats.claudeCalls > 0 ? (stats.totalResponseTime / stats.claudeCalls / 1000).toFixed(1) : 0;
    const text = `📈 S.C.O.R.P. Статистика

⏱️ Аптайм: ${uptime} мин
📨 Сообщений: ${stats.messages}
🤖 Вызовов AI: ${stats.claudeCalls}
⚡ Среднее время ответа: ${avgTime}с
🎙️ Голосовых: ${stats.voiceMessages}
📎 Файлов: ${stats.files}
❌ Ошибок: ${stats.errors}
🧠 Активных агентов: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}
MODEL: ${uc.model}`;
    await editText(chatId, msgId, text, mainMenu(chatId));
  }
  else if (data === 'status') {
    // Перенаправляем status на объединённый tasks_menu
    cb.data = 'tasks_menu';
    return handleCallback(cb);
  }
  else if (data === 'clear') { stopTask(chatId); clearHistory(chatId); messageQueue.delete(chatId); await editText(chatId, msgId, '🗑 История, очередь и задачи очищены', mainMenu(chatId)); }
  else if (data === 'set_model') await editText(chatId, msgId, `🤖 Текущая модель: ${uc.model}\n\nВыберите провайдер:`, modelMenu());
  else if (data === 'model_settings') await editText(chatId, msgId, `⚙️ Настройки параметров для модели ${uc.model}:`, modelSettingsMenu(chatId, uc.model));
  else if (data === 'set_modeltemp') {
    clearAllWaiting(chatId);
    waitingModelSetting.set(chatId, 'temperature');
    setWaitingTimeout(chatId, waitingModelSetting, 'waitingModelSetting');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => { });
    send(chatId, `🌡 Введите значение температуры для модели ${uc.model} (от 0.0 до 2.0):\n\nОтправьте 0 или авто для сброса.`, { reply_markup: { force_reply: true } });
  }
  else if (data === 'set_modeltokens') {
    clearAllWaiting(chatId);
    waitingModelSetting.set(chatId, 'maxTokens');
    setWaitingTimeout(chatId, waitingModelSetting, 'waitingModelSetting');
    if (msgId) tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => { });
    send(chatId, `📏 Введите максимальное количество возвращаемых токенов для модели ${uc.model} (до 8192):\n\nОтправьте 0 или авто для сброса.`, { reply_markup: { force_reply: true } });
  }
  else if (data === 'reset_modelsettings') {
    if (!uc.modelSettings) uc.modelSettings = {};
    delete uc.modelSettings[uc.model];
    saveUserConfig(chatId);
    await editText(chatId, msgId, `✅ Параметры модели ${uc.model} сброшены.\n\n⚙️ Настройки параметров для модели ${uc.model}:`, modelSettingsMenu(chatId, uc.model));
  }
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
    await editText(chatId, msgId, `💬 Системный промпт\n\n${current}\n\nОтправьте новый промпт или /clear_system для сброса:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑 Сбросить', callback_data: 'clear_system' }],
          [{ text: '◀️ Назад', callback_data: 'settings' }]
        ]
      }
    });
    waitingSystemPrompt.add(chatId);
    setWaitingTimeout(chatId, waitingSystemPrompt, 'waitingSystemPrompt');
  }
  else if (data === 'clear_system') { uc.systemPrompt = ''; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Системный промпт сброшен', settingsMenu(chatId)); waitingSystemPrompt.delete(chatId); }
  else if (data === 'toggle_auto') { uc.autoModel = !uc.autoModel; saveUserConfig(chatId); await editText(chatId, msgId, `🧠 Авто-модель: ${uc.autoModel ? '✅ Включена' : '❌ Выключена'}`, settingsMenu(chatId)); }
  else if (data === 'toggle_agent') { uc.agentMode = uc.agentMode === false ? true : false; saveUserConfig(chatId); await editText(chatId, msgId, `🤖 Агент: ${uc.agentMode ? '✅ Включён' : '❌ Выключен'}`, settingsMenu(chatId)); }
  else if (data === 'toggle_thinking') { uc.thinking = !uc.thinking; saveUserConfig(chatId); await editText(chatId, msgId, `💭 Thinking: ${uc.thinking ? '✅ Включён — Claude будет размышлять глубже (effort: high)' : '❌ Выключен — стандартный режим'}`, settingsMenu(chatId)); }
  else if (data === 'stop_agents') {
    // 1. Отменяем cancellable операции
    const token = cancellableOperations.get(chatId);
    if (token) token.isCancelled = true;
    cancellableOperations.delete(chatId);
    // 2. Останавливаем активную задачу (foreground)
    stopTask(chatId);
    // 3. Останавливаем фоновые задачи
    const userBg = backgroundTasks.get(chatId);
    if (userBg) {
      for (const [taskId, task] of userBg) {
        if (task.abort) { try { task.abort.abort(); } catch (e) { } }
        task.status = 'cancelled';
      }
      userBg.clear();
    }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '⛔ Всё остановлено' });
    await editText(chatId, msgId, '⛔ Все задачи остановлены', mainMenu(chatId));
  }  // === Быстрые переключатели главного меню (mt_) ===
  else if (data === 'mt_agent') { uc.agentMode = uc.agentMode === false ? true : false; saveUserConfig(chatId); await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: `🤖 Режим агента: ${uc.agentMode ? 'включён' : 'выключен'}` }); await editText(chatId, msgId, '🤖 Главное меню', mainMenu(chatId)); }
  else if (data === 'mem_menu') {
    const s = zepMemory.stats();
    const zepLine = s.enabled ? (s.zepQuotaExhausted ? '⚠️ Zep Cloud: лимит исчерпан' : '✅ Zep Cloud активна') : '❌ Zep Cloud не настроена';
    const localLine = `📋 Локальная: ${s.localFacts} фактов, ${s.localUsers} пользователей`;
    const ctx = zepMemory.getContext(chatId);
    const ctxPreview = ctx ? `\n\nТекущий контекст:\n${ctx.slice(0, 300)}${ctx.length > 300 ? '…' : ''}` : '\n\nКонтекст пока пуст — расскажи о себе.';
    await editText(chatId, msgId, `🧠 Память\n\n${zepLine}\n${localLine}${ctxPreview}`, {
      reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'back' }]] }
    });
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
    await editText(chatId, msgId, `🔢 Максимум шагов агента (сейчас: ${uc.agentMaxSteps || 10}):`, {
      reply_markup: {
        inline_keyboard: [
          ...[5, 10, 15, 20].map(n => [{ text: (n === (uc.agentMaxSteps || 10) ? '✅ ' : '') + n, callback_data: `maxsteps_${n}` }]),
          [{ text: '◀️ Назад', callback_data: 'settings' }]
        ]
      }
    });
  }
  else if (data.startsWith('maxsteps_')) { uc.agentMaxSteps = safeParseInt(data.slice(9)); saveUserConfig(chatId); await editText(chatId, msgId, `✅ Макс шагов: ${uc.agentMaxSteps}`, settingsMenu(chatId)); }
  else if (data === 'set_lang') await editText(chatId, msgId, '🌐 Язык ответов Claude:', langMenu());
  else if (data === 'lang_ru') { uc.language = 'Всегда отвечай на русском языке.'; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Язык: Русский', settingsMenu(chatId)); }
  else if (data === 'lang_en') { uc.language = 'Always respond in English.'; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Language: English', settingsMenu(chatId)); }
  else if (data === 'lang_uk') { uc.language = 'Завжди відповідай українською мовою.'; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Мова: Українська', settingsMenu(chatId)); }
  else if (data === 'lang_es') { uc.language = 'Siempre responde en español.'; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Idioma: Español', settingsMenu(chatId)); }
  else if (data === 'lang_clear') { uc.language = ''; saveUserConfig(chatId); await editText(chatId, msgId, '✅ Языковая настройка сброшена', settingsMenu(chatId)); }
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
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Синхронизировать', callback_data: `mcp_sync_${idx}` }, { text: s.enabled !== false ? '❌ Выкл' : '✅ Вкл', callback_data: `mcp_toggle_${idx}` }],
            [{ text: '🔐 Тип авторизации', callback_data: `mcp_editauth_${idx}` }],
            [{ text: '🗑 Удалить', callback_data: `mcp_del_${idx}` }],
            [{ text: '◀️ Назад', callback_data: 'integrations' }],
          ]
        }
      });
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
      const baseId = (name || 'mcp').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mcp';
      const uc = getUserConfig(chatId);
      const existingIds = new Set((uc.mcpServers || []).map(s => (s.id || '').toLowerCase()));
      const id = existingIds.has(baseId) ? baseId + '_' + Date.now().toString(36) : baseId;
      const serverCfg = { id, name: name || id, url, apiKey: '', authType: 'auto', transport: 'http', tools: [], enabled: true, lastSync: null };
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
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎭 К режимам', callback_data: 'modes_menu' }],
            [{ text: '◀️ Главное меню', callback_data: 'main' }],
          ]
        }
      });
  }
  else if (data === 'mode_off') {
    const prevMode = uc.activeMode ? SPECIALIZED_MODES[uc.activeMode] : null;
    uc.activeMode = null;
    saveUserConfig(chatId);
    await editText(chatId, msgId,
      `❌ Режим выключен${prevMode ? ` (был: ${prevMode.icon} ${prevMode.label})` : ''}\n\nТеперь бот работает в стандартном режиме.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎭 К режимам', callback_data: 'modes_menu' }],
            [{ text: '◀️ Главное меню', callback_data: 'main' }],
          ]
        }
      });
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
  // === Задачи из меню ===
  else if (data === 'tasks_menu') {
    const userBg = getUserBgTasks(chatId);
    const fgTask = activeTasks.has(chatId);
    const todos = (config.todos || []).filter(t => t.chatId === chatId);
    const provLabel = PROVIDER_LABELS[getProvider(uc.model)] || '';
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const histLen = (chatHistory.get(chatId) || []).length;
    const uptimeH = uptime >= 60 ? `${Math.floor(uptime / 60)}ч${uptime % 60}м` : `${uptime}м`;

    let msg = '📊 Статус | 📋 Задачи\n\n';
    msg += `🤖 Модель: ${uc.model} ${provLabel}\n`;
    msg += `⏱ Аптайм: ${uptimeH} | 💬 История: ${histLen}\n\n`;

    if (fgTask) {
      const activeTask = activeTasks.get(chatId);
      const state = activeTask?.statusState;
      if (state) {
        const fmtSec = (s) => s >= 3600 ? `${Math.floor(s / 3600)}ч${Math.floor((s % 3600) / 60)}м` : s >= 60 ? `${Math.floor(s / 60)}м${s % 60}с` : `${s}с`;
        const elapsed = Math.round((Date.now() - state.startTime) / 1000);
        const progress = state.maxSteps > 0 ? Math.round((state.step / state.maxSteps) * 100) : 0;
        msg += `🔵 Основная: ${(state.actionName || 'выполняется').slice(0, 30)}\n`;
        msg += `   ${state.step}/${state.maxSteps} шагов • ${progress}% • ⏱${fmtSec(elapsed)}\n\n`;
      } else {
        msg += '🔵 Основная: выполняется\n\n';
      }
    }

    if (userBg.size > 0) {
      const fmtSec = (s) => s >= 60 ? `${Math.floor(s / 60)}м${s % 60}с` : `${s}с`;
      msg += `🔄 Фоновые (${userBg.size}/${MAX_BG_TASKS_PER_USER}):\n`;
      for (const [tid, t] of userBg) {
        const elapsed = Math.round((Date.now() - t.startTime) / 1000);
        const statusIcon = t.status === 'running' ? '⏳' : t.status === 'done' ? '✅' : '❌';
        msg += `  ${statusIcon} ${t.desc} (${fmtSec(elapsed)})\n`;
      }
      msg += '\n';
    }

    if (todos.length > 0) {
      msg += `✅ Задачи (${todos.length}):\n`;
      const statusIcons = { pending: '□', in_progress: '🔄', done: '✅' };
      todos.slice(0, 10).forEach(t => {
        msg += `  ${statusIcons[t.status] || '□'} ${t.text}\n`;
      });
    }

    if (!fgTask && userBg.size === 0 && todos.length === 0) {
      msg += '🟢 Нет активных задач';
    }

    const rows = [];
    for (const [tid, t] of userBg) {
      if (t.status === 'running') rows.push([{ text: `❌ Отменить: ${t.desc.slice(0, 20)}`, callback_data: `bg_cancel_${tid}` }]);
    }
    rows.push([{ text: '🔄 Обновить', callback_data: 'tasks_menu' }, { text: '◀️ Назад', callback_data: 'back' }]);
    await editText(chatId, msgId, msg, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data === 'back' || data === 'main') await editText(chatId, msgId, '🤖 Главное меню', mainMenu(chatId));

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
      await editText(chatId, msgId, '⚡ Навыки пусты\n\nСохраняйте часто используемые промпты:\n/skill <имя> <промпт>\n\nПримеры:\n• /skill review Сделай code review\n• /skill summary Дай краткое резюме\n\nИли отправьте .txt файл при создании', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Создать навык', callback_data: 'skill_create' }],
            [{ text: '◀️ Назад', callback_data: 'back' }]
          ]
        }
      });
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
      const pageLabel = totalPages > 1 ? ` — стр. ${page + 1}/${totalPages}` : '';
      await editText(chatId, msgId, `⚡ Навыки (${skills.length})${pageLabel}:`, { reply_markup: { inline_keyboard: rows } });
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
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '▶️ Запуск', callback_data: `skill_run_${idx}` }, { text: '✏️ Редактировать', callback_data: `skill_edit_${idx}` }],
              [{ text: '🗑 Удалить', callback_data: `skill_del_${idx}` }, { text: '◀️ Назад', callback_data: 'skills_menu' }],
            ]
          }
        }
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
      await editText(chatId, msgId, `✏️ Редактирование: ${skill.name}\n\nВыберите что изменить:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Имя', callback_data: `skedit_name_${idx}` }, { text: '📄 Промпт', callback_data: `skedit_prompt_${idx}` }],
            [{ text: '📝 Описание', callback_data: `skedit_desc_${idx}` }, { text: '📂 Категория', callback_data: `skedit_cat_${idx}` }],
            [{ text: '◀️ Назад', callback_data: `skill_info_${idx}` }],
          ]
        }
      });
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
    const pageLabel = totalPages > 1 ? ` — стр. ${page + 1}/${totalPages}` : '';
    await editText(chatId, msgId, `👥 Агенты (встроенных: ${builtinEntries.length - 1}, своих: ${custom.length})${pageLabel}\n\nСтатус: ${agentOn ? '✅ Активна' : '❌ Выключена'}`, { reply_markup: { inline_keyboard: rows } });
  }
  else if (data === 'prison_blocks') {
    // ═══ PRISON CELL BLOCKS DASHBOARD ═══
    const tracker = multiAgentTasks.get(chatId);
    const allAgents = tracker ? tracker.agents : [];
    const byBlock = {};
    for (const sa of allAgents) {
      const block = getCellBlock(sa.role);
      if (!byBlock[block]) byBlock[block] = [];
      byBlock[block].push(sa);
    }
    const WING_ICONS = { 'A-Wing': '💻', 'B-Wing': '🔬', 'C-Wing': '✍️', 'D-Wing': '⚡', 'E-Wing': '🔎', 'F-Wing': '🎨', 'G-Wing': '📈', 'Z-Wing': '🔒' };
    const WING_NAMES = { 'A-Wing': 'Кодеры', 'B-Wing': 'Исследователи', 'C-Wing': 'Писатели', 'D-Wing': 'Исполнители', 'E-Wing': 'Ревьюеры', 'F-Wing': 'Дизайнеры', 'G-Wing': 'Бизнес', 'Z-Wing': 'Одиночка' };

    let text = '🏛 𝗖𝗘𝗟𝗟 𝗕𝗟𝗢𝗖𝗞𝗦\n━━━━━━━━━━━━━━━━━━\n\n';

    if (allAgents.length === 0) {
      text += '🔇 Тюрьма пуста — нет активных инмейтов.\n\nОтправьте сложный запрос, чтобы оркестратор назначил заключённых.';
    } else {
      const active = allAgents.filter(a => a.status === 'running').length;
      const done = allAgents.filter(a => a.status === 'done').length;
      const err = allAgents.filter(a => a.status === 'error').length;
      text += `📊 ⛏️${active} Active │ ✅${done} Done │ ❌${err} Err │ 👥${allAgents.length} Total\n\n`;

      for (const [block, agents] of Object.entries(byBlock)) {
        const icon = WING_ICONS[block] || '📦';
        const name = WING_NAMES[block] || block;
        text += `${icon} ${block}: ${name}\n`;
        for (const sa of agents) {
          const effectiveRoles = getEffectiveAgents(chatId);
          const ri = effectiveRoles[sa.role] || AGENT_ROLES[sa.role] || { icon: '🔄', label: sa.role };
          const num = sa.inmateNum || '???';
          const langTag = sa.language ? ` ${PRISON_CONFIG.languageLabels[sa.language] || sa.language}` : '';
          const modelTag = sa.model ? ` [${sa.model}]` : '';
          const dur = sa.endTime ? `${Math.round((sa.endTime - sa.startTime) / 1000)}с` : sa.status === 'running' ? `${Math.round((Date.now() - sa.startTime) / 1000)}с` : '';
          const statusIcon = sa.status === 'running' ? '⛏️' : sa.status === 'done' ? '✅' : '❌';
          text += `  ${statusIcon} #${num} ${ri.icon} ${ri.label}${langTag}${modelTag} ${dur}\n`;
          if (sa.task) text += `     📋 ${sa.task.slice(0, 50)}\n`;
        }
        text += '\n';
      }
    }

    const rows = [[{ text: '🔄 Обновить', callback_data: 'prison_blocks' }], [{ text: '◀️ Назад', callback_data: 'back' }]];
    await editText(chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
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
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '▶️ Тест', callback_data: `agent_test_${idx}` }, { text: '✏️ Редактировать', callback_data: `agent_edit_${idx}` }],
              [{ text: agent.enabled !== false ? '❌ Выключить' : '✅ Включить', callback_data: `agent_toggle_${idx}` }, { text: '🗑 Удалить', callback_data: `agent_del_${idx}` }],
              [{ text: '◀️ Назад', callback_data: 'agents_menu' }],
            ]
          }
        }
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
      await editText(chatId, msgId, `✏️ Редактирование: ${agent.icon || '🤖'} ${agent.label}\n\nВыберите что изменить:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Имя', callback_data: `agedit_name_${idx}` }, { text: '🎨 Иконка', callback_data: `agedit_icon_${idx}` }],
            [{ text: '📄 Промпт', callback_data: `agedit_prompt_${idx}` }, { text: '📝 Описание', callback_data: `agedit_desc_${idx}` }],
            [{ text: '🔢 Шагов', callback_data: `agedit_steps_${idx}` }, { text: '🤖 Модель', callback_data: `agedit_model_${idx}` }],
            [{ text: '◀️ Назад', callback_data: `agent_info_${idx}` }],
          ]
        }
      });
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
    if (hasOpenAIKey(chatId)) extra.push({ text: '🟢 GPT-4.1', callback_data: `agsetmodel_${idx}_gpt-4.1` });
    if (hasOpenAIKey(chatId)) extra.push({ text: '🛠️ Codex (API)', callback_data: `agsetmodel_${idx}_codex` });
    if (hasCodexCli()) extra.push({ text: '🛠️ Codex CLI', callback_data: `agsetmodel_${idx}_codex-cli` });
    if (process.env.GROQ_API_KEY) extra.push({ text: '⚡ Groq', callback_data: `agsetmodel_${idx}_llama3-70b` });
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
      const testPrompt = `Ты агент "${agent.label}". Представься и опиши что умеешь в 3-4 предложениях.`;
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
    const info = `👤 User ${targetId}\n\nРоль: ${roleIcon}\nСтатус: ${bannedTag}\nМодель: ${tc.model}\nПапка: ${tc.workDir}\nАгент: ${tc.agentMode !== false ? '✅' : '❌'}`;
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
      await editText(chatId, msgId, `🔑 Ключевые слова для @${ch.username}\n\nТекущие: ${current}\n\nОтправьте новые через запятую или "clear" для сброса:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Сбросить фильтр', callback_data: `ch_kw_clear_${idx}` }],
            [{ text: '◀️ Назад', callback_data: `ch_${idx}` }]
          ]
        }
      });
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
      await editText(chatId, msgId, `🧠 Инструкция для @${ch.username}\n\nТекущая:\n${current}\n\nОтправьте новую инструкцию или "clear" для сброса.\n\nПримеры:\n• «Присылай только новости про AI, кратко на 2 предложения»\n• «Фильтруй рекламу, присылай только полезный контент с кратким резюме»`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Сбросить', callback_data: `ch_prompt_clear_${idx}` }],
            [{ text: '◀️ Назад', callback_data: `ch_${idx}` }]
          ]
        }
      });
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
  else if (data === 'stats') {
    await editText(chatId, msgId, '📈 Статистика\n\nРаздел в разработке.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'main' }]] } });
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
    } catch (e) { await editText(chatId, msgId, `❌ ${e.message}`, nbMainMenu); }
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
    } catch (e) { await editText(chatId, msgId, `❌ ${e.message}`, nbMainMenu); }
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
    } catch (e) { await editText(chatId, msgId, `❌ ${e.message}`, nbMainMenu); }
  }

  // === API Ключи ===
  else if (data === 'api_keys') {
    const providers = [
      { key: 'openai', label: '🟢 OpenAI', envKey: 'OPENAI_API_KEY' },
      { key: 'google', label: '🔵 Google (Gemini)', envKey: 'GEMINI_API_KEY' },
      { key: 'anthropic', label: '🟣 Anthropic', envKey: 'ANTHROPIC_API_KEY' },
      { key: 'groq', label: '⚡ Groq', envKey: 'GROQ_API_KEY' },
      { key: 'openrouter', label: '🌌 OpenRouter', envKey: 'OPENROUTER_API_KEY' },
      { key: 'deepseek', label: '🐳 DeepSeek', envKey: 'DEEPSEEK_API_KEY' },
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
    const labels = { openai: 'OpenAI', google: 'Google (Gemini)', groq: 'Groq', anthropic: 'Anthropic', openrouter: 'OpenRouter', deepseek: 'DeepSeek' };
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
    const envKeys = { openai: process.env.OPENAI_API_KEY, google: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY };
    const key = userKey || envKeys[provider];
    if (!key) { await editText(chatId, msgId, `❌ Ключ ${provider} не задан`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'api_keys' }]] } }); return; }
    await editText(chatId, msgId, `🔍 Проверяю ${provider}...`);
    try {
      const testModels = { openai: 'gpt-4o-mini', google: 'gemini-2.5-flash', groq: 'llama3-8b', anthropic: 'claude-3-5-haiku', openrouter: 'gpt-oss-20b', deepseek: 'deepseek-chat' };
      await callAI(testModels[provider], [{ role: 'user', content: 'Hi, reply with just OK' }], '', true, chatId);
      await editText(chatId, msgId, `✅ ${provider}: ключ работает!`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К ключам', callback_data: 'api_keys' }]] } });
    } catch (e) {
      await editText(chatId, msgId, `❌ ${provider}: ${e.message}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К ключам', callback_data: 'api_keys' }]] } });
    }
  }

  // === Настройки изображений ===
  else if (data === 'img_settings') {
    const imgModel = IMAGE_MODELS[uc.imageModel] || IMAGE_MODELS['nano-banana'];
    const text = `🎨 Настройки изображений\n\n🤖 Модель: ${imgModel.label}\n📐 Формат: ${uc.imageAspect || '1:1'}`;
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
    await editText(chatId, msgId, `📐 Формат фото (сейчас: ${uc.imageAspect || '1:1'}):`, {
      reply_markup: {
        inline_keyboard: [
          ['1:1', '16:9', '9:16', '3:4', '4:3'].map(a => ({ text: (a === (uc.imageAspect || '1:1') ? '✅ ' : '') + a, callback_data: `imgaspect_${a}` })),
          [{ text: '◀️ Назад', callback_data: 'settings' }]
        ]
      }
    });
  }
  else if (data === 'vid_format') {
    await editText(chatId, msgId, `📐 Формат видео (сейчас: ${uc.videoAspect || '16:9'}):`, {
      reply_markup: {
        inline_keyboard: [
          ['16:9', '9:16'].map(a => ({ text: (a === (uc.videoAspect || '16:9') ? '✅ ' : '') + a, callback_data: `vidaspect_${a}` })),
          [{ text: '◀️ Назад', callback_data: 'settings' }]
        ]
      }
    });
  }
  else if (data === 'vid_res') {
    await editText(chatId, msgId, `📏 Разрешение видео (сейчас: ${uc.videoResolution || '720p'}):`, {
      reply_markup: {
        inline_keyboard: [
          ['720p', '1080p', '4K'].map(r => ({ text: (r === (uc.videoResolution || '720p') ? '✅ ' : '') + r, callback_data: `vidres_${r}` })),
          [{ text: '◀️ Назад', callback_data: 'settings' }]
        ]
      }
    });
  }
  else if (data === 'vid_dur') {
    await editText(chatId, msgId, `⏱ Длительность видео (сейчас: ${uc.videoDuration || '8'}с):`, {
      reply_markup: {
        inline_keyboard: [
          ['4', '6', '8'].map(d => ({ text: (d === (uc.videoDuration || '8') ? '✅ ' : '') + d + 'с', callback_data: `viddur_${d}` })),
          [{ text: '◀️ Назад', callback_data: 'settings' }]
        ]
      }
    });
  }

  // === Статистика ===
  else if (data === 'stats') {
    const uptime = Math.round((Date.now() - stats.startTime) / 60000);
    const avgTime = stats.claudeCalls > 0 ? (stats.totalResponseTime / stats.claudeCalls / 1000).toFixed(1) : 0;
    await editText(chatId, msgId, `📈 Статистика\n\n⏱ Аптайм: ${uptime} мин\n📨 Сообщений: ${stats.messages}\n🤖 Claude вызовов: ${stats.claudeCalls}\n⚡ Среднее время ответа: ${avgTime}с\n🎙 Голосовых: ${stats.voiceMessages}\n📎 Файлов: ${stats.files}\n❌ Ошибок: ${stats.errors}\n🧠 AI активен: ${activeClaudeCount}/${MAX_CLAUDE_PROCS}\n🤖 Модель: ${uc.model}`, mainMenu(chatId));
  }

  tgApi('answerCallbackQuery', { callback_query_id: cb.id });
}

function stopTask(chatId, taskId = null) {
  const fgTasks = getActiveFgTasks(chatId);

  if (taskId) {
    // Останавливаем конкретную задачу
    const task = fgTasks.get(taskId);
    if (task) {
      if (task.timer) clearInterval(task.timer);
      if (task.pid) { try { process.kill(task.pid); } catch (e) { } }
      if (task.abort) { try { task.abort.abort(); } catch (e) { } }
      if (task.msgId) del(chatId, task.msgId);
      if (task._claudeSlot) releaseClaudeSlot(task._claudeSlot);
      fgTasks.delete(taskId);
      if (fgTasks.size === 0) activeTasks.delete(chatId);
    }
  } else {
    // Останавливаем все задачи пользователя
    for (const [tId, task] of fgTasks) {
      if (task.timer) clearInterval(task.timer);
      if (task.pid) { try { process.kill(task.pid); } catch (e) { } }
      if (task.abort) { try { task.abort.abort(); } catch (e) { } }
      if (task.msgId) del(chatId, task.msgId);
      if (task._claudeSlot) releaseClaudeSlot(task._claudeSlot);
    }
    fgTasks.clear();
    activeTasks.delete(chatId);
  }
  messageQueue.delete(chatId);
}

// === MCP HTTP/SSE Client — универсальный клиент для пользовательских MCP-серверов ===
class MCPHttpClient {
  constructor(config) {
    this.serverId = config.id || 'mcp';
    this.url = config.url.replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.authType = config.authType || 'auto'; // bearer | x-api-key | api-key | custom | auto
    this.name = config.name || this.serverId;
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
    const reqId = Date.now();
    const body = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params });
    const res = await fetch(this.url, { method: 'POST', headers: this._headers(), body, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const ct = res.headers.get('content-type') || '';
    let data;
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      const lines = text.split('\n');
      let lastValid = null;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]' || payload === '') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) lastValid = parsed;
        } catch (e) { /* skip malformed chunk */ }
      }
      data = lastValid;
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
      }).catch(() => { });
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

const MCP_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/** Возвращает все доступные MCP-серверы: из конфига пользователя + из ~/.claude/settings.json */
function getAllMcpServers(chatId) {
  const list = [];
  const uc = getUserConfig(chatId);
  for (const s of (uc.mcpServers || [])) {
    if (s.enabled === false) continue;
    list.push(s);
  }
  if (fs.existsSync(MCP_SETTINGS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(MCP_SETTINGS_PATH, 'utf8'));
      const servers = raw.mcpServers || raw.mcp_servers || {};
      for (const [id, entry] of Object.entries(servers)) {
        if (!entry || list.some(s => s.id === id)) continue;
        const url = entry.url || entry.endpoint;
        if (!url || typeof url !== 'string') continue;
        let apiKey = '';
        let authType = 'auto';
        if (entry.headers && typeof entry.headers === 'object') {
          const h = entry.headers;
          if (h.Authorization) {
            apiKey = h.Authorization.startsWith('Bearer ') ? h.Authorization.slice(7) : h.Authorization;
            authType = 'bearer';
          } else if (h['x-api-key']) { apiKey = h['x-api-key']; authType = 'x-api-key'; }
          else if (h['api-key']) { apiKey = h['api-key']; authType = 'api-key'; }
        }
        list.push({
          id,
          name: entry.name || id,
          url: url.replace(/\/+$/, ''),
          apiKey,
          authType,
          transport: 'http',
          tools: [],
          enabled: true,
          _source: 'file',
        });
      }
    } catch (e) { /* ignore */ }
  }
  return list;
}

/** Найти конфиг сервера по id или имени (регистронезависимо, id может быть префиксом) */
function findMcpServerConfig(chatId, serverId) {
  const normalized = String(serverId).trim().toLowerCase();
  const all = getAllMcpServers(chatId);
  return all.find(s => {
    const sid = (s.id || '').toLowerCase();
    const sname = (s.name || '').toLowerCase();
    return sid === normalized || sname === normalized || sid.startsWith(normalized) || normalized.startsWith(sid);
  }) || null;
}

async function getMcpClient(chatId, serverId) {
  const serverCfg = findMcpServerConfig(chatId, serverId);
  if (!serverCfg) throw new Error(`MCP сервер "${serverId}" не найден. Добавьте сервер в Настройки → Интеграции (MCP) или в ~/.claude/settings.json`);
  const effectiveId = serverCfg.id;
  const key = `${chatId}_${effectiveId}`;
  if (mcpClients.has(key) && mcpClients.get(key).ready) return mcpClients.get(key);
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
  const allServers = getAllMcpServers(chatId);

  // Auto-sync только пользовательские серверы (не из файла) без tools
  for (const s of allServers) {
    if (s._source !== 'file' && (!s.tools || s.tools.length === 0)) {
      syncMcpServer(chatId, s).catch(e => console.error(`[MCP auto-sync] ${s.name}: ${e.message}`));
    }
  }

  const prefix = `${chatId}_`;
  const byId = new Map();
  for (const s of allServers) {
    if (s.tools?.length > 0) byId.set(s.id, { id: s.id, name: s.name, tools: s.tools });
  }
  for (const [key, client] of mcpClients) {
    if (!key.startsWith(prefix) || !client.ready || !client.tools?.length) continue;
    const id = key.slice(prefix.length);
    if (!byId.has(id)) byId.set(id, { id, name: client.name, tools: client.tools });
  }

  const servers = [...byId.values()];
  if (servers.length === 0) return '';
  let text = '\n\n## Доступные MCP-интеграции (вызывай через [ACTION: mcp])\n';
  text += 'Формат: server: <id или имя>\\ntool: <имя>\\nargs: <JSON или пустой {}>\n';
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
      if (this.process && !this.process.killed) { try { this.process.kill(); } catch (e) { } }
      // ВАЖНО: обязательный флаг --transport stdio для stdin/stdout режима
      this.process = spawn('/opt/homebrew/bin/notebooklm-mcp', ['--transport', 'stdio'], {
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
              // notifications/initialized возвращает error -32602 — это нормально, игнорируем
              if (msg.error && msg.error.code !== -32602) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result || {});
            }
          } catch (e) { /* silent json parse errors */ }
        }
      });
      this.process.stderr.on('data', () => { }); // подавляем stderr FastMCP-баннеров
      this.process.on('close', (code) => {
        console.log(`[NotebookLM MCP] процесс завершён (code=${code})`);
        this.ready = false;
        this.startPromise = null;
        // Отклоняем все pending запросы
        for (const [, { reject, timer }] of this.pending) { clearTimeout(timer); reject(new Error('MCP процесс завершён')); }
        this.pending.clear();
      });
      this.process.on('error', (e) => {
        console.error(`[NotebookLM MCP] ошибка: ${e.message}`);
        this.ready = false;
        this.startPromise = null;
      });

      // MCP Handshake: шаг 1 — initialize
      await this._send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'telegram-bot', version: '1.0' }
      }, 15000);

      // Шаг 2 — уведомление (ответа не ждём, это notification)
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

      this.ready = true;
      this.startPromise = null;
      console.log('✅ NotebookLM MCP: подключён (transport=stdio)');
    } catch (e) {
      this.ready = false;
      this.startPromise = null;
      console.error(`❌ NotebookLM MCP init error: ${e.message}`);
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
    try { return JSON.parse(combined); } catch (e) { return combined; }
  }

  stop() {
    if (this.process) { try { this.process.kill(); } catch (e) { } this.process = null; }
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
  const updateStatus = async (text, menu, isFinal = false) => {
    if (msgId) { await editText(chatId, msgId, text, menu); if (isFinal) autoDeleteMsg(chatId, msgId); return; }
    const res = await send(chatId, text, menu);
    if (res?.result?.message_id) { msgId = res.result.message_id; if (isFinal) autoDeleteMsg(chatId, msgId); }
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
              await updateStatus(resultText, nbDetailMenu(nbId), true);
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
                await fs.promises.writeFile(filePath, buf);
                if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) await sendAudio(chatId, filePath, label);
                else if (['mp4', 'webm', 'mov'].includes(ext)) await sendVideo(chatId, filePath, label);
                else if (['png', 'jpg', 'jpeg'].includes(ext)) await sendPhoto(chatId, filePath, label);
                else await sendDocument(chatId, filePath);
                try { await fs.promises.unlink(filePath); } catch (e) { }
              } catch (dlErr) {
                resultText += `\n⚠️ Не удалось скачать: ${dlErr.message}`;
              }
            }
            resultText += `\n\n📓 ${nbLink}`;
            await updateStatus(resultText, nbDetailMenu(nbId), true);
            return;
          }
          if (st === 'failed' || st === 'error') {
            await updateStatus(`❌ ${label}: ошибка генерации\n${latest.error || ''}\n\n📓 ${nbLink}`, nbDetailMenu(nbId), true);
            return;
          }
        }
      } catch (pollErr) {
        // Поллинг-ошибка — продолжаем пробовать
      }
    }
    // Таймаут поллинга
    await updateStatus(`⏱ ${label}: генерация заняла >5мин\nПроверьте вручную:\n${nbLink}`, nbDetailMenu(nbId), true);
  } catch (e) {
    await updateStatus(`❌ ${label}: ${e.message}\n\n📓 ${nbLink}`, nbDetailMenu(nbId), true);
  }
}

// === Помощь ===
function helpText() {
  return `🤖 *S.C.O.R.P.* — просто напишите что нужно

💬 *Примеры:*
• «нарисуй кота в космосе» — изображение
• «сделай видео заката» — видео
• «напомни через 2ч позвонить» — напоминание
• «найди в интернете новости AI» — веб-поиск
• «напиши пост для Instagram» — генерация текста
• «переведи на английский» — перевод
• «выполни: npm init» — команды

🚀 *Quick Actions в меню:*
🎨 Нарисовать • 🎬 Видео • 📝 Текст

🛠 *Инструменты:*
📓 База знаний • 📤 Экспорт • 🔍 Поиск • ⏰ Напоминания

📋 /menu • ⚙️ /settings • 🎭 /mode • 👤 /profile
🔄 /clear • ⛔ /stop • ❓ /help

🎤 Голос · 📎 Файлы · 📷 Фото — всё распознаётся`;
}

// === Bash команда ===
// ############################################################
// # 6. ИНСТРУМЕНТЫ (TOOLS) / ОПЕРАЦИИ BASH
// ############################################################
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
    try { child.kill(); } catch (e) { }
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
  sendTemp(chatId, `📥 Скачиваю ${fileName}...`);

  const downloaded = await downloadTelegramFile(fileId, destPath);
  if (!downloaded) {
    send(chatId, `❌ Не удалось скачать файл`);
    return true;
  }

  sendTemp(chatId, `✅ Файл сохранён: ${destPath}`);

  // === Обработка одиночного фото с типом кадра / анимацией ===
  if (msg.photo && !msg.media_group_id) {
    const capTest = caption || '';
    const isStartFrame = /начальный\s*кадр|старт[\s-]?кадр|start[\s-]?frame|first[\s-]?frame|первый\s*кадр/i.test(capTest);
    const isEndFrame = /конечный\s*кадр|финальный\s*кадр|end[\s-]?frame|last[\s-]?frame|финиш[\s-]?кадр|последний\s*кадр/i.test(capTest);
    const isReference = /^референс|^reference|\bреференс\b|\breference\b/i.test(capTest) && !/видео|video|animate|анимац/i.test(capTest);
    const isAnimate = /оживи|анимируй|animate|сделай\s+видео|создай\s+видео|в\s+движение|оживить|make.*video|video.*from|из.*фото.*видео|видео.*из.*фото/i.test(capTest);

    // Всегда читаем imgData для фото — нужно для хранения и прямой анимации
    let imgData = null;
    try { imgData = (await fs.promises.readFile(destPath)).toString('base64'); } catch (e) { console.warn('Photo read failed:', e.message); }

    if (imgData) {
      // Всегда сохраняем последнее загруженное фото — агент сможет использовать его
      if (!sessionFrames.has(chatId)) sessionFrames.set(chatId, { lastPhotos: [], lastPhotosPaths: [] });
      const frames = sessionFrames.get(chatId);
      frames.lastPhoto = imgData;
      frames.lastPhotoPath = destPath;
      frames.lastPhotoAt = Date.now();
      
      // Мульти-фото: добавляем в список (ограничим 10 последними)
      if (!frames.lastPhotos) frames.lastPhotos = [];
      if (!frames.lastPhotosPaths) frames.lastPhotosPaths = [];
      frames.lastPhotos.push(imgData);
      frames.lastPhotosPaths.push(destPath);
      if (frames.lastPhotos.length > 10) {
        frames.lastPhotos.shift();
        frames.lastPhotosPaths.shift();
      }

      if (isStartFrame || isEndFrame || isReference) {
        frames.savedAt = Date.now();
        if (isStartFrame) {
          frames.startFrame = imgData;
          frames.startPath = destPath;
          const stored = [];
          if (frames.endFrame) stored.push('конечный кадр ✅');
          if (frames.referenceImage) stored.push('референс ✅');
          const extra = stored.length > 0 ? `\nУже сохранено: ${stored.join(', ')}` : '';
          const hint = frames.endFrame
            ? '\n\nОба кадра готовы! Напиши промпт для видео — агент создаст анимацию от первого к последнему кадру.'
            : '\n\nТеперь отправь конечный кадр с подписью "конечный кадр" или просто напиши промпт для видео.';
          sendTemp(chatId, `🎬 Начальный кадр сохранён${extra}${hint}`);
        } else if (isEndFrame) {
          frames.endFrame = imgData;
          frames.endPath = destPath;
          const stored = [];
          if (frames.startFrame) stored.push('начальный кадр ✅');
          if (frames.referenceImage) stored.push('референс ✅');
          const extra = stored.length > 0 ? `\nУже сохранено: ${stored.join(', ')}` : '';
          const hint = frames.startFrame
            ? '\n\nОба кадра готовы! Напиши промпт — агент создаст видео от первого кадра к последнему.\n⚠️ Режим A→B работает только с veo-2. Для veo-3 используется только начальный кадр.'
            : '\n\nТеперь отправь начальный кадр или напиши промпт для видео.';
          sendTemp(chatId, `🎬 Конечный кадр сохранён${extra}${hint}`);
        } else if (isReference) {
          frames.referenceImage = imgData;
          frames.refPath = destPath;
          sendTemp(chatId, `🎨 Референс сохранён. Используй его:\n• Для генерации видео — напиши промпт\n• Для генерации изображений — напиши задание\n• Для очистки — /clearframes`);
        }
        return true;
      }

      // Прямое оживление: фото + "оживи / animate / сделай видео"
      if (isAnimate) {
        const userInstruction = capTest
          .replace(/^(оживи|анимируй|animate|сделай\s+видео|создай\s+видео|в\s+движение|оживить)\s*/i, '')
          .trim();
        const statusMsg = await send(chatId, `🎬 Оживляю изображение...`);
        const statusMsgId = statusMsg?.result?.message_id;
        const startTime = Date.now();
        try {
          // AI-powered animation prompt
          const animPrompt = await mediaPromptEngine.generateAnimationPrompt(
            userInstruction,
            userInstruction || 'a photograph'
          );
          console.log(`[MediaEngine] Animation prompt: ${animPrompt.slice(0, 100)}...`);
          const result = await generateVideo(chatId, animPrompt, {
            referenceImage: imgData,
            onProgress: (poll) => {
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              if (statusMsgId) editText(chatId, statusMsgId, `🎬 Генерация видео... ⏱ ${elapsed}с`);
            }
          });
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          if (statusMsgId) { editText(chatId, statusMsgId, `✅ Видео готово (${elapsed}с)`); autoDeleteMsg(chatId, statusMsgId); }
          await sendVideo(chatId, result.path, animPrompt.slice(0, 200));
          try { fs.unlinkSync(result.path); } catch (e) { }
        } catch (e) {
          if (statusMsgId) { editText(chatId, statusMsgId, `❌ ${e.message}`); autoDeleteMsg(chatId, statusMsgId); }
        }
        return true;
      }
    }
  }

  // Если есть caption — отправить в AI с контекстом о файле
  if (caption) {
    runClaude(chatId, `[Пользователь отправил файл: ${destPath}]\n${caption}`);
    return true;
  }

  // Обработка группы фото (media_group) для мульти-изображения
  if (msg.photo && msg.media_group_id) {
    const groupId = msg.media_group_id;
    if (!mediaGroupBuffer.has(groupId)) {
      mediaGroupBuffer.set(groupId, { chatId, photos: [], paths: [], caption: caption || '', timer: null, _created: Date.now() });
    }
    const group = mediaGroupBuffer.get(groupId);
    try {
      const imgData = (await fs.promises.readFile(destPath)).toString('base64');
      group.photos.push(imgData);
      group.paths.push(destPath);
    } catch (e) { console.warn('Media group photo read failed:', e.message); }
    if (!group.caption && caption) group.caption = caption;
    // Сбрасываем таймер — ждём все фото в группе
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(async () => {
      mediaGroupBuffer.delete(groupId);

      // Сохраняем группу фото в сессию для последующего редактирования
      if (!sessionFrames.has(chatId)) sessionFrames.set(chatId, { lastPhotos: [], lastPhotosPaths: [] });
      const frames = sessionFrames.get(chatId);
      frames.lastPhotos = group.photos;
      frames.lastPhotosPaths = group.paths;
      frames.lastPhoto = group.photos[0];
      frames.lastPhotoPath = group.paths[0];
      frames.lastPhotoAt = Date.now();
      frames.savedAt = Date.now();

      if (group.photos.length >= 1 && group.caption) {
        const cap = group.caption.toLowerCase();
        const isVideoReq = /видео|video|animate|анимац|сделай.*вид|создай.*вид/.test(cap);
        if (isVideoReq) {
          // Видео из фото: первое = start frame, второе (если есть) = end frame
          const hasEndFrame = group.photos.length >= 2;
          const label = hasEndFrame ? `A→B анимация из ${group.photos.length} кадров` : `видео из фото`;
          const statusMsg = await send(chatId, `🎬 Генерация ${label}...`);
          const statusMsgId = statusMsg?.result?.message_id;
          const startTime = Date.now();
          try {
            const vidOpts = {
              startFrame: group.photos[0],
              onProgress: (poll) => {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                if (statusMsgId) editText(chatId, statusMsgId, `🎬 Генерация ${label}... ⏱ ${elapsed}с`);
              }
            };
            if (hasEndFrame) vidOpts.endFrame = group.photos[group.photos.length - 1];
            const result = await generateVideo(chatId, group.caption, vidOpts);
            if (statusMsgId) { editText(chatId, statusMsgId, '✅ Видео готово'); autoDeleteMsg(chatId, statusMsgId); }
            await sendVideo(chatId, result.path, group.caption.slice(0, 200));
            try { fs.unlinkSync(result.path); } catch (e) { }
          } catch (e) {
            if (statusMsgId) { editText(chatId, statusMsgId, `❌ ${e.message}`); autoDeleteMsg(chatId, statusMsgId); }
          }
        } else if (group.photos.length > 1) {
          // Мульти-изображение
          const statusMsg = await send(chatId, `🎨 Мульти-композиция (${group.photos.length} фото)...`);
          const statusMsgId = statusMsg?.result?.message_id;
          try {
            const results = await generateImage(chatId, group.caption, { model: 'nano-banana-pro', referenceImages: group.photos });
            if (statusMsgId) { editText(chatId, statusMsgId, '✅ Готово'); autoDeleteMsg(chatId, statusMsgId); }
            for (const r of results) {
              if (r.type === 'image') {
                await sendPhoto(chatId, r.path, group.caption.slice(0, 200));
                try { fs.unlinkSync(r.path); } catch (e) { }
              }
            }
          } catch (e) {
            if (statusMsgId) { editText(chatId, statusMsgId, `❌ ${e.message}`); autoDeleteMsg(chatId, statusMsgId); }
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
      const fileContent = (await fs.promises.readFile(destPath, 'utf8')).trim();
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
      const fileContent = (await fs.promises.readFile(destPath, 'utf8')).trim();
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
      const fileContent = (await fs.promises.readFile(destPath, 'utf8')).trim();
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
      const fileContent = (await fs.promises.readFile(destPath, 'utf8')).trim();
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

  if (getActiveFgTasksCount(chatId) >= MAX_CONCURRENT_TASKS_PER_USER) {
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
    const audioData = (await fs.promises.readFile(filePath)).toString('base64');
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeMap = { ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', opus: 'audio/opus' };
    const mimeType = mimeMap[ext] || 'audio/ogg';

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Транскрибируй это аудио. Выведи ТОЛЬКО текст транскрипции, ничего больше. Определи язык автоматически.' },
            { inline_data: { mime_type: mimeType, data: audioData } }
          ]
        }],
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
    if (statusMsgId) { editText(chatId, statusMsgId, `❌ Не удалось скачать голосовое`); autoDeleteMsg(chatId, statusMsgId); }
    else sendTemp(chatId, `❌ Не удалось скачать голосовое`);
    return true;
  }

  try {
    const result = await transcribeVoice(destPath, chatId);
    try { fs.unlinkSync(destPath); } catch (e) { }

    if (result.error || !result.text) {
      if (statusMsgId) { editText(chatId, statusMsgId, `❌ Не удалось распознать: ${result.error || 'пустой текст'}`); autoDeleteMsg(chatId, statusMsgId); }
      else sendTemp(chatId, `❌ Не удалось распознать: ${result.error || 'пустой текст'}`);
      return true;
    }

    const text = result.text;
    console.log(`🎙 Голосовое: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    if (statusMsgId) { editText(chatId, statusMsgId, `🎙 «${text}»`); autoDeleteMsg(chatId, statusMsgId); }
    else sendTemp(chatId, `🎙 «${text}»`);

    if (activeTasks.has(chatId)) {
      enqueue(chatId, { text, type: 'text' });
      sendTemp(chatId, `📬 В очереди (позиция: ${getQueueSize(chatId)})`);
    } else {
      runClaude(chatId, text);
    }
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch (e) { }
    console.error('Voice handling error:', err);
    if (statusMsgId) { editText(chatId, statusMsgId, `❌ Ошибка: ${err.message}`); autoDeleteMsg(chatId, statusMsgId); }
    else sendTemp(chatId, `❌ Ошибка распознавания: ${err.message}`);
  }
  return true;
}

// === Запуск AI (async) ===
const MAX_CLAUDE_PROCS = 5;
let activeClaudeCount = 0;
const activeClaudeTokens = new Set(); // track each active slot by unique token
function acquireClaudeSlot() {
  if (activeClaudeTokens.size >= MAX_CLAUDE_PROCS) return null;
  const token = `slot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeClaudeTokens.add(token);
  activeClaudeCount = activeClaudeTokens.size;
  return token;
}
function releaseClaudeSlot(token) {
  if (token) activeClaudeTokens.delete(token);
  activeClaudeCount = activeClaudeTokens.size;
}
const PARALLEL_AGENT_LIMIT = 10;

// === PRISON ORCHESTRATION SYSTEM ===
// Тюремная метафора: Warden (надзиратель) = оркестратор, Inmates (заключённые) = субагенты
// Каждый "заключённый" имеет номер, специализацию, язык и статус
const PRISON_CONFIG = {
  enabled: true,
  wardenIcon: '👮',
  inmateIcon: '🟠',
  cellBlockIcons: { code: '💻', research: '🔍', text: '✍️', exec: '⚡', design: '🎨', data: '📊', security: '🔒', devops: '🔧' },
  statusIcons: { idle: '💤', working: '⛏️', done: '✅', error: '❌', investigating: '🔎', transferring: '📡' },
  // Языки для мульти-язычных агентов (совещание на разных языках)
  languages: ['ru', 'en', 'zh', 'es', 'de'],
  languageLabels: { ru: '🇷🇺 RU', en: '🇺🇸 EN', zh: '🇨🇳 ZH', es: '🇪🇸 ES', de: '🇩🇪 DE' },
  languagePrompts: {
    ru: 'Отвечай и думай на русском языке.',
    en: 'Think and respond in English.',
    zh: '请用中文思考和回答。',
    es: 'Piensa y responde en español.',
    de: 'Denke und antworte auf Deutsch.',
  },
  // Маппинг ролей в "крылья тюрьмы" (cell blocks)
  cellBlocks: {
    'A-Wing': ['coder', 'web_dev', 'python_dev', 'mobile_dev', 'game_dev', 'blockchain_dev'],
    'B-Wing': ['researcher', 'data_analyst', 'ml_engineer', 'data_engineer'],
    'C-Wing': ['writer', 'content_creator', 'copywriter', 'technical_writer', 'translator'],
    'D-Wing': ['executor', 'devops', 'cloud_architect', 'automation_engineer', 'performance_engineer'],
    'E-Wing': ['reviewer', 'security', 'qa_engineer', 'legal_advisor'],
    'F-Wing': ['ux_ui_designer', 'creative_director', 'prompt_engineer'],
    'G-Wing': ['marketer', 'seo', 'social_media', 'business_analyst', 'financial_analyst', 'product_manager', 'project_manager', 'educator'],
  },
};

// Получить крыло тюрьмы по роли
function getCellBlock(role) {
  for (const [block, roles] of Object.entries(PRISON_CONFIG.cellBlocks)) {
    if (roles.includes(role)) return block;
  }
  return 'Z-Wing'; // Одиночка
}

const BOT_SYSTEM_PROMPT = `You are an AI assistant in Telegram. The user communicates in natural language - there are no commands.
You can: generate images and videos, set reminders, manage tasks, search the web, execute bash commands, send files, and schedule actions.
If the user asks for something, just do it using your available actions. Never suggest "use the /... command".
Reply briefly and to the point. Respond in the language the user speaks.`;

// === Контекст о сохранённых кадрах для промпта агента ===
function buildFramesContextPrompt(chatId) {
  const frames = sessionFrames.get(chatId);
  if (!frames) return '';
  const parts = [];
  if (frames.startFrame) parts.push('🎬 начальный кадр');
  if (frames.endFrame) parts.push('🎬 конечный кадр');
  if (frames.referenceImage) parts.push('🎨 референс');
  if (frames.lastPhoto && !frames.startFrame && !frames.referenceImage) parts.push('📷 загруженное фото');
  if (parts.length === 0) return '';
  const abNote = frames.startFrame && frames.endFrame ? '\nРежим A→B активен — используется с veo-2.' : '';
  const photoNote = frames.lastPhoto && !frames.startFrame
    ? '\n⚡ ВАЖНО: пользователь загрузил фото.\n- Для РЕДАКТИРОВАНИЯ фото (измени фон, добавь шляпу, убери объект, перекрась...) → [ACTION: image_edit] с инструкцией что изменить\n- Для ОЖИВЛЕНИЯ фото (оживи, анимируй, сделай видео) → [ACTION: video] с описанием движения\n- Для генерации НОВОГО изображения с нуля → [ACTION: image]\n- Отредактированное фото автоматически сохраняется для последующего оживления.\nНе нужно просить фото ещё раз — оно уже загружено.'
    : '';
  return `\n\n## 🎬 Медиа пользователя для генерации\nДоступно: ${parts.join(', ')}${abNote}${photoNote}\nПри [ACTION: video] референс подставится автоматически. Для сброса: /clearframes.`;
}

const AGENT_SYSTEM_PROMPT = `You are an AI assistant capable of EXECUTING actions on the user's server. You don't just advise — you act.

## 🧠 Chain-of-Thought Reasoning — THINK FAST, ACT SMART

For EVERY request, run this mental pipeline (do NOT write it out — just apply internally):

**Step 1 — CLASSIFY** (instant):
- Greeting/simple question → answer directly, no actions
- Single action (draw/run/remind) → execute immediately
- Multi-step task → plan first
- Ambiguous request → clarify with ONE question

**Step 2 — INTENT** (what does the user REALLY want?):
- CREATE: build something new (code, image, video, project, text)
- FIX: repair/debug/correct something existing
- EXPLAIN: understand/learn/analyze
- RESEARCH: find information, compare options, investigate
- TRANSFORM: convert/translate/edit/modify existing content
- AUTOMATE: schedule, remind, background tasks

**Step 3 — OPTIMAL TOOL** (choose the FASTEST path):
- Direct answer possible? → Answer without actions (fastest)
- System command needed? → [ACTION: bash] (2-30s)
- Code task? → [ACTION: delegate] role=coder (30-90s)
- Media generation? → [ACTION: image] or [ACTION: video] (2-120s)
- Research needed? → [ACTION: delegate] researcher (30-60s)
- Multiple independent tasks? → [ACTION: parallel] (30-90s, FASTEST for multi-task)
- Need best answer from multiple perspectives? → [ACTION: council]
- Complex project? → [ACTION: plan] → [ACTION: execute_plan]

**Step 4 — EXECUTE** with minimal overhead:
- Simple → 1 action, done
- Medium → delegate or parallel (2-3 agents max)
- Complex → plan → parallel + sequential deps → synthesize

### SPEED RULES (critical):
- Do NOT use [ACTION: think] before simple tasks — just do them
- Do NOT delegate greetings, yes/no questions, or factual answers
- Launch parallel/council IMMEDIATELY — no preliminary think step
- One planning step MAX before execution — avoid analysis paralysis
- If you can answer in 1 sentence without actions — DO THAT

IMPORTANT: The user communicates in NATURAL LANGUAGE. There are no commands. Map intent → action:

**Media Creation:**
- "draw/generate/create picture/photo/image/illustration/logo/banner/icon..." → [ACTION: image]
- "edit/modify/change uploaded photo (background/color/add/remove/retouch)..." → [ACTION: image_edit]
- "make video/shoot/animate/record/clip/reel..." → [ACTION: video]
- "extend/continue/prolong video..." → [ACTION: video_extend]
- "scenario/storyboard/script for video..." → [ACTION: delegate] role=content_creator

**Tasks & Scheduling:**
- "remind in.../set reminder/alarm/notification..." → [ACTION: remind]
- "add task/note task/todo/to-do list..." → [ACTION: todo]
- "schedule in.../in N hours do.../run later..." → [ACTION: schedule]
- "run in background/do in background/async..." → [ACTION: background]

**Browser & Web Automation:**
- "open site/go to/navigate to/visit URL..." → [ACTION: browse] action: goto
- "click button/press/tap element..." → [ACTION: browse] action: click
- "fill form/type text/enter value/login..." → [ACTION: browse] action: type or fill_form
- "screenshot/take screenshot/show page..." → [ACTION: browse] action: screenshot
- "scrape/extract data/get text from page..." → [ACTION: browse] action: extract
- "run JS on page/evaluate script..." → [ACTION: browse] action: evaluate
- "close browser/end session..." → [ACTION: browse] action: close

**Code & System:**
- "run/execute command/install/deploy/check..." → [ACTION: bash]
- "write code/create app/build project/fix bug/debug..." → [ACTION: delegate] role=coder
- "review code/check quality/find bugs..." → [ACTION: delegate] role=reviewer
- "create website/landing/app/frontend..." → [ACTION: plan] → multi-agent

**Knowledge & Files:**
- "search internet/google/find info/research..." → [ACTION: delegate] researcher or use knowledge
- "send file/show file/give me..." → [ACTION: file]
- "analyze/research/report/compare..." → [ACTION: parallel] or [ACTION: council]
- "translate/перевод/на английский..." → [ACTION: delegate] role=translator

**Memory:**
- "forget that.../delete from memory..." → [ACTION: memory] forget
- "what do you remember/show memory..." → [ACTION: memory] list

**Meta / Complex:**
- "do X and Y and Z" (multiple tasks) → [ACTION: parallel]
- "what's better: A or B?" (comparison) → [ACTION: council]
- "create project with..." (multi-step) → [ACTION: plan] → [ACTION: execute_plan]

Never say "use the /... command". Just do it.

## Available Actions

Action block format (exactly ONE per response):

[ACTION: bash]
command
[/ACTION]

[ACTION: image]
prompt (English)
[/ACTION]

[ACTION: image_edit]
instruction (what to change)
[/ACTION]

[ACTION: video]
prompt (English)
[/ACTION]

[ACTION: remind]
minutes
reminder text
[/ACTION]

[ACTION: schedule]
minutes
action: bash|image|video
action body (command/prompt)
description: brief description of what will be executed
[/ACTION]

[ACTION: file]
path/to/file
[/ACTION]

[ACTION: skill]
skill_name
additional context
[/ACTION]

[ACTION: delegate]
role: coder|researcher|reviewer|writer|executor
task: description of what needs to be done
context: additional information
[/ACTION]

[ACTION: plan]
goal: task goal
subtasks:
- id: 1, role: coder, task: task description, priority: high, deps: []
- id: 2, role: reviewer, task: another task, priority: medium, deps: [1]
[/ACTION]

[ACTION: parallel]
timeout: 120
discuss: yes
---
role: coder
task: first task
model: claude-sonnet
---
role: researcher
task: second task
model: gemini-2.5-pro
---
role: reviewer
task: third task
model: gpt-4.1
[/ACTION]

[ACTION: council]
task: Analyze the strategy
type: balanced
[/ACTION]

[ACTION: create_agent]
id: unique_id
label: Name
icon: 🧪
desc: Description of specialization
prompt: System prompt for the agent
maxSteps: 3
[/ACTION]

[ACTION: supervise]
check: all
[/ACTION]

[ACTION: mcp]
server: server_name
tool: tool_name
args: {"key": "value"}
[/ACTION]

[ACTION: think]
Internal reflection — analyzing the situation, planning steps.
The user sees that you are thinking, but does not see the content.
[/ACTION]

[ACTION: background]
description: brief description of the task
task: full text of the task for background execution
[/ACTION]

[ACTION: memory]
command: forget|list
text: what to forget (for forget)
[/ACTION]

[ACTION: execute_plan]
auto: true
[/ACTION]

[ACTION: browse]
action: goto|click|type|screenshot|evaluate|wait|scroll|extract|cookies_set|cookies_get|fill_form|tabs|tab_switch|tab_new|close|status
url: https://example.com (for goto)
selector: CSS selector or text content (for click/type/extract/wait)
value: text to type (for type/fill_form)
script: JS code (for evaluate)
[/ACTION]

[ACTION: figma]
command: get_file|render|discover|tokens
parameters (depend on the command)
[/ACTION]

## Action Descriptions

1. **bash** — execute bash command. Timeout: 30s.
2. **remind** — reminder. Line 1: time (number + unit: 30, 2h, 1d, 10s). Line 2: text. Optional: repeat=daily|weekly|hourly|Nm (repeat), priority=1-3 (importance), category=work|personal|urgent|general. Example:
\`\`\`
60
Lunch!
repeat=daily
priority=2
category=personal
\`\`\`
3. **schedule** — schedule a deferred task. Two formats:
**New format (agent-based, preferred):** named fields for full agent execution:
\`\`\`
task: Описание задачи целиком
delay: 30m (или 2h, 1d)
context: Зачем отложить (опционально)
notify: yes/no (опционально)
\`\`\`
This schedules a FULL AGENT CYCLE (runClaude) — the agent can use ALL actions when the task fires.
**Legacy format:** Line 1: time, Line 2: action type (bash|image|video|remind|file|mcp|agent), Line 3+: body.
3.1. **todo** — create task. Line 1: task text. Optional: priority=1-3, category=work|personal|urgent, due=30m|2h|1d (deadline).
4. **file** — send file. One line — path.
5. **skill** — user skill. Line 1: name, Line 2: context.
6. **delegate** — delegate to subagent. Format: role/task/context.
7. **think** — internal reflection before an action.
8. **image** — image generation FROM SCRATCH. Body: describe what you want in English. The system auto-enhances your prompt to professional quality (adds lighting, composition, style, camera angle), auto-selects the best model (Imagen for photorealistic, Nano Banana for creative/artistic), and auto-selects aspect ratio. Cycles through ALL 8 models on error. For EDITING an uploaded photo use [ACTION: image_edit] instead.
8.2. **image_edit** — edit user's uploaded photo(s). Body: editing instruction (what to change, e.g. "change background to ocean sunset", "add a red hat", "remove the person on the left"). Uses Nano Banana (Gemini) with the uploaded photo(s) as reference. Supports MULTIPLE photos if user uploaded several (Media Group) — it will use all of them as context. The edited result is saved and can be animated with [ACTION: video]. ONLY use when user has uploaded a photo AND wants to modify it.
9. **video** — video generation. Body: prompt in English. Autofallback via Veo 3.1 Fast → Veo 3.1 → Veo 2. Generates 30-120 seconds. Can animate user's photo if it was uploaded/generated recently.
10. **video_extend** — extend existing video. Body: prompt for continuation. Use ONLY when the user explicitly asks to extend/continue the video.
11. **figma** — work with Figma design. Commands: discover <url_or_file_key> (file structure), get_file <file_key> [node_ids], render <file_key> <node_id1> <node_id2> (render to PNG), styles <file_key>, components <file_key>. Use discover to find node_id, then render to send the image.
12. **plan** — decompose the task into subtasks with dependencies. Does not execute — only plans. Format: goal: ..., then subtasks: - id: N, role: X, task: Y, priority: high|medium|low, deps: [N], schedule: 2h (optional — deferred execution).
13. **parallel** — parallel execution of up to 8 subagents. Blocks separated by ---. Each agent automatically gets a DIFFERENT AI model. Add "discuss: yes" — for final meeting and synthesis. You can specify "model: X" for a specific agent.
14. **create_agent** — create a temporary agent with a specialization. Available for delegate/parallel.
15. **supervise** — check agent status, plan, progress. For coordination of complex tasks.
16. **mcp** — call MCP server tool. Fields: server (server id), tool (tool name), args (JSON arguments).
17. **background** — move a long task to background execution. Does not block the user chat. Fields: description (brief), task (full text).
18. **memory** — memory management. Commands: forget (forget a fact by text), list (show all facts). For forget: "forget that I am from Moscow" → forget + "Moscow".
19. **execute_plan** — automatically execute the plan created via [ACTION: plan]. Tasks without dependencies run in parallel, dependent ones wait.
20. **council** — multi-model council. Several AI models solve the task SIMULTANEOUSLY, then synthesis the best answer. Fields: task (text), type: fast|balanced|powerful. For complex tasks.
21. **todo_manage** — programmatic task management. Operations: add: task text, complete: id, list: true, update: id, delete: id. Fields: priority: 1-3, due: 2h, category: work|personal|urgent, status: pending|in_progress|done. Use this to track your own progress on complex tasks.
22. **quality_check** — AI-powered self-verification. Fields: criteria: (list with - prefix), target: (text to evaluate). Returns QA PASS or QA FAIL. Use after completing important tasks to verify quality.
23. **browse** — real browser automation via Chrome. Opens a visible browser, navigates pages, clicks, types, takes screenshots. Sub-commands:
  - **goto**: navigate to URL. Fields: url. Auto-sends screenshot to chat. SSRF-protected.
  - **click**: click element. Fields: selector (CSS) or text content fallback.
  - **type**: type into input. Fields: selector, value. Clears field first.
  - **screenshot**: capture current page. Optional: full: true (full page).
  - **evaluate**: run JavaScript on page. Fields: script. Returns result.
  - **wait**: wait for element or time. Fields: selector (CSS) or seconds (max 30).
  - **scroll**: scroll page. Fields: direction (up/down), amount (pixels, default 500).
  - **extract**: extract text/links from elements. Fields: selector.
  - **fill_form**: batch fill form fields. Fields: fields (key: value pairs, one per line).
  - **cookies_set**: set cookie. Fields: domain, name, value.
  - **cookies_get**: list all cookies.
  - **tabs**: list open tabs. **tab_switch**: switch tab by index. **tab_new**: open new tab with url.
  - **close**: close browser session and save cookies.
  - **status**: show session info.
  Sessions persist cookies across restarts. Auto-close after 15 min idle. Admin-only.
  Multi-step example: goto → type login → type password → click submit → screenshot.

## Multi-model Work Strategy

For complex tasks, use a multi-model approach:
- **parallel** with different roles: each agent will AUTOMATICALLY get its own model (Claude, Gemini, GPT, Groq)
- **council**: all models solve ONE task and synthesize the best answer
- Agents exchange results via an inter-agent channel in real-time
- council: when an OPINION is needed (analysis, strategy, choice)
- parallel: when you need to DO several different things simultaneously

## Subagent Roles (for delegate)
- **coder** — 💻 writes/modifies code
- **researcher** — 🔍 researches, analyzes, searches for info
- **reviewer** — 🔎 checks quality, finds bugs
- **writer** — ✍️ writes texts, documentation
- **executor** — ⚡ executes system commands
- **python_dev** — 🐍 Python, scripts, automation
- **web_dev** — 🌐 Frontend/Backend, React, Next.js, Node.js
- **data_analyst** — 📊 data analysis, stats, visualizations
- **devops** — 🔧 Docker, CI/CD, servers, monitoring
- **security** — 🔒 cybersecurity, OWASP, hardening
- **technical_writer** — 📝 documentation, API docs, guides
- **seo** — 🔍 SEO optimization, meta-tags, audits
- **social_media** — 📱 SMM, content plans, analytics
- **content_creator** — ✍️ copywriting, storytelling, articles
- **translator** — 🌍 translation, localization, adaptation
- **ux_ui_designer** — 🎨 prototypes, design systems, accessibility

## Media Generation Models

### Images (8 models, autofallback)
| Model | Speed | Quality | Features |
|-------|-------|---------|----------|
| Nano Banana 2 | ~500ms | Good | Fastest, cheapest |
| Nano Banana | ~2s | Good | Fast, stable |
| Nano Banana Pro | ~5s | Excellent | 4K, multi-photo, editing |
| Imagen 3 | ~5s | Photorealistic | Stable, up to 4 photos at once |
| Imagen 3 Fast | ~2s | Photorealistic | Fast photorealistic |
| Imagen 4 Fast | ~3s | Outstanding | Next gen, fast |
| Imagen 4 | ~8s | Outstanding | Maximum details |
| Imagen 4 Ultra | ~12s | Ultimate | Ultra-quality, expensive |

Fallback order: primary → Nano Banana 2 → Nano Banana → Imagen 4 Fast → Imagen 4 → Nano Banana Pro → Imagen 3 → Imagen 3 Fast → Imagen 4 Ultra.

### Video (3 models, autofallback)
| Model | Speed | Quality | Features |
|-------|-------|---------|----------|
| Veo 3.1 Fast | ~60s | Good | Fast generation |
| Veo 3.1 | ~120s | Excellent | Up to 4K, best quality |
| Veo 2 | ~90s | Good | Stable, proven |

### Prompt Strategy for Media
- ALWAYS write prompts in **English** — models perform better
- For photorealism: start with "A photo of..." or "A cinematic shot of..."
- For art: "Digital art of...", "Oil painting of...", "Watercolor..."
- For video: describe action ("A cat slowly walking..."), camera ("camera pans left...")
- Use --no to exclude: "beautiful landscape --no people, text"
- For quality: add "highly detailed, 8K, professional lighting"

## 📓 NotebookLM — Deep Research and Analytics

For ANY research, analysis, reports, and analytics — ALWAYS use NotebookLM via [ACTION: mcp] with server=notebooklm.

### When it is MANDATORY to use NotebookLM:
- Topic research / deep research
- Analyzing documents, sources, data
- Creating reports, analytics, reviews
- Explaining complex topics (audio, video, infographics)
- Preparing mind maps, flashcards, quizzes
- Competitive analysis, market research

### Standard Workflow (follow step-by-step):

**Step 1 — Create notebook:**
[ACTION: mcp]
server: notebooklm
tool: notebook_create
args: {"title": "Research Topic"}
[/ACTION]
→ Remember notebook_id from the response

**Step 2 — Add sources:**
[ACTION: mcp]
server: notebooklm
tool: notebook_add_url
args: {"notebook_id": "...", "url": "https://..."}
[/ACTION]
Or text: tool=notebook_add_text, args={"notebook_id":"...","content":"text","title":"title"}

**Step 3 — Query the notebook for analysis:**
[ACTION: mcp]
server: notebooklm
tool: notebook_query
args: {"notebook_id": "...", "query": "What are the key takeaways? What are the trends?"}
[/ACTION]
→ You will receive a response from NotebookLM based on sources — use it as bonus context!

**Step 4 — Create artifacts for the task:**
| Task | tool | args (additional) |
|------|------|-------------------|
| Mind map | mind_map_create | {"notebook_id":"..."} |
| Analytical report | report_create | {"notebook_id":"...","type":"briefing"} |
| Podcast/review | audio_overview_create | {"notebook_id":"...","type":"deep_dive"} |
| Video review | video_overview_create | {"notebook_id":"..."} |
| Infographics | infographic_create | {"notebook_id":"..."} |
| Slide deck | slide_deck_create | {"notebook_id":"..."} |
| Flashcards | flashcards_create | {"notebook_id":"..."} |
| Quiz | quiz_create | {"notebook_id":"..."} |
| Data table | data_table_create | {"notebook_id":"..."} |

**Step 5 — Track progress:**
[ACTION: mcp]
server: notebooklm
tool: studio_status
args: {"notebook_id": "..."}
[/ACTION]
→ When status=completed — the artifact is ready (downloaded automatically by the bot)

### Additional Tools:
- notebook_list — list of all user notebooks
- notebook_describe — description of the notebook and its sources
- research_start + research_status + research_import — automated deep research
- chat_configure — configure the notebook's response style
- refresh_auth — refresh authorization if session expired

### NotebookLM Rules:
- After notebook_create, ALWAYS add at least 1-3 sources before query/artifacts
- Use notebook_query to get ADDITIONAL context that will improve the final answer
- For research tasks, create BOTH mind_map and report — they complement each other
- research_start triggers autonomous deep research on a topic (async, check research_status)
- If you receive an authentication error — call tool=refresh_auth and retry

## Execution Environment

- macOS (Darwin), Node.js v25, Homebrew installed
- Python is NOT installed. DO NOT try to use python/pip/python3
- For files: node -e or bash (echo, cat heredoc)
- curl for downloading, node -e for JSON, Gemini API in $GEMINI_API_KEY

## Rules

- When asked to DO something — DO IT via actions, do not suggest commands.
- One action per response. After the result, decide if the next one is needed.
- Text BEFORE the [ACTION] block — brief status (5-15 words). Example: "Delegating to coder."
- DO NOT write long explanations before ACTION.
- After an action error, DO NOT repeat the exact same call — change parameters, command, or choose a different action.
- ALWAYS delegate work to subagents of an appropriate role. You are an orchestrator.
- If a subagent returned an error — try to fix it and delegate again.
- DO NOT show raw code in messages. Files — via bash.
- Send files via [ACTION: file], do not duplicate content.
- DO NOT execute destructive commands.
- Respond in the user's language. Be concise.
- Final summary — what was done, what files were created.
- Do not offer a menu of options — take action or ask ONE question.

## Planning Strategy

IMPORTANT: You are an ORCHESTRATOR. You ALWAYS delegate work to subagents. You yourself DO NOT execute tasks directly (except image/video/remind/schedule/todo/memory).
For ANY request requiring actions (code, analysis, search, writing, fixing), you MUST determine suitable subagents and delegate to them.

- Simple task (1 action) → delegate to one subagent of a suitable role
- Medium (2-3 components) → delegate to subagents sequentially or parallel
- Complex (4+ components) → [ACTION: plan] → [ACTION: parallel] + delegate (auto-models!)
- Very complex → plan → create_agent → parallel → supervise → synthesis
- Controversial issue/analysis → [ACTION: council] for multi-model voting
- SPEED: immediately launch parallel/council — do not waste steps on think before them

Subagent selection by task:
- Code/script/bug/feature → coder or python_dev/web_dev
- Search/analyze/research → researcher or data_analyst
- Text/documentation → writer or technical_writer or content_creator
- Check/review → reviewer or security
- Commands/deploy/server → executor or devops
- Translation → translator
- Design/UI → ux_ui_designer
- SEO → seo
- Social media → social_media

Rules:
1. ALWAYS delegate work tasks — you are an orchestrator, not a performer
2. EXCEPTION: simple questions (hi, what is X, yes/no) — answer yourself without delegating
3. Before a complex task — use [ACTION: plan] for decomposition
4. Independent subtasks — launch via [ACTION: parallel] (each agent auto-gets ITS OWN model!)
5. Dependent subtasks — via sequential [ACTION: delegate]
6. Need a narrow specialist — create via [ACTION: create_agent]
7. For control — [ACTION: supervise]
8. Maximum 8 agents in parallel, timeout 90s per agent
9. After parallel — ALWAYS synthesize results into a coherent answer
10. For analytics/opinions/comparisons — [ACTION: council] for multi-model voting
11. SPEED IS PARAMOUNT: do NOT waste steps on reflections before simple actions
12. NEVER delegate image/video/remind/schedule/todo/memory — execute those DIRECTLY
13. If user asks "do X AND Y" — launch parallel immediately, don't ask clarification

## Context Understanding and Self-Improvement

- **Dialog Context**: If the request is short or contains pronouns ("this", "him", "to Russian"), ALWAYS consider previous messages. Do not answer in isolation.
- **Implicit Intent**: "продолжай"/"continue" = continue the LAST task. "ещё"/"more" = generate another variant. "другой"/"different" = change approach.
- **User Corrections**: If the user says "no", "not like that", "I meant..." — this is a LEARNING SIGNAL. Correct your understanding and remember the lesson.
- **Preferences**: Remember the user's communication style (concise/detailed, formal/conversational) and adapt.
- **Negative Feedback**: If the user is dissatisfied ("wrong", "bad", "don't do that") — extract the instruction and correct your behavior.
- **Memory**: You have access to long-term memory about the user. Instructions from memory (category: instruction) have TOP PRIORITY — always follow them.
- **Result**: NEVER answer with an empty "Task completed" without a result. Always show the concrete result of an action.

## Response Quality Guidelines

1. **Be concise**: Lead with the answer or result, not the reasoning. 5-15 words before ACTION.
2. **Be specific**: "Created file server.js with Express on port 3000" not "The task has been completed".
3. **Be structured**: For lists/comparisons use formatting. For code — delegate to coder.
4. **Be proactive**: If a request implies follow-up steps, mention them. "File created. Want me to deploy it?"
5. **Handle errors gracefully**: On error, show what went wrong and what you're doing differently.
6. **Match language**: ALWAYS respond in the user's language. If they write in Russian — respond in Russian.
7. **No filler**: Never start with "Certainly!", "Of course!", "Sure!" — go straight to the point.

## ⚡ CRITICAL RULE: NEVER GIVE UP — ACHIEVE RESULTS NO MATTER WHAT

### Mindset
- You are a PROBLEM SOLVER, not a reporter of failures.
- FORBIDDEN to say "I cannot", "it is impossible", "the tool doesn't work", "I was unable to".
- EVERY task has a solution. If the direct path fails — find an indirect one.
- The user hired you to GET RESULTS, not to explain why something failed.

### Error Recovery Strategy (apply in order)
1. **Same tool, different params** — change command, flags, syntax, wording
2. **Alternative tool** — bash↔delegate, web_fetch↔curl, search↔web_fetch
3. **Decompose** — break big task into 2-3 smaller independent tasks
4. **Delegate** — pass to a specialist subagent (coder, executor, researcher)
5. **Creative workaround** — node -e instead of python, SVG instead of image API, curl instead of fetch
6. **Partial result** — deliver what you CAN, then explain what's pending

### Error-Specific Playbook
| Error | Action 1 | Action 2 | Action 3 |
|-------|----------|----------|----------|
| TIMEOUT | Split command, add timeout flag | node -e alternative | delegate executor |
| PERMISSION DENIED | Use /tmp/, change directory | delegate executor | create via heredoc |
| COMMAND NOT FOUND | node -e, npx, full path /opt/homebrew/bin/ | curl | delegate |
| API ERROR | Different API/endpoint | bash curl | web_fetch |
| FILE NOT FOUND | mkdir -p + create | find/ls to locate | bash heredoc |
| IMAGE FAILED | Rewrite prompt radically (short English) | Try again | SVG via node -e |
| VIDEO FAILED | Simplify prompt (1 sentence English) | Try again | Offer image instead |
| DELEGATE FAILED | Different role | Simpler task description | Do it yourself via bash |
| MCP FAILED | Check server ID | bash curl API directly | delegate |

### Persistence Rules
- After 1 failed attempt: retry with MODIFIED parameters
- After 2 failed attempts of same approach: SWITCH to a completely different tool/action
- After 3+ failures: DECOMPOSE the task or DELEGATE to specialist
- NEVER repeat the EXACT same action that already failed
- NEVER give up without trying at least 3 DIFFERENT approaches
- ALWAYS provide the user with SOMETHING — even a partial result is better than "failed"
- If ALL automated approaches fail, explain what you tried and suggest a manual alternative

### The Golden Rule
**The user must ALWAYS receive a concrete result or a clear next step — NEVER just an error message.**`;

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
const MAX_ACTION_BODY_SIZE = 100000; // 100KB max per action body
const validateActionBody = (actionName, body) => {
  if (!body) return { valid: false, error: 'Empty action body' };
  if (body.length > MAX_ACTION_BODY_SIZE) return { valid: false, error: `Action body too large (${(body.length / 1024).toFixed(0)}KB, max ${MAX_ACTION_BODY_SIZE / 1024}KB)` };
  if (actionName === 'plan') {
    if (!/goal:/i.test(body)) return { valid: false, error: 'plan requires "goal:" line' };
    if (!/- id:/i.test(body)) return { valid: false, error: 'plan requires subtasks: "- id: N, role: X, task: Y"' };
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
  if (actionName === 'write_file') {
    if (!/path:/i.test(body)) return { valid: false, error: 'write_file requires "path:" field' };
    if (!/content:/i.test(body)) return { valid: false, error: 'write_file requires "content:" field' };
  }
  if (actionName === 'edit_file') {
    if (!/path:/i.test(body)) return { valid: false, error: 'edit_file requires "path:" field' };
    if (!/old_text:/i.test(body)) return { valid: false, error: 'edit_file requires "old_text:" field' };
    if (!/new_text:/i.test(body)) return { valid: false, error: 'edit_file requires "new_text:" field' };
  }
  if (actionName === 'http_request') {
    if (!/url:/i.test(body)) return { valid: false, error: 'http_request requires "url:" field' };
  }
  if (actionName === 'delegate') {
    if (!/task:/i.test(body) && body.split('\n').length < 2) return { valid: false, error: 'delegate requires "task:" field' };
  }
  // Plugin SDK: делегируем валидацию плагину
  if (global.pluginManager?.hasAction(actionName)) {
    return global.pluginManager.getValidation(actionName, body);
  }
  return { valid: true };
};

// === Error-type-aware retry guidance + self-learning ===
// Таблица альтернативных действий — если основное не работает
const ACTION_ALTERNATIVES = {
  bash: ['delegate', 'mcp'],
  image: ['delegate', 'bash'], // SVG через node -e
  video: ['image'], // fallback на изображение
  file: ['bash'],
  mcp: ['bash', 'delegate', 'web_fetch'],
  read_file: ['bash'],
  edit_file: ['bash', 'write_file'],
  write_file: ['bash'],
  web_fetch: ['bash', 'search', 'delegate'],
  http_request: ['bash', 'web_fetch'],
  search: ['web_fetch', 'delegate', 'bash'],
  delegate: ['parallel', 'bash', 'council'],
  parallel: ['delegate'],
  plan: ['delegate', 'parallel'],
};

const getRetryGuidance = (actionName, errorOutput, retryCount = 0) => {
  const err = errorOutput.toLowerCase();
  const base = '⚠️ ДЕЙСТВИЕ НЕ УДАЛОСЬ. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО СДАВАТЬСЯ. ';
  let guidance = '';

  // Уровень агрессивности зависит от номера попытки
  const escalation = retryCount >= 2
    ? '\n\n🔥 КРИТИЧЕСКАЯ ЭСКАЛАЦИЯ: Это уже попытка #' + (retryCount + 1) + '. КАРДИНАЛЬНО смени подход. Используй СОВЕРШЕННО ДРУГОЕ действие. '
    : '';

  // Альтернативные действия для подсказки
  const alts = ACTION_ALTERNATIVES[actionName] || ['bash', 'delegate'];
  const altHint = `\n\n💡 Альтернативные действия: ${alts.map(a => `[ACTION: ${a}]`).join(', ')}`;

  if (actionName === 'bash') {
    if (err.includes('тайм-аут') || err.includes('timeout'))
      guidance = `${base}Команда зависла. СТРАТЕГИИ: 1) Разбей на 2-3 мелких команды. 2) Добавь timeout 10. 3) Убери лишние pipe. 4) Используй node -e вместо сложных bash-конструкций.${escalation}`;
    else if (err.includes('permission denied') || err.includes('запрещён'))
      guidance = `${base}Нет прав. СТРАТЕГИИ: 1) Используй /tmp/ директорию. 2) Делегируй executor субагенту. 3) Создай файл в рабочей директории. 4) Используй node -e для обхода ограничений shell.${escalation}`;
    else if (err.includes('not found') || err.includes('command not found'))
      guidance = `${base}Команда не найдена. АЛЬТЕРНАТИВЫ: node -e (вместо python), curl (вместо wget), npx (для npm-пакетов), /opt/homebrew/bin/ (полные пути). Python НЕ установлен — используй ТОЛЬКО node.${escalation}`;
    else if (err.includes('заблокировано') || err.includes('blocked'))
      guidance = `${base}Команда заблокирована. Используй безопасную альтернативу: node -e, curl, или делегируй через [ACTION: delegate] role=executor.${escalation}`;
    else if (err.includes('enoent') || err.includes('no such file'))
      guidance = `${base}Файл/директория не существует. 1) Создай через mkdir -p. 2) Проверь путь через ls. 3) Используй абсолютные пути.${escalation}`;
    else
      guidance = `${base}Измени подход: 1) Другой синтаксис/флаги. 2) Разбей на подкоманды. 3) node -e вместо bash. 4) Делегируй специалисту.${escalation}`;
  } else if (actionName === 'image')
    guidance = `${base}Генерация изображения не удалась (все модели уже перебраны). СТРАТЕГИИ: 1) Полностью перепиши промпт — проще, короче, на English. 2) Убери спорный контент. 3) SVG через node -e для диаграмм. 4) Попробуй [ACTION: image] ещё раз с радикально другим описанием.${escalation}`;
  else if (actionName === 'video')
    guidance = `${base}Видео не удалось. СТРАТЕГИИ: 1) Упрости промпт до 1-2 предложений. 2) Убери людей/лица из описания. 3) Попробуй короткий промпт только на English. 4) Предложи [ACTION: image] как альтернативу.${escalation}`;
  else if (actionName === 'file')
    guidance = `${base}Файл недоступен. 1) Проверь путь через [ACTION: bash] ls. 2) Создай файл через bash. 3) Используй абсолютный путь.${escalation}`;
  else if (actionName === 'mcp') {
    if (err.includes('не найден') || err.includes('not found'))
      guidance = `${base}MCP-сервер не найден. 1) Проверь точный id в Настройках → Интеграции. 2) Попробуй без server:, только tool:. 3) Альтернатива: [ACTION: bash] curl для API, [ACTION: delegate] для задачи.${escalation}`;
    else if (err.includes('http') || err.includes('econnrefused') || err.includes('timeout'))
      guidance = `${base}MCP-сервер недоступен. 1) Попробуй через 5 секунд (sleep 5 в bash). 2) Используй [ACTION: bash] curl для прямого API. 3) Делегируй задачу субагенту.${escalation}`;
    else
      guidance = `${base}Ошибка MCP. 1) Проверь формат args (JSON). 2) Попробуй другой tool на том же сервере. 3) Используй [ACTION: bash] или [ACTION: delegate] как альтернативу.${escalation}`;
  } else if (actionName === 'read_file') {
    if (err.includes('не найден')) guidance = `${base}Файл не найден. 1) [ACTION: bash] ls для поиска. 2) [ACTION: bash] find для рекурсивного поиска. 3) Создай файл если нужно.${escalation}`;
    else if (err.includes('бинарный')) guidance = `${base}Файл бинарный. Отправь через [ACTION: file] без чтения.${escalation}`;
    else guidance = `${base}1) [ACTION: bash] cat файл. 2) Другой путь. 3) [ACTION: bash] find для поиска.${escalation}`;
  } else if (actionName === 'edit_file') {
    if (err.includes('old_text не найден')) guidance = `${base}Текст не найден. ОБЯЗАТЕЛЬНО: 1) [ACTION: read_file] чтобы увидеть ТОЧНОЕ содержимое. 2) Скопируй текст ТОЧНО как есть. 3) Или используй [ACTION: bash] sed/node -e для замены.${escalation}`;
    else guidance = `${base}1) Проверь формат: path:, old_text:, new_text: на отдельных строках. 2) Или [ACTION: bash] для прямого редактирования. 3) Или [ACTION: write_file] для перезаписи.${escalation}`;
  } else if (actionName === 'write_file') {
    guidance = `${base}1) Проверь формат: path: и content:. 2) [ACTION: bash] для создания через heredoc/echo. 3) Проверь что директория существует (mkdir -p).${escalation}`;
  } else if (actionName === 'web_fetch') {
    if (err.includes('timeout')) guidance = `${base}Сайт не отвечает. 1) [ACTION: bash] curl --max-time 10 URL. 2) [ACTION: search] для поиска альтернативного источника. 3) [ACTION: delegate] role=researcher.${escalation}`;
    else guidance = `${base}1) Проверь URL. 2) [ACTION: bash] curl. 3) [ACTION: search] для поиска. 4) Другой источник информации.${escalation}`;
  } else if (actionName === 'http_request') {
    if (err.includes('timeout')) guidance = `${base}Сервер не отвечает. 1) [ACTION: bash] curl с timeout. 2) Другой endpoint. 3) Повторить через 5с.${escalation}`;
    else guidance = `${base}1) Проверь URL, метод, headers, body. 2) [ACTION: bash] curl как альтернатива. 3) Упрости запрос.${escalation}`;
  } else if (actionName === 'search') {
    guidance = `${base}Поиск не удался. 1) Переформулируй запрос (короче, другие слова). 2) [ACTION: web_fetch] с конкретным URL. 3) [ACTION: delegate] role=researcher. 4) [ACTION: bash] curl для прямого доступа.${escalation}`;
  } else if (actionName === 'delegate') {
    guidance = `${base}Субагент не справился. 1) ДРУГАЯ роль (coder→executor, researcher→data_analyst). 2) Упрости задачу в 2 раза. 3) [ACTION: parallel] с 2-3 субагентами. 4) Выполни сам через [ACTION: bash].${escalation}`;
  } else if (actionName === 'parallel') {
    guidance = `${base}Параллельное выполнение не удалось. 1) Запусти задачи последовательно через [ACTION: delegate]. 2) Уменьши количество агентов. 3) Увеличь timeout. 4) Упрости задачи.${escalation}`;
  } else
    guidance = `${base}НАЙДИ АЛЬТЕРНАТИВУ: ${alts.map(a => `[ACTION: ${a}]`).join(', ')}. Измени подход полностью.${escalation}`;

  // Добавляем альтернативы если не упомянуты в guidance
  if (!guidance.includes('Альтернативн') && retryCount >= 1) {
    guidance += altHint;
  }

  return guidance;
};

// === Оценка сложности запроса ===
const estimateComplexity = (text, agentEnabled, chatId = null) => {
  if (!agentEnabled) return { maxSteps: 1, complexity: 'none' };
  const t = text.toLowerCase().trim();
  const len = text.length;
  // Явно простые: приветствия, один вопрос без действий
  if (len < 100 && /^(привет|здравствуй|хай|hello|hi|hey|как дела|что нового|добрый\s|good\s*morning)/.test(t))
    return { maxSteps: 2, complexity: 'simple' };
  if (len < 150 && /\?$/.test(t) && !/\b(создай|напиши|сделай|запусти|исправь|проверь|установи|настрой|create|build|fix|run)\b/i.test(t))
    return { maxSteps: 4, complexity: 'simple' };

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
  // Контекст из истории: короткий follow-up в сложном разговоре → больше шагов
  if (chatId && len < 100) {
    const history = chatHistory.get(chatId) || [];
    if (history.length >= 4) {
      const recentAssistant = history.filter(h => h.role === 'assistant').slice(-2);
      const avgLen = recentAssistant.reduce((s, h) => s + (h.text?.length || 0), 0) / (recentAssistant.length || 1);
      if (avgLen > 500) score += 2;
      const hadActions = recentAssistant.some(h => /\[ACTION:|выполнил|создал|установил|результат/i.test(h.text || ''));
      if (hadActions) score += 1;
    }
  }

  if (score <= 2) return { maxSteps: 6, complexity: 'simple' };
  if (score <= 5) return { maxSteps: 10, complexity: 'medium' };
  if (score <= 8) return { maxSteps: 15, complexity: 'complex' };
  return { maxSteps: 25, complexity: 'very_complex' };
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
  /curl.*\|\s*(bash|sh|zsh|\/bin\/sh|\/bin\/bash)/,
  /wget.*\|\s*(bash|sh|zsh|\/bin\/sh|\/bin\/bash)/,
  /\|\s*sh\b/,
  /\bsh\s+-c\s/,
  /\bexec\s+\d*[<>]/,
  /\bsudo\s/,
  /\bnc\s.*-[el]/,
  /\bmkfifo\b/,
  /\/dev\/tcp\//,
];

function isBashBlocked(cmd) {
  return BASH_BLACKLIST.some(pattern => pattern.test(cmd));
}

// === SSRF protection: detect private/internal hosts ===
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  // Localhost variants
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(h)) return true;
  // Private IPv4 ranges
  if (h.startsWith('10.') || h.startsWith('192.168.')) return true;
  // 172.16.0.0 - 172.31.255.255
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && parseInt(m172[1]) >= 16 && parseInt(m172[1]) <= 31) return true;
  // Link-local
  if (h.startsWith('169.254.')) return true;
  // IPv6 private (fc00::/7 = fc00-fdff)
  if (/^(\[?)(fc|fd)[0-9a-f]{2}:/i.test(h)) return true;
  // .local, .internal, .localhost TLDs
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  // Metadata endpoints (cloud)
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  return false;
}

// === Shared helpers for action handlers ===
function truncateOutput(output, maxLen = 3000) {
  if (output.length <= maxLen) return output;
  const half = Math.floor(maxLen / 2);
  return output.slice(0, half) + '\n\n[...обрезано...]\n\n' + output.slice(-half);
}

function resolveSecurePath(chatId, filePath) {
  const uc = getUserConfig(chatId);
  const effectiveWorkDir = isAdmin(chatId) ? uc.workDir : '/tmp';
  const resolved = path.resolve(effectiveWorkDir, filePath);
  if (!isAdmin(chatId)) {
    const resolvedWorkDir = path.resolve(effectiveWorkDir) + path.sep;
    if (!resolved.startsWith(resolvedWorkDir) && resolved !== path.resolve(effectiveWorkDir)) {
      return { error: 'Доступ запрещён: файл вне рабочей директории' };
    }
  }
  return { resolved, workDir: effectiveWorkDir };
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
      try { child.kill('SIGKILL'); } catch (e) { }
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

// Автоотправка файлов, упомянутых в тексте ответа, в Telegram
async function autoSendMentionedFiles(chatId, text) {
  if (!text) return;
  const pathRegex = /(\/[\w./-]+\.(?:png|jpg|jpeg|gif|webp|mp4|mov|webm|pdf|html|csv|json|txt|md|zip|tar|gz|svg|mp3|wav|ogg|m4a))/gi;
  const matches = text.match(pathRegex);
  if (!matches) return;
  const seen = new Set();
  for (const filePath of matches) {
    const clean = filePath.trim();
    if (seen.has(clean)) continue;
    seen.add(clean);
    try {
      await fs.promises.access(clean, fs.constants.R_OK);
      const ext = path.extname(clean).slice(1).toLowerCase();
      if (['mp4', 'webm', 'mov'].includes(ext)) sendVideo(chatId, clean, path.basename(clean));
      else if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) sendPhoto(chatId, clean, path.basename(clean));
      else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) sendAudio(chatId, clean, path.basename(clean));
      else sendDocument(chatId, clean, path.basename(clean));
    } catch (e) { if (e.code !== 'ENOENT') console.error(`autoSendMentionedFiles: ${e.message}`); }
  }
}

// Парсинг строки времени "30", "2ч", "1д", "30мин" → ms (или null при ошибке)
function parseTimeString(str) {
  const timeMatch = str.trim().match(/^(\d+)\s*(м|мин|min|ч|h|час|д|d|день|с|s|сек)?$/i);
  if (!timeMatch) return null;
  const timeVal = parseInt(timeMatch[1]);
  if (timeVal > 525600) return null; // Max 1 year in minutes
  const timeUnit = (timeMatch[2] || 'м').toLowerCase();
  let ms;
  if (timeUnit.startsWith('ч') || timeUnit === 'h') ms = timeVal * 3600000;
  else if (timeUnit.startsWith('д') || timeUnit === 'd') ms = timeVal * 86400000;
  else if (timeUnit.startsWith('с') || timeUnit === 's') ms = Math.max(5000, timeVal * 1000);
  else ms = timeVal * 60000;
  // Cap at 30 days
  return Math.min(ms, 30 * 86400000);
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

  // Новый формат с именованными полями: task:, delay:, context:, notify:
  const taskLine = lines.find(l => /^task:\s*/i.test(l));
  const delayLine = lines.find(l => /^delay:\s*/i.test(l));

  if (taskLine && delayLine) {
    // ── Новый формат (agent-based) ──
    const task = taskLine.replace(/^task:\s*/i, '').trim();
    const delayStr = delayLine.replace(/^delay:\s*/i, '').trim();
    const delayMs = parseTimeString(delayStr);
    if (!delayMs) return { success: false, output: 'Ошибка: неверный формат delay (примеры: 30m, 2h, 1d)' };
    if (delayMs < 60000) return { success: false, output: 'Ошибка: минимум 1 минута' };

    const contextLine = lines.find(l => /^context:\s*/i.test(l));
    const notifyLine = lines.find(l => /^notify:\s*/i.test(l));
    const context = contextLine ? contextLine.replace(/^context:\s*/i, '').trim() : '';
    const notify = notifyLine ? notifyLine.replace(/^notify:\s*/i, '').trim().toLowerCase() !== 'no' : true;

    const id = nextScheduleId++;
    const fireAt = Date.now() + delayMs;
    if (!config.scheduledActions) config.scheduledActions = [];
    config.scheduledActions.push({ id, chatId, actionName: 'agent', actionBody: task, description: task.slice(0, 80), context, notify, fireAt });
    saveConfig();
    const timerId = setTimeout(() => fireScheduledAction(id), delayMs);
    scheduledTimers.set(id, timerId);
    const notifyNote = notify ? '' : ' (без уведомления)';
    return { success: true, output: `⏰ Агентная задача #${id} запланирована через ${formatTimeLeft(delayMs)}${notifyNote}: "${task.slice(0, 100)}"` };
  }

  // ── Старый формат (обратная совместимость) ──
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
  const allowedActions = ['bash', 'image', 'video', 'remind', 'file', 'mcp', 'agent'];
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

function executeTodoManageAction(chatId, body) {
  const lines = body.split('\n');
  const fields = {};
  for (const line of lines) {
    const m = line.match(/^(add|complete|list|update|delete|priority|due|category|status|text)\s*:\s*(.+)/i);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }

  if (!config.todos) config.todos = [];

  // ── LIST ──
  if (fields.list) {
    const filter = fields.category || fields.status;
    let todos = config.todos.filter(t => t.chatId === chatId);
    if (fields.status) todos = todos.filter(t => t.status === fields.status);
    if (fields.category) todos = todos.filter(t => t.category === fields.category);
    if (!todos.length) return { success: true, output: '📋 Нет задач' + (filter ? ` с фильтром "${filter}"` : '') };
    const PRIORITY_ICONS = { 1: '⚪', 2: '🟡', 3: '🔴' };
    const STATUS_ICONS = { pending: '⬜', done: '✅', in_progress: '🔄', cancelled: '❌' };
    const list = todos.map(t => {
      const pi = PRIORITY_ICONS[t.priority] || '⚪';
      const si = STATUS_ICONS[t.status] || '⬜';
      const due = t.dueAt ? ` ⏰${new Date(t.dueAt).toLocaleDateString('ru')}` : '';
      return `${si} #${t.id} ${pi} ${t.text}${due}`;
    }).join('\n');
    return { success: true, output: `📋 Задачи (${todos.length}):\n${list}` };
  }

  // ── ADD ──
  if (fields.add) {
    const priority = fields.priority ? Math.min(3, Math.max(1, parseInt(fields.priority) || 1)) : 1;
    const category = fields.category || 'general';
    let dueAt = null;
    if (fields.due) {
      const dueMs = parseTimeString(fields.due);
      if (dueMs) dueAt = Date.now() + dueMs;
    }
    const id = nextTodoId++;
    config.todos.push({ id, chatId, text: fields.add, status: 'pending', createdAt: Date.now(), priority, category, dueAt });
    saveConfig();
    return { success: true, output: `📋 Задача #${id} создана: ${fields.add}` };
  }

  // ── COMPLETE ──
  if (fields.complete) {
    const tid = parseInt(fields.complete);
    const todo = config.todos.find(t => t.id === tid && t.chatId === chatId);
    if (!todo) return { success: false, output: `Задача #${tid} не найдена` };
    todo.status = 'done';
    todo.completedAt = Date.now();
    saveConfig();
    return { success: true, output: `✅ Задача #${tid} завершена: ${todo.text}` };
  }

  // ── UPDATE ──
  if (fields.update) {
    const tid = parseInt(fields.update);
    const todo = config.todos.find(t => t.id === tid && t.chatId === chatId);
    if (!todo) return { success: false, output: `Задача #${tid} не найдена` };
    if (fields.text) todo.text = fields.text;
    if (fields.priority) todo.priority = Math.min(3, Math.max(1, parseInt(fields.priority) || todo.priority));
    if (fields.category) todo.category = fields.category;
    if (fields.status) todo.status = fields.status;
    if (fields.due) {
      const dueMs = parseTimeString(fields.due);
      if (dueMs) todo.dueAt = Date.now() + dueMs;
    }
    saveConfig();
    return { success: true, output: `📝 Задача #${tid} обновлена` };
  }

  // ── DELETE ──
  if (fields.delete) {
    const tid = parseInt(fields.delete);
    const idx = config.todos.findIndex(t => t.id === tid && t.chatId === chatId);
    if (idx === -1) return { success: false, output: `Задача #${tid} не найдена` };
    config.todos.splice(idx, 1);
    saveConfig();
    return { success: true, output: `🗑 Задача #${tid} удалена` };
  }

  return { success: false, output: 'Укажите операцию: add, complete, list, update или delete' };
}

async function executeQualityCheckAction(chatId, body) {
  const lines = body.split('\n');
  const fields = { criteria: [], target: '' };
  let inCriteria = false;
  for (const line of lines) {
    const targetMatch = line.match(/^target:\s*(.+)/i);
    if (targetMatch) { fields.target = targetMatch[1].trim(); inCriteria = false; continue; }
    if (/^criteria:\s*$/i.test(line)) { inCriteria = true; continue; }
    if (inCriteria && /^-\s+/.test(line)) { fields.criteria.push(line.replace(/^-\s+/, '').trim()); continue; }
    if (/^criteria:\s*(.+)/i.test(line)) {
      fields.criteria.push(line.replace(/^criteria:\s*/i, '').trim());
      continue;
    }
  }

  if (!fields.criteria.length) return { success: false, output: 'Укажите criteria (список критериев)' };
  if (!fields.target) return { success: false, output: 'Укажите target (что проверять)' };

  const prompt = `You are a quality control inspector. Evaluate the following work against the given criteria.

TARGET (work to evaluate):
${fields.target}

CRITERIA:
${fields.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For each criterion, respond:
- ✅ PASS: [brief reason]
- ❌ FAIL: [what's wrong]

Then give overall verdict: QA PASS or QA FAIL
Keep response concise (under 500 chars).`;

  try {
    const result = await callAI('gemini-2.5-flash', [{ role: 'user', content: prompt }], 'You are a strict QA inspector.', false, chatId);
    const verdict = result.includes('QA FAIL') ? '❌ QA FAIL' : '✅ QA PASS';
    return { success: true, output: `🔍 Проверка качества:\n${result.slice(0, 1500)}\n\n${verdict}` };
  } catch (e) {
    return { success: false, output: `Ошибка QA: ${e.message}` };
  }
}

async function executeSearchAction(query, chatId) {
  const uc = chatId ? getUserConfig(chatId) : {};
  const key = uc.apiKeys?.google || process.env.GEMINI_API_KEY;
  if (!key) {
    return { success: false, output: 'GEMINI_API_KEY не задан — веб-поиск недоступен. Ответь на основе своих знаний.' };
  }
  try {
    const body = {
      contents: [{ parts: [{ text: query.trim() }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 4096 }
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { success: false, output: `Search API error: HTTP ${res.status}. ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
    const grounding = data.candidates?.[0]?.groundingMetadata;
    let sources = '';
    if (grounding?.groundingChunks) {
      sources = '\n\nИсточники:\n' + grounding.groundingChunks
        .filter(c => c.web).map(c => `- ${c.web.title || c.web.uri}: ${c.web.uri}`).slice(0, 8).join('\n');
    }
    let output = text + sources;
    output = truncateOutput(output);
    return { success: true, output, isSearch: true, query: query.trim() };
  } catch (e) {
    return { success: false, output: `Ошибка поиска: ${e.message?.slice(0, 300)}` };
  }
}

async function executeFileAction(chatId, filePath) {
  const uc = getUserConfig(chatId);
  const cleanPath = filePath.split('\n')[0].trim();
  const resolvedWorkDir = path.resolve(uc.workDir) + path.sep;
  const resolved = path.resolve(uc.workDir, cleanPath);
  if (!resolved.startsWith(resolvedWorkDir) && resolved !== path.resolve(uc.workDir)) {
    return { success: false, output: 'Доступ запрещён: файл вне рабочей директории' };
  }
  try { await fs.promises.access(resolved, fs.constants.R_OK); } catch (_) {
    return { success: false, output: `Файл не найден: ${resolved}. Убедись, что файл создан через [ACTION: bash] перед отправкой.` };
  }
  sendDocument(chatId, resolved);
  return { success: true, output: `Файл отправлен: ${resolved}` };
}

// === OpenClaw-like File Tools ===

async function executeReadFileAction(chatId, body) {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  let filePath = lines[0];
  let offset = 0;
  let limit = 2000;
  for (const line of lines) {
    const pm = line.match(/^path:\s*(.+)/i);
    const om = line.match(/^offset:\s*(\d+)/i);
    const lm = line.match(/^limit:\s*(\d+)/i);
    if (pm) filePath = pm[1].trim();
    if (om) offset = parseInt(om[1]);
    if (lm) limit = Math.min(parseInt(lm[1]), 5000);
  }
  if (!filePath) return { success: false, output: 'read_file: укажи путь к файлу' };
  filePath = filePath.replace(/^path:\s*/i, '').trim();
  const sec = resolveSecurePath(chatId, filePath);
  if (sec.error) return { success: false, output: sec.error };
  const resolved = sec.resolved;
  let stat;
  try { stat = await fs.promises.stat(resolved); } catch (e) { return { success: false, output: `Файл не найден: ${resolved}` }; }
  if (stat.isDirectory()) return { success: false, output: `${resolved} — директория. Используй [ACTION: bash] ls` };
  if (stat.size > 10 * 1024 * 1024) return { success: false, output: `Файл слишком большой (${(stat.size / 1024 / 1024).toFixed(1)}MB). Используй offset/limit` };
  // Binary detection
  const fh = await fs.promises.open(resolved, 'r');
  const sample = Buffer.alloc(512);
  const { bytesRead } = await fh.read(sample, 0, 512, 0);
  await fh.close();
  if (sample.slice(0, bytesRead).filter(b => b === 0).length > bytesRead * 0.1) {
    return { success: false, output: `Файл бинарный (${stat.size} bytes). Отправь через [ACTION: file]` };
  }
  const content = await fs.promises.readFile(resolved, 'utf-8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const sliced = allLines.slice(offset, offset + limit);
  const numbered = sliced.map((l, i) => `${offset + i + 1} | ${l}`).join('\n');
  let output = `📄 ${resolved} (${totalLines} строк, ${stat.size} bytes)`;
  if (offset > 0 || limit < totalLines) output += `\nСтроки ${offset + 1}-${Math.min(offset + limit, totalLines)} из ${totalLines}`;
  output += '\n' + numbered;
  return { success: true, output: truncateOutput(output) };
}

async function executeWriteFileAction(chatId, body) {
  const pathMatch = body.match(/^path:\s*(.+)/im);
  if (!pathMatch) return { success: false, output: 'write_file: требуется поле "path:"' };
  const filePath = pathMatch[1].trim();
  const contentMatch = body.match(/^content:\s*\n?([\s\S]*)/im);
  if (!contentMatch) return { success: false, output: 'write_file: требуется поле "content:"' };
  const content = contentMatch[1];
  const sec = resolveSecurePath(chatId, filePath);
  if (sec.error) return { success: false, output: sec.error };
  const resolved = sec.resolved;
  // Safety: prevent overwriting critical files for non-admins
  const dangerous = ['.env', 'config.json', 'bot.js', 'package.json', 'users.json'];
  if (dangerous.some(d => resolved.endsWith(d)) && !isAdmin(chatId)) {
    return { success: false, output: 'Запрещено перезаписывать системные файлы' };
  }
  const dir = path.dirname(resolved);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    let existed = false;
    try { await fs.promises.access(resolved); existed = true; } catch (_) {}
    await fs.promises.writeFile(resolved, content, 'utf-8');
    const lineCount = content.split('\n').length;
    const stat = await fs.promises.stat(resolved);
    return { success: true, output: `${existed ? '✏️ Перезаписан' : '📝 Создан'}: ${resolved} (${lineCount} строк, ${stat.size} bytes)` };
  } catch (e) {
    return { success: false, output: `Ошибка записи файла: ${e.message}` };
  }
}

async function executeEditFileAction(chatId, body) {
  const pathMatch = body.match(/^path:\s*(.+)/im);
  if (!pathMatch) return { success: false, output: 'edit_file: требуется поле "path:"' };
  const filePath = pathMatch[1].trim();
  const sec = resolveSecurePath(chatId, filePath);
  if (sec.error) return { success: false, output: sec.error };
  const resolved = sec.resolved;
  try { await fs.promises.access(resolved); } catch (_) { return { success: false, output: `Файл не найден: ${resolved}` }; }
  const oldMatch = body.match(/old_text:\s*\n([\s\S]*?)(?=\nnew_text:)/i);
  const newMatch = body.match(/new_text:\s*\n([\s\S]*?)$/i);
  if (!oldMatch) return { success: false, output: 'edit_file: требуется поле "old_text:"' };
  if (!newMatch) return { success: false, output: 'edit_file: требуется поле "new_text:"' };
  const oldText = oldMatch[1];
  const newText = newMatch[1];
  let content = await fs.promises.readFile(resolved, 'utf-8');
  if (!content.includes(oldText)) {
    const trimmedOld = oldText.trim();
    if (trimmedOld && content.includes(trimmedOld)) {
      content = content.replace(trimmedOld, newText.trim());
    } else {
      return { success: false, output: 'edit_file: old_text не найден в файле. Используй [ACTION: read_file] чтобы проверить содержимое.' };
    }
  } else {
    content = content.replace(oldText, newText);
  }
  await fs.promises.writeFile(resolved, content, 'utf-8');
  const lineCount = content.split('\n').length;
  return { success: true, output: `✅ Файл изменён: ${resolved} (${lineCount} строк)` };
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

    const responseText = (result?.text || '').trim();
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


// === Plan Action: декомпозиция задачи ===
async function executePlanAction(chatId, body, statusUpdater) {
  const tracker = multiAgentTasks.get(chatId);
  const goalMatch = body.match(/goal:\s*(.+)/i);
  const goal = goalMatch ? goalMatch[1].trim() : 'Цель не указана';

  const subtaskMatches = [...body.matchAll(/- id:\s*(\d+),\s*role:\s*([\w\-а-яёА-ЯЁ]+),\s*task:\s*(.+?)(?:,\s*priority:\s*(\w+))?(?:,\s*deps:\s*\[([^\]]*)\])?(?:,\s*schedule:\s*(\S+))?$/gm)];
  if (subtaskMatches.length === 0) {
    return { success: false, output: 'plan: подзадачи не найдены. Формат: - id: N, role: X, task: Y, deps: [N], schedule: 2h' };
  }

  const plan = {
    goal,
    subtasks: subtaskMatches.map(m => ({
      id: parseInt(m[1]),
      role: m[2].trim().toLowerCase(),
      task: m[3].trim(),
      priority: (m[4] || 'medium').trim(),
      deps: m[5] ? m[5].split(',').map(d => parseInt(d.trim())).filter(Boolean) : [],
      schedule: m[6] ? m[6].trim() : null,
      status: 'pending',
    })),
    createdAt: Date.now(),
  };

  if (tracker) {
    tracker.plan = plan;
    tracker.log.push({ ts: Date.now(), text: `📋 План: ${plan.subtasks.length} подзадач для "${goal.slice(0, 60)}"` });
  }

  const planDisplay = plan.subtasks.map(st => {
    const roleInfo = getAgentRoleInfo(chatId, st.role);
    const depsStr = st.deps.length > 0 ? ` (после: ${st.deps.join(',')})` : '';
    const schedStr = st.schedule ? ` ⏰${st.schedule}` : '';
    return `  ${st.id}. ${roleInfo.icon} ${st.role}: ${st.task.slice(0, 80)}${depsStr}${schedStr}`;
  }).join('\n');

  if (statusUpdater) statusUpdater(`📋 План: ${plan.subtasks.length} подзадач`);

  return {
    success: true,
    output: `[PLAN]\n🎯 Цель: ${goal}\n\n📋 Подзадачи:\n${planDisplay}\n[/PLAN]`,
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
  if (tracker) tracker.log.push({ ts: Date.now(), text: `🤖 Создан агент: ${icon} ${label} (${id})` });

  return {
    success: true,
    output: `Агент создан: ${icon} ${label} (id: ${id})\nМаксимум шагов: ${maxSteps}`,
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
  const serverMatch = body.match(/server:\s*(\S+)/i);
  const toolMatch = body.match(/tool:\s*(\S+)/i);
  const argsMatch = body.match(/args:\s*(\{[\s\S]*\})/i);

  if (!serverMatch) return { success: false, output: 'mcp: требуется поле "server:" (например server: rube)' };
  if (!toolMatch) return { success: false, output: 'mcp: требуется поле "tool:" (имя инструмента)' };

  const serverId = serverMatch[1].trim();
  const toolName = toolMatch[1].trim();
  let args = {};
  if (argsMatch) {
    try { args = JSON.parse(argsMatch[1].trim()); }
    catch (e) { return { success: false, output: `mcp: невалидный JSON в args: ${e.message}` }; }
  }

  try {
    // NotebookLM использует stdio-клиент (nbClient), а не HTTP MCP
    if (serverId.toLowerCase() === 'notebooklm') {
      const result = await nbClient.call(toolName, args);
      return { success: true, output: `[MCP notebooklm/${toolName}]\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n[/MCP]` };
    }
    const client = await getMcpClient(chatId, serverId);
    const result = await client.callTool(toolName, args);
    return { success: true, output: `[MCP ${serverId}/${toolName}]\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n[/MCP]` };
  } catch (e) {
    return { success: false, output: `MCP ошибка: ${e.message}` };
  }
}

async function executeImageAction(chatId, body) {
  const { prompt: rawPrompt, negativePrompt } = parseNegativePrompt(body);

  // Auto-detect: if user has uploaded photo and prompt looks like edit instruction → redirect to image_edit
  const storedFrames = sessionFrames.get(chatId);
  const hasPhoto = !!(storedFrames?.lastPhoto);
  if (hasPhoto) {
    const editKeywords = /измени|поменяй|замени|добавь|убери|удали|сделай фон|change|replace|add|remove|modify|edit|swap|make.*background|фон|волосы|одежд|цвет|перекрас|ретушь|retouch/i;
    if (editKeywords.test(rawPrompt)) {
      return executeImageEditAction(chatId, rawPrompt);
    }
  }

  const uc = getUserConfig(chatId);
  const genOpts = {};
  if (uc.imageSize) genOpts.imageSize = uc.imageSize;

  const startTime = Date.now();
  const statusMsg = await send(chatId, '🎨 Подготовка промпта...');
  const statusMsgId = statusMsg?.result?.message_id;

  // AI-powered prompt enhancement
  let prompt = rawPrompt;
  let engineModel = null;
  try {
    const enhanced = await mediaPromptEngine.generateImagePrompt(rawPrompt, { chatId });
    prompt = enhanced.prompt;
    if (enhanced.enhanced) {
      engineModel = enhanced.model;
      if (enhanced.aspectRatio) genOpts.aspectRatio = enhanced.aspectRatio;
      if (!negativePrompt && enhanced.negativePrompt) genOpts.negativePrompt = enhanced.negativePrompt;
      console.log(`[MediaEngine] Image prompt enhanced: style=${enhanced.style}, model=${engineModel}, sphere=${enhanced.metadata?.sphere}`);
    }
  } catch (e) {
    console.warn('[MediaEngine] Image prompt enhancement skipped:', e.message);
  }

  if (negativePrompt) genOpts.negativePrompt = negativePrompt;
  const primaryModel = engineModel || uc.imageModel || 'nano-banana';
  const fallbackOrder = ['nano-banana-2', 'nano-banana', 'imagen-4-fast', 'imagen-4', 'nano-banana-pro', 'imagen-3', 'imagen-3-fast', 'imagen-4-ultra'].filter(m => m !== primaryModel);
  const modelsToTry = [primaryModel, ...fallbackOrder];
  const errors = [];
  let attempt = 0;

  for (const modelKey of modelsToTry) {
    attempt++;
    const modelLabel = IMAGE_MODELS[modelKey]?.label || modelKey;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (statusMsgId) {
      const statusText = attempt === 1
        ? `🎨 Генерация · ${modelLabel}\n${gradientBar(30, 20)} ⏱ ${elapsed}с`
        : `🎨 Пробую ${modelLabel} (${attempt}/${modelsToTry.length})\n${gradientBar(Math.round(attempt / modelsToTry.length * 80), 20)} ⏱ ${elapsed}с`;
      editText(chatId, statusMsgId, statusText);
    }
    try {
      const results = await generateImage(chatId, prompt, { ...genOpts, model: modelKey });
      const images = results.filter(r => r.type === 'image');
      const texts = results.filter(r => r.type === 'text');
      const elapsed2 = Math.round((Date.now() - startTime) / 1000);
      const fallbackNote = modelKey !== primaryModel ? ` · ${modelLabel}` : '';
      if (statusMsgId) { editText(chatId, statusMsgId, `✅ Фото готово${fallbackNote} (${elapsed2}с)`); autoDeleteMsg(chatId, statusMsgId); }
      for (const img of images) {
        await sendPhoto(chatId, img.path, prompt.slice(0, 200));
        // Save generated image to sessionFrames for chaining (e.g. "draw → animate")
        try {
          const newData = (await fs.promises.readFile(img.path)).toString('base64');
          if (!sessionFrames.has(chatId)) sessionFrames.set(chatId, { lastPhotos: [], lastPhotosPaths: [] });
          const frames = sessionFrames.get(chatId);
          frames.lastPhoto = newData;
          frames.lastPhotoPath = img.path;
          frames.lastPhotoAt = Date.now();
          if (!frames.lastPhotos) frames.lastPhotos = [];
          frames.lastPhotos.push(newData);
          if (frames.lastPhotos.length > 10) frames.lastPhotos.shift();
        } catch (e) { /* ignore */ }
        try { await fs.promises.unlink(img.path); } catch (e) { }
      }
      const textResult = texts.map(t => t.text).join('\n').slice(0, 500);
      const fallbackNote2 = modelKey !== primaryModel ? ` (через ${IMAGE_MODELS[modelKey]?.label || modelKey})` : '';
      return { success: true, output: `Изображение отправлено${fallbackNote2}. ${textResult}` };
    } catch (e) {
      errors.push(`${modelKey}: ${e.message}`);
      continue;
    }
  }

  if (statusMsgId) { editText(chatId, statusMsgId, `❌ Все генераторы недоступны`); autoDeleteMsg(chatId, statusMsgId); }
  return { success: false, output: `Все генераторы изображений недоступны (${errors.join('; ')}). ОБЯЗАТЕЛЬНО используй альтернативный подход: создай визуал через bash (node -e с canvas/SVG), или создай HTML-макет и сделай скриншот через bash. НЕ отправляй сырой код пользователю.` };
}

async function executeImageEditAction(chatId, body) {
  const storedFrames = sessionFrames.get(chatId);
  const photos = (storedFrames?.lastPhotos && storedFrames.lastPhotos.length > 0)
    ? storedFrames.lastPhotos
    : (storedFrames?.lastPhoto ? [storedFrames.lastPhoto] : []);

  if (photos.length === 0) {
    return { success: false, output: 'Нет загруженных фото для редактирования. Попроси пользователя отправить фото.' };
  }

  const uc = getUserConfig(chatId);
  const editModels = ['nano-banana', 'nano-banana-2', 'nano-banana-pro'];
  const primaryModel = editModels.includes(uc.imageModel) ? uc.imageModel : 'nano-banana';
  const fallbackOrder = editModels.filter(m => m !== primaryModel);
  const modelsToTry = [primaryModel, ...fallbackOrder];

  const instruction = body.trim();
  const errors = [];
  const startTime = Date.now();
  const photoLabel = photos.length > 1 ? `${photos.length} фото` : 'фото';
  const statusMsg = await send(chatId, `✏️ Редактирование ${photoLabel}...`);
  const statusMsgId = statusMsg?.result?.message_id;
  let attempt = 0;

  for (const modelKey of modelsToTry) {
    attempt++;
    const modelLabel = IMAGE_MODELS[modelKey]?.label || modelKey;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (statusMsgId) {
      const statusText = attempt === 1
        ? `✏️ Редактирование · ${modelLabel}\n${gradientBar(30, 20)} ⏱ ${elapsed}с`
        : `✏️ Пробую ${modelLabel} (${attempt}/${modelsToTry.length})\n${gradientBar(Math.round(attempt / modelsToTry.length * 80), 20)} ⏱ ${elapsed}с`;
      editText(chatId, statusMsgId, statusText);
    }
    try {
      const results = await generateImage(chatId, instruction, {
        model: modelKey,
        referenceImages: photos,
        aspectRatio: uc.imageAspect || '1:1',
      });
      const images = results.filter(r => r.type === 'image');
      if (images.length === 0) throw new Error('Нет изображений в ответе');

      const elapsed2 = Math.round((Date.now() - startTime) / 1000);
      const fallbackNote = modelKey !== primaryModel ? ` · ${modelLabel}` : '';
      if (statusMsgId) { editText(chatId, statusMsgId, `✅ Редактирование готово${fallbackNote} (${elapsed2}с)`); autoDeleteMsg(chatId, statusMsgId); }

      for (const img of images) {
        await sendPhoto(chatId, img.path, `✏️ ${instruction.slice(0, 180)}`);
        try {
          const editedData = (await fs.promises.readFile(img.path)).toString('base64');
          if (!sessionFrames.has(chatId)) sessionFrames.set(chatId, { lastPhotos: [], lastPhotosPaths: [] });
          const frames = sessionFrames.get(chatId);
          frames.lastPhoto = editedData;
          frames.lastPhotoPath = img.path;
          frames.lastPhotoAt = Date.now();
          if (!frames.lastPhotos) frames.lastPhotos = [];
          frames.lastPhotos.push(editedData);
          if (frames.lastPhotos.length > 10) frames.lastPhotos.shift();
          frames.editedPhoto = true;
        } catch (e) { /* ignore */ }
        try { await fs.promises.unlink(img.path); } catch (e) { /* ignore */ }
      }

      return { success: true, output: photos.length > 1
        ? `Фото (${photos.length} шт.) отредактированы. Результат сохранён.`
        : 'Фото отредактировано и сохранено. Пользователь может попросить "оживи" для создания видео из отредактированного изображения.' };
    } catch (e) {
      errors.push(`${modelKey}: ${e.message}`);
      continue;
    }
  }
  if (statusMsgId) { editText(chatId, statusMsgId, `❌ Ошибка редактирования`); autoDeleteMsg(chatId, statusMsgId); }
  return { success: false, output: `Ошибка редактирования (${errors.join('; ')}). Попробуй переформулировать инструкцию.` };
}

async function executeVideoAction(chatId, body, statusUpdater) {
  const { prompt: rawPrompt, negativePrompt } = parseNegativePrompt(body);
  const uc = getUserConfig(chatId);

  // Detect stored frames for context
  const storedFrames = sessionFrames.get(chatId);
  const hasStartFrame = !!(storedFrames && (storedFrames.startFrame || storedFrames.lastPhoto));
  const hasEndFrame = !!(storedFrames && storedFrames.endFrame);

  // AI-powered prompt enhancement
  let prompt = rawPrompt;
  let engineModel = null;
  let engineOpts = {};
  try {
    const enhanced = await mediaPromptEngine.generateVideoPrompt(rawPrompt, { chatId }, { hasStartFrame, hasEndFrame });
    prompt = enhanced.prompt;
    if (enhanced.enhanced) {
      engineModel = enhanced.model;
      engineOpts.duration = enhanced.duration;
      engineOpts.resolution = enhanced.resolution;
      engineOpts.aspectRatio = enhanced.aspectRatio;
      if (!negativePrompt && enhanced.negativePrompt) engineOpts.negativePrompt = enhanced.negativePrompt;
      console.log(`[MediaEngine] Video prompt enhanced: model=${engineModel}, duration=${enhanced.duration}, sphere=${enhanced.metadata?.sphere}`);
    }
  } catch (e) {
    console.warn('[MediaEngine] Video prompt enhancement skipped:', e.message);
  }

  const primaryModel = engineModel || uc.videoModel || 'veo-3.1-fast';
  const fallbackOrder = ['veo-3.1-fast', 'veo-3.1', 'veo-2'].filter(m => m !== primaryModel);
  const modelsToTry = [primaryModel, ...fallbackOrder];
  const errors = [];

  const primaryLabel = VIDEO_MODELS[primaryModel]?.label || primaryModel;
  const statusMsg = await send(chatId, `🎬 Генерация видео · ${primaryLabel}\n${gradientBar(10, 20)} ⏱ 0с`);
  const statusMsgId = statusMsg?.result?.message_id;
  let attempt = 0;

  for (const modelKey of modelsToTry) {
    attempt++;
    const startTime = Date.now();
    const modelLabel = VIDEO_MODELS[modelKey]?.label || modelKey;
    try {
      if (statusMsgId && modelKey !== primaryModel) {
        editText(chatId, statusMsgId, `🎬 Пробую ${modelLabel} (${attempt}/${modelsToTry.length})\n${gradientBar(15, 20)} ⏱ 0с`);
      }
      const vidOpts = {
        model: modelKey,
        ...engineOpts,
        onProgress: (poll) => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const pct = Math.min(90, 15 + elapsed * 2);
          if (statusMsgId) editText(chatId, statusMsgId, `🎬 ${modelLabel}\n${gradientBar(pct, 20)} ⏱ ${elapsed}с`);
        }
      };
      if (negativePrompt) vidOpts.negativePrompt = negativePrompt;
      // Подставляем сохранённые кадры пользователя (startFrame > lastPhoto > referenceImage)
      if (storedFrames) {
        if (storedFrames.startFrame) {
          vidOpts.startFrame = storedFrames.startFrame;
        } else if (storedFrames.lastPhoto) {
          vidOpts.referenceImage = storedFrames.lastPhoto;
        } else if (storedFrames.referenceImage) {
          vidOpts.referenceImage = storedFrames.referenceImage;
        }
        if (storedFrames.endFrame) vidOpts.endFrame = storedFrames.endFrame;
      }
      const result = await generateVideo(chatId, prompt, vidOpts);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const fallbackNote = modelKey !== primaryModel ? ` · ${modelLabel}` : '';
      if (statusMsgId) { editText(chatId, statusMsgId, `✅ Видео готово${fallbackNote} (${elapsed}с)\n${gradientBar(100, 20)}`); autoDeleteMsg(chatId, statusMsgId); }
      await sendVideo(chatId, result.path, prompt.slice(0, 200));
      try { fs.unlinkSync(result.path); } catch (e) { }
      return { success: true, output: `Видео отправлено${fallbackNote}` };
    } catch (e) {
      errors.push(`${modelLabel}: ${e.message}`);
      continue;
    }
  }

  if (statusMsgId) { editText(chatId, statusMsgId, `❌ Все модели видео недоступны`); autoDeleteMsg(chatId, statusMsgId); }
  return { success: false, output: `Все модели видео недоступны (${errors.join('; ')}). Предложи пользователю попробовать позже или использовать другой промпт.` };
}

async function executeVideoExtendAction(chatId, body, statusUpdater) {
  try {
    const statusMsg = await send(chatId, '🎬 Продление видео... (требуется видео через /videoextend)');
    const statusMsgId = statusMsg?.result?.message_id;
    // Agent-triggered action — у агента нет доступа к reply-контексту с видеофайлом
    // Направляем пользователя использовать /videoextend
    if (statusMsgId) { editText(chatId, statusMsgId, '⚠️ Для продления видео используйте /videoextend (ответ на видео)'); autoDeleteMsg(chatId, statusMsgId); }
    return { success: false, output: 'video_extend требует ответа на видео. Предложи пользователю команду: /videoextend [промпт] (ответом на видео).' };
  } catch (e) {
    return { success: false, output: `Ошибка: ${e.message}` };
  }
}

// === Scenario: покадровая генерация видео-истории ===
async function executeScenarioAction(chatId, body, statusUpdater) {
  try {
    const statusMsg = await send(chatId, '🎬 Создаю сценарий...');
    const statusMsgId = statusMsg?.result?.message_id;

    // Generate storyboard via MediaPromptEngine
    const scenario = await mediaPromptEngine.generateScenario(body, { chatId });

    // Send storyboard summary
    const charDesc = scenario.characters
      ? Object.entries(scenario.characters).map(([id, desc]) => `  • ${id}: ${desc.slice(0, 100)}...`).join('\n')
      : '  (нет персонажей)';
    const frameList = scenario.frames.map(f =>
      `  ${f.id}. ${f.title || 'Кадр ' + f.id} (${f.duration}с) — ${f.camera || 'auto'}`
    ).join('\n');

    await send(chatId, `🎬 **${scenario.title || 'Видео-сценарий'}**\n\n` +
      `📊 Кадров: ${scenario.totalFrames} | Длительность: ~${scenario.totalDuration}с\n\n` +
      `👤 Персонажи:\n${charDesc}\n\n` +
      `🎞 Раскадровка:\n${frameList}\n\n` +
      `⏳ Начинаю покадровую генерацию...`);

    let lastFrameBase64 = null;
    const generatedPaths = [];

    for (let i = 0; i < scenario.frames.length; i++) {
      const frame = scenario.frames[i];
      const label = `${i + 1}/${scenario.totalFrames}`;

      if (statusMsgId) {
        editText(chatId, statusMsgId, `🎬 Генерация кадра ${label}: ${frame.title || ''}... ⏱ 0с`);
      }

      const startTime = Date.now();
      const vidOpts = {
        duration: frame.duration || 8,
        onProgress: (poll) => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          if (statusMsgId) editText(chatId, statusMsgId, `🎬 Кадр ${label}... ⏱ ${elapsed}с`);
        }
      };

      // Use last frame of previous video as reference for consistency
      if (lastFrameBase64) {
        vidOpts.referenceImage = lastFrameBase64;
      }

      try {
        const result = await generateVideo(chatId, frame.prompt, vidOpts);
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        // Send the frame video
        const caption = `🎞 Кадр ${label}: ${frame.title || ''} (${elapsed}с)${frame.transition && frame.transition !== 'none' ? ` → ${frame.transition}` : ''}`;
        await sendVideo(chatId, result.path, caption.slice(0, 200));
        generatedPaths.push(result.path);

        // Extract last frame for next video's reference
        const extracted = await extractLastFrame(result.path);
        if (extracted) {
          lastFrameBase64 = extracted;
        }

        // Store in session frames
        if (!sessionFrames.has(chatId)) sessionFrames.set(chatId, {});
        const frames = sessionFrames.get(chatId);
        if (extracted) {
          frames.lastPhoto = extracted;
          frames.lastPhotoAt = Date.now();
        }

        mediaPromptEngine.advanceFrame(chatId, { path: result.path, frame: i });

        try { fs.unlinkSync(result.path); } catch (e) { }
      } catch (e) {
        await send(chatId, `❌ Кадр ${label} не удался: ${e.message}`);
        mediaPromptEngine.advanceFrame(chatId, { error: e.message, frame: i });
        // Continue with next frame
      }
    }

    const successCount = generatedPaths.length;
    if (statusMsgId) {
      editText(chatId, statusMsgId, `✅ Сценарий завершён: ${successCount}/${scenario.totalFrames} кадров`);
      autoDeleteMsg(chatId, statusMsgId);
    }

    mediaPromptEngine.clearScenario(chatId);
    return {
      success: successCount > 0,
      output: `Сценарий "${scenario.title}" завершён. Сгенерировано ${successCount}/${scenario.totalFrames} кадров (~${successCount * 8}с видео).`
    };
  } catch (e) {
    return { success: false, output: `Ошибка сценария: ${e.message}` };
  }
}

// === Figma интеграция через REST API ===
// === Figma Design — AI-powered layout/creative generation via Figma MCP ===
const FIGMA_DESIGN_TEMPLATES = {
  landing: { label: 'Landing Page', size: '1440x900', desc: 'Hero + Features + Testimonials + CTA + Footer' },
  card: { label: 'Card/Creative', size: '1080x1080', desc: 'Visual card for social media or marketing' },
  stories: { label: 'Stories/Reels', size: '1080x1920', desc: 'Vertical story format for Instagram/TikTok' },
  carousel: { label: 'Carousel', size: '1080x1080', desc: 'Multi-slide carousel for Instagram/LinkedIn' },
  banner: { label: 'Banner/Ad', size: '1200x628', desc: 'Web banner or social media ad' },
  dashboard: { label: 'Dashboard', size: '1440x900', desc: 'Analytics dashboard with sidebar, stats, charts' },
  email: { label: 'Email Template', size: '600x800', desc: 'Email newsletter template' },
  presentation: { label: 'Presentation Slide', size: '1920x1080', desc: 'Pitch deck / presentation slide' },
  mobile: { label: 'Mobile Screen', size: '390x844', desc: 'iPhone mobile app screen' },
  website: { label: 'Website Section', size: '1440x900', desc: 'Custom website section/block' },
};

async function executeFigmaDesignAction(chatId, body, statusUpdater) {
  // Parse: brief, figma URL, template
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  let figmaUrl = '';
  let template = '';
  let brief = '';

  for (const line of lines) {
    const urlMatch = line.match(/(?:url|file|figma):\s*(https?:\/\/[^\s]+)/i) || line.match(/(https:\/\/www\.figma\.com\/[^\s]+)/i);
    if (urlMatch) { figmaUrl = urlMatch[1]; continue; }
    const tmplMatch = line.match(/(?:template|шаблон|тип):\s*(\w+)/i);
    if (tmplMatch) { template = tmplMatch[1].toLowerCase(); continue; }
    brief += (brief ? '\n' : '') + line;
  }

  if (!brief) return { success: false, output: 'Укажи описание дизайна. Пример:\n[ACTION: figma_design]\nЛендинг для кофейни "Brew Lab". Тёмная тема, минимализм.\nurl: https://www.figma.com/file/XXXXX\n[/ACTION]' };

  // Check Figma MCP availability
  const figmaServer = findMcpServerConfig(chatId, 'figma');
  if (!figmaServer) {
    return { success: false, output: 'Figma MCP не подключен. Подключи:\n1. Добавь MCP сервер: /mcp_add figma https://mcp.figma.com/mcp\n2. Или через настройки: Настройки → Интеграции → Добавить MCP → figma' };
  }

  // Get user's stored figma URL if not provided
  const uc = getUserConfig(chatId);
  if (!figmaUrl && uc.figmaFileUrl) figmaUrl = uc.figmaFileUrl;

  // Save figma URL for future use
  if (figmaUrl && !uc.figmaFileUrl) {
    uc.figmaFileUrl = figmaUrl;
    saveUserConfig(chatId);
  }

  // Auto-detect template from brief
  if (!template) {
    const briefLower = brief.toLowerCase();
    if (/лендинг|landing|посадочн/i.test(briefLower)) template = 'landing';
    else if (/карточк|card|креатив|creative|пост/i.test(briefLower)) template = 'card';
    else if (/stor|рилс|reels|верти/i.test(briefLower)) template = 'stories';
    else if (/карусел|carousel|слайд/i.test(briefLower)) template = 'carousel';
    else if (/баннер|banner|реклам|ad\b/i.test(briefLower)) template = 'banner';
    else if (/дашборд|dashboard|панел|аналит/i.test(briefLower)) template = 'dashboard';
    else if (/email|письм|рассылк|newsletter/i.test(briefLower)) template = 'email';
    else if (/презентац|presentation|pitch|deck|слайд/i.test(briefLower)) template = 'presentation';
    else if (/мобил|mobile|app|приложен/i.test(briefLower)) template = 'mobile';
    else template = 'website';
  }

  const tmpl = FIGMA_DESIGN_TEMPLATES[template] || FIGMA_DESIGN_TEMPLATES.website;
  const [w, h] = tmpl.size.split('x');

  // Get available Figma MCP tools
  let figmaTools = '';
  try {
    const client = await getMcpClient(chatId, figmaServer.id);
    if (client.tools?.length > 0) {
      figmaTools = '\n\n## Available Figma MCP Tools:\n' + client.tools.map(t => `- **${t.name}**: ${t.description || ''}`).join('\n');
    }
  } catch (e) {
    figmaTools = '\n\n(Figma MCP tools not cached — discover them with first mcp call)';
  }

  // Build context for designer agent
  const designContext = `## Design Brief
${brief}

## Template: ${tmpl.label} (${tmpl.size}px)
${tmpl.desc}

## Canvas: ${w}x${h}px
${figmaUrl ? `## Figma File: ${figmaUrl}` : '## No Figma file URL provided — create content and describe it, or ask user for their Figma file URL.'}

## Figma MCP Server ID: ${figmaServer.id}
Use [ACTION: mcp] with server: ${figmaServer.id} for all Figma operations.
${figmaTools}

## Instructions
1. ${figmaUrl ? `First, discover the file structure: [ACTION: mcp] server: ${figmaServer.id}, tool: get_file, args: {file_key from URL}` : 'Ask the user for a Figma file URL, or create the design description.'}
2. Create a new frame "${tmpl.label} — ${brief.slice(0, 40)}" with size ${w}x${h}
3. Build the layout step by step using MCP tools: frames, text, rectangles, images
4. Apply styling: colors, typography, spacing, border-radius
5. After creating all elements, render the result and send it as an image

CRITICAL: Use [ACTION: mcp] for EVERY Figma operation. The server ID is "${figmaServer.id}".
Format: server: ${figmaServer.id}\\ntool: <tool_name>\\nargs: <JSON>`;

  if (statusUpdater) statusUpdater(`🎨 Figma Design: ${tmpl.label} — создаю макет...`);

  try {
    const result = await runSubAgentLoop(chatId, designContext, 'figma_designer', '', 12);

    // Try to render result if we have a figma URL
    if (figmaUrl && result.success) {
      try {
        const fileKeyMatch = figmaUrl.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)/);
        if (fileKeyMatch) {
          const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
          if (FIGMA_TOKEN) {
            const fileKey = fileKeyMatch[1];
            const fileRes = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=1`, {
              headers: { 'X-Figma-Token': FIGMA_TOKEN },
              signal: AbortSignal.timeout(15000),
            });
            if (fileRes.ok) {
              const fileData = await fileRes.json();
              const pages = fileData.document?.children || [];
              const firstPage = pages[0];
              if (firstPage?.children?.length > 0) {
                const lastFrame = firstPage.children[firstPage.children.length - 1];
                const imgRes = await fetch(`https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(lastFrame.id)}&format=png&scale=2`, {
                  headers: { 'X-Figma-Token': FIGMA_TOKEN },
                  signal: AbortSignal.timeout(30000),
                });
                if (imgRes.ok) {
                  const imgData = await imgRes.json();
                  const imgUrl = imgData.images?.[lastFrame.id];
                  if (imgUrl) {
                    const imgPath = `/tmp/figma_design_${Date.now()}.png`;
                    const dlRes = await fetch(imgUrl, { signal: AbortSignal.timeout(30000) });
                    const buf = Buffer.from(await dlRes.arrayBuffer());
                    await fs.promises.writeFile(imgPath, buf);
                    await sendPhoto(chatId, imgPath, `🎨 ${tmpl.label}: ${brief.slice(0, 100)}`);
                    try { await fs.promises.unlink(imgPath); } catch (e) { /* ignore */ }
                  }
                }
              }
            }
          }
        }
      } catch (renderErr) {
        console.warn('[FigmaDesign] Render failed:', renderErr.message);
      }
    }

    return {
      success: result.success,
      output: `[FIGMA DESIGN: ${tmpl.label}]\n\n${result.output}\n\n${figmaUrl ? '📎 Макет создан в Figma файле. Откройте ссылку для просмотра и допиливания.' : 'Описание макета готово. Отправьте ссылку на Figma-файл для автоматического создания.'}\n[/FIGMA DESIGN]`
    };
  } catch (e) {
    return { success: false, output: `Figma Design ошибка: ${e.message}` };
  }
}

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
            await fs.promises.writeFile(imgPath, buf);
            await sendPhoto(chatId, imgPath, `Figma: ${nodeId}`);
            try { await fs.promises.unlink(imgPath); } catch (e) { }
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

// === Background Action (enhanced) ===
async function executeBackgroundAction(chatId, body) {
  const descMatch = body.match(/описание:\s*(.+)/i) || body.match(/desc:\s*(.+)/i);
  const taskMatch = body.match(/задача:\s*([\s\S]+?)(?=\n(?:roles?:|parallel:|chain:|$))/i) || body.match(/task:\s*([\s\S]+?)(?=\n(?:roles?:|parallel:|chain:|$))/i);
  const rolesMatch = body.match(/roles?:\s*(.+)/i);
  const parallelMatch = body.match(/parallel:\s*(true|yes|да)/i);
  const chainMatch = body.match(/chain:\s*([\s\S]+)/i);

  const desc = descMatch ? descMatch[1].trim() : body.split('\n')[0].slice(0, 80);
  const prompt = taskMatch ? taskMatch[1].trim() : body;
  const requestedRoles = rolesMatch ? rolesMatch[1].split(/[,;]\s*/).map(r => r.trim()) : null;
  const isParallel = !!parallelMatch || !!requestedRoles;

  // Определяем домен задачи для информации
  const domain = detectDomain(prompt);
  const domainLabel = domain ? BUSINESS_DOMAINS[domain]?.label : null;

  if (isParallel && requestedRoles) {
    // Фоновая задача с параллельными субагентами
    const taskId = await runBackground(chatId, prompt, desc, { roles: requestedRoles, parallel: true, domain });
    if (taskId) {
      return { success: true, output: `Параллельная фоновая задача запущена: ${desc}\nID: ${taskId}\nРоли: ${requestedRoles.join(', ')}${domainLabel ? `\nДомен: ${domainLabel}` : ''}\nПользователь может продолжать общаться.` };
    }
  } else {
    const taskId = await runBackground(chatId, prompt, desc, { domain });
    if (taskId) {
      return { success: true, output: `Задача запущена в фоне: ${desc}\nID: ${taskId}${domainLabel ? `\nДомен: ${domainLabel}` : ''}\nПользователь может продолжать общаться.` };
    }
  }
  return { success: false, output: 'Не удалось запустить фоновую задачу (лимит достигнут)' };
}

// Memory Action — через Zep (управление автоматическое)
function executeMemoryAction(chatId, body) {
  return { success: true, output: 'Память управляется автоматически через Zep Cloud. Бот запоминает контекст из диалогов.' };
}

// === Delegate Action: прямая делегация субагенту с агентным циклом ===

async function executeDelegateAction(chatId, body, statusUpdater) {
  const roleMatch = body.match(/^role:\s*(.+)/im);
  const taskMatch = body.match(/^task:\s*([\s\S]+?)(?=\n(?:context:|maxSteps:|parallel:|$))/im);
  const contextMatch = body.match(/^context:\s*([\s\S]+?)(?=\n(?:maxSteps:|parallel:|$))/im);
  const stepsMatch = body.match(/^maxSteps:\s*(\d+)/im);
  const parallelMatch = body.match(/^parallel:\s*(true|yes|да)/im);

  const roleStr = roleMatch ? roleMatch[1].trim().toLowerCase() : 'executor';
  const task = taskMatch ? taskMatch[1].trim() : body.split('\n').slice(roleMatch ? 1 : 0).join('\n').trim();
  const context = contextMatch ? contextMatch[1].trim() : '';
  const maxSteps = stepsMatch ? Math.min(parseInt(stepsMatch[1]), 15) : 7;
  const isParallel = !!parallelMatch;

  if (!task) return { success: false, output: 'delegate: требуется поле "task:"' };

  // Поддержка нескольких ролей: "role: coder, reviewer, seo"
  const roles = roleStr.split(/[,;]\s*/).map(r => r.trim()).filter(Boolean);

  const tracker = multiAgentTasks.get(chatId);

  // === Мульти-роль параллельная делегация ===
  if (roles.length > 1 || isParallel) {
    const effectiveRoles = roles.length > 1 ? roles : detectRolesForTask(task);
    if (statusUpdater) statusUpdater(`🚀 Параллельная делегация: ${effectiveRoles.length} агентов`);
    if (tracker) tracker.log.push({ ts: Date.now(), text: `🚀 Параллельная делегация → ${effectiveRoles.join(', ')}` });

    try {
      const result = await autoDelegate(chatId, task, {
        runSubAgentLoop,
        getEffectiveAgents,
        callAI: callAIWithFallback,
        statusUpdater,
        pool: globalPool,
      });

      // Авто-генерация скиллов из успешных выполнений
      if (result.success && result.subtasks) {
        for (const st of result.subtasks) {
          if (st.result?.success && shouldGenerateSkill(st.task, st.result.output, st.result.actions)) {
            const skillDef = generateSkillDefinition(st.task, st.role, st.result.actions, st.result.output);
            const uc = getUserConfig(chatId);
            if (!uc.skills) uc.skills = [];
            if (uc.skills.length < 30) {
              uc.skills.push({ name: skillDef.name, prompt: skillDef.prompt, category: skillDef.category, desc: skillDef.desc });
              saveUserConfig(chatId);
              console.log(`[AutoSkill] Generated: ${skillDef.name} for ${st.role}`);
            }
          }
        }
      }

      const domainLabel = result.domain ? BUSINESS_DOMAINS[result.domain]?.label : 'General';
      return {
        success: result.success,
        output: `[PARALLEL DELEGATE: ${domainLabel} | ${result.roles?.join(', ')}]\n\n${result.output}\n[/PARALLEL DELEGATE]`
      };
    } catch (e) {
      return { success: false, output: `parallel delegate error: ${e.message}` };
    }
  }

  // === Одиночная делегация (оригинальная логика, улучшенная) ===
  const role = roles[0] || 'executor';
  const roleInfo = getAgentRoleInfo(chatId, role);
  if (statusUpdater) statusUpdater(`${roleInfo.icon} ${roleInfo.label}: выполняет задачу...`);
  if (tracker) tracker.log.push({ ts: Date.now(), text: `🚀 Делегация → ${roleInfo.icon} ${roleInfo.label}: ${task.slice(0, 60)}` });

  try {
    const result = await runSubAgentLoop(chatId, task, role, context, maxSteps);
    const actionsInfo = result.actions?.length ? `\n🔧 Действия: ${result.actions.map(a => `${a.success ? '✅' : '❌'} ${a.name}`).join(', ')}` : '';

    // Авто-генерация скиллов
    if (result.success && shouldGenerateSkill(task, result.output, result.actions)) {
      const skillDef = generateSkillDefinition(task, role, result.actions, result.output);
      const uc = getUserConfig(chatId);
      if (!uc.skills) uc.skills = [];
      if (uc.skills.length < 30) {
        uc.skills.push({ name: skillDef.name, prompt: skillDef.prompt, category: skillDef.category, desc: skillDef.desc });
        saveUserConfig(chatId);
        console.log(`[AutoSkill] Generated: ${skillDef.name} for ${role}`);
      }
    }

    return {
      success: result.success,
      output: `[DELEGATE: ${roleInfo.icon} ${roleInfo.label}]${actionsInfo}\n\n${result.output}\n[/DELEGATE]`
    };
  } catch (e) {
    return { success: false, output: `delegate ошибка: ${e.message}` };
  }
}

// === OpenClaw-like Web Tools ===

async function executeWebFetchAction(body, chatId = null) {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  let url = lines[0];
  for (const line of lines) {
    const um = line.match(/^url:\s*(.+)/i);
    if (um) url = um[1].trim();
  }
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { success: false, output: 'web_fetch: требуется валидный URL (http/https)' };
  }
  // SSRF protection
  try {
    const urlObj = new URL(url);
    if (isPrivateHost(urlObj.hostname)) {
      return { success: false, output: 'web_fetch: запросы к локальным/приватным адресам запрещены' };
    }
  } catch (e) { return { success: false, output: `web_fetch: невалидный URL: ${e.message}` }; }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sCORP-Bot/1.0)', 'Accept': 'text/html,application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(30000), redirect: 'follow'
    });
    if (!res.ok) return { success: false, output: `web_fetch: HTTP ${res.status} ${res.statusText}` };
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await res.json();
      return { success: true, output: truncateOutput(`[JSON ${url}]\n${JSON.stringify(json, null, 2)}`) };
    }
    let text = await res.text();
    if (contentType.includes('text/html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
    }
    return { success: true, output: truncateOutput(`[WEB: ${url}]\n${text}`) };
  } catch (e) {
    return { success: false, output: `web_fetch ошибка: ${e.message?.slice(0, 300)}` };
  }
}

async function executeHttpRequestAction(chatId, body) {
  const methodMatch = body.match(/^method:\s*(\w+)/im);
  const urlMatch = body.match(/^url:\s*(.+)/im);
  const headersMatch = body.match(/^headers:\s*(\{[\s\S]*?\})\s*$/im);
  const bodyMatch = body.match(/^body:\s*([\s\S]*?)$/im);
  const method = (methodMatch ? methodMatch[1].trim() : 'GET').toUpperCase();
  const url = urlMatch ? urlMatch[1].trim() : null;
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { success: false, output: 'http_request: требуется поле "url:" с валидным URL' };
  }
  // SSRF protection for non-admins
  if (!isAdmin(chatId)) {
    try {
      const urlObj = new URL(url);
      if (isPrivateHost(urlObj.hostname)) {
        return { success: false, output: 'http_request: запросы к локальным/приватным адресам запрещены' };
      }
    } catch (e) { return { success: false, output: `http_request: невалидный URL: ${e.message}` }; }
  }
  let headers = {};
  if (headersMatch) {
    try { headers = JSON.parse(headersMatch[1]); }
    catch (e) { return { success: false, output: `http_request: невалидный JSON в headers: ${e.message}` }; }
  }
  const fetchOpts = { method, headers, signal: AbortSignal.timeout(30000) };
  if (['POST', 'PUT', 'PATCH'].includes(method) && bodyMatch) {
    fetchOpts.body = bodyMatch[1].trim();
    if (!headers['Content-Type'] && !headers['content-type']) {
      try { JSON.parse(fetchOpts.body); headers['Content-Type'] = 'application/json'; } catch (e) { /* not json */ }
    }
  }
  try {
    const res = await fetch(url, fetchOpts);
    const ct = res.headers.get('content-type') || '';
    let output;
    if (ct.includes('json')) { output = JSON.stringify(await res.json(), null, 2); }
    else { output = await res.text(); }
    const statusInfo = `HTTP ${res.status} ${res.statusText}`;
    return { success: res.ok, output: truncateOutput(`[${method} ${url}] ${statusInfo}\n${output}`) };
  } catch (e) {
    return { success: false, output: `http_request ошибка: ${e.message?.slice(0, 300)}` };
  }
}

// === Browser Automation ===
async function executeBrowseAction(chatId, body) {
  if (!isAdmin(chatId)) {
    return { success: false, output: 'browse: доступ только для администраторов' };
  }

  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const params = {};
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*([\s\S]+)/);
    if (kv) params[kv[1].toLowerCase()] = kv[2].trim();
  }

  const action = params.action || lines[0]?.split(/\s+/)[0]?.toLowerCase();
  if (!action) {
    return { success: false, output: 'browse: требуется действие (goto, click, type, screenshot, evaluate, extract, etc.)' };
  }

  const BROWSE_TIMEOUT = 120_000;

  try {
    switch (action) {
      case 'goto': {
        const url = params.url || lines[0]?.replace(/^goto\s+/i, '').trim();
        if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
          return { success: false, output: 'browse goto: требуется валидный URL (http/https)' };
        }
        try {
          const urlObj = new URL(url);
          if (isPrivateHost(urlObj.hostname)) {
            return { success: false, output: 'browse: навигация к приватным адресам запрещена' };
          }
        } catch (e) {
          return { success: false, output: `browse: невалидный URL: ${e.message}` };
        }

        const page = await browserManager.getPage(chatId);
        const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: BROWSE_TIMEOUT });
        const title = await page.title();
        const status = resp?.status() || 'unknown';

        const session = browserManager.sessions.get(chatId);
        if (session) session.history.push({ action: 'goto', url, title, ts: Date.now() });

        const screenshotPath = `/tmp/browse_${chatId}_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: false });
        try { await sendPhoto(chatId, screenshotPath, `🌐 ${title}`); } catch (e) {}
        try { fs.unlinkSync(screenshotPath); } catch (e) {}

        return { success: true, output: `Navigated to: ${url}\nTitle: ${title}\nStatus: ${status}\nScreenshot sent to chat.` };
      }

      case 'click': {
        const selector = params.selector || params.text || lines[0]?.replace(/^click\s+/i, '').trim();
        if (!selector) return { success: false, output: 'browse click: требуется selector или text' };

        const page = await browserManager.getPage(chatId);
        let clicked = false;
        try {
          await page.click(selector, { timeout: 10000 });
          clicked = true;
        } catch (_) {
          const elements = await page.$$('a, button, [role="button"], input[type="submit"], [onclick]');
          for (const el of elements) {
            const text = await el.evaluate(e => e.textContent?.trim());
            if (text && text.toLowerCase().includes(selector.toLowerCase())) {
              await el.click();
              clicked = true;
              break;
            }
          }
        }
        if (!clicked) return { success: false, output: `browse click: элемент не найден: ${selector}` };

        await new Promise(r => setTimeout(r, 1500));
        const title = await page.title();
        return { success: true, output: `Clicked: ${selector}\nPage title: ${title}` };
      }

      case 'type': {
        const selector = params.selector;
        const value = params.value || params.text;
        if (!selector || !value) {
          return { success: false, output: 'browse type: требуются поля selector: и value:' };
        }
        const page = await browserManager.getPage(chatId);
        await page.click(selector, { timeout: 10000 });
        // Очистить поле перед вводом
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.value = '';
        }, selector);
        await page.type(selector, value, { delay: 50 });
        return { success: true, output: `Typed "${value.slice(0, 50)}${value.length > 50 ? '...' : ''}" into ${selector}` };
      }

      case 'select': {
        const selector = params.selector;
        const value = params.value;
        if (!selector || !value) {
          return { success: false, output: 'browse select: требуются поля selector: и value:' };
        }
        const page = await browserManager.getPage(chatId);
        await page.select(selector, value);
        return { success: true, output: `Selected "${value}" in ${selector}` };
      }

      case 'screenshot': {
        const page = await browserManager.getPage(chatId);
        const fullPage = params.full === 'true' || params.fullpage === 'true';
        const screenshotPath = `/tmp/browse_${chatId}_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage });
        const title = await page.title();
        try { await sendPhoto(chatId, screenshotPath, `📸 ${title}`); } catch (e) {}
        try { fs.unlinkSync(screenshotPath); } catch (e) {}
        return { success: true, output: `Screenshot sent. Page: ${title}` };
      }

      case 'evaluate':
      case 'eval': {
        const script = params.script || params.code || lines.slice(1).join('\n').trim()
          || lines[0]?.replace(/^eval(uate)?\s+/i, '').trim();
        if (!script) return { success: false, output: 'browse evaluate: требуется JavaScript код' };
        const page = await browserManager.getPage(chatId);
        const result = await page.evaluate((code) => {
          try { return eval(code); } catch (e) { return `Error: ${e.message}`; }
        }, script);
        const output = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? 'undefined');
        return { success: true, output: truncateOutput(`[eval result]\n${output}`) };
      }

      case 'wait': {
        const target = params.selector || params.time || params.seconds
          || lines[0]?.replace(/^wait\s+/i, '').trim();
        if (!target) return { success: false, output: 'browse wait: требуется selector или число секунд' };
        const page = await browserManager.getPage(chatId);
        if (/^\d+$/.test(target)) {
          const ms = Math.min(parseInt(target), 30) * 1000;
          await new Promise(r => setTimeout(r, ms));
          return { success: true, output: `Waited ${parseInt(target)} seconds` };
        } else {
          await page.waitForSelector(target, { timeout: BROWSE_TIMEOUT });
          return { success: true, output: `Element appeared: ${target}` };
        }
      }

      case 'scroll': {
        const direction = params.direction || 'down';
        const amount = parseInt(params.amount || params.pixels || '500');
        const page = await browserManager.getPage(chatId);
        const deltaY = direction === 'up' ? -amount : amount;
        await page.evaluate((dy) => window.scrollBy(0, dy), deltaY);
        return { success: true, output: `Scrolled ${direction} by ${Math.abs(amount)}px` };
      }

      case 'extract': {
        const selector = params.selector || lines[0]?.replace(/^extract\s+/i, '').trim();
        if (!selector) return { success: false, output: 'browse extract: требуется CSS selector' };
        const page = await browserManager.getPage(chatId);
        const data = await page.$$eval(selector, els =>
          els.slice(0, 50).map(el => ({
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim().slice(0, 200),
            href: el.href || undefined,
            src: el.src || undefined,
          }))
        );
        return { success: true, output: truncateOutput(`[extract "${selector}"] ${data.length} elements\n${JSON.stringify(data, null, 2)}`) };
      }

      case 'cookies_set': {
        const domain = params.domain;
        const name = params.name;
        const value = params.value;
        if (!domain || !name || !value) {
          return { success: false, output: 'browse cookies_set: требуются domain, name, value' };
        }
        const page = await browserManager.getPage(chatId);
        await page.setCookie({
          name, value, domain, path: '/',
          secure: params.secure === 'true' || domain.includes('google'),
        });
        return { success: true, output: `Cookie set: ${name} on ${domain}` };
      }

      case 'cookies_get': {
        const page = await browserManager.getPage(chatId);
        const cookies = await page.cookies();
        const summary = cookies.slice(0, 30).map(c => `${c.name}=${c.value.slice(0, 20)}... (${c.domain})`);
        return { success: true, output: truncateOutput(`${cookies.length} cookies:\n${summary.join('\n')}`) };
      }

      case 'cookies_save': {
        await browserManager.saveCookies(chatId);
        return { success: true, output: 'Cookies saved to disk.' };
      }

      case 'tabs':
      case 'tab_list': {
        const session = browserManager.sessions.get(chatId);
        if (!session) return { success: false, output: 'No browser session' };
        const pages = await session.browser.pages();
        const tabs = [];
        for (let i = 0; i < pages.length; i++) {
          const title = await pages[i].title().catch(() => '(untitled)');
          tabs.push(`${i}: ${title} — ${pages[i].url()}`);
        }
        return { success: true, output: `${pages.length} tabs:\n${tabs.join('\n')}` };
      }

      case 'tab_switch': {
        const index = parseInt(params.index || params.tab || '0');
        const session = browserManager.sessions.get(chatId);
        if (!session) return { success: false, output: 'No browser session' };
        const pages = await session.browser.pages();
        if (index < 0 || index >= pages.length) return { success: false, output: `Tab ${index} not found (${pages.length} tabs)` };
        session.page = pages[index];
        await pages[index].bringToFront();
        return { success: true, output: `Switched to tab ${index}: ${await pages[index].title()}` };
      }

      case 'tab_new': {
        const session = await browserManager.getOrCreate(chatId);
        const newPage = await session.browser.newPage();
        await newPage.setViewport({ width: 1920, height: 1080 });
        session.page = newPage;
        if (params.url) {
          await newPage.goto(params.url, { waitUntil: 'networkidle2', timeout: BROWSE_TIMEOUT });
        }
        return { success: true, output: `New tab opened${params.url ? ': ' + params.url : ''}` };
      }

      case 'fill_form': {
        // Пакетное заполнение формы: field1: value1\nfield2: value2
        const page = await browserManager.getPage(chatId);
        const fields = Object.entries(params).filter(([k]) => !['action'].includes(k));
        let filled = 0;
        for (const [selector, value] of fields) {
          try {
            await page.click(selector, { timeout: 5000 });
            await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, selector);
            await page.type(selector, value, { delay: 30 });
            filled++;
          } catch (e) {
            // Пробуем по name/id
            try {
              const sel = `[name="${selector}"], #${selector}`;
              await page.click(sel, { timeout: 5000 });
              await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.value = ''; }, sel);
              await page.type(sel, value, { delay: 30 });
              filled++;
            } catch (e2) {}
          }
        }
        return { success: filled > 0, output: `Filled ${filled}/${fields.length} form fields` };
      }

      case 'close': {
        await browserManager.close(chatId);
        return { success: true, output: 'Browser session closed. Cookies saved.' };
      }

      case 'status': {
        const sessions = browserManager.listSessions();
        if (sessions.length === 0) return { success: true, output: 'No active browser sessions.' };
        const info = sessions.map(s =>
          `Chat ${s.chatId}: ${s.connected ? 'ALIVE' : 'DEAD'}, age=${s.age}s, idle=${s.idle}s, history=${s.historyLength}`
        );
        return { success: true, output: info.join('\n') };
      }

      default:
        return { success: false, output: `browse: неизвестная команда "${action}". Доступны: goto, click, type, select, screenshot, evaluate, wait, scroll, extract, fill_form, cookies_set, cookies_get, cookies_save, tabs, tab_switch, tab_new, close, status` };
    }
  } catch (e) {
    const msg = e.message?.slice(0, 500) || String(e);
    // При ошибке навигации или таймауте — пробуем скриншот для контекста
    if (action === 'goto' || action === 'click') {
      try {
        const page = await browserManager.getPage(chatId);
        const errScreenPath = `/tmp/browse_err_${chatId}_${Date.now()}.png`;
        await page.screenshot({ path: errScreenPath, fullPage: false });
        await sendPhoto(chatId, errScreenPath, `⚠️ Error: ${msg.slice(0, 100)}`);
        try { fs.unlinkSync(errScreenPath); } catch (_) {}
      } catch (_) {}
    }
    return { success: false, output: `browse error: ${msg}` };
  }
}

// === Execute Plan (автовыполнение плана) ===
// === Agentic subtask runner: full agent loop for a single subtask ===
async function runSubAgentLoop(chatId, task, role, context, maxSteps, opts = {}) {
  const uc = getUserConfig(chatId);
  const model = uc.model;

  // Build role-specific system prompt
  const effectiveAgents = getEffectiveAgents(chatId);
  const agentDef = effectiveAgents[role];
  let roleSystemPrompt;
  if (agentDef && agentDef.prompt) {
    roleSystemPrompt = `${agentDef.prompt}\n\n${AGENT_SYSTEM_PROMPT}`;
  } else {
    const roleInfo = agentDef || { icon: '🔄', label: role, desc: role };
    roleSystemPrompt = `Ты — ${roleInfo.icon} ${roleInfo.label} (${roleInfo.desc}) в мульти-агентной системе.
Эксперт с 10+ лет опыта. Ответы практичны и actionable. Действуй быстро.
Выполняй ТОЛЬКО свою задачу — не отвлекайся. СКОРОСТЬ: начинай действовать сразу.

${AGENT_SYSTEM_PROMPT}`;
  }
  // Inject available MCP tools so sub-agent knows what servers exist
  const mcpCtx = getMcpToolsForPrompt(chatId);
  if (mcpCtx) roleSystemPrompt += mcpCtx;

  const taskPrompt = `Выполни задачу: ${task}${context ? `\n\nКонтекст от предыдущих шагов:\n${context}` : ''}`;
  const messages = [{ role: 'user', content: taskPrompt }];
  const completedActions = [];
  let finalOutput = '';

  for (let step = 0; step < maxSteps; step++) {
    try {
      const aiResult = await callAIWithFallback(model, messages, roleSystemPrompt, chatId, { allowMcp: true });
      const responseText = (aiResult.text || '').trim();
      if (!responseText) break;

      const action = parseAction(responseText);
      if (!action) {
        // No action — this is the final text response
        finalOutput = responseText;
        break;
      }

      // Execute the action
      const actionResult = await executeAction(chatId, action);
      completedActions.push({ name: action.name, success: actionResult.success });

      // Track self-learning
      if (action.name !== 'think') {
        if (actionResult.success) recordAgentSuccess(action.name, action.body, actionResult.output, model, 0);
        else recordAgentFailure(action.name, action.body, actionResult.output, model);
      }

      // Feed result back into conversation
      messages.push({ role: 'assistant', content: responseText });
      messages.push({ role: 'user', content: `[RESULT: ${action.name}]\n${actionResult.output}\n[/RESULT]` });

      // On last step, capture what we have
      if (step === maxSteps - 1) {
        finalOutput = `Выполнено ${maxSteps} шагов. Действия: ${completedActions.map(a => `${a.success ? '✅' : '❌'}${a.name}`).join(', ')}. Последний результат: ${actionResult.output.slice(0, 500)}`;
      }
    } catch (e) {
      finalOutput = `Ошибка на шаге ${step + 1}: ${e.message}`;
      break;
    }
  }

  // Auto-save final output to KB if available
  if (opts.kbSession?.isActive && finalOutput) {
    opts.kbSession.saveFindings(role, `loop_${Date.now()}`, finalOutput).catch(() => { });
  }

  return {
    success: !finalOutput.startsWith('Ошибка'),
    output: finalOutput || 'Субагент не вернул результат',
    actions: completedActions
  };
}

async function executeAutoplan(chatId, statusUpdater) {
  const tracker = multiAgentTasks.get(chatId);
  if (!tracker || !tracker.plan) {
    return { success: false, output: 'execute_plan: нет активного плана. Сначала создай план через [ACTION: plan]' };
  }

  const plan = tracker.plan;
  const subtasks = plan.subtasks;
  const results = new Map(); // id -> result
  const progress = new ProgressAggregator(subtasks.length);

  // Определяем домен задачи для умного выбора моделей
  const taskDomain = detectDomain(plan.goal);

  // Топологическая сортировка: определяем порядок выполнения
  const pending = new Set(subtasks.map(st => st.id));
  let totalDone = 0;

  if (statusUpdater) statusUpdater(`📋 Автовыполнение: ${subtasks.length} подзадач${taskDomain ? ` (${BUSINESS_DOMAINS[taskDomain]?.label})` : ''}`);

  while (pending.size > 0) {
    // Находим задачи, чьи зависимости уже выполнены
    const ready = subtasks.filter(st => pending.has(st.id) && st.deps.every(d => results.has(d)));
    if (ready.length === 0) {
      return { success: false, output: `execute_plan: циклическая зависимость или невыполнимые задачи. Pending: ${[...pending].join(',')}` };
    }

    // Разделяем на немедленные и отложенные задачи
    const immediate = ready.filter(st => !st.schedule);
    const deferred = ready.filter(st => st.schedule);

    // Отложенные → создаём scheduledAction с agent типом
    for (const st of deferred) {
      const delayMs = parseTimeString(st.schedule);
      if (delayMs && delayMs >= 60000) {
        const depsContext = st.deps.map(d => {
          const depResult = results.get(d);
          const depTask = subtasks.find(s => s.id === d);
          return depResult ? `Результат #${d} (${depTask?.role}): ${depResult.output.slice(0, 500)}` : '';
        }).filter(Boolean).join('\n');

        const id = nextScheduleId++;
        const fireAt = Date.now() + delayMs;
        if (!config.scheduledActions) config.scheduledActions = [];
        config.scheduledActions.push({
          id, chatId, actionName: 'agent',
          actionBody: `[DEFERRED PLAN SUBTASK]\nЦель плана: ${plan.goal}\nПодзадача: ${st.task}\nРоль: ${st.role}\n${depsContext ? `Контекст зависимостей:\n${depsContext}` : ''}`,
          description: `План: ${st.task.slice(0, 60)}`,
          context: `Deferred from plan "${plan.goal}"`,
          fireAt
        });
        saveConfig();
        const timerId = setTimeout(() => fireScheduledAction(id), delayMs);
        scheduledTimers.set(id, timerId);

        // Помечаем как deferred с плейсхолдер-результатом
        st.status = 'deferred';
        results.set(st.id, { success: true, output: `⏰ Отложено на ${st.schedule} (scheduled #${id})`, actions: [] });
        pending.delete(st.id);
        totalDone++;
        if (tracker) tracker.log.push({ ts: Date.now(), text: `⏰ #${st.id} ${st.role}: отложено на ${st.schedule}` });
      } else {
        // Невалидный schedule — выполнить сразу
        immediate.push(st);
      }
    }

    if (immediate.length === 0) continue;

    // Выполняем через пул конкурентности (лимит параллельных AI-вызовов)
    const batchTasks = immediate.map(st => ({
      id: `plan-${chatId}-${st.id}`,
      meta: { role: st.role, priority: st.priority, chatId },
      fn: async () => {
        st.status = 'running';
        if (tracker) tracker.log.push({ ts: Date.now(), text: `▶️ #${st.id} ${st.role}: ${st.task.slice(0, 60)}` });
        progress.update(st.id, { pct: 10, phase: 'starting', role: st.role });

        // Собираем расширенный контекст от зависимостей
        const depsContext = st.deps.map(d => {
          const depResult = results.get(d);
          const depTask = subtasks.find(s => s.id === d);
          return depResult ? `[Результат #${d} (${depTask?.role})]:\n${depResult.output.slice(0, 2000)}` : '';
        }).filter(Boolean).join('\n\n');

        // maxSteps по роли и приоритету
        const effectiveAgentsMap = getEffectiveAgents(chatId);
        const agentDef = effectiveAgentsMap[st.role];
        const baseSteps = agentDef?.maxSteps || 5;
        const priorityMultiplier = st.priority === 'high' ? 1.5 : st.priority === 'low' ? 0.6 : 1;
        const maxSteps = Math.max(2, Math.min(10, Math.round(baseSteps * priorityMultiplier)));

        try {
          progress.update(st.id, { pct: 30, phase: 'executing', role: st.role });
          const result = await runSubAgentLoop(chatId, st.task, st.role, depsContext, maxSteps);
          progress.update(st.id, { pct: 100, phase: 'done', role: st.role });
          return { id: st.id, result };
        } catch (e) {
          progress.update(st.id, { pct: 100, phase: 'error', role: st.role });
          return { id: st.id, result: { success: false, output: `Ошибка: ${e.message}`, actions: [] } };
        }
      }
    }));

    const batchResults = await globalPool.runBatch(batchTasks);

    for (const br of batchResults) {
      const { id, result } = br.status === 'fulfilled' ? br.value : { id: ready[0]?.id, result: { success: false, output: br.reason?.message || 'Error', actions: [] } };
      results.set(id, result);
      pending.delete(id);
      const st = subtasks.find(s => s.id === id);
      if (st) {
        st.status = result.success ? 'done' : 'error';
        totalDone++;
      }
      const actionsInfo = result.actions?.length ? ` (${result.actions.length} действий)` : '';
      if (tracker) tracker.log.push({ ts: Date.now(), text: `${result.success ? '✅' : '❌'} #${id}${actionsInfo}: завершено` });
    }

    if (statusUpdater) {
      statusUpdater(progress.buildStatusLine());
    }
  }

  // Авто-генерация скиллов из успешных подзадач
  for (const st of subtasks) {
    const r = results.get(st.id);
    if (r?.success && shouldGenerateSkill(st.task, r.output, r.actions)) {
      const skillDef = generateSkillDefinition(st.task, st.role, r.actions, r.output);
      const uc = getUserConfig(chatId);
      if (!uc.skills) uc.skills = [];
      if (uc.skills.length < 30) {
        uc.skills.push({ name: skillDef.name, prompt: skillDef.prompt, category: skillDef.category, desc: skillDef.desc });
        console.log(`[AutoSkill] Plan-generated: ${skillDef.name} for ${st.role}`);
      }
    }
  }

  // Quality Gate: автоматическая проверка качества при ≥2 успешных подзадачах
  let qaVerdict = '';
  const successResults = [...results.entries()].filter(([, r]) => r.success);
  if (successResults.length >= 2) {
    try {
      const summary = successResults.map(([id, r]) => {
        const st = subtasks.find(s => s.id === id);
        return `#${id} (${st?.role}): ${(r.output || '').slice(0, 300)}`;
      }).join('\n---\n');
      const qaPrompt = `Ты QA-инспектор. Оцени результаты выполнения плана "${plan.goal}".

Результаты подзадач:
${summary.slice(0, 3000)}

Проверь:
1. Все ли подзадачи согласованы между собой?
2. Есть ли противоречия в результатах?
3. Покрывают ли результаты цель плана?

Ответь кратко (до 300 символов): QA PASS + резюме или QA FLAG + что не так.`;
      const qaResult = await callAI('gemini-2.5-flash', [{ role: 'user', content: qaPrompt }], 'Strict QA inspector', false, chatId);
      qaVerdict = qaResult.includes('QA FLAG') ? `\n\n⚠️ QA FLAG: ${qaResult.slice(0, 400)}` : `\n\n✅ QA PASS: ${qaResult.slice(0, 200)}`;
    } catch (e) {
      qaVerdict = `\n\n⚠️ QA: не удалось проверить (${e.message})`;
    }
  }

  // Формируем итоговый отчёт
  const report = subtasks.map(st => {
    const r = results.get(st.id);
    const icon = st.status === 'deferred' ? '⏰' : r?.success ? '✅' : '❌';
    const actionsInfo = r?.actions?.length ? ` [${r.actions.map(a => `${a.success ? '✓' : '✗'}${a.name}`).join(', ')}]` : '';
    return `${icon} #${st.id} ${st.role}: ${st.task.slice(0, 60)}${actionsInfo}\n   ${(r?.output || 'нет результата').slice(0, 300)}`;
  }).join('\n\n');

  const successCount = [...results.values()].filter(r => r.success).length;
  const deferredCount = subtasks.filter(st => st.status === 'deferred').length;
  const domainLabel = taskDomain ? ` | ${BUSINESS_DOMAINS[taskDomain]?.label}` : '';
  const deferredLabel = deferredCount > 0 ? ` | ⏰ отложено: ${deferredCount}` : '';

  return {
    success: successCount > 0,
    output: `[AUTOPLAN: ${successCount}/${subtasks.length} успешно${deferredLabel}${domainLabel}]\n🎯 ${plan.goal}\n\n${report}${qaVerdict}\n[/AUTOPLAN]`,
  };
}

async function executeAction(chatId, action, statusUpdater) {
  // Plugin SDK middleware: beforeAction
  if (global.pluginManager) {
    action = await global.pluginManager.runBeforeAction(action, chatId);
    if (!action) return { success: false, output: 'Действие заблокировано плагином', silent: true };
  }

  const result = await _executeActionInner(chatId, action, statusUpdater);

  // Plugin SDK middleware: afterAction
  if (global.pluginManager) {
    return await global.pluginManager.runAfterAction(action, result, chatId);
  }
  return result;
}

async function _executeActionInner(chatId, action, statusUpdater) {
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
    case 'todo_manage': return executeTodoManageAction(chatId, action.body);
    case 'quality_check': return await executeQualityCheckAction(chatId, action.body);
    case 'search': return await executeSearchAction(action.body, chatId);
    case 'file': return await executeFileAction(chatId, action.body);
    case 'read_file': return await executeReadFileAction(chatId, action.body);
    case 'write_file': return await executeWriteFileAction(chatId, action.body);
    case 'edit_file': return await executeEditFileAction(chatId, action.body);
    case 'web_fetch': return await executeWebFetchAction(action.body, chatId);
    case 'http_request': return await executeHttpRequestAction(chatId, action.body);
    case 'skill': return await executeSkillAction(chatId, action.body);
    case 'plan': return await executePlanAction(chatId, action.body, statusUpdater);
    case 'execute_plan': return await executeAutoplan(chatId, statusUpdater);
    case 'create_agent': return await executeCreateAgentAction(chatId, action.body);
    case 'supervise': return await executeSuperviseAction(chatId);
    case 'think': return { success: true, output: '(размышление завершено)', silent: true };
    case 'image': return await executeImageAction(chatId, action.body);
    case 'image_edit': return await executeImageEditAction(chatId, action.body);
    case 'video': return await executeVideoAction(chatId, action.body, statusUpdater);
    case 'video_extend': return await executeVideoExtendAction(chatId, action.body, statusUpdater);
    case 'scenario': return await executeScenarioAction(chatId, action.body, statusUpdater);
    case 'mcp': return await executeMcpAction(chatId, action.body);
    case 'figma': return await executeFigmaAction(chatId, action.body);
    case 'figma_design': return await executeFigmaDesignAction(chatId, action.body, statusUpdater);
    case 'background': return await executeBackgroundAction(chatId, action.body);
    case 'memory': return executeMemoryAction(chatId, action.body);
    case 'delegate': return await executeDelegateAction(chatId, action.body, statusUpdater);
    case 'autonomous': return await executeAutonomousAction(chatId, action.body, statusUpdater);
    case 'browse': return await executeBrowseAction(chatId, action.body);
    default: {
      // === Plugin SDK: попытка выполнить action через плагин ===
      if (global.pluginManager?.hasAction(action.name)) {
        return await global.pluginManager.executeAction(action.name, chatId, action.body, statusUpdater);
      }
      return { success: false, output: `Неизвестное действие: ${action.name}` };
    }
  }
}

// === Visual Helpers ===
function gradientBar(pct, len = 15) {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * len);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, len - filled));
}

function miniBar(pct, len = 6) {
  const chars = ['░', '▒', '▓', '█'];
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * len;
  let bar = '';
  for (let i = 0; i < len; i++) {
    if (i < Math.floor(filled)) bar += chars[3];
    else if (i < filled) bar += chars[Math.min(2, Math.floor((filled - i) * 3))];
    else bar += chars[0];
  }
  return bar;
}

function fancySpin(elapsed) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  return frames[Math.floor(elapsed) % frames.length];
}

function buildLaunchMessage({ providerLabel, model, autoReason, complexity, maxSteps, agentEnabled, queueInfo }) {
  const complexLabels = { none: 'Прямой ответ', simple: 'Простой', medium: 'Средний', complex: 'Сложный', very_complex: 'Очень сложный' };
  const label = complexLabels[complexity] || complexLabels.medium;
  const autoTag = autoReason ? ` (${autoReason})` : '';
  const tools = agentEnabled ? 'агент' : 'ответ';
  const lines = [
    `${providerLabel} · ${model}${autoTag}`,
    `${label} · ${maxSteps} шагов · ${tools}`,
    `${gradientBar(0, 20)} 0%`,
    `⠋ Инициализация...`
  ];
  if (queueInfo) lines.push(queueInfo);
  return lines.join('\n');
}

function buildCompletionDashboard({ startTime, model, provider, completedActions = [], step, maxSteps, error, totalCost }) {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const fmtTime = (s) => s >= 60 ? `${Math.floor(s / 60)}м${s % 60 > 0 ? s % 60 + 'с' : ''}` : `${s}с`;
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  const isErr = !!error;
  const lines = [isErr ? '❌ Ошибка' : '✅ Готово'];
  lines.push(`${providerLabel} · ${model} · ${fmtTime(elapsed)}`);
  lines.push(`${gradientBar(100, 20)} 100%`);
  if (completedActions.length > 0) {
    const successCount = completedActions.filter(a => a.success).length;
    const successPct = Math.round((successCount / completedActions.length) * 100);
    lines.push(`\n${completedActions.length} действий · ${step || 0} шагов · ${successPct}% успешно`);
  }
  if (totalCost > 0) lines.push(`💰 $${totalCost.toFixed(4)}`);
  if (isErr) lines.push(`\n⚠️ ${error.slice(0, 150)}`);
  return lines.join('\n');
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
  const isPrison = subAgents && subAgents.length > 0;
  const ACTION_ICONS = { bash: '⚡', remind: '⏰', file: '📄', skill: '🎯', think: '🧠', search: '🔍', image: '🎨', image_edit: '✏️', video: '🎬', schedule: '📅', figma: '🎨', figma_design: '🖼️', plan: '📋', create_agent: '🤖', supervise: '📊', mcp: '🔗', background: '🔄', memory: '🧠', execute_plan: '📋', Bash: '⚡', Read: '📖', Edit: '✏️', Write: '📝', Glob: '🔍', Grep: '🔎', Task: '🤝', WebFetch: '🌐', WebSearch: '🔍', NotebookEdit: '📓' };

  const spin = fancySpin(elapsed);
  const fmtTime = (s) => s >= 60 ? `${Math.floor(s / 60)}м${s % 60 > 0 ? s % 60 + 'с' : ''}` : `${s}с`;

  // Progress
  const filled = Math.min(step, maxSteps);
  const pct = maxSteps > 0 ? Math.round((filled / maxSteps) * 100) : 0;
  const avgStepTime = step > 0 ? elapsed / step : 0;
  const remSteps = Math.max(0, maxSteps - step);
  const eta = step > 0 && remSteps > 0 ? `~${fmtTime(Math.round(avgStepTime * remSteps))}` : '';

  if (isPrison) {
    // --- Мульти-агентный режим ---
    const activeCount = subAgents.filter(a => a.status === 'running').length;
    const doneCount = subAgents.filter(a => a.status === 'done').length;
    const errCount = subAgents.filter(a => a.status === 'error').length;
    const totalCount = subAgents.length;

    lines.push(`${providerLabel} · ${model}`);
    lines.push(`${spin} ${fmtTime(elapsed)} · Шаг ${step}/${maxSteps}${eta ? ' · ' + eta : ''}`);
    lines.push(`${gradientBar(pct, 20)} ${pct}%`);

    // Сводка агентов
    const parts = [];
    if (activeCount > 0) parts.push(`${activeCount} работают`);
    if (doneCount > 0) parts.push(`${doneCount} готово`);
    if (errCount > 0) parts.push(`${errCount} ошибок`);
    parts.push(`${totalCount} всего`);
    lines.push(`\nАгенты: ${parts.join(' · ')}`);

    if (phase) lines.push(`${spin} ${phase}`);
    if (thought) lines.push(`\n💭 ${thought.slice(0, 150)}${thought.length > 150 ? '…' : ''}`);

    if (actionName) {
      const aIcon = ACTION_ICONS[actionName] || '🔄';
      lines.push(`\n${aIcon} ${actionName}${actionDetail ? ' → ' + actionDetail.slice(0, 100) : ''}`);
    }

    // Список агентов
    lines.push('');
    for (const sa of subAgents) {
      const effectiveRoles = chatId ? getEffectiveAgents(chatId) : AGENT_ROLES;
      const roleInfo = effectiveRoles[sa.role] || AGENT_ROLES[sa.role] || { icon: '🔄', label: sa.role };
      const modelShort = sa.model ? sa.model.replace(/^(claude-|gemini-|gpt-|llama-)/, '').slice(0, 15) : '';

      if (sa.status === 'running') {
        const runSec = Math.round((Date.now() - sa.startTime) / 1000);
        lines.push(`${fancySpin(runSec)} ${roleInfo.icon} ${roleInfo.label}${modelShort ? ' · ' + modelShort : ''} → ${sa.task ? sa.task.slice(0, 35) : ''} (${fmtTime(runSec)})`);
      } else if (sa.status === 'done') {
        const dur = sa.endTime ? fmtTime(Math.round((sa.endTime - sa.startTime) / 1000)) : '';
        lines.push(`✅ ${roleInfo.icon} ${roleInfo.label}${modelShort ? ' · ' + modelShort : ''} ${dur}`);
      } else if (sa.status === 'error') {
        lines.push(`❌ ${roleInfo.icon} ${roleInfo.label}${modelShort ? ' · ' + modelShort : ''}`);
      }
    }

    // План
    if (opts.plan) {
      const cpl = opts.plan.subtasks.filter(st => st.status === 'done').length;
      const ttl = opts.plan.subtasks.length;
      const mPct = ttl > 0 ? Math.round((cpl / ttl) * 100) : 0;
      lines.push(`\n🎯 ${opts.plan.goal.slice(0, 50)}`);
      lines.push(`${gradientBar(mPct, 15)} ${cpl}/${ttl} (${mPct}%)`);
    }

    // Лог действий (последние 3)
    if (completedActions.length > 0) {
      lines.push('');
      for (const ca of completedActions.slice(-3)) {
        const dt = fmtTime(Math.round((ca.time - startTime) / 1000));
        const ico = ca.success ? '✅' : '❌';
        const aIco = ACTION_ICONS[ca.name] || '';
        lines.push(`${ico}${aIco} ${ca.name}${ca.detail ? ' → ' + ca.detail.slice(0, 35) : ''} (${dt})`);
      }
    }

    if (opts.totalCost > 0) lines.push(`\n💰 $${opts.totalCost.toFixed(4)}`);

  } else {
    // --- Стандартный режим ---
    lines.push(`${providerLabel} · ${model}`);
    lines.push(`${spin} ${fmtTime(elapsed)} · Шаг ${step}/${maxSteps}${eta ? ' · ' + eta : ''}`);
    lines.push(`${gradientBar(pct, 20)} ${pct}%`);

    if (phase) lines.push(`\n${spin} ${phase}`);
    if (thought) lines.push(`\n💭 ${thought.slice(0, 200)}${thought.length > 200 ? '…' : ''}`);

    if (actionName) {
      const aIcon = ACTION_ICONS[actionName] || '🔄';
      lines.push(`\n${aIcon} ${actionName}${actionDetail ? ' → ' + actionDetail.slice(0, 100) : ''}`);
    }

    // Лог действий (последние 4)
    if (completedActions.length > 0) {
      lines.push('');
      for (const ca of completedActions.slice(-4)) {
        const dt = fmtTime(Math.round((ca.time - startTime) / 1000));
        const ico = ca.success ? '✅' : '❌';
        const aIco = ACTION_ICONS[ca.name] || '';
        lines.push(`${ico}${aIco} ${ca.name}${ca.detail ? ' → ' + ca.detail.slice(0, 38) : ''} (${dt})`);
      }
    }

    // План
    if (opts.plan) {
      const cpl = opts.plan.subtasks.filter(st => st.status === 'done').length;
      const ttl = opts.plan.subtasks.length;
      const mPct = ttl > 0 ? Math.round((cpl / ttl) * 100) : 0;
      lines.push(`\n🎯 ${opts.plan.goal.slice(0, 50)}`);
      const subtaskLine = opts.plan.subtasks.map(st => st.status === 'done' ? '●' : st.status === 'in_progress' ? '◐' : '○').join('');
      lines.push(`${subtaskLine} ${cpl}/${ttl} (${mPct}%)`);
      const current = opts.plan.subtasks.find(st => st.status === 'in_progress');
      if (current) lines.push(`${spin} ${current.task.slice(0, 50)}`);
    }

    if (opts.totalCost > 0) lines.push(`\n💰 $${opts.totalCost.toFixed(4)}`);
  }

  if (opts.fallbackInfo) lines.push(`\n${opts.fallbackInfo}`);
  if (error) lines.push(`\n❌ ${error}`);
  return lines.join('\n');
}


// === Фоновое выполнение задач ===
// ############################################################
// # 7. МУЛЬТИ-АГЕНТНАЯ СИСТЕМА (SUMB-AGENTS / SWARM)
// ############################################################
async function runBackground(chatId, prompt, desc, extraOpts = {}) {
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
    phase: '🔄 Запуск...',
    currentStep: 0,
    maxSteps: 0,
    currentAction: null,
    lastActivityTime: Date.now(),
    completedActions: [],
    phaseTimings: [],
  };
  // Atomic: reserve slot immediately (sync) before any await
  userBg.set(taskId, taskInfo);

  send(chatId, `🔄 Задача запущена в фоне: ${taskInfo.desc}\n🆔 ${taskId}\n\nИспользуй /tasks для просмотра.`);

  // Запускаем задачу асинхронно, не блокируя foreground
  (async () => {
    const uc = getUserConfig(chatId);
    let model = uc.model;
    const startTime = Date.now();
    const bgSlot = acquireClaudeSlot();
    if (!bgSlot) { taskInfo.status = 'error'; taskInfo.result = 'Нет свободных слотов AI'; return; }
    taskInfo._claudeSlot = bgSlot;

    try {
      const agentEnabled = uc.agentMode !== false;
      const basePrompt = agentEnabled ? AGENT_SYSTEM_PROMPT : BOT_SYSTEM_PROMPT;

      let skillsPrompt = '';
      const skills = uc.skills || [];
      if (skills.length > 0) {
        skillsPrompt = '\n\n## Доступные навыки\n';
        skills.forEach((s, i) => {
          skillsPrompt += `${i + 1}. **${s.name}**: ${s.prompt.slice(0, 100)}\n`;
        });
      }

      const modePrompt = uc.activeMode && SPECIALIZED_MODES[uc.activeMode] ? `\n\n## АКТИВНЫЙ РЕЖИМ: ${SPECIALIZED_MODES[uc.activeMode].icon} ${SPECIALIZED_MODES[uc.activeMode].label}\n${SPECIALIZED_MODES[uc.activeMode].prompt}` : '';
      const framesCtxBg = buildFramesContextPrompt(chatId);
      // Zep контекст для фоновых задач
      await zepMemory.prefetchContext(chatId, prompt).catch(() => { });
      const bgZepCtx = zepMemory.getContext(chatId);
      const bgZepPrompt = bgZepCtx
        ? `\n\n## Долгосрочная память о пользователе:\n${bgZepCtx}\n\nИспользуй эти данные для персонализации. Не упоминай Zep.`
        : '';
      const bgMcpPrompt = getMcpToolsForPrompt(chatId);
      const fullSystemPrompt = [basePrompt, bgZepPrompt, uc.language, uc.systemPrompt, modePrompt, skillsPrompt, bgMcpPrompt, framesCtxBg].filter(Boolean).join('\n\n');
      const maxSteps = Math.min(uc.agentMaxSteps || 15, 10);
      taskInfo.maxSteps = maxSteps;

      // === Параллельная фоновая делегация (если указаны роли) ===
      if (extraOpts.roles && extraOpts.roles.length > 1) {
        taskInfo.phase = `🚀 Параллельная делегация: ${extraOpts.roles.length} агентов`;
        taskInfo.maxSteps = extraOpts.roles.length;

        try {
          const result = await autoDelegate(chatId, prompt, {
            runSubAgentLoop,
            getEffectiveAgents,
            callAI: callAIWithFallback,
            statusUpdater: (detail) => { taskInfo.phase = detail; taskInfo.lastActivityTime = Date.now(); },
            pool: globalPool,
          });

          taskInfo.result = result.output;
          taskInfo.completedActions = (result.subtasks || []).map(st => ({
            name: `delegate:${st.role}`,
            time: Date.now(),
            success: st.result?.success || false,
            duration: 0,
          }));

          // Авто-генерация скиллов
          if (result.success && result.subtasks) {
            for (const st of result.subtasks) {
              if (st.result?.success && shouldGenerateSkill(st.task, st.result.output, st.result.actions)) {
                const skillDef = generateSkillDefinition(st.task, st.role, st.result.actions, st.result.output);
                if (!uc.skills) uc.skills = [];
                if (uc.skills.length < 30) {
                  uc.skills.push({ name: skillDef.name, prompt: skillDef.prompt, category: skillDef.category, desc: skillDef.desc });
                  saveUserConfig(chatId);
                }
              }
            }
          }

          taskInfo.status = 'done';
          releaseClaudeSlot(bgSlot);
          taskInfo.endTime = Date.now();
          const parallelElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const domainLabel = extraOpts.domain ? BUSINESS_DOMAINS[extraOpts.domain]?.label : '';
          const actsCount = taskInfo.completedActions.length;
          const successPct = actsCount > 0 ? Math.round((taskInfo.completedActions.filter(a => a.success).length / actsCount) * 100) : 100;
          let bgDash = `✅ Параллельная фоновая задача завершена\n━━━━━━━━━━━━━━━━━━\n`;
          bgDash += `📋 ${taskInfo.desc}\n`;
          bgDash += `⏱ ${parallelElapsed}с │ ${actsCount} агентов │ ${successPct}% успешно\n`;
          if (domainLabel) bgDash += `🏷 ${domainLabel}\n`;
          bgDash += `━━━━━━━━━━━━━━━━━━\n\n${cleanMarkdown(result.output.slice(0, 3500))}`;
          send(chatId, bgDash);
          setTimeout(() => { userBg.delete(taskId); }, 5 * 60 * 1000);
          return;
        } catch (e) {
          taskInfo.status = 'error';
          taskInfo.result = `Ошибка параллельной делегации: ${e.message}`;
          releaseClaudeSlot(bgSlot);
          taskInfo.endTime = Date.now();
          send(chatId, `❌ Фоновая задача (параллельная): ${e.message}`);
          setTimeout(() => { userBg.delete(taskId); }, 5 * 60 * 1000);
          return;
        }
      }

      const messages = [{ role: 'user', content: prompt }];

      for (let step = 0; step < maxSteps; step++) {
        if (abort.signal.aborted) break;
        taskInfo.currentStep = step + 1;
        taskInfo.phase = `🧠 Шаг ${step + 1}/${maxSteps}: генерация ответа...`;
        taskInfo.lastActivityTime = Date.now();

        const result = await callAIWithFallback(model, normalizeMessages(messages), fullSystemPrompt, chatId, { allowMcp: true });
        if (result.fallbackUsed) model = result.actualModel;
        stats.claudeCalls++;

        const responseText = (result?.text || '').trim();
        if (!agentEnabled) {
          taskInfo.result = responseText;
          break;
        }

        const action = parseAction(responseText);
        if (!action) {
          taskInfo.result = responseText;
          break;
        }

        taskInfo.currentAction = action.name;
        taskInfo.phase = `⚡ Шаг ${step + 1}/${maxSteps}: ${action.name}...`;
        taskInfo.lastActivityTime = Date.now();
        const bgActionStartMs = Date.now();
        const actionResult = await executeAction(chatId, action);
        const bgActionDuration = Date.now() - bgActionStartMs;
        taskInfo.completedActions.push({ name: action.name, time: Date.now(), success: actionResult.success, duration: bgActionDuration });
        taskInfo.currentAction = null;

        // === SELF-LEARNING: Трекинг и в фоновых задачах ===
        if (action.name !== 'think') {
          if (actionResult.success) {
            recordAgentSuccess(action.name, action.body, actionResult.output, model, bgActionDuration);
          } else {
            recordAgentFailure(action.name, action.body, actionResult.output, model);
            // experience synced via Zep Cloud
          }
        }

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
      releaseClaudeSlot(bgSlot);
      taskInfo.endTime = Date.now();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (taskInfo.status === 'done') {
        const displayText = cleanMarkdown(taskInfo.result || 'Готово (без вывода)');
        const acts = taskInfo.completedActions || [];
        const successCount = acts.filter(a => a.success).length;
        const failCount = acts.length - successCount;
        const successPct = acts.length > 0 ? Math.round((successCount / acts.length) * 100) : 100;
        const fmtT = (s) => s >= 60 ? `${Math.floor(s / 60)}м${s % 60 > 0 ? s % 60 + 'с' : ''}` : `${s}с`;
        let bgDash = `✅ 𝗙𝗢𝗡 𝗭𝗔𝗩𝗘𝗥𝗦𝗛𝗘𝗡\n━━━━━━━━━━━━━━━━━━\n`;
        bgDash += `📋 ${taskInfo.desc}\n`;
        bgDash += `⏱ ${fmtT(Math.round(parseFloat(elapsed)))} │ ⚡${acts.length} действий\n`;
        if (acts.length > 0) bgDash += `${miniBar(successPct)} ${successPct}% │ ✅${successCount} ❌${failCount}\n`;
        bgDash += `━━━━━━━━━━━━━━━━━━\n\n${displayText}`;
        send(chatId, bgDash);
      } else if (taskInfo.status === 'error') {
        let bgErr = `❌ 𝗙𝗢𝗡 𝗢𝗦𝗛𝗜𝗕𝗞𝗔\n━━━━━━━━━━━━━━━━━━\n`;
        bgErr += `📋 ${taskInfo.desc}\n⏱ ${elapsed}с\n`;
        bgErr += `━━━━━━━━━━━━━━━━━━\n\n${taskInfo.result}`;
        send(chatId, bgErr);
      }
      // Удаляем через 5 минут
      setTimeout(() => { userBg.delete(taskId); }, 5 * 60 * 1000);
    }
  })();

  return taskId;
}

// === Агент-ревьюер: проверяет качество финального ответа перед отправкой ===

// Быстрая проверка: нужен ли ревью вообще
function shouldSkipReview(userQuery, aiResponse) {
  if (!aiResponse || aiResponse.length < 200) return true;
  if (aiResponse === 'Готово (без вывода)') return true;
  // Приветствия и простые вопросы — не ревьюим
  const q = userQuery.toLowerCase().trim();
  if (q.length < 30 && /^(привет|здравствуй|хай|hello|hi|хей|ку|прив|добр|как дела|что умеешь|спасибо|thanks|ok|ок|да|нет|понял)/i.test(q)) return true;
  // Результаты действий агента (код, файлы, списки) — не ревьюим
  if (aiResponse.startsWith('[RESULT:') || aiResponse.startsWith('\```') || aiResponse.startsWith('- ') || aiResponse.startsWith('1.')) return true;
  // Короткие ответы и вопросы пользователя — не ревьюим
  if (q.length < 15) return true;
  // Ответы с action результатами внутри — уже прошли агентный цикл
  if (aiResponse.includes('[RESULT:') || aiResponse.includes('✅') || aiResponse.includes('📁')) return true;
  return false;
}

async function validateResponseWithAgent(userQuery, aiResponse, chatId) {
  if (shouldSkipReview(userQuery, aiResponse)) return { valid: true, reason: 'skip', score: 10 };

  const validatorModel = 'gemini-2.5-flash';
  const systemPrompt = `Ты — ревьюер ответов AI-ассистента в Telegram-боте. Оцени ответ по шкале 1-10.

ПРАВИЛА ОЦЕНКИ:
- Ответ ДОЛЖЕН отвечать на вопрос пользователя (не на другой вопрос)
- Ответ НЕ должен обрываться на середине предложения
- Если пользователь спрашивает про возможности бота/инструменты/функции — это ВАЛИДНЫЙ вопрос, AI МОЖЕТ на него отвечать
- Если пользователь просит что-то сделать и AI объясняет как — это ВАЛИДНО
- Субъективное мнение, стиль, длина ответа — НЕ причины для отказа
- Сомневаешься — ставь 7+

ШКАЛА: 1-3 = мусор/нерелевантно, 4-5 = плохо, 6-7 = нормально, 8-10 = хорошо

Ответ СТРОГО JSON, одна строка:
{"score":8,"reason":"OK"}`;

  try {
    const result = await Promise.race([
      callAI(validatorModel, [
        { role: 'user', content: `ЗАПРОС: ${userQuery.slice(0, 500)}\n\nОТВЕТ: ${aiResponse.slice(0, 2500)}` }
      ], systemPrompt, false, chatId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('validator timeout')), 8000))
    ]);

    const text = (result.text || '').trim();
    const jsonMatch = text.match(/\{[^{}]*\}/);
    if (!jsonMatch) return { valid: true, reason: 'parse fail', score: 7 };
    const parsed = JSON.parse(jsonMatch[0]);
    const score = Number(parsed.score) || 7;
    return { valid: score >= 5, reason: parsed.reason || 'OK', score };
  } catch (e) {
    return { valid: true, reason: 'validator error', score: 7 };
  }
}

async function runClaude(chatId, text) {
  // Параллельное выполнение: без chatLock, задачи запускаются одновременно
  // Typing indicator: непрерывный "печатает..." пока идёт обработка
  const typingInterval = setInterval(() => {
    tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  // Первый typing сразу
  tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try { return await _runClaudeInner(chatId, text); } finally { clearInterval(typingInterval); }
}
async function _runClaudeInner(chatId, text) {
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
        if (statusMsgId) { editText(chatId, statusMsgId, '✅ Изображение готово'); autoDeleteMsg(chatId, statusMsgId); }
        await Promise.allSettled(results.map(r => {
          if (r.type === 'image') return sendPhoto(chatId, r.path, imgPrompt.slice(0, 200)).finally(() => { try { fs.unlinkSync(r.path); } catch (e) { } });
          if (r.type === 'text' && r.text) return send(chatId, r.text);
          return Promise.resolve();
        }));
      } catch (e) { if (statusMsgId) { editText(chatId, statusMsgId, `❌ ${e.message}`); autoDeleteMsg(chatId, statusMsgId); } else sendTemp(chatId, `❌ ${e.message}`); }
      return;
    }
    if (auto.isScenario && getGeminiKey(chatId)) {
      const scenarioResult = await executeScenarioAction(chatId, prompt);
      if (scenarioResult.success) await send(chatId, scenarioResult.output);
      else await send(chatId, `❌ ${scenarioResult.output}`);
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
        if (statusMsgId) { editText(chatId, statusMsgId, '✅ Видео готово'); autoDeleteMsg(chatId, statusMsgId); }
        await sendVideo(chatId, result.path, vidPrompt.slice(0, 200));
        try { fs.unlinkSync(result.path); } catch (e) { }
      } catch (e) { if (statusMsgId) { editText(chatId, statusMsgId, `❌ ${e.message}`); autoDeleteMsg(chatId, statusMsgId); } else sendTemp(chatId, `❌ ${e.message}`); }
      return;
    }
    if (isModelAvailableForUser(auto.model, chatId)) {
      model = auto.model;
      autoReason = auto.reason;
    }

  }

  const claudeSlot = acquireClaudeSlot();
  if (!claudeSlot) {
    enqueue(chatId, { text, type: 'text' });
    sendTemp(chatId, `⏳ AI занят (${activeClaudeCount}/${MAX_CLAUDE_PROCS}). В очереди: ${getQueueSize(chatId)}`);
    return;
  }
  console.log(`[runClaude] ENTER: chatId=${chatId}, count=${activeClaudeCount}`);

  // Генерируем уникальный taskId для поддержки параллельных задач
  const taskId = generateFgTaskId();
  const fgTasks = getActiveFgTasks(chatId);

  // Сразу ставим пометку о новой задаче, до любых await
  fgTasks.set(taskId, { timer: null, msgId: null, startTime: Date.now(), _startTime: Date.now(), _claudeSlot: claudeSlot, taskId });

  const cancellationToken = { isCancelled: false };
  cancellableOperations.set(chatId, cancellationToken);

  const agentEnabled = uc.agentMode !== false;
  const estimated = estimateComplexity(prompt, agentEnabled, chatId);

  // === SMART REQUEST ANALYSIS: дедуктивный анализ намерения, инструментов, моделей ===
  const originalText = queryRewrite.rewritten ? queryRewrite.original : prompt;
  const requestAnalysis = agentEnabled
    ? analyzeRequest(chatId, originalText, estimated.complexity)
    : null;

  const startTime = Date.now();
  let statusMsgId = null;
  let step = 0;
  const maxSteps = Math.min(uc.agentMaxSteps || 15, estimated.maxSteps);

  try {
    // Zep: restore history async (don't block)
    if (!chatHistory.has(chatId) && zepMemory.enabled) {
      zepMemory.loadMessages(chatId).then(recovered => {
        if (recovered.length > 0 && !chatHistory.has(chatId)) {
          chatHistory.set(chatId, recovered);
          chatHistoryAccess.set(chatId, Date.now());
          console.log(`[Zep] Restored ${recovered.length} messages for ${chatId}`);
        }
      }).catch(() => { });
    }

    addToHistory(chatId, 'user', queryRewrite.rewritten ? queryRewrite.original : prompt);

    const history = chatHistory.get(chatId) || [];
    const complexity = estimated.complexity || 'medium';
    let maxHistoryPairs = complexity === 'simple' ? 3 : complexity === 'medium' ? 6 : Math.min(history.length, 20);
    if (prompt.length < 80 && history.length >= 6) maxHistoryPairs = Math.max(maxHistoryPairs, 5);
    const historyStart = Math.max(0, history.length - 1 - maxHistoryPairs * 2);
    const messages = [];
    for (let i = historyStart; i < history.length - 1; i++) {
      messages.push({ role: history[i].role, content: history[i].text });
    }
    messages.push({ role: 'user', content: prompt });

    const queueLen = getQueueSize(chatId);
    const initialCodexRoute = resolveCodexRoute(model, chatId);
    if (initialCodexRoute.routed) {
      model = initialCodexRoute.model;
    }
    let provider = getProvider(model);
    let providerLabel = PROVIDER_LABELS[provider] || provider;
    console.log(`[runClaude] Sending status: ${providerLabel} ${model}`);
    const launchText = buildLaunchMessage({ providerLabel, model, autoReason, complexity: estimated.complexity, maxSteps: estimated.maxSteps, agentEnabled, queueInfo: queueLen > 0 ? `📬 ${queueLen} в очереди` : '' });

    // Non-blocking: send status and continue immediately
    send(chatId, launchText).then(res => {
      statusMsgId = res?.result?.message_id;
      const fgTasks = getActiveFgTasks(chatId);
      if (fgTasks.has(taskId)) fgTasks.get(taskId).msgId = statusMsgId;
    }).catch(() => { });

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

    let effectiveBasePrompt = basePrompt;

    // Инъекция MCP-инструментов в промпт
    const mcpToolsPrompt = getMcpToolsForPrompt(chatId);
    if (mcpToolsPrompt) {
      effectiveBasePrompt += mcpToolsPrompt;
    }

    // Инъекция Plugin SDK actions в промпт (синхронно)
    if (global.pluginManager) {
      const pluginPrompt = global.pluginManager.getPluginActionsPrompt();
      if (pluginPrompt) effectiveBasePrompt += pluginPrompt;
    }

    // Параллельно: plugin middleware + Zep prefetch (оба async, не зависят друг от друга)
    const [pluginBasePrompt] = await Promise.all([
      global.pluginManager
        ? global.pluginManager.runBeforePrompt(effectiveBasePrompt, chatId)
        : Promise.resolve(effectiveBasePrompt),
      zepMemory.enabled
        ? zepMemory.prefetchContext(chatId, prompt).catch(() => { })
        : Promise.resolve(),
    ]);
    effectiveBasePrompt = pluginBasePrompt;

    // Синхронные операции (быстрые, запускаем после async чтобы не блокировать)
    const modePrompt = uc.activeMode && SPECIALIZED_MODES[uc.activeMode] ? `\n\n## АКТИВНЫЙ РЕЖИМ: ${SPECIALIZED_MODES[uc.activeMode].icon} ${SPECIALIZED_MODES[uc.activeMode].label}\n${SPECIALIZED_MODES[uc.activeMode].prompt}` : '';

    // === ZEP CLOUD: Долгосрочная семантическая память (prefetch уже завершён выше) ===
    const zepCtx = zepMemory.getContext(chatId);
    if (zepCtx) console.log(`[Memory:${chatId}] Context: ${zepCtx.length} chars`);
    const zepContextPrompt = zepCtx
      ? `\n\n## ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ (обязательно используй):\n${zepCtx}\n\nВАЖНО: Всегда учитывай эту информацию при ответах. Если пользователь спрашивает о себе — отвечай на основе этих данных. Не упоминай источник данных.`
      : '';

    // === TASK ANALYSIS: инъекция дедуктивного анализа для medium+ сложности ===
    let taskAnalysisPrompt = '';
    if (requestAnalysis && estimated.complexity !== 'simple') {
      const toolsList = requestAnalysis.requiredTools.length > 0
        ? requestAnalysis.requiredTools.map(t => `[ACTION: ${t}]`).join(', ')
        : 'на твоё усмотрение';
      const rolesList = requestAnalysis.suggestedRoles.length > 0
        ? requestAnalysis.suggestedRoles.join(', ')
        : '';
      const planningNote = requestAnalysis.needsPlanning
        ? '\n⚠️ ОБЯЗАТЕЛЬНО: начни с [ACTION: think] → [ACTION: plan] перед выполнением!'
        : '';
      const notebookNote = requestAnalysis.requiredTools.includes('notebook')
        ? '\n📓 ОБЯЗАТЕЛЬНО: используй NotebookLM для исследования → [ACTION: mcp] server=notebooklm\n  Последовательность: notebook_create → notebook_add_url/text → notebook_query → mind_map_create/report_create/audio_overview_create'
        : '';
      const domainNote = requestAnalysis.detectedDomain
        ? `\n- Бизнес-домен: **${BUSINESS_DOMAINS[requestAnalysis.detectedDomain]?.label || requestAnalysis.detectedDomain}**`
        : '';
      const parallelNote = requestAnalysis.suggestedRoles?.length >= 2
        ? `\n- 💡 Рекомендуется **параллельная делегация**: используй [ACTION: delegate] с role: ${requestAnalysis.suggestedRoles.join(', ')} для одновременной работы нескольких агентов`
        : '';
      taskAnalysisPrompt = `\n\n## 🎯 Анализ текущей задачи\n- Намерение пользователя: **${requestAnalysis.intent}**\n- Рекомендуемые инструменты: ${toolsList}${rolesList ? `\n- Рекомендуемые роли субагентов: ${rolesList}` : ''}${domainNote}\n- Сложность: ${estimated.complexity} (до ${estimated.maxSteps} шагов)\n- Модели: ${requestAnalysis.modelStack.join(' → ')} (авто-fallback)${planningNote}${notebookNote}${parallelNote}`;
      console.log(`[analyzeRequest:${chatId}] intent=${requestAnalysis.intent} tools=[${requestAnalysis.requiredTools}] roles=[${requestAnalysis.suggestedRoles}] domain=${requestAnalysis.detectedDomain || 'none'} stack=[${requestAnalysis.modelStack}] plan=${requestAnalysis.needsPlanning}`);
    }

    const framesCtxFg = buildFramesContextPrompt(chatId);
    const fullSystemPrompt = [effectiveBasePrompt, zepContextPrompt, uc.language, uc.systemPrompt, modePrompt, skillsPrompt, taskAnalysisPrompt, framesCtxFg].filter(Boolean).join('\n\n');

    // Dynamic effort: simple → low (fast), medium → default, complex → high
    const effortLevel = uc.thinking ? 'high' : (estimated.complexity === 'simple' ? 'low' : (estimated.complexity === 'very_complex' ? 'high' : undefined));

    // Session continuation for Anthropic multi-step agents
    const agentSessionId = agentEnabled && getProvider(model) === 'anthropic' ? crypto.randomUUID() : null;

    // Локальный трекер для логирования шагов
    const tracker = { orchestratorMsgId: statusMsgId, agents: [], log: [], startTime };

    // Состояние для live display
    const statusState = { model, provider, step: 0, maxSteps, startTime, thought: null, actionName: null, actionDetail: null, subAgents: tracker.agents, plan: tracker?.plan, phase: '🔄 Запуск...', error: null, fallbackInfo: null, chatId, completedActions: [], complexity: estimated.complexity, totalCost: 0, totalMs: 0 };

    // Прикрепляем statusState к activeTasks для доступа из serializeAgentState
    const fgTasks = getActiveFgTasks(chatId);
    if (fgTasks.has(taskId)) fgTasks.get(taskId).statusState = statusState;

    // Lazy MCP: пропускаем загрузку MCP-серверов для простых запросов (экономия ~3-5 сек init)
    const needsMcp = agentEnabled && estimated.complexity !== 'simple';

    // Fallback callback для автоматического переключения модели
    const fallbackOpts = {
      allowMcp: needsMcp,
      onFallback: (failedModel, nextModel, reason) => {
        const shortReason = reason.slice(0, 60);
        updateStatus({ phase: `🔄 ${failedModel} → ${nextModel}...`, fallbackInfo: `⚠️ ${failedModel}: ${shortReason}` });
        tracker.log.push({ ts: Date.now(), text: `⚠️ ${failedModel} → ${nextModel}: ${shortReason}` });
        console.log(`🔄 Agent fallback: ${failedModel} → ${nextModel}`);
      }
    };

    let lastStatusUpdate = 0;
    let lastStatusText = '';
    const THROTTLE_NORMAL = 300;   // 300мс — быстрые обновления статуса
    const THROTTLE_IMPORTANT = 100; // 100мс — для критичных обновлений
    const STATUS_MARKUP = { reply_markup: { inline_keyboard: [[{ text: '⛔ Стоп', callback_data: 'stop_agents' }]] } };
    const updateStatus = (overrides = {}) => {
      if (cancellationToken.isCancelled) return;
      const now = Date.now();
      const isImportant = overrides.error !== undefined ||
        (overrides.phase && /самокоррекция|субагент|ошибка|завершен|fallback|→/i.test(overrides.phase)) ||
        false;
      const throttle = isImportant ? THROTTLE_IMPORTANT : THROTTLE_NORMAL;
      if (now - lastStatusUpdate < throttle) return;
      Object.assign(statusState, overrides);
      if (!statusMsgId) { lastStatusUpdate = now; return; }
      const text = buildStatusMessage(statusState);
      if (text === lastStatusText) return;
      lastStatusText = text;
      lastStatusUpdate = now;
      editText(chatId, statusMsgId, text, STATUS_MARKUP).catch(() => { });
    };

    let finalText = '';
    let lastActionResult = null; // трекаем последний результат действия
    const actionRetries = new Map();
    const MAX_RETRIES_PER_ACTION = 3;
    const MAX_TOTAL_RETRIES = 8;
    const failureLog = []; // трекинг ошибок для детекции зацикливания
    let totalRetries = 0;

    while (step < maxSteps) {
      if (cancellationToken.isCancelled) {
        finalText = 'Операция отменена пользователем.';
        break;
      }
      if (!activeTasks.has(chatId)) {
        finalText = 'Остановлено пользователем.';
        break;
      }
      step++;

      // Контекстные фазы вместо generic "Шаг X/Y"
      const stepPhases = [
        '🧠 Анализирую запрос...',
        '🔍 Планирую действия...',
        '⚡ Выполняю...',
        '🔧 Обрабатываю результат...',
        '🔄 Уточняю детали...',
        '⚡ Продолжаю выполнение...',
        '📊 Проверяю результат...',
        '🔧 Доработка...',
        '🔍 Финальная проверка...',
        '📝 Формирую ответ...',
        '✨ Полирую результат...',
        '🎯 Финализирую...'
      ];
      let phaseIdx;
      if (step === 1) phaseIdx = 0;
      else if (step === maxSteps) phaseIdx = stepPhases.length - 1;
      else if (step <= stepPhases.length) phaseIdx = step - 1;
      else {
        const cyclePhases = stepPhases.slice(2, -2);
        phaseIdx = 2 + ((step - stepPhases.length) % cyclePhases.length);
      }
      const smartPhase = stepPhases[phaseIdx] || `🔄 Шаг ${step}/${maxSteps}`;
      updateStatus({ step, phase: smartPhase, thought: null, actionName: null, actionDetail: null });

      let result;

      // === ПАРАЛЛЕЛЬНЫЕ СУБАГЕНТЫ: на шаге 1 запускаем несколько моделей одновременно ===
      if (!result) {
        {
          let lastEditTime = 0;
          const currentProvider = () => getProvider(model);

          // Трекинг инструментов Claude CLI
          const cliToolActions = [];
          let cliCurrentTool = null;
          let cliThinking = null;

          const onChunk = (partial) => {
            if (currentProvider() === 'anthropic' && agentEnabled) return;
            const now = Date.now();
            if (now - lastEditTime < 120) return;
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
                const cost = typeof event.cost_usd === 'number' ? `$${event.cost_usd.toFixed(4)}` : '';
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

          // Session continuation: step 1 = new session, steps 2+ = resume (only action result)
          const isResumeStep = step > 1 && agentSessionId && getProvider(model) === 'anthropic';
          const stepCliOpts = isResumeStep
            ? { resumeSessionId: agentSessionId, effort: effortLevel }
            : { sessionId: agentSessionId, effort: effortLevel };
          const stepMessages = isResumeStep ? messages.slice(-1) : normalizeMessages(messages);
          const stepSystemPrompt = isResumeStep ? '' : fullSystemPrompt;

          result = await callAIStreamWithFallback(model, stepMessages, stepSystemPrompt, onChunk, chatId, { ...fallbackOpts, onEvent, cliOpts: stepCliOpts });
        }
      } // end if (!result)

      // Синхронизируем фактически использованную модель/провайдера
      const syncModel = result.actualModel || model;
      const syncProvider = result.provider || getProvider(syncModel);
      const modelChanged = syncModel !== model || syncProvider !== provider;
      if (modelChanged) {
        model = syncModel;
        provider = syncProvider;
        providerLabel = PROVIDER_LABELS[provider] || provider;
        statusState.model = model;
        statusState.provider = provider;
      }
      if (result.fallbackUsed) {
        tracker.log.push({ ts: Date.now(), text: `🔄 Переключено на ${model}` });
      } else if (result.codexRouted) {
        tracker.log.push({ ts: Date.now(), text: `🛠️ Codex routed: ${result.requestedModel} → ${model}` });
      }

      stats.claudeCalls++;
      stats.totalResponseTime += result.ms;

      // Трекинг стоимости в статусе
      if (result.usage?.cost_usd) statusState.totalCost += result.usage.cost_usd;
      statusState.totalMs += result.ms || 0;

      // Трекинг производительности модели
      const effectiveModel = result.actualModel || model;
      if (!uc.modelStats) uc.modelStats = {};
      if (!uc.modelStats[effectiveModel]) uc.modelStats[effectiveModel] = { calls: 0, errors: 0, totalMs: 0 };
      uc.modelStats[effectiveModel].calls++;
      uc.modelStats[effectiveModel].totalMs += result.ms || 0;
      if (uc.modelStats[effectiveModel].calls % 5 === 0) saveUserConfig(chatId);

      const responseText = (result?.text || '').trim();

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
      // Детальные фазы с контекстом из действия
      const actionPhases = {
        think: '🧠 Размышляю...',
        bash: `⚡ ${action.body.split('\n')[0].slice(0, 40)}`,
        file: '📄 Отправляю файл...',
        skill: `🎯 Навык: ${action.body.split('\n')[0].slice(0, 30)}`,
        background: '🔄 Запускаю фоновую задачу...',
        memory: `🧠 Память: ${action.body.includes('save') ? 'сохраняю' : action.body.includes('search') ? 'ищу' : 'обрабатываю'}...`,
        execute_plan: '📋 Автовыполнение плана...',
        search: '🔍 Ищу в интернете...',
        image: '🎨 Генерирую изображение...',
        image_edit: '✏️ Редактирую фото...',
        video: '🎬 Генерирую видео...',
        video_extend: '🎬 Продлеваю видео...',
        scenario: '🎬 Создаю сценарий...',
        schedule: '📅 Планирую задачу...',
        remind: '⏰ Устанавливаю напоминание...',
        plan: '📋 Составляю план...',
        parallel: '🚀 Параллельное выполнение...',
        create_agent: '🤖 Создаю агента...',
        supervise: '📊 Проверяю статус агентов...',
        delegate: '🤝 Делегирую субагенту...',
        mcp: '🔗 Вызов интеграции...',
        figma_design: '🖼️ Создаю дизайн в Figma...',
        install: '📦 Установка пакетов...',
        git: '🔀 Git операция...',
        create_project: '🏗️ Создаю проект...',
        deploy: '🚀 Деплой...',
        browse: '🌐 Открываю браузер...',
      };
      updateStatus({
        thought,
        actionName: action.name,
        actionDetail: action.name === 'think' ? action.body.slice(0, 150) : action.body.split('\n')[0],
        phase: actionPhases[action.name] || `🔄 ${action.name}...`
      });

      // Функция обновления статуса для субагентов
      const subStatusUpdater = (detail) => {
        updateStatus({ actionDetail: detail, phase: '🤝 Субагент работает...' });
      };

      const actionStartMs = Date.now();
      const actionResult = await executeAction(chatId, action, subStatusUpdater);
      const actionDuration = Date.now() - actionStartMs;
      if (!actionResult.silent) lastActionResult = { name: action.name, ...actionResult };

      // Автоотправка файлов из результатов действий в Telegram
      if (actionResult.success && ['bash', 'write_file'].includes(action.name)) {
        autoSendMentionedFiles(chatId, actionResult.output);
      }

      console.log(`🤖 Agent step ${step}: [${action.name}] → ${actionResult.success ? 'OK' : 'FAIL'} (${actionResult.output.slice(0, 100)})`);

      // === SELF-LEARNING: Запись опыта агента ===
      if (action.name !== 'think') {
        const effectiveModel = result?.actualModel || model;
        if (actionResult.success) {
          recordAgentSuccess(action.name, action.body, actionResult.output, effectiveModel, actionDuration);
        } else {
          recordAgentFailure(action.name, action.body, actionResult.output, effectiveModel);
        }
      }

      // Трекинг выполненных действий для таймлайна
      statusState.completedActions.push({
        name: action.name,
        detail: action.body.split('\n')[0].slice(0, 60),
        success: actionResult.success,
        time: Date.now()
      });

      // === Умная самокоррекция: per-action retry + stuck detection + model escalation + strategy switching ===
      if (!actionResult.success) {
        const actionTypeRetries = actionRetries.get(action.name) || 0;
        const canRetryAction = actionTypeRetries < MAX_RETRIES_PER_ACTION;
        const canRetryTotal = totalRetries < MAX_TOTAL_RETRIES;

        // --- Stuck-loop detection: если одна и та же ошибка повторяется ---
        const errSignature = `${action.name}:${actionResult.output.slice(0, 80).replace(/\d+/g, 'N')}`;
        failureLog.push(errSignature);
        const sameErrorCount = failureLog.filter(e => e === errSignature).length;
        const isStuck = sameErrorCount >= 2; // одна и та же ошибка дважды = зацикливание

        if (isStuck && canRetryTotal) {
          // Зацикливание обнаружено — принудительная смена стратегии
          totalRetries++;
          actionRetries.set(action.name, MAX_RETRIES_PER_ACTION); // блокируем этот тип
          updateStatus({
            phase: `🔄 Зацикливание! Смена стратегии...`,
            error: `${action.name}: одна и та же ошибка ${sameErrorCount}x`
          });
          tracker.log.push({ ts: Date.now(), text: `🔄 STUCK: ${action.name} → смена подхода` });

          const alts = ACTION_ALTERNATIVES[action.name] || ['bash', 'delegate'];
          const stuckGuidance = `⚠️ ЗАЦИКЛИВАНИЕ ОБНАРУЖЕНО: действие "${action.name}" даёт ОДНУ И ТУ ЖЕ ошибку ${sameErrorCount} раз подряд.

🚫 ЗАПРЕЩЕНО повторять "${action.name}" с похожими параметрами.
✅ ОБЯЗАТЕЛЬНО используй ДРУГОЕ действие: ${alts.map(a => `[ACTION: ${a}]`).join(', ')}.

Перестрой подход ПОЛНОСТЬЮ. Если задача — выполнить команду, используй node -e. Если задача — получить данные, делегируй. Если задача — создать файл, используй write_file или bash heredoc.`;

          messages.push({ role: 'assistant', content: responseText });
          messages.push({ role: 'user', content: `[ERROR: ${action.name}]\n${actionResult.output}\n[/ERROR]\n\n${stuckGuidance}` });
          continue;
        }

        if (canRetryAction && canRetryTotal) {
          actionRetries.set(action.name, actionTypeRetries + 1);
          totalRetries++;
          updateStatus({
            phase: `🔧 Самокоррекция [${action.name}] (${actionTypeRetries + 1}/${MAX_RETRIES_PER_ACTION})...`,
            error: actionResult.output.slice(0, 100)
          });
          tracker.log.push({ ts: Date.now(), text: `🔧 Retry ${action.name}: ${actionResult.output.slice(0, 80)}` });

          const errorGuidance = getRetryGuidance(action.name, actionResult.output, actionTypeRetries);

          // --- Model escalation: если >4 общих ошибок, эскалируем на более сильную модель ---
          if (totalRetries >= 4 && !model.includes('opus') && !model.includes('pro')) {
            const escalationModels = ['gemini-2.5-pro', 'claude-sonnet', 'gpt-4.1'];
            const escalatedModel = escalationModels.find(m => m !== model) || model;
            tracker.log.push({ ts: Date.now(), text: `🚀 Escalation: ${model} → ${escalatedModel}` });
            // Подменяем модель для следующего вызова через cliOpts
            if (typeof cliOpts === 'object') cliOpts.escalatedModel = escalatedModel;
          }

          messages.push({ role: 'assistant', content: responseText });
          messages.push({
            role: 'user',
            content: `[ERROR: ${action.name}]\n${actionResult.output}\n[/ERROR]\n\n${errorGuidance}`
          });
          continue;
        }

        // Исчерпаны попытки для этого типа — предложить конкретные альтернативы
        if (!canRetryAction && canRetryTotal) {
          totalRetries++;
          const alts = ACTION_ALTERNATIVES[action.name] || ['bash', 'delegate'];
          updateStatus({
            phase: `🔄 Смена стратегии → ${alts[0]}...`,
            error: `${action.name}: исчерпаны попытки`
          });
          tracker.log.push({ ts: Date.now(), text: `🔄 ${action.name}: смена на ${alts.join('/')}` });

          const altGuidance = `🚫 Действие "${action.name}" НЕ РАБОТАЕТ после ${MAX_RETRIES_PER_ACTION} попыток.

КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать "${action.name}" снова.
✅ ОБЯЗАТЕЛЬНО используй ДРУГОЙ тип действия: ${alts.map(a => `[ACTION: ${a}]`).join(', ')}.

Конкретные стратегии:
${action.name === 'bash' ? '• [ACTION: delegate] role=executor — делегируй выполнение\n• node -e "..." — используй Node.js вместо bash' : ''}
${action.name === 'delegate' ? '• [ACTION: bash] — выполни напрямую через команду\n• [ACTION: parallel] — попробуй несколько подходов одновременно' : ''}
${action.name === 'image' ? '• Перепиши промпт РАДИКАЛЬНО, максимум 20 слов, на English\n• [ACTION: bash] node -e — создай SVG для схем/диаграмм' : ''}
${!['bash', 'delegate', 'image'].includes(action.name) ? `• ${alts.map(a => `[ACTION: ${a}]`).join('\n• ')}` : ''}

Ты ДОЛЖЕН найти способ выполнить задачу. У тебя достаточно инструментов.`;

          messages.push({ role: 'assistant', content: responseText });
          messages.push({
            role: 'user',
            content: `[ERROR: ${action.name}]\n${actionResult.output}\n[/ERROR]\n\n${altGuidance}`
          });
          continue;
        }

        // Все retry исчерпаны — но НЕ сдаёмся, а даём финальный шанс
        if (totalRetries >= MAX_TOTAL_RETRIES && step < maxSteps - 1) {
          updateStatus({ phase: '🔥 Последняя попытка...', error: 'Все retry исчерпаны' });
          messages.push({ role: 'assistant', content: responseText });
          messages.push({
            role: 'user',
            content: `[ERROR: ${action.name}]\n${actionResult.output}\n[/ERROR]\n\n🔥 ВСЕ ПОПЫТКИ ИСЧЕРПАНЫ. Это ПОСЛЕДНИЙ шанс. Дай пользователю ХОТЬ КАКОЙ-ТО результат. Если основная задача невыполнима — предложи ближайшую альтернативу или частичный результат. НЕ говори "не удалось" без конкретного объяснения и предложения.`
          });
          totalRetries = MAX_TOTAL_RETRIES - 1; // даём ещё 1 попытку
          continue;
        }

        updateStatus({ error: actionResult.output.slice(0, 100) });
      } else {
        updateStatus({ error: null });
        // Успех — сбрасываем failure log для этого типа
        const idx = failureLog.lastIndexOf(failureLog.find(e => e.startsWith(action.name + ':')));
        if (idx >= 0) failureLog.splice(idx, 1);
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

    // === Агент-ревьюер (неблокирующий) ===
    // Ответ отправляется сразу, ревьюер проверяет в фоне и при необходимости редактирует
    const _reviewPrompt = prompt, _reviewDisplayText = displayText, _reviewFullSystemPrompt = fullSystemPrompt, _reviewModel = model;
    const reviewInBackground = (sentMsgId) => {
      if (shouldSkipReview(_reviewPrompt, _reviewDisplayText)) return;
      validateResponseWithAgent(_reviewPrompt, _reviewDisplayText, chatId).then(async (validation) => {
        if (validation.score >= 6) {
          console.log(`✅ [${chatId}] Ревьюер: ${validation.score}/10 (${validation.reason})`);
          return;
        }
        console.log(`🔁 [${chatId}] Ревьюер: ${validation.score}/10 — ${validation.reason}, коррекция...`);
        const corrModels = ['gemini-2.5-flash', 'claude-sonnet', 'gpt-4.1-mini'].filter(m => m !== _reviewModel);
        const corrModel = corrModels[0] || _reviewModel;
        try {
          const corrResult = await callAIWithFallback(corrModel, [
            { role: 'user', content: `${_reviewPrompt}\n\n[ИСПРАВЛЕНИЕ: предыдущий ответ получил низкую оценку — "${validation.reason}". Дай точный, полный, релевантный ответ.]` }
          ], _reviewFullSystemPrompt, chatId);
          if (corrResult?.text?.trim()) {
            const corrected = cleanMarkdown(corrResult.text.trim());
            if (sentMsgId) {
              editText(chatId, sentMsgId, corrected).catch(() => send(chatId, corrected));
            } else {
              send(chatId, corrected);
            }
            addToHistory(chatId, 'assistant', corrected);
            lastResponse.set(chatId, { text: corrected, prompt: _reviewPrompt });
            console.log(`✏️ [${chatId}] Ревьюер: коррекция через ${corrModel} (${corrected.length} симв.)`);
          }
        } catch (e) { console.error(`[${chatId}] Background correction failed: ${e.message}`); }
      }).catch(e => console.error(`[${chatId}] Background review failed: ${e.message}`));
    };
    // === /Агент-ревьюер ===

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (process.env.BOT_DEBUG) console.log(`📋 ${model}: ${displayText.length}б, ${elapsed}с`);

    addToHistory(chatId, 'assistant', displayText);
    lastResponse.set(chatId, { text: displayText, prompt });

    // Память через Zep — syncMessage уже вызывается в addToHistory

    // Трекинг успешности модели для категории (самообучение)
    if (autoReason && autoCategory) {
      trackCategorySuccess(chatId, autoCategory, model, Date.now() - startTime, true);
    }

    // Показываем completion dashboard вместо удаления
    if (statusMsgId) {
      const dashboard = buildCompletionDashboard({
        startTime, model, provider, step,
        maxSteps, completedActions: statusState.completedActions,
        totalCost: statusState.totalCost
      });
      editText(chatId, statusMsgId, dashboard);
      setTimeout(() => del(chatId, statusMsgId), 5000);
    }

    send(chatId, displayText).then(res => {
      const sentId = res?.result?.message_id;
      reviewInBackground(sentId);
    }).catch(() => { });

    // Автоотправка файлов, упомянутых в результатах, в Telegram
    autoSendMentionedFiles(chatId, displayText);

    if (step >= maxSteps && parseAction(finalText)) {
      send(chatId, `⚠️ Достигнут лимит шагов (${maxSteps}). Напишите "продолжай" чтобы я продолжил выполнение.`);
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
    if (statusMsgId) {
      const errDashboard = buildCompletionDashboard({
        startTime, model, provider: getProvider(model), step: step || 0,
        maxSteps, completedActions: statusState?.completedActions || [],
        error: e.message, totalCost: statusState?.totalCost || 0
      });
      editText(chatId, statusMsgId, errDashboard);
      setTimeout(() => del(chatId, statusMsgId), 5000);
    }
    send(chatId, `❌ Ошибка ${model}: ${e.message}`);
  } finally {
    releaseClaudeSlot(claudeSlot);
    // Удаляем завершённую задачу из параллельного набора
    const fgTasks = getActiveFgTasks(chatId);
    fgTasks.delete(taskId);
    if (fgTasks.size === 0) {
      activeTasks.delete(chatId);
      cancellableOperations.delete(chatId);
      sessionAgents.delete(chatId);
    } else {
      // Очищаем cancellableOperations только для этой задачи
      const allTokens = Array.from(cancellableOperations.entries());
      for (const [key, token] of allTokens) {
        if (key.startsWith(chatId + '_')) cancellableOperations.delete(key);
      }
    }
    processQueue(chatId);
  }
}

// === Polling (Long Polling + async) ===
let stopPolling = false;

async function processUpdate(upd) {
  if (upd.callback_query) {
    const cbChatId = upd.callback_query?.message?.chat?.id;
    console.log(`[processUpdate] Callback from ${cbChatId}: ${upd.callback_query.data}`);
    if (cbChatId && isRateLimited(cbChatId)) {
      tgApi('answerCallbackQuery', { callback_query_id: upd.callback_query.id }).catch(() => { });
      return;
    }
    handleCallback(upd.callback_query).catch(e => console.error(`[chatId:${cbChatId}] CB ERR:`, e.message));
    return;
  }

  const msg = upd.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text || '';

  console.log(`[processUpdate] Message from ${chatId}: "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"`);
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
    } catch (e) { send(chatId, `❌ ${e.message}`, nbMainMenu); }
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
    } catch (e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbUrl.has(chatId)) {
    const nbId = waitingNbUrl.get(chatId);
    waitingNbUrl.delete(chatId);
    send(chatId, '🔗 Добавляю URL...');
    try {
      await nbClient.call('notebook_add_url', { notebook_id: nbId, url: text.trim() });
      send(chatId, `🔗 URL добавлен: ${text.trim()}`, nbDetailMenu(nbId));
    } catch (e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbText.has(chatId)) {
    const nbId = waitingNbText.get(chatId);
    waitingNbText.delete(chatId);
    sendTemp(chatId, '📝 Добавляю текст...');
    try {
      await nbClient.call('notebook_add_text', { notebook_id: nbId, text, title: `Текст ${new Date().toLocaleDateString('ru')}` });
      send(chatId, '📝 Текст добавлен как источник', nbDetailMenu(nbId));
    } catch (e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbRename.has(chatId)) {
    const nbId = waitingNbRename.get(chatId);
    waitingNbRename.delete(chatId);
    try {
      await nbClient.call('notebook_rename', { notebook_id: nbId, new_title: text });
      send(chatId, `✏️ Переименован: ${text}`, nbDetailMenu(nbId));
    } catch (e) { send(chatId, `❌ ${e.message}`, nbDetailMenu(nbId)); }
    return;
  }
  if (waitingNbResearch.has(chatId)) {
    waitingNbResearch.delete(chatId);
    sendTemp(chatId, '🔍 Запускаю исследование...\n⏳ Быстрый режим ~30с');
    try {
      const startResult = await nbClient.call('research_start', { query: text, source: 'web', mode: 'fast' }, 60000);
      const nbId = startResult.notebook_id || startResult.data?.notebook_id;
      const taskId = startResult.task_id || startResult.data?.task_id;
      if (!nbId) { send(chatId, `🔍 Исследование запущено:\n${JSON.stringify(startResult).slice(0, 2000)}`, nbMainMenu); return; }
      // Поллинг
      sendTemp(chatId, `⏳ Поллинг результатов... (блокнот: ${nbId})`);
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
        } catch (impErr) { resultText += `\n\n⚠️ Импорт: ${impErr.message}`; }
      }
      send(chatId, resultText, nbMainMenu);
    } catch (e) { send(chatId, `❌ ${e.message}`, nbMainMenu); }
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


  // === Медиа-промпты из меню ===
  if (waitingImagePrompt.has(chatId)) {
    waitingImagePrompt.delete(chatId);
    runClaude(chatId, `Нарисуй: ${text}`);
    return;
  }
  if (waitingVideoPrompt.has(chatId)) {
    waitingVideoPrompt.delete(chatId);
    runClaude(chatId, `Сделай видео: ${text}`);
    return;
  }

  // === Плагины из меню ===
  if (waitingWeatherCity.has(chatId)) {
    waitingWeatherCity.delete(chatId);
    runClaude(chatId, `Погода в ${text}`);
    return;
  }
  if (waitingExchangeQuery.has(chatId)) {
    waitingExchangeQuery.delete(chatId);
    runClaude(chatId, `Курс ${text}`);
    return;
  }
  if (waitingCryptoQuery.has(chatId)) {
    waitingCryptoQuery.delete(chatId);
    runClaude(chatId, `Цена криптовалюты ${text}`);
    return;
  }
  if (waitingTranslateQuery.has(chatId)) {
    waitingTranslateQuery.delete(chatId);
    runClaude(chatId, `Переведи: ${text}`);
    return;
  }
  if (waitingQRText.has(chatId)) {
    waitingQRText.delete(chatId);
    runClaude(chatId, `Создай QR-код для: ${text}`);
    return;
  }

  // === Quick Actions из меню ===
  if (waitingTextPrompt.has(chatId)) {
    waitingTextPrompt.delete(chatId);
    runClaude(chatId, `Напиши качественный текст по запросу: ${text}`);
    return;
  }
  if (waitingSearchQuery.has(chatId)) {
    waitingSearchQuery.delete(chatId);
    runClaude(chatId, `Найди в интернете: ${text}`);
    return;
  }

  // === Plugin SDK: обработка плагиновых команд ===
  if (text.startsWith('/') && global.pluginManager) {
    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const cmdArgs = parts.slice(1).join(' ');
    if (cmd === 'plugins') {
      send(chatId, global.pluginManager.formatPluginList(), { parse_mode: 'Markdown' });
      return;
    }
    if (cmd === 'plugin_reload' && isAdmin(chatId)) {
      try {
        const arg = cmdArgs.trim();
        if (arg) {
          await global.pluginManager.reload(arg);
          send(chatId, `🔄 Плагин "${arg}" перезагружен`);
        } else {
          await global.pluginManager.reloadAll();
          sendTemp(chatId, `🔄 Все плагины перезагружены`);
        }
      } catch (e) { send(chatId, `❌ Ошибка перезагрузки: ${e.message}`); }
      return;
    }
    if (global.pluginManager.hasCommand(cmd)) {
      await global.pluginManager.executeCommand(cmd, chatId, cmdArgs);
      return;
    }
  }

  // === Super Agent Commands: обработка ===
  if (text.startsWith('/') && global.superAgentHandlers) {
    const cmdList = ['team', 'agents', 'skills', 'reuse', 'team-status', 'task-history'];
    const parts = text.split(/\s+/);
    const cmd = parts[0].slice(1).toLowerCase();
    if (cmdList.includes(cmd) && global.superAgentHandlers[cmd]) {
      try {
        await global.superAgentHandlers[cmd]({
          from: { id: chatId },
          message: { text, message_id: null },
          reply: async (msg, opts) => await send(chatId, msg, opts),
          deleteMessage: async () => { },
        });
      } catch (e) { console.error('SuperAgent command error', e); }
      return;
    }
  }

  // === Orchestrator / Dynamic Agent / Skill / Integration Commands ===
  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].slice(1).toLowerCase();
    const cmdBody = parts.slice(1).join(' ').trim();

    // /orchestrate <task> — smart autonomous task execution
    if (cmd === 'orchestrate' || cmd === 'orch' || cmd === 'do') {
      if (!cmdBody) { await send(chatId, 'Usage: /orchestrate <task description>'); return; }
      const statusMsg = await send(chatId, '[Orchestrator] Analyzing task...');
      const statusMsgId = statusMsg?.result?.message_id;
      try {
        const result = await orchestrator.execute(chatId, cmdBody, {
          onProgress: (u) => {
            if (statusMsgId) tgApi('editMessageText', { chat_id: chatId, message_id: statusMsgId, text: u.message?.slice(0, 4000) || '...' }).catch(() => {});
          },
        });
        const output = result.output || result.error || 'No output';
        const header = `Strategy: ${result.strategy || 'auto'} | ${result.duration ? Math.round(result.duration / 1000) + 's' : ''}`;
        await send(chatId, `${header}\n\n${String(output).slice(0, 4000)}`);
      } catch (e) { await send(chatId, `Error: ${e.message}`); }
      return;
    }

    // /create_agent <description> — create new custom agent
    if (cmd === 'create_agent' || cmd === 'newagent') {
      if (!cmdBody) { await send(chatId, 'Usage: /create_agent <agent description>'); return; }
      await send(chatId, 'Creating custom agent...');
      const { created, agent, reason } = await dynamicAgentCreator.createAgent(cmdBody, { chatId });
      if (created) {
        await send(chatId, `Agent created: ${agent.icon || ''} ${agent.label}\nID: ${agent.id}\nExpertise: ${agent.expertise || agent.desc}\nTools: ${(agent.tools || []).join(', ')}`);
      } else {
        await send(chatId, `Found existing agent: ${agent.icon || ''} ${agent.label} (${agent.id})\nScore: ${(agent.score * 100).toFixed(0)}%`);
      }
      return;
    }

    // /custom_agents — list custom agents
    if (cmd === 'custom_agents' || cmd === 'myagents') {
      const agents = dynamicAgentCreator.getCustomAgents();
      const list = Object.values(agents);
      if (list.length === 0) { await send(chatId, 'No custom agents yet. Use /create_agent to create one.'); return; }
      const text = list.map(a => `${a.icon || ''} ${a.label} [${a.id}]\n  ${a.desc}\n  Uses: ${a.usageCount || 0} | Success: ${((a.successRate || 1) * 100).toFixed(0)}%`).join('\n\n');
      await send(chatId, `Custom Agents (${list.length}):\n\n${text}`);
      return;
    }

    // /create_skill <name> | <description> — create new skill
    if (cmd === 'create_skill' || cmd === 'newskill') {
      if (!cmdBody) { await send(chatId, 'Usage: /create_skill <name> | <description>'); return; }
      const [name, ...descParts] = cmdBody.split('|').map(s => s.trim());
      const desc = descParts.join(' ') || name;
      await send(chatId, 'Creating skill...');
      const result = await skillManager.createSkill(name, desc, { chatId });
      if (result.success) {
        await send(chatId, `Skill created: ${result.skill.name}\nID: ${result.skill.id}\nSteps: ${(result.skill.steps || []).length}\nCategory: ${result.skill.category}`);
      } else {
        await send(chatId, `Error: ${result.error}`);
      }
      return;
    }

    // /run_skill <skill_id> [params] — execute a skill
    if (cmd === 'run_skill' || cmd === 'skill') {
      if (!cmdBody) { await send(chatId, 'Usage: /run_skill <skill_id> [task description]'); return; }
      const [skillId, ...taskParts] = cmdBody.split(/\s+/);
      const task = taskParts.join(' ') || '';
      await send(chatId, `Executing skill: ${skillId}...`);
      const result = await skillManager.executeSkill(skillId, { task, topic: task, description: task, business: task }, {
        chatId,
        onProgress: (p) => send(chatId, `Step ${p.step}/${p.total}: ${p.desc}`).catch(() => {}),
      });
      await send(chatId, result.success ? String(result.output).slice(0, 4000) : `Error: ${result.error}`);
      return;
    }

    // /all_skills — list all skills
    if (cmd === 'all_skills' || cmd === 'skilllist') {
      const skills = skillManager.getAllSkills();
      const list = Object.values(skills);
      if (list.length === 0) { await send(chatId, 'No skills yet. Use /create_skill or let the bot auto-learn.'); return; }
      const text = list.map(s => `${s.name} [${s.id}]\n  ${s.desc}\n  Type: ${s.type} | Uses: ${s.usageCount || 0} | Category: ${s.category}`).join('\n\n');
      await send(chatId, `Skills (${list.length}):\n\n${text.slice(0, 4000)}`);
      return;
    }

    // /integrate <description> — auto-setup integration
    if (cmd === 'integrate' || cmd === 'connect') {
      if (!cmdBody) { await send(chatId, 'Usage: /integrate <what to connect, e.g. "GitHub repo myuser/myrepo">'); return; }
      await send(chatId, 'Setting up integration...');
      const result = await integrationHub.autoSetupIntegration(cmdBody, { chatId });
      if (result.success) {
        let msg = `Integration added: ${result.integration.name} (${result.integration.type})\nID: ${result.integration.id}`;
        if (result.instructions) msg += `\n\nSetup needed:\n${result.instructions}`;
        if (result.envVars?.length) msg += `\n\nRequired env vars: ${result.envVars.join(', ')}`;
        await send(chatId, msg);
      } else {
        await send(chatId, `Error: ${result.error}`);
      }
      return;
    }

    // /integrations — list integrations
    if (cmd === 'integrations' || cmd === 'intlist') {
      const ints = integrationHub.getAllIntegrations();
      const list = Object.values(ints);
      if (list.length === 0) { await send(chatId, 'No integrations. Use /integrate to add one.'); return; }
      const text = list.map(i => `${i.name} [${i.type}] — ${i.status}\n  Uses: ${i.usageCount || 0} | ID: ${i.id}`).join('\n\n');
      await send(chatId, `Integrations (${list.length}):\n\n${text}`);
      return;
    }

    // /orch_stats — orchestrator statistics
    if (cmd === 'orch_stats' || cmd === 'ostats') {
      const stats = orchestrator.getStats();
      const skillStats = skillManager.getStats();
      const intStats = integrationHub.getStats();
      const customAgentCount = Object.keys(dynamicAgentCreator.getCustomAgents()).length;
      let msg = `=== Orchestrator Stats ===\nTotal tasks: ${stats.totalTasks}\nSuccess rate: ${stats.successRate}\n\n`;
      msg += `Strategies:\n`;
      for (const [name, s] of Object.entries(stats.strategies)) {
        if (s.count > 0) msg += `  ${name}: ${s.count} tasks, ${s.success} ok, avg ${Math.round(s.avgDuration / 1000)}s\n`;
      }
      msg += `\nCustom agents: ${customAgentCount}`;
      msg += `\nSkills: ${skillStats.total} (${skillStats.totalExecutions} executions)`;
      msg += `\nIntegrations: ${intStats.total} (${intStats.totalUsage} uses)`;
      await send(chatId, msg);
      return;
    }
  }

  // === Минимальные команды ===

  if (text === '/start' || text === '/menu') {
    const provLabel = PROVIDER_LABELS[getProvider(uc.model)] || '';
    const modeInfo = uc.activeMode ? `\n🎭 Режим: ${SPECIALIZED_MODES[uc.activeMode]?.icon || ''} ${SPECIALIZED_MODES[uc.activeMode]?.label || uc.activeMode}` : '';
    // Убираем старую постоянную клавиатуру (если она ещё есть от предыдущей версии)
    const tmp = await tgApi('sendMessage', { chat_id: chatId, text: '.', reply_markup: { remove_keyboard: true } });
    if (tmp?.ok && tmp.result?.message_id) {
      tgApi('deleteMessage', { chat_id: chatId, message_id: tmp.result.message_id }).catch(() => { });
    }
    const modeStr = uc.activeMode && SPECIALIZED_MODES[uc.activeMode]
      ? `\n${SPECIALIZED_MODES[uc.activeMode].icon} Режим: ${SPECIALIZED_MODES[uc.activeMode].label}`
      : '';
    send(chatId, `🤖 Готов к работе\n\nМодель: ${uc.model} ${provLabel}${modeStr}\n\nПросто напишите что нужно — или выберите раздел ниже.`, mainMenu(chatId));
    return;
  }
  if (text === '/stop') { stopTask(chatId); sendTemp(chatId, '⛔ Остановлено'); return; }
  if (text === '/settings') { send(chatId, '⚙️ Настройки', settingsMenu(chatId)); return; }
  if (text === '/help') { send(chatId, helpText(), mainMenu(chatId)); return; }
  if (text === '/profile') {
    const uc = getUserConfig(chatId);
    const history = chatHistory.get(chatId) || [];
    const mode = uc.mode || 'обычный';
    const model = uc.model || 'auto';
    const imgModel = uc.imageModel || 'nano-banana';
    const vidModel = uc.videoModel || 'veo-3.1-fast';
    const agent = uc.agentMode ? '✅' : '❌';
    const mem = uc.memory ? '✅' : '❌';
    const todos = (config.todos || []).filter(t => t.chatId === chatId);
    const rems = (config.reminders || []).filter(r => r.chatId === chatId);
    send(chatId, `👤 *Ваш профиль*

🧠 Модель: \`${model}\`
🎭 Режим: ${mode}
🤖 Агент: ${agent}
💾 Память: ${mem}

📊 *Статистика:*
💬 Сообщений в истории: ${history.length}
✅ Задач: ${todos.length}
⏰ Напоминаний: ${rems.length}

🎨 Модель изображений: \`${imgModel}\`
🎬 Модель видео: \`${vidModel}\``, { parse_mode: 'Markdown' });
    return;
  }
  if (text === '/chats') {
    try {
      const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
      const chatIds = Object.keys(users).sort((a, b) => parseInt(b) - parseInt(a));

      if (chatIds.length === 0) {
        send(chatId, '📭 Нет активных диалогов');
        return;
      }

      let chatsList = '📋 *Активные диалоги*\n━━━━━━━━━━━━━━━━━━━━\n\n';
      chatIds.forEach((id, idx) => {
        const userData = users[id];
        const role = userData.role ? ` (${userData.role})` : '';
        const model = userData.model ? ` • ${userData.model}` : '';
        const banned = userData.banned ? ' 🚫' : '';
        chatsList += `${idx + 1}. \`${id}\`${role}${model}${banned}\n`;
      });

      chatsList += `\n📊 *Всего чатов:* ${chatIds.length}`;
      send(chatId, chatsList, { parse_mode: 'Markdown' });
    } catch (e) {
      send(chatId, `❌ Ошибка при чтении данных: ${e.message}`);
    }
    return;
  }

  // === Авторизация MTProto ===
  if (text === '/auth') {
    if (!apiId || !apiHash) {
      send(chatId, '❌ Не настроены API credentials.\n\n📱 Для авторизации MTProto:\n\n1. Получи API credentials на https://my.telegram.org/apps\n2. Добавь в .env файл:\n   TG_API_ID=твой_api_id\n   TG_API_HASH=твой_api_hash\n3. Перезагрузи бота\n4. Снова используй /auth');
      return;
    }
    if (!mtClient) {
      send(chatId, '❌ MTProto клиент не инициализирован. Перезагрузи бота.');
      return;
    }
    if (mtConnected) {
      send(chatId, '✅ MTProto уже авторизован!\n\nИспользуй:\n/mychats — список всех диалогов\n/chathistory [ID] — история чата');
      return;
    }

    clearAllWaiting(chatId);
    waitingAuthPhone.add(chatId);
    send(chatId, '📱 *Авторизация MTProto*\n\nВведи номер телефона в международном формате:\n\nПример: +77001234567\n\n⚠️ Будет отправлен код подтверждения в Telegram',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'auth_cancel' }]] }
      });
    return;
  }

  // === Получить ВСЕ личные диалоги через MTProto ===
  if (text === '/mychats') {
    if (!mtClient || !mtConnected) {
      send(chatId, '❌ MTProto не подключен.\n\n📱 Для доступа ко всем твоим личным переписками используй:\n\n/auth — авторизоваться через User API\n\nЕсли ещё не настроил API credentials:\n1. Получи их на https://my.telegram.org/apps\n2. Добавь в .env:\n   TG_API_ID=твой_api_id\n   TG_API_HASH=твой_api_hash\n3. Перезагрузи бота');
      return;
    }

    try {
      send(chatId, '🔍 Получаю список всех твоих диалогов...');
      const dialogs = await mtClient.getDialogs({ limit: 100 });

      if (dialogs.length === 0) {
        send(chatId, '📭 Нет диалогов');
        return;
      }

      let chatsList = '💬 *Все твои диалоги в Telegram*\n━━━━━━━━━━━━━━━━━━━━\n\n';
      dialogs.slice(0, 50).forEach((dialog, idx) => {
        const name = dialog.name || dialog.title || 'Без названия';
        const type = dialog.isUser ? '👤' : dialog.isGroup ? '👥' : dialog.isChannel ? '📢' : '❓';
        const unread = dialog.unreadCount > 0 ? ` 🔴${dialog.unreadCount}` : '';
        const date = dialog.date ? new Date(dialog.date * 1000).toLocaleDateString('ru-RU') : '';
        chatsList += `${idx + 1}. ${type} *${name}*${unread}\n    ID: \`${dialog.id}\` │ ${date}\n\n`;
      });

      chatsList += `━━━━━━━━━━━━━━━━━━━━\n📊 *Всего диалогов:* ${dialogs.length}`;
      if (dialogs.length > 50) chatsList += ` (показано первые 50)`;
      chatsList += '\n\n💡 Чтобы получить историю чата:\n/chathistory [ID]';

      send(chatId, chatsList, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(`[chatId:${chatId}] /mychats error:`, e);
      send(chatId, `❌ Ошибка: ${e.message}`);
    }
    return;
  }

  // === Получить историю чата через MTProto ===
  if (text.startsWith('/chathistory')) {
    if (!mtClient || !mtConnected) {
      send(chatId, '❌ MTProto не подключен. Используй /mychats для инструкций по подключению');
      return;
    }

    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      send(chatId, '❌ Укажи ID чата.\n\nФормат: /chathistory [ID]\n\nПример: /chathistory 123456789\n\n💡 Получить ID можно через /mychats');
      return;
    }

    const targetChatId = parts[1].trim();
    const limit = parts[2] ? parseInt(parts[2]) : 50;

    try {
      send(chatId, `🔍 Получаю историю чата ${targetChatId}...`);
      const messages = await mtClient.getMessages(targetChatId, { limit: Math.min(limit, 100) });

      if (messages.length === 0) {
        send(chatId, '📭 Нет сообщений или чат не найден');
        return;
      }

      // Получаем информацию о чате
      let chatInfo = '';
      try {
        const entity = await mtClient.getEntity(targetChatId);
        const name = entity.firstName || entity.title || entity.username || 'Неизвестно';
        chatInfo = `💬 *Чат:* ${name}\n`;
      } catch (e) {
        chatInfo = `💬 *Chat ID:* ${targetChatId}\n`;
      }

      let history = `${chatInfo}━━━━━━━━━━━━━━━━━━━━\n\n`;
      messages.reverse().slice(0, 30).forEach((msg, idx) => {
        const date = new Date(msg.date * 1000).toLocaleString('ru-RU');
        const text = msg.text || '[медиа/стикер]';
        const sender = msg.senderId?.toString() || 'unknown';
        history += `${idx + 1}. 📅 ${date}\n👤 ${sender}\n📝 ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}\n\n`;
      });

      history += `━━━━━━━━━━━━━━━━━━━━\n📊 Показано: ${Math.min(messages.length, 30)} из ${messages.length}`;

      send(chatId, history);
    } catch (e) {
      console.error(`[chatId:${chatId}] /chathistory error:`, e);
      send(chatId, `❌ Ошибка: ${e.message}\n\n💡 Убедись что ID правильный. Получить ID можно через /mychats`);
    }
    return;
  }
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
  if (text === '/clearframes') {
    const frames = sessionFrames.get(chatId);
    if (!frames || (!frames.startFrame && !frames.endFrame && !frames.referenceImage)) {
      send(chatId, '📭 Нет сохранённых кадров');
    } else {
      const cleared = [];
      if (frames.startFrame) cleared.push('начальный кадр');
      if (frames.endFrame) cleared.push('конечный кадр');
      if (frames.referenceImage) cleared.push('референс');
      sessionFrames.delete(chatId);
      send(chatId, `🗑 Кадры очищены: ${cleared.join(', ')}`);
    }
    return;
  }
  if (text.startsWith('/check_models')) {
    const arg = text.split(' ')[1]?.toLowerCase();
    const uc = getUserConfig(chatId);
    
    if (!arg) {
      send(chatId, '🔍 Укажите провайдера: `/check_models groq`, `openrouter`, `google`, `anthropic`');
      return;
    }

    let url, key, headers;
    if (arg === 'groq') {
      url = 'https://api.groq.com/openai/v1/models';
      key = uc.apiKeys?.groq || process.env.GROQ_API_KEY;
      headers = { 'Authorization': `Bearer ${key}` };
    } else if (arg === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/models';
      key = uc.apiKeys?.openrouter || process.env.OPENROUTER_API_KEY;
      headers = { 'Authorization': `Bearer ${key}` };
    } else if (arg === 'google') {
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${uc.apiKeys?.google || process.env.GEMINI_API_KEY}`;
      headers = {};
    } else if (arg === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models';
      key = uc.apiKeys?.anthropic || process.env.ANTHROPIC_API_KEY;
      headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    } else {
      send(chatId, '❌ Неизвестный провайдер');
      return;
    }

    if (!key && arg !== 'google') { send(chatId, `❌ Ключ для ${arg} не задан`); return; }
    sendTemp(chatId, `🔍 Запрашиваю список моделей ${arg}...`);

    try {
      const res = await fetch(url, { headers });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      
      let models = [];
      if (arg === 'google') models = data.models?.map(m => `• \`${m.name.split('/').pop()}\` (${m.description || 'без описания'})`) || [];
      else if (data.data) models = data.data.map(m => `• \`${m.id}\``);
      
      send(chatId, `🌐 **Доступные модели ${arg}:**\n\n${models.slice(0, 50).join('\n') || 'Модели не найдены'}`);
    } catch (e) {
      send(chatId, `❌ Ошибка: ${e.message}`);
    }
    return;
  }
  if (text === '/frames') {
    const frames = sessionFrames.get(chatId);
    if (!frames || (!frames.startFrame && !frames.endFrame && !frames.referenceImage)) {
      send(chatId, '📭 Нет сохранённых кадров.\n\nЧтобы сохранить кадр:\n• Отправь фото с подписью "начальный кадр"\n• Отправь фото с подписью "конечный кадр"\n• Отправь фото с подписью "референс"\n• Или сразу: фото с "оживи [промпт]"');
    } else {
      const parts = [];
      if (frames.startFrame) parts.push('✅ Начальный кадр');
      if (frames.endFrame) parts.push('✅ Конечный кадр');
      if (frames.referenceImage) parts.push('✅ Референс');
      const ago = frames.savedAt ? `\nСохранено: ${Math.round((Date.now() - frames.savedAt) / 60000)} мин назад` : '';
      const hint = frames.startFrame && frames.endFrame
        ? '\n\n🎬 A→B режим активен. Напиши промпт — агент сделает видео от первого кадра к последнему.\n⚠️ A→B работает только с veo-2'
        : frames.startFrame
          ? '\n\n🎬 Начальный кадр задан. Напиши промпт или добавь конечный кадр.'
          : '\n\n🎨 Референс задан. Напиши задание для видео/изображения.';
      send(chatId, `🎬 Сохранённые кадры:\n${parts.join('\n')}${ago}${hint}`);
    }
    return;
  }
  if (text === '/office') {
    if (MINIAPP_URL) {
      send(chatId, '🏢 Pixel Office', { reply_markup: { inline_keyboard: [[{ text: '💻 Открыть Pixel Office', web_app: { url: MINIAPP_URL } }], [{ text: '◀️ Назад', callback_data: 'back' }]] } });
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
    const fmtSec = (s) => s >= 60 ? `${Math.floor(s / 60)}м${s % 60 > 0 ? s % 60 + 'с' : ''}` : `${s}с`;
    let msg = '📋 𝗧𝗔𝗦𝗞𝗦\n━━━━━━━━━━━━━━━━━━━━\n';
    if (fgTask) {
      const at = activeTasks.get(chatId);
      const st = at?.statusState;
      if (st) {
        const elapsed = Math.round((Date.now() - st.startTime) / 1000);
        const pct = st.maxSteps > 0 ? Math.round((st.step / st.maxSteps) * 100) : 0;
        const eta = st.step > 0 && st.maxSteps > st.step ? ` ETA ~${fmtSec(Math.round(elapsed / st.step * (st.maxSteps - st.step)))}` : '';
        const successCount = (st.completedActions || []).filter(a => a.success).length;
        const failCount = (st.completedActions || []).length - successCount;
        msg += `🔵 𝗙𝗼𝗿𝗲𝗴𝗿𝗼𝘂𝗻𝗱\n`;
        msg += `[${gradientBar(pct, 14)}] ${st.step}/${st.maxSteps}${eta}\n`;
        msg += `⏱ ${fmtSec(elapsed)} │ ✅${successCount} ❌${failCount}\n`;
        if (st.phase) msg += `${fancySpin(elapsed)} ${st.phase}\n`;
        if (st.actionName) msg += `╰─ ${st.actionName}${st.actionDetail ? ': ' + st.actionDetail.slice(0, 30) : ''}\n`;
      } else {
        msg += '🔵 Foreground: выполняется\n';
      }
      msg += '\n';
    }
    if (userBg.size > 0) {
      const running = Array.from(userBg.values()).filter(t => t.status === 'running').length;
      const done = Array.from(userBg.values()).filter(t => t.status === 'done').length;
      const errCount = userBg.size - running - done;
      msg += `🔄 𝗕𝗮𝗰𝗸𝗴𝗿𝗼𝘂𝗻𝗱 (${userBg.size}/${MAX_BG_TASKS_PER_USER}) │ ✅${done} ❌${errCount}\n`;
      const rows = [];
      for (const [tid, t] of userBg) {
        const elapsed = Math.round((Date.now() - t.startTime) / 1000);
        const statusIcon = t.status === 'running' ? fancySpin(elapsed) : t.status === 'done' ? '✅' : '❌';
        const pctBar = t.progress != null ? ` ${miniBar(t.progress)} ${t.progress}%` : '';
        msg += `${statusIcon} ${t.desc.slice(0, 28)}${pctBar} ${fmtSec(elapsed)}\n`;
        if (t.status === 'running') rows.push([{ text: `❌ Отменить: ${t.desc.slice(0, 20)}`, callback_data: `bg_cancel_${tid}` }]);
      }
      msg += '━━━━━━━━━━━━━━━━━━━━';
      rows.push([{ text: '◀️ Назад', callback_data: 'back' }]);
      send(chatId, msg, { reply_markup: { inline_keyboard: rows } });
    } else {
      msg += '━━━━━━━━━━━━━━━━━━━━';
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
    // Ask for optional API key; name = первый сегмент хоста (rube.app → rube)
    clearAllWaiting(chatId);
    const name = url.replace(/^https?:\/\//, '').split('/')[0].replace(/^([^.]+).*$/, '$1') || 'mcp';
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
    const baseId = (name || 'mcp').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mcp';
    const existingIds = new Set((uc.mcpServers || []).map(s => (s.id || '').toLowerCase()));
    const id = existingIds.has(baseId) ? baseId + '_' + Date.now().toString(36) : baseId;
    const serverCfg = { id, name: name || id, url, apiKey, authType, transport: 'http', tools: [], enabled: true, lastSync: null };
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

  // === Ввод параметров модели ===
  if (waitingModelSetting.has(chatId)) {
    const settingName = waitingModelSetting.get(chatId);
    waitingModelSetting.delete(chatId);
    const val = text.trim().toLowerCase();
    if (!uc.modelSettings) uc.modelSettings = {};
    if (!uc.modelSettings[uc.model]) uc.modelSettings[uc.model] = {};

    if (val === '0' || val === 'авто' || val === 'auto') {
      delete uc.modelSettings[uc.model][settingName];
      send(chatId, `✅ Настройка ${settingName} для ${uc.model} сброшена на Авто.`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К параметрам', callback_data: 'model_settings' }]] } });
    } else {
      const num = parseFloat(val);
      if (isNaN(num) || num < 0) {
        send(chatId, `❌ Неверное значение. Настройка отменена.`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К параметрам', callback_data: 'model_settings' }]] } });
      } else {
        uc.modelSettings[uc.model][settingName] = settingName === 'maxTokens' ? Math.floor(num) : num;
        send(chatId, `✅ Настройка ${settingName} для ${uc.model} сохранена: ${uc.modelSettings[uc.model][settingName]}`, { reply_markup: { inline_keyboard: [[{ text: '◀️ К параметрам', callback_data: 'model_settings' }]] } });
      }
    }
    saveUserConfig(chatId);
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

  // Параллельные задачи: проверяем лимит вместо полной блокировки
  const currentFgCount = getActiveFgTasksCount(chatId);
  if (currentFgCount >= MAX_CONCURRENT_TASKS_PER_USER) {
    enqueue(chatId, { text, type: 'text' });
    send(chatId, `📬 В очереди (${getQueueSize(chatId)}). Лимит: ${MAX_CONCURRENT_TASKS_PER_USER} параллельных задач.`);
    return;
  }

  if (currentFgCount > 0) {
    send(chatId, `⚡ Запускаю параллельно (${currentFgCount + 1}/${MAX_CONCURRENT_TASKS_PER_USER}) — обрабатываю одновременно`).then(r => autoDeleteMsg(chatId, r?.result?.message_id, 5000));
  }

  // Typing indicator для пользователя пока идёт обработка
  tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  // Zep + local memory: prefetch context
  zepMemory.prefetchContext(chatId, text).catch(() => { });

  runClaude(chatId, text).catch(e => {
    console.error(`[processUpdate] runClaude FATAL ERROR for ${chatId}:`, e);
    send(chatId, `❌ Произошла критическая ошибка: ${e.message}`);
  });
}

// Long polling — эффективнее и надёжнее
// ############################################################
// # 8. ОСНОВНОЙ ЦИКЛ (MAIN POLLING LOOP)
// ############################################################
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
  } catch (e) { return null; }
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
        id: a.id || null,
        task: a.task ? (a.task).slice(0, 120) : null,
        status: a.status || 'pending',
        result: a.result ? (a.result).slice(0, 100) : null,
        startTime: a.startTime,
        endTime: a.endTime || null,
        error: a.error || null,
        parallelGroup: a.parallelGroup || null,
      })),
      log: (multi.log || []).slice(-30).map(entry =>
        typeof entry === 'string' ? { ts: null, text: entry } : entry
      ),
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
    agentRoles: Object.fromEntries(Object.entries(getEffectiveAgents(chatId)).map(([k, v]) => [k, { icon: v.icon, label: v.label, desc: v.desc || v.description || '' }])),
  };
}

let miniappServer = null;
const sseClients = new Map(); // res -> { chatId, lastHash }

function startMiniAppServer() {
  const http = require('http');
  const PORT = process.env.MINIAPP_PORT || process.env.PORT || '3847';

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
        res.end(JSON.stringify({
          error: initData ? 'Invalid initData' : 'Open this Mini App from Telegram to connect',
          code: 'AUTH_REQUIRED',
        }));
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

    // Serve miniapp static files
    const miniappDir = path.join(__dirname, 'miniapp', 'dist');
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.join(miniappDir, filePath);
    // Security: prevent path traversal
    if (!fullPath.startsWith(miniappDir)) { res.writeHead(403); res.end(); return; }
    const extMap = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    const ext = path.extname(fullPath);
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, { 'Content-Type': extMap[ext] || 'application/octet-stream', 'X-Frame-Options': 'ALLOWALL' });
        res.end(content);
      } else {
        // SPA fallback — serve index.html for all non-file routes
        const indexPath = path.join(miniappDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'ALLOWALL' });
          res.end(fs.readFileSync(indexPath));
        } else {
          res.writeHead(404); res.end('Not found');
        }
      }
    } catch (e) { res.writeHead(500); res.end('Server error'); }
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
      } catch (e) { sseClients.delete(res); }
    }
  }, 500);

  try {
    miniappServer.listen(PORT, () => {
      console.log(`🎮 Mini App API on port ${PORT}`);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ Port ${PORT} занят, MiniApp API пропущен`);
      } else if (err.code === 'EACCES' || err.code === 'EPERM') {
        console.log(`⚠️ Port ${PORT} заблокирован (sandbox/permissions), MiniApp API пропущен`);
      } else {
        console.log(`⚠️ MiniApp server: ${err.code || err.message} — пропущен`);
      }
      miniappServer = null;
    });
  } catch (e) {
    console.log(`⚠️ MiniApp server не запущен: ${e.message}`);
    miniappServer = null;
  }
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
    if (task.pid) { try { process.kill(task.pid); } catch (e) { } }
    if (task.abort) { try { task.abort.abort(); } catch (e) { } }
  }
  activeTasks.clear();

  // Останавливаем фоновые задачи
  for (const [chatId, tasks] of backgroundTasks) {
    for (const [taskId, task] of tasks) {
      if (task.abort) { try { task.abort.abort(); } catch (e) { } }
    }
  }
  backgroundTasks.clear();

  if (miniappServer) miniappServer.close();

  // Закрываем браузерные сессии
  try { browserManager?.destroyAll(); } catch (e) { }

  // Отключаем MTProto
  if (mtClient) {
    mtClient.disconnect().catch(() => { });
  }

  // Удаляем PID файл
  try { fs.unlinkSync(PID_FILE); } catch (e) { }

  console.log('👋 Бот остановлен');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log('🤖 Multi-Model AI Telegram Bot');
console.log(`🔧 Per-user config system enabled`);
const availableProviders = ['Anthropic (CLI)'];
if (process.env.OPENAI_API_KEY) availableProviders.push('OpenAI');
if (hasCodexCli()) availableProviders.push('Codex CLI');
if (process.env.GEMINI_API_KEY) availableProviders.push('Google');
if (process.env.GROQ_API_KEY) availableProviders.push('Groq');
console.log(`🌐 Провайдеры: ${availableProviders.length > 0 ? availableProviders.join(', ') : '⚠️ ни одного API ключа!'}`);

// === Plugin SDK: инициализация ===
(async () => {
  try {
    const { PluginManager } = require('./src/core/plugin-sdk');
    global.pluginManager = new PluginManager(PLUGINS_DIR, {
      send, sendPhoto, sendVideo, sendDocument,
      getUserConfig, saveUserConfig: (chatId) => saveUserConfig(chatId),
      isAdmin, editMessage: editText,
      execBash: (cmd, opts) => executeBashAction(cmd, opts?.workDir || '/tmp'),
      callAI: async (promptOrModel, optionsOrMessages = {}, maybeSystemPrompt = '', maybeAllowMcp = true) => {
        // Backward-compatible adapter:
        // 1) SDK style: callAI(prompt, { model, systemPrompt, allowMcp, chatId })
        // 2) Core style: callAI(model, messages, systemPrompt, allowMcp, chatId)
        if (Array.isArray(optionsOrMessages)) {
          return callAI(
            promptOrModel,
            optionsOrMessages,
            maybeSystemPrompt || '',
            maybeAllowMcp !== false,
            undefined
          );
        }

        const opts = optionsOrMessages || {};
        const model = opts.model || getUserConfig(opts.chatId)?.model || 'claude-sonnet';
        const promptText = String(promptOrModel ?? '');
        const messages = opts.messages || [{ role: 'user', content: promptText }];
        const result = await callAI(
          model,
          messages,
          opts.systemPrompt || '',
          opts.allowMcp !== false,
          opts.chatId || null,
          opts.cliOpts || {}
        );
        return result.text || '';
      },
      webSearch: (query) => executeSearchAction(query),
      getMcpClient: (chatId, serverId) => getMcpClient(chatId, serverId),
      getPluginData: (pn, k) => global.pluginManager?.getPluginData(pn, k),
      setPluginData: (pn, k, v) => global.pluginManager?.setPluginData(pn, k, v),
    });
    const result = await global.pluginManager.loadAll();
    console.log(`🔌 Plugin SDK: ${result.loaded} плагинов загружено${result.errors.length ? `, ${result.errors.length} ошибок` : ''}`);
  } catch (e) {
    console.error('⚠️ Plugin SDK init error:', e.message);
  }
})();

// === Autonomous Executor: init ===
const toolRouter = new ToolRouter({
  executeAction, callAI, callAIWithFallback,
  runSubAgentLoop, getEffectiveAgents,
  pluginManager: global.pluginManager,
});
const autonomousExecutor = new AutonomousExecutor({
  toolRouter, callAI, callAIWithFallback, globalPool,
  sendUpdate: (chatId, text) => send(chatId, text),
  persistDir: path.join(__dirname, 'data', 'tasks'),
});

// === Super-Agent Factory: init ===
const { initSuperAgentSystem } = require('./modules/superAgentIntegration');
const superAgentFactory = initSuperAgentSystem({
  command: (cmd, fn) => {
    global.superAgentHandlers = global.superAgentHandlers || {};
    global.superAgentHandlers[cmd] = fn;
  }
}, {
  usersFile: path.join(__dirname, 'users.json'),
  dataDir: path.join(__dirname, 'data'),
  maxConcurrent: 4,
  callAI,
  runSubAgentLoop,
  getEffectiveAgents
});

// === Dynamic Agent Creator: init ===
const dynamicAgentCreator = new DynamicAgentCreator({
  callAI, callAIWithFallback,
});
console.log('[DynamicAgentCreator] Initialized. Custom agents:', dynamicAgentCreator.customAgents.size);

// === Skill Manager: init ===
const skillManager = new SkillManager({
  callAI, callAIWithFallback, executeAction, runSubAgentLoop,
});
console.log('[SkillManager] Initialized. Skills loaded:', skillManager.skills.size);

// === Integration Hub: init ===
const integrationHub = new IntegrationHub({
  callAI, callAIWithFallback, executeAction,
});
console.log('[IntegrationHub] Initialized. Integrations:', integrationHub.integrations.size);

// === Orchestrator: init ===
const orchestrator = new Orchestrator({
  callAI, callAIWithFallback, runSubAgentLoop, executeAction,
  dynamicAgentCreator, skillManager, integrationHub,
  autonomousExecutor, superAgentFactory, globalPool,
  sendUpdate: (chatId, text) => send(chatId, text),
});
console.log('[Orchestrator] Initialized. Ready for autonomous task routing.');

// Export globally for cross-module access
global.dynamicAgentCreator = dynamicAgentCreator;
global.skillManager = skillManager;
global.integrationHub = integrationHub;
global.orchestrator = orchestrator;

async function executeAutonomousAction(chatId, body, statusUpdater) {
  const goal = body.replace(/^goal:\s*/i, '').trim();
  if (statusUpdater) statusUpdater('Autonomous execution started...');

  // Use orchestrator for smart routing
  const result = await orchestrator.execute(chatId, goal, {
    onProgress: (u) => {
      if (statusUpdater) statusUpdater(u.message);
    },
  });
  return result;
}

// Resume pending autonomous tasks on startup
setTimeout(async () => {
  try {
    const tasksDir = path.join(__dirname, 'data', 'tasks');
    if (!fs.existsSync(tasksDir)) return;
    const chatDirs = fs.readdirSync(tasksDir).filter(d => /^\d+$/.test(d));
    for (const chatId of chatDirs) {
      const pending = autonomousExecutor.listPending(chatId);
      if (pending.length > 0) {
        const list = pending.map(t => `  - ${t.goal} (${t.progress})`).join('\n');
        await send(chatId, `Найдены незавершённые автономные задачи:\n${list}\n\nОтправьте "resume <task_id>" чтобы продолжить.`);
      }
    }
  } catch (e) {
    console.error('Resume check error:', e.message);
  }
}, 5000);

startMiniAppServer();

// Запуск MTProto и мониторинга
initMTProto().catch(e => {
  console.error('CRITICAL: MTProto startup failed:', e);
});

// Регистрируем команды бота (минимум — всё через AI)
tgApi('setMyCommands', {
  commands: [
    { command: 'start', description: '🏠 Главное меню' },
    { command: 'menu', description: '📋 Открыть меню' },
    { command: 'settings', description: '⚙️ Настройки' },
    { command: 'mode', description: '🎭 Режимы AI' },
    { command: 'profile', description: '👤 Профиль и статистика' },
    { command: 'help', description: '❓ Помощь' },
    { command: 'tasks', description: '📋 Активные задачи' },
    { command: 'stop', description: '⛔ Остановить задачу' },
    { command: 'clear', description: '🗑 Очистить историю' },
    { command: 'office', description: '🏢 Pixel Office' },
  ]
}).catch(e => console.error('setMyCommands error:', e.message));

// Одноразовая очистка старой постоянной клавиатуры для активных пользователей
setTimeout(async () => {
  const adminList = Array.from(new Set([...adminIds, ...Array.from(userConfigs.keys())])).slice(0, 20);
  for (let i = 0; i < adminList.length; i += 5) {
    const batch = adminList.slice(i, i + 5);
    await Promise.allSettled(batch.map(async chatId => {
      try {
        const tmp = await tgApi('sendMessage', { chat_id: chatId, text: '.', reply_markup: { remove_keyboard: true } });
        if (tmp?.ok && tmp.result?.message_id) {
          await tgApi('deleteMessage', { chat_id: chatId, message_id: tmp.result.message_id });
        }
      } catch (_) { }
    }));
    if (i + 5 < adminList.length) await new Promise(r => setTimeout(r, 300));
  }
}, 4000);

tick().catch(e => {
  console.error('🚨 CRITICAL: tick() loop crashed:', e);
  process.exit(1);
});
