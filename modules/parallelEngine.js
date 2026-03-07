'use strict';

/**
 * PARALLEL ENGINE v2.0
 *
 * Улучшенное параллельное, фоновое выполнение и создание
 * субагентов под конкретные задачи/бизнес/направления.
 *
 * FEATURES:
 * - Concurrency pool с лимитом одновременных задач
 * - Приоритетная очередь (high/medium/low)
 * - Стриминг прогресса в реальном времени
 * - Auto-delegate: умный анализ задачи -> авто-делегация субагентам
 * - Domain-aware agent factory: создание агентов под бизнес-домен
 * - Skill auto-generation: авто-создание скиллов из успешных выполнений
 * - Task chaining: цепочки фоновых задач
 * - Result aggregation: умная агрегация результатов параллельных задач
 */

const EventEmitter = require('events');

// === CONCURRENCY POOL ===
class ConcurrencyPool {
  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.running = new Map();   // id -> { promise, meta }
    this.queue = [];            // { id, fn, priority, meta, resolve, reject }
    this.completed = new Map(); // id -> result (последние 50)
    this.events = new EventEmitter();
  }

  get activeCount() { return this.running.size; }
  get queuedCount() { return this.queue.length; }
  get stats() {
    return {
      running: this.running.size,
      queued: this.queue.length,
      completed: this.completed.size,
      maxConcurrent: this.maxConcurrent
    };
  }

  /**
   * Добавить задачу в пул с приоритетом
   * @param {string} id - уникальный ID задачи
   * @param {Function} fn - async function для выполнения
   * @param {object} meta - { role, priority, chatId, desc }
   * @returns {Promise} результат выполнения
   */
  submit(id, fn, meta = {}) {
    const priority = meta.priority || 'medium';
    return new Promise((resolve, reject) => {
      const item = { id, fn, priority, meta, resolve, reject };

      if (this.running.size < this.maxConcurrent) {
        this._run(item);
      } else {
        // Вставка с учётом приоритета
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const idx = this.queue.findIndex(q =>
          (priorityOrder[q.priority] || 1) > (priorityOrder[priority] || 1)
        );
        if (idx >= 0) this.queue.splice(idx, 0, item);
        else this.queue.push(item);
        this.events.emit('queued', { id, position: idx >= 0 ? idx : this.queue.length - 1, meta });
      }
    });
  }

  _run(item) {
    const { id, fn, meta, resolve, reject } = item;
    const startTime = Date.now();

    this.events.emit('started', { id, meta, activeCount: this.running.size + 1 });

    const promise = fn()
      .then(result => {
        this.running.delete(id);
        const duration = Date.now() - startTime;
        const record = { id, result, meta, duration, success: true };
        this._addCompleted(id, record);
        this.events.emit('completed', record);
        resolve(result);
        this._drain();
        return result;
      })
      .catch(err => {
        this.running.delete(id);
        const duration = Date.now() - startTime;
        const record = { id, error: err.message, meta, duration, success: false };
        this._addCompleted(id, record);
        this.events.emit('failed', record);
        reject(err);
        this._drain();
      });

    this.running.set(id, { promise, meta, startTime });
  }

  _drain() {
    while (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
      this._run(this.queue.shift());
    }
  }

  _addCompleted(id, record) {
    this.completed.set(id, record);
    // Keep last 50
    if (this.completed.size > 50) {
      const firstKey = this.completed.keys().next().value;
      this.completed.delete(firstKey);
    }
  }

  /**
   * Выполнить массив задач параллельно с лимитом конкурентности
   */
  async runBatch(tasks) {
    // tasks: [{ id, fn, meta }]
    const promises = tasks.map(t => this.submit(t.id, t.fn, t.meta));
    return Promise.allSettled(promises);
  }

  cancel(id) {
    // Remove from queue
    const idx = this.queue.findIndex(q => q.id === id);
    if (idx >= 0) {
      const item = this.queue.splice(idx, 1)[0];
      item.reject(new Error('Cancelled'));
      return true;
    }
    return false;
  }

  cancelAll() {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      item.reject(new Error('Cancelled'));
    }
  }
}


// === DOMAIN-AWARE AGENT FACTORY ===
// Создание агентов под конкретный бизнес/направление

const BUSINESS_DOMAINS = {
  ecommerce: {
    label: 'E-commerce',
    roles: ['copywriter', 'seo', 'marketer', 'ux_ui_designer', 'ecommerce_specialist'],
    skillTemplates: ['product-card', 'price-analysis', 'competitor-audit', 'conversion-funnel'],
    modelPreference: 'claude-sonnet',
  },
  saas: {
    label: 'SaaS',
    roles: ['product_manager', 'web_dev', 'ux_ui_designer', 'growth_hacker', 'copywriter'],
    skillTemplates: ['onboarding-flow', 'pricing-page', 'feature-comparison', 'churn-analysis'],
    modelPreference: 'claude-sonnet',
  },
  content: {
    label: 'Content & Media',
    roles: ['content_creator', 'seo', 'social_media', 'video_producer', 'prompt_engineer'],
    skillTemplates: ['content-plan', 'viral-hook', 'reels-script', 'seo-article'],
    modelPreference: 'claude-sonnet',
  },
  marketing: {
    label: 'Marketing',
    roles: ['marketer', 'copywriter', 'creative_director', 'email_marketer', 'growth_hacker'],
    skillTemplates: ['campaign-brief', 'ad-copy', 'media-plan', 'unit-economics'],
    modelPreference: 'claude-sonnet',
  },
  dev: {
    label: 'Development',
    roles: ['architect', 'coder', 'qa_engineer', 'devops', 'database_admin'],
    skillTemplates: ['code-review', 'api-design', 'ci-cd-setup', 'performance-audit'],
    modelPreference: 'claude-sonnet',
  },
  startup: {
    label: 'Startup',
    roles: ['business_analyst', 'product_manager', 'marketer', 'financial_analyst', 'copywriter'],
    skillTemplates: ['lean-canvas', 'pitch-deck', 'mvp-scope', 'investor-email'],
    modelPreference: 'claude-sonnet',
  },
  education: {
    label: 'Education',
    roles: ['educator', 'content_creator', 'ux_ui_designer', 'video_producer', 'translator'],
    skillTemplates: ['course-outline', 'lesson-plan', 'quiz-generator', 'learning-path'],
    modelPreference: 'gemini-2.5-flash',
  },
  crypto: {
    label: 'Crypto & Web3',
    roles: ['crypto_analyst', 'blockchain_dev', 'marketer', 'community_manager', 'legal_advisor'],
    skillTemplates: ['tokenomics', 'smart-contract-audit', 'whitepaper', 'airdrop-strategy'],
    modelPreference: 'claude-sonnet',
  },
  services: {
    label: 'Services & Agency',
    roles: ['sales_manager', 'copywriter', 'project_manager', 'marketer', 'hr_specialist'],
    skillTemplates: ['service-proposal', 'case-study', 'cold-outreach', 'client-onboarding'],
    modelPreference: 'claude-sonnet',
  },
  automation: {
    label: 'Automation',
    roles: ['automation_engineer', 'coder', 'data_engineer', 'devops', 'systems_analyst'],
    skillTemplates: ['workflow-design', 'api-integration', 'data-pipeline', 'monitoring-setup'],
    modelPreference: 'claude-sonnet',
  },
};

// Паттерны для авто-определения домена из текста задачи
const DOMAIN_PATTERNS = {
  ecommerce: /маркетплейс|товар|карточк|wb|ozon|wildberries|озон|магазин|каталог|корзин|checkout|product.card|e.?commerce|маркет/i,
  saas: /saas|подписк|subscription|pricing|freemium|onboarding|churn|retention|trial|b2b.?платформ/i,
  content: /контент|(?<![а-яё])пост(?![а-яё])|рилс|reels|тикток|tiktok|youtube|ютуб|видео.?сценарий|блог|(?<![а-яё])статья|story|stories|сторис/i,
  marketing: /реклам|кампани|таргет|лид|конверси|ctr|roas|кпи|kpi|маркетинг|промоакц|воронк|funnel|ad\b|ads\b|баннер|офер/i,
  dev: /код|программ|api|backend|frontend|сервер|deploy|деплой|docker|microservice|refactor|тест|bug|фикс/i,
  startup: /стартап|бизнес.?план|инвест|mvp|pitch|lean|canvas|финмодел|unit.?экономик|раунд|seed/i,
  education: /курс|урок|обучен|учебн|тренинг|воркшоп|workshop|лекци|методик|преподав/i,
  crypto: /крипт|блокчейн|blockchain|token|nft|defi|смарт.?контракт|web3|dao|airdrop/i,
  services: /услуг|агентств|клиент|предложени|коммерческ|kp|презентац|case.?study|портфолио/i,
  automation: /автоматиз|workflow|pipeline|n8n|zapier|make|парсинг|scraping|cron|интеграци|бот/i,
};

/**
 * Определить бизнес-домен задачи
 */
function detectDomain(taskText) {
  const scores = {};
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    const matches = (taskText.match(pattern) || []).length;
    if (matches > 0) scores[domain] = matches;
  }
  if (Object.keys(scores).length === 0) return null;
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Определить нужные роли для задачи на основе домена и текста
 */
function detectRolesForTask(taskText, domain = null) {
  const detectedDomain = domain || detectDomain(taskText);
  const domainConfig = detectedDomain ? BUSINESS_DOMAINS[detectedDomain] : null;
  const t = taskText.toLowerCase();

  // Специфичные роли по ключевым словам
  const specificRoles = [];
  const ROLE_PATTERNS = {
    coder: /код|code|функц|class|api|backend|frontend|server|скрипт|script|implement|програм/i,
    researcher: /исследуй|анализ|research|analyze|сравни|compare|изучи|обзор|дайджест/i,
    reviewer: /проверь|review|тест|test|validate|quality|баг|bug|аудит/i,
    writer: /напиши текст|статью|документац|readme|\bwrite\s+(?:text|article|doc|content|post)|\bпост\b|article/i,
    copywriter: /реклам.?текст|заголов|оффер|offer|лендинг|landing|cta|продающ|конверси/i,
    seo: /seo|мета.?тег|ключев.?слов|keyword|ранжирован|search.?engine|organic/i,
    marketer: /маркетинг|стратеги|воронк|funnel|target|таргет|campaign|кампани/i,
    ux_ui_designer: /дизайн|ui|ux|прототип|wireframe|макет|layout|интерфейс|figma/i,
    web_dev: /react|vue|angular|frontend|css|html|next\.?js|nuxt|web.?app/i,
    devops: /docker|deploy|ci.?cd|kubernetes|nginx|devops|сервер|server/i,
    data_analyst: /данн|data|аналитик|метрик|дашборд|dashboard|отчёт|report|visualiz/i,
    product_manager: /roadmap|prd|user.?stor|backlog|приоритизац|product|продукт/i,
    business_analyst: /бизнес.?план|финмодел|swot|canvas|tam|som|unit.?эконом|p&l/i,
    prompt_engineer: /промпт|prompt|midjourney|dall.?e|flux|stable.?diffusion|генераци/i,
    social_media: /smm|соцсет|инстаграм|instagram|telegram|телеграм|вовлечен|engagement/i,
    video_producer: /видео|video|сценарий|ролик|монтаж|reels|shorts/i,
    sales_manager: /продаж|sales|холодн.?письм|скрипт.?продаж|crm|лид|lead/i,
    translator: /перевод|translat|локализ|localiz/i,
  };

  for (const [role, pattern] of Object.entries(ROLE_PATTERNS)) {
    if (pattern.test(t)) specificRoles.push(role);
  }

  // Комбинируем: специфичные + доменные (без дублей)
  const domainRoles = domainConfig?.roles || [];
  const allRoles = [...new Set([...specificRoles, ...domainRoles])];

  // Лимит: максимум 5 ролей для одной задачи
  return allRoles.slice(0, 5);
}


// === AUTO-DELEGATE ENGINE ===

/**
 * Авто-делегация: разбивает задачу на подзадачи и делегирует нужным ролям
 *
 * @param {string} chatId
 * @param {string} taskText - описание задачи
 * @param {object} opts - { runSubAgentLoop, getEffectiveAgents, statusUpdater, pool }
 * @returns {object} { success, output, subtasks, domain, roles }
 */
async function autoDelegate(chatId, taskText, opts = {}) {
  const { runSubAgentLoop, getEffectiveAgents, callAI, statusUpdater, pool } = opts;

  const domain = detectDomain(taskText);
  const roles = detectRolesForTask(taskText, domain);
  const domainConfig = domain ? BUSINESS_DOMAINS[domain] : null;

  if (roles.length <= 1) {
    // Одна роль — просто delegate без параллельности
    const role = roles[0] || 'executor';
    const result = await runSubAgentLoop(chatId, taskText, role, '', 7);
    return {
      success: result.success,
      output: result.output,
      subtasks: [{ role, task: taskText, result }],
      domain,
      roles: [role],
      parallel: false,
    };
  }

  // Несколько ролей — AI-декомпозиция + параллельное выполнение
  const decomposition = await decomposeTask(chatId, taskText, roles, domain, callAI);

  if (!decomposition || decomposition.length === 0) {
    // Fallback: распределяем саму задачу между ролями
    const fallbackTasks = roles.map(role => ({
      role,
      task: taskText,
      deps: [],
      priority: 'medium',
    }));
    return await executeParallelSubtasks(chatId, fallbackTasks, pool, runSubAgentLoop, statusUpdater);
  }

  return await executeParallelSubtasks(chatId, decomposition, pool, runSubAgentLoop, statusUpdater);
}

/**
 * AI-декомпозиция задачи на подзадачи с ролями
 */
async function decomposeTask(chatId, taskText, roles, domain, callAI) {
  if (!callAI) return null;

  const domainLabel = domain ? BUSINESS_DOMAINS[domain]?.label : 'General';
  const rolesStr = roles.join(', ');

  const prompt = `Decompose this task into 2-${Math.min(roles.length, 5)} subtasks for parallel execution.

Task: ${taskText}
Domain: ${domainLabel}
Available roles: ${rolesStr}

Reply ONLY with JSON array (no markdown):
[
  {"role": "role_name", "task": "specific subtask description", "deps": [], "priority": "high|medium|low"},
  ...
]

Rules:
- Each subtask gets exactly one role
- deps = array of indices (0-based) this task depends on
- Independent tasks will run in parallel
- Be specific in task descriptions
- Keep it to ${Math.min(roles.length, 4)} subtasks max`;

  try {
    const result = await callAI('gemini-2.5-flash',
      [{ role: 'user', content: prompt }],
      'You are a task decomposition engine. Reply ONLY with valid JSON.',
      chatId,
      { allowMcp: false }
    );

    const text = (result?.text || '').trim();
    // Extract JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    return parsed.map((item, idx) => ({
      role: item.role || roles[idx % roles.length],
      task: item.task || taskText,
      deps: Array.isArray(item.deps) ? item.deps : [],
      priority: item.priority || 'medium',
    }));
  } catch (e) {
    console.error('[autoDelegate] Decomposition failed:', e.message);
    return null;
  }
}

/**
 * Параллельное выполнение подзадач с учётом зависимостей и пулом конкурентности
 */
async function executeParallelSubtasks(chatId, subtasks, pool, runSubAgentLoop, statusUpdater) {
  const results = new Map(); // idx -> result
  const pending = new Set(subtasks.map((_, i) => i));
  const domain = detectDomain(subtasks.map(s => s.task).join(' '));
  let totalDone = 0;

  // Используем пул если предоставлен, иначе Promise.allSettled
  while (pending.size > 0) {
    // Находим задачи без неразрешённых зависимостей
    const ready = [...pending].filter(idx => {
      const deps = subtasks[idx].deps || [];
      return deps.every(d => results.has(d));
    });

    if (ready.length === 0) {
      // Циклическая зависимость — запускаем всё оставшееся
      ready.push(...pending);
    }

    if (statusUpdater) {
      const bar = '\u2588'.repeat(totalDone) + '\u2591'.repeat(Math.max(0, subtasks.length - totalDone));
      statusUpdater(`[${bar}] ${totalDone}/${subtasks.length} | ${ready.length} параллельно`);
    }

    const promises = ready.map(async (idx) => {
      const st = subtasks[idx];

      // Контекст от зависимостей
      const depsContext = (st.deps || []).map(d => {
        const depResult = results.get(d);
        const depTask = subtasks[d];
        return depResult ? `[Result from ${depTask?.role}]: ${depResult.output?.slice(0, 1500)}` : '';
      }).filter(Boolean).join('\n\n');

      try {
        const maxSteps = st.priority === 'high' ? 10 : st.priority === 'low' ? 4 : 7;
        const result = await runSubAgentLoop(chatId, st.task, st.role, depsContext, maxSteps);
        return { idx, result };
      } catch (e) {
        return { idx, result: { success: false, output: `Error: ${e.message}`, actions: [] } };
      }
    });

    const batchResults = await Promise.allSettled(promises);

    for (const br of batchResults) {
      const { idx, result } = br.status === 'fulfilled' ? br.value : { idx: ready[0], result: { success: false, output: br.reason?.message || 'Error', actions: [] } };
      results.set(idx, result);
      pending.delete(idx);
      totalDone++;
    }
  }

  // Агрегация результатов
  const report = subtasks.map((st, idx) => {
    const r = results.get(idx);
    const icon = r?.success ? '\u2705' : '\u274C';
    const actionsInfo = r?.actions?.length ? ` [${r.actions.map(a => `${a.success ? '\u2713' : '\u2717'}${a.name}`).join(', ')}]` : '';
    return `${icon} ${st.role}: ${st.task.slice(0, 80)}${actionsInfo}\n   ${(r?.output || 'no result').slice(0, 400)}`;
  }).join('\n\n');

  const successCount = [...results.values()].filter(r => r.success).length;
  const allOutputs = [...results.values()].map(r => r.output).join('\n\n---\n\n');

  return {
    success: successCount > 0,
    output: `[PARALLEL: ${successCount}/${subtasks.length} ok | domain: ${domain || 'general'}]\n\n${report}\n\n---\nCombined output:\n${allOutputs.slice(0, 4000)}`,
    subtasks: subtasks.map((st, idx) => ({ ...st, result: results.get(idx) })),
    domain,
    roles: [...new Set(subtasks.map(s => s.role))],
    parallel: true,
  };
}


// === TASK CHAINS ===
// Цепочки задач: последовательное + параллельное выполнение фоновых задач

class TaskChain {
  constructor(chatId, description) {
    this.chatId = chatId;
    this.description = description;
    this.steps = [];    // { type: 'sequential'|'parallel', tasks: [...] }
    this.status = 'pending';
    this.currentStep = 0;
    this.results = [];
  }

  /**
   * Добавить последовательный шаг
   */
  then(task) {
    this.steps.push({ type: 'sequential', tasks: [task] });
    return this;
  }

  /**
   * Добавить параллельный шаг (несколько задач одновременно)
   */
  parallel(tasks) {
    this.steps.push({ type: 'parallel', tasks });
    return this;
  }

  /**
   * Выполнить цепочку
   * @param {Function} executor - async (task, prevResults) => result
   */
  async execute(executor) {
    this.status = 'running';
    let prevResults = [];

    for (let i = 0; i < this.steps.length; i++) {
      this.currentStep = i;
      const step = this.steps[i];

      if (step.type === 'sequential') {
        const task = step.tasks[0];
        try {
          const result = await executor(task, prevResults);
          prevResults = [result];
          this.results.push({ step: i, type: 'sequential', results: [result] });
        } catch (e) {
          this.results.push({ step: i, type: 'sequential', error: e.message });
          this.status = 'error';
          return this;
        }
      } else {
        // parallel
        const promises = step.tasks.map(task => executor(task, prevResults).catch(e => ({ success: false, error: e.message })));
        const results = await Promise.allSettled(promises);
        const values = results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message });
        prevResults = values;
        this.results.push({ step: i, type: 'parallel', results: values });
      }
    }

    this.status = 'done';
    return this;
  }
}


// === SKILL AUTO-GENERATION ===

/**
 * Анализирует результат успешного выполнения и решает, создавать ли скилл
 */
function shouldGenerateSkill(taskText, result, completedActions) {
  // Минимум 2 успешных действия и нетривиальный результат
  if (!completedActions || completedActions.length < 2) return false;
  const successCount = completedActions.filter(a => a.success).length;
  if (successCount < 2) return false;
  if (!result || result.length < 100) return false;

  // Паттерны повторяющихся задач, которые стоит превратить в скилл
  const skillPatterns = [
    /создай.*для|make.*for|build.*for/i,
    /напиши.*текст|write.*copy|create.*content/i,
    /проанализируй|analyze|audit|аудит/i,
    /оптимизируй|optimize|улучши/i,
    /настрой|configure|setup/i,
    /шаблон|template|boilerplate/i,
  ];

  return skillPatterns.some(p => p.test(taskText));
}

/**
 * Генерирует определение скилла из успешного выполнения
 */
function generateSkillDefinition(taskText, role, completedActions, result) {
  // Извлекаем паттерн действий
  const actionSequence = completedActions
    .filter(a => a.success && a.name !== 'think')
    .map(a => a.name)
    .join(' -> ');

  // Создаём название скилла
  const words = taskText.split(/\s+/).slice(0, 4).join('-').toLowerCase()
    .replace(/[^a-z0-9а-яё-]/gi, '').slice(0, 30);
  const name = `auto-${words}-${Date.now().toString(36)}`;

  return {
    name,
    category: 'auto-generated',
    desc: `Auto-skill from: ${taskText.slice(0, 60)}`,
    role,
    actionSequence,
    prompt: `Execute this task pattern: ${taskText.slice(0, 200)}
Based on proven sequence: ${actionSequence}
Apply the same approach to the current context.`,
    generatedAt: new Date().toISOString(),
    successRate: 1.0,
    usageCount: 0,
  };
}


// === ENHANCED BACKGROUND TASKS ===

/**
 * Расширенная фоновая задача с уведомлениями и цепочками
 */
class EnhancedBackgroundTask {
  constructor(chatId, taskInfo) {
    this.chatId = chatId;
    this.taskInfo = taskInfo;
    this.subtasks = [];
    this.onComplete = null;
    this.onProgress = null;
    this.chain = null;
  }

  /**
   * Добавить подзадачу для параллельного выполнения
   */
  addSubtask(role, task, priority = 'medium') {
    this.subtasks.push({ role, task, priority, status: 'pending' });
    return this;
  }

  /**
   * Создать цепочку: текущая задача -> следующая
   */
  chainWith(nextTask) {
    if (!this.chain) this.chain = new TaskChain(this.chatId, 'Background chain');
    this.chain.then(nextTask);
    return this;
  }

  /**
   * Получить краткий статус
   */
  getStatusLine() {
    const info = this.taskInfo;
    const elapsed = Math.round((Date.now() - info.startTime) / 1000);
    const fmtTime = (s) => s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
    const acts = info.completedActions?.length || 0;
    const subs = this.subtasks.length;
    const subsDone = this.subtasks.filter(s => s.status === 'done').length;

    let line = `${info.phase || 'Running'} | ${fmtTime(elapsed)} | ${acts} actions`;
    if (subs > 0) line += ` | subtasks: ${subsDone}/${subs}`;
    return line;
  }
}


// === PROGRESS AGGREGATOR ===

/**
 * Агрегатор прогресса для параллельных задач
 * Собирает прогресс от нескольких субагентов в единый статус
 */
class ProgressAggregator {
  constructor(totalTasks) {
    this.totalTasks = totalTasks;
    this.taskProgress = new Map(); // taskId -> { pct, phase, role }
    this.startTime = Date.now();
  }

  update(taskId, progress) {
    this.taskProgress.set(taskId, { ...progress, updatedAt: Date.now() });
  }

  getOverallProgress() {
    const tasks = [...this.taskProgress.values()];
    if (tasks.length === 0) return { pct: 0, phases: [], elapsed: 0 };

    const totalPct = tasks.reduce((sum, t) => sum + (t.pct || 0), 0);
    const avgPct = Math.round(totalPct / this.totalTasks);
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);

    const phases = tasks
      .filter(t => t.phase)
      .map(t => `${t.role || '?'}: ${t.phase}`);

    return { pct: avgPct, phases, elapsed, done: tasks.filter(t => t.pct >= 100).length, total: this.totalTasks };
  }

  buildStatusLine() {
    const { pct, done, total, elapsed } = this.getOverallProgress();
    const filled = Math.round(pct / 5);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled);
    const fmtTime = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
    return `[${bar}] ${pct}% | ${done}/${total} done | ${fmtTime}`;
  }
}


// === EXPORTS ===
module.exports = {
  ConcurrencyPool,
  TaskChain,
  EnhancedBackgroundTask,
  ProgressAggregator,

  // Domain detection
  BUSINESS_DOMAINS,
  detectDomain,
  detectRolesForTask,

  // Auto-delegation
  autoDelegate,
  decomposeTask,
  executeParallelSubtasks,

  // Skill generation
  shouldGenerateSkill,
  generateSkillDefinition,
};
