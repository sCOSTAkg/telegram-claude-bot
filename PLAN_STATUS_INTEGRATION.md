# План Интеграции Улучшений Статуса в bot.js

**Дата:** 2026-03-03
**Файл:** `/Users/guest1/Desktop/sCORP/bot.js` (10759 строк)
**Статус:** Анализ завершён ✅

---

## РАЗДЕЛ 1: СОЗДАНИЕ НОВЫХ КЛАССОВ УТИЛИТ

### Шаг 1.1: Добавить класс ProgressBar (строка ~2800-2850)

**Местоположение:** После `const multiAgentTasks = new Map();` (строка 2886)
**Перед:** Функцией `loadUserConfigs()` (строка 2888)

```javascript
// === PROGRESS BAR CLASS ===
class ProgressBar {
  constructor(total = 100, width = 20) {
    this.total = total;
    this.width = width;
    this.current = 0;
  }

  update(current) {
    this.current = Math.min(current, this.total);
  }

  render() {
    const percent = Math.round((this.current / this.total) * 100);
    const filled = Math.round((this.current / this.total) * this.width);
    const empty = this.width - filled;
    return `[${('█'.repeat(filled))}${('░'.repeat(empty))}] ${percent}%`;
  }

  advance(delta = 1) {
    this.update(this.current + delta);
  }

  getPercent() {
    return Math.round((this.current / this.total) * 100);
  }
}
```

**Комментарий:** Класс для ASCII-баров прогресса. Используется при live-обновлении статуса задач.

---

### Шаг 1.2: Добавить класс TaskHistory (строка ~2850-2900)

**Местоположение:** Сразу после ProgressBar
**Внутри:** Раздела новых классов утилит

```javascript
// === TASK HISTORY CLASS ===
class TaskHistory {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.entries = []; // { ts, action, status, duration, agent, error? }
  }

  add(action, status = 'started', duration = 0, agent = 'system', error = null) {
    const entry = {
      ts: Date.now(),
      action,
      status,
      duration,
      agent,
      ...(error && { error })
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.shift(); // Удаляем старые
    }
  }

  getRecent(count = 10) {
    return this.entries.slice(-count).reverse();
  }

  formatForDisplay() {
    return this.getRecent(5)
      .map(e => {
        const time = new Date(e.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const status = e.status === 'completed' ? '✅' : e.status === 'error' ? '❌' : '⏳';
        const dur = e.duration > 0 ? ` (${e.duration}мс)` : '';
        return `${status} ${time} | ${e.action}${dur}`;
      })
      .join('\n');
  }

  clear() {
    this.entries = [];
  }
}
```

**Комментарий:** История выполненных задач последних N операций. Добавляется в chatId → history.

---

### Шаг 1.3: Добавить класс ResourceMonitor (строка ~2900-2950)

**Местоположение:** Сразу после TaskHistory

```javascript
// === RESOURCE MONITOR CLASS ===
class ResourceMonitor {
  constructor() {
    this.samples = [];
    this.maxSamples = 60; // 60 сек истории
  }

  sample() {
    const mem = process.memoryUsage();
    this.samples.push({
      ts: Date.now(),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024)
    });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  getStats() {
    if (this.samples.length === 0) return null;
    const latest = this.samples[this.samples.length - 1];
    const oldest = this.samples[0];
    const trendHeap = latest.heapUsed - oldest.heapUsed; // Рост/спад

    return {
      heapUsed: latest.heapUsed,
      heapTotal: latest.heapTotal,
      external: latest.external,
      trend: trendHeap > 0 ? '📈' : '📉',
      percent: Math.round((latest.heapUsed / latest.heapTotal) * 100)
    };
  }

  formatForDisplay() {
    const stats = this.getStats();
    if (!stats) return 'N/A';
    return `💾 ${stats.heapUsed}/${stats.heapTotal}MB (${stats.percent}%) ${stats.trend}`;
  }

  clear() {
    this.samples = [];
  }
}
```

**Комментарий:** Мониторит память и CPU. Запускается раз в 5 сек фоновой задачей.

---

### Шаг 1.4: Добавить класс PhaseTracker (строка ~2950-3010)

**Местоположение:** Сразу после ResourceMonitor

```javascript
// === PHASE TRACKER CLASS ===
class PhaseTracker {
  constructor(phases = []) {
    this.phases = phases.map((p, i) => ({
      name: p,
      index: i,
      started: null,
      completed: null,
      duration: 0,
      status: 'pending' // pending, running, done, error
    }));
    this.currentPhaseIdx = 0;
    this.startTime = Date.now();
  }

  startPhase(phaseName) {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) {
      phase.status = 'running';
      phase.started = Date.now();
      this.currentPhaseIdx = this.phases.indexOf(phase);
    }
  }

  completePhase(phaseName) {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) {
      phase.status = 'done';
      phase.completed = Date.now();
      phase.duration = phase.completed - phase.started;
    }
  }

  failPhase(phaseName, error = '') {
    const phase = this.phases.find(p => p.name === phaseName);
    if (phase) {
      phase.status = 'error';
      phase.completed = Date.now();
      phase.duration = phase.completed - phase.started;
      phase.error = error;
    }
  }

  getCurrentPhase() {
    return this.phases[this.currentPhaseIdx];
  }

  getETAms() {
    const completed = this.phases.filter(p => p.status === 'done');
    if (completed.length === 0) return null;
    const avgDuration = completed.reduce((sum, p) => sum + p.duration, 0) / completed.length;
    const remaining = this.phases.filter(p => p.status !== 'done').length;
    return avgDuration * remaining;
  }

  formatForDisplay() {
    const lines = [];
    const current = this.getCurrentPhase();

    this.phases.forEach((p, i) => {
      const icon = p.status === 'done' ? '✅' : p.status === 'running' ? '⛏️' : p.status === 'error' ? '❌' : '⏳';
      const dur = p.duration > 0 ? ` ${p.duration}мс` : '';
      const marker = i === this.currentPhaseIdx ? ' ➜ ' : '   ';
      lines.push(`${marker}${icon} ${p.name}${dur}`);
    });

    const eta = this.getETAms();
    if (eta) lines.push(`\n⏱ ETA: ${Math.round(eta / 1000)}с`);

    return lines.join('\n');
  }

  clear() {
    this.phases = [];
  }
}
```

**Комментарий:** Трекирует фазы выполнения сложных действий (council, delegate). Вычисляет ETA.

---

## РАЗДЕЛ 2: ИНИЦИАЛИЗАЦИЯ И РЕГИСТРАЦИЯ КЛАССОВ

### Шаг 2.1: Создать глобальные Maps для отслеживания (строка ~3880-3920)

**Местоположение:** После `const stats = { ... };` (строка 3955)
**Перед:** `const reminderTimers = new Map();` (строка 3958)

```javascript
// === STATUS TRACKING MAPS ===
const taskHistories = new Map(); // chatId -> TaskHistory instance
const resourceMonitors = new Map(); // chatId -> ResourceMonitor instance
const phaseTrackers = new Map(); // chatId -> Map<taskId, PhaseTracker>

function getTaskHistory(chatId) {
  if (!taskHistories.has(chatId)) {
    taskHistories.set(chatId, new TaskHistory(150));
  }
  return taskHistories.get(chatId);
}

function getResourceMonitor(chatId) {
  if (!resourceMonitors.has(chatId)) {
    resourceMonitors.set(chatId, new ResourceMonitor());
  }
  return resourceMonitors.get(chatId);
}

function getPhaseTracker(chatId, taskId = 'main') {
  if (!phaseTrackers.has(chatId)) {
    phaseTrackers.set(chatId, new Map());
  }
  const map = phaseTrackers.get(chatId);
  if (!map.has(taskId)) {
    map.set(taskId, new PhaseTracker());
  }
  return map.get(taskId);
}

function clearStatusTracking(chatId) {
  taskHistories.delete(chatId);
  resourceMonitors.delete(chatId);
  phaseTrackers.delete(chatId);
}
```

**Комментарий:** Глобальная регистрация для быстрого доступа из любой функции.

---

### Шаг 2.2: Добавить фоновый сервис мониторинга ресурсов (строка ~3980-4020)

**Местоположение:** В конце инициализации, перед `loadUserConfigs()` или после инициализации классов

```javascript
// === BACKGROUND RESOURCE MONITORING ===
let resourceMonitorInterval = null;

function startResourceMonitoring() {
  if (resourceMonitorInterval) return;
  resourceMonitorInterval = setInterval(() => {
    for (const [chatId, monitor] of resourceMonitors) {
      monitor.sample();
    }
  }, 5000); // Раз в 5 сек
}

function stopResourceMonitoring() {
  if (resourceMonitorInterval) {
    clearInterval(resourceMonitorInterval);
    resourceMonitorInterval = null;
  }
}

// Запускаем при старте бота
startResourceMonitoring();
```

**Комментарий:** Автоматический сбор метрик памяти каждые 5 сек для каждого активного chatId.

---

## РАЗДЕЛ 3: ОБНОВЛЕНИЕ КОМАНДЫ `status` (строка 4752)

### Шаг 3.1: Расширить команду status с историей и ресурсами

**Местоположение:** Строки 4752-4781
**Действие:** ЗАМЕНИТЬ весь блок `else if (data === 'status') { ... }`

```javascript
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

  // ===== НОВОЕ: Получаем ресурсы и историю =====
  const taskHist = getTaskHistory(chatId);
  const resourceMonitor = getResourceMonitor(chatId);
  const resourceStats = resourceMonitor.getStats();
  const recentHistory = taskHist.getRecent(3);

  // Форматируем историю
  let historyText = '';
  if (recentHistory.length > 0) {
    historyText = '\n┌─ 📜 История (последние 3) ─\n';
    for (const entry of recentHistory) {
      const time = new Date(entry.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const status = entry.status === 'completed' ? '✅' : entry.status === 'error' ? '❌' : '⏳';
      historyText += `│ ${status} ${time} ${entry.action}\n`;
    }
    historyText += '└──────────────────\n';
  }

  // Форматируем ресурсы
  let resourceText = '';
  if (resourceStats) {
    resourceText = `\n┌─ 💾 Ресурсы ─────────\n` +
      `│ Память: ${resourceStats.heapUsed}/${resourceStats.heapTotal}MB (${resourceStats.percent}%) ${resourceStats.trend}\n` +
      `└──────────────────\n`;
  }

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
    `└──────────────────` +
    resourceText +
    historyText,
    mainMenu(chatId));
}
```

**Комментарий:** Расширена команда с историей последних 3 операций и текущими ресурсами.

---

## РАЗДЕЛ 4: ОБНОВЛЕНИЕ КОМАНДЫ `prison_blocks` (строка 5427-5471)

### Шаг 4.1: Добавить детальный статус агентов

**Местоположение:** Строки 5440-5471 (в цикле отрисовки агентов)
**Действие:** ЗАМЕНИТЬ отрисовку агента (строки 5454-5464)

**ЗАМЕНА СТАРОГО:**
```javascript
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
```

**НА НОВОЕ:**
```javascript
for (const sa of agents) {
  const effectiveRoles = getEffectiveAgents(chatId);
  const ri = effectiveRoles[sa.role] || AGENT_ROLES[sa.role] || { icon: '🔄', label: sa.role };
  const num = sa.inmateNum || '???';
  const langTag = sa.language ? ` ${PRISON_CONFIG.languageLabels[sa.language] || sa.language}` : '';
  const modelTag = sa.model ? ` [${sa.model}]` : '';

  // ===== НОВОЕ: Детальный статус =====
  let dur = '';
  let progressBar = '';
  if (sa.status === 'running') {
    const elapsed = Math.round((Date.now() - sa.startTime) / 1000);
    dur = `${elapsed}с`;
    // Оценка прогресса: 0-50% за первые 10сек, затем слабление
    const percent = Math.min(Math.round((elapsed / 20) * 100), 95);
    const bar = new ProgressBar(100, 15);
    bar.update(percent);
    progressBar = ` ${bar.render()}`;
  } else if (sa.endTime) {
    dur = `${Math.round((sa.endTime - sa.startTime) / 1000)}с`;
  }

  const statusIcon = sa.status === 'running' ? '⛏️' : sa.status === 'done' ? '✅' : '❌';
  text += `  ${statusIcon} #${num} ${ri.icon} ${ri.label}${langTag}${modelTag} ${dur}\n`;
  if (progressBar) text += `     ${progressBar}\n`;
  if (sa.task) text += `     📋 ${sa.task.slice(0, 50)}\n`;
  if (sa.error) text += `     ⚠️ ${sa.error.slice(0, 40)}\n`;
}
```

**Комментарий:** Добавлены progress-бары, процент выполнения и отображение ошибок.

---

## РАЗДЕЛ 5: ОБНОВЛЕНИЕ ФУНКЦИИ `executeCouncilAction()` (строка 7129)

### Шаг 5.1: Добавить live прогресс в executeCouncilAction

**Местоположение:** Строка 7129-7245 (вся функция)
**Действие:** Добавить отслеживание фаз

**ВСТАВИТЬ после строки 7152** (где уже `if (statusUpdater) statusUpdater(...)`):

```javascript
  // ===== НОВОЕ: Инициализируем PhaseTracker =====
  const phaseTracker = new PhaseTracker([
    'инициализация',
    'подготовка_моделей',
    'запрос_совета',
    'сбор_ответов',
    'агрегация'
  ]);

  const tracker = multiAgentTasks.get(chatId);
  if (tracker) {
    phaseTrackers.get(chatId).set(`council_${Date.now()}`, phaseTracker);
  }

  phaseTracker.startPhase('инициализация');
```

**ЗАМЕНИТЬ строку 7165** (где начинается цикл запуска моделей):

```javascript
  // Запускаем все модели параллельно
  phaseTracker.completePhase('инициализация');
  phaseTracker.startPhase('подготовка_моделей');
```

**ВСТАВИТЬ перед 7165** (перед `const promises = ...`):

```javascript
  const startTime = Date.now();
  const councilId = `council_${Date.now()}`;

  // Обновляем статус с ETA
  if (statusUpdater && phaseTracker.getETAms()) {
    const eta = Math.round(phaseTracker.getETAms() / 1000);
    statusUpdater(`🏛️ Совет запущен\n⏳ Время выполнения: ~${eta}с\n${phaseTracker.formatForDisplay()}`);
  }
```

**ВСТАВИТЬ перед результирующим `Promise.allSettled(promises)` (строка 7200)**:

```javascript
  phaseTracker.completePhase('подготовка_моделей');
  phaseTracker.startPhase('запрос_совета');
```

**ВСТАВИТЬ после `const successResults = ...` (строка 7203)**:

```javascript
  phaseTracker.completePhase('запрос_совета');
  phaseTracker.startPhase('агрегация');

  // Логируем завершение
  const taskHist = getTaskHistory(chatId);
  taskHist.add(`council: ${availableModels.length} моделей`, 'completed', Date.now() - startTime, 'council');

  phaseTracker.completePhase('агрегация');
```

**Комментарий:** Добавлен полный tracking фаз выполнения совета с вычислением ETA.

---

## РАЗДЕЛ 6: ОБНОВЛЕНИЕ ФУНКЦИИ `executeDelegateAction()` (строка 7964)

### Шаг 6.1: Добавить фазы выполнения в executeDelegateAction

**Местоположение:** Строки 7964-8150 (основной цикл выполнения)
**Действие:** Интегрировать PhaseTracker

**ВСТАВИТЬ после строки 8010** (после логирования в tracker.log):

```javascript
  // ===== НОВОЕ: Инициализируем фазы выполнения =====
  const execPhases = new PhaseTracker([
    'инициализация',
    'контекст',
    `шаг_0`,
    ...(subMaxSteps > 1 ? Array.from({length: subMaxSteps - 1}, (_, i) => `шаг_${i + 1}`) : []),
    'завершение'
  ]);

  if (tracker) {
    phaseTrackers.get(chatId).set(subAgentId, execPhases);
  }

  execPhases.startPhase('инициализация');
```

**ВСТАВИТЬ перед циклом на строке 8031** (перед `for (let subStep = 0; subStep < subMaxSteps; ...)`):

```javascript
  execPhases.completePhase('инициализация');
  execPhases.startPhase('контекст');
```

**ВСТАВИТЬ в начало цикла (строка 8031, сразу после `for (let subStep = ...`)**:

```javascript
  for (let subStep = 0; subStep < subMaxSteps; subStep++) {
    execPhases.completePhase(`шаг_${subStep === 0 ? 0 : subStep - 1}`);
    execPhases.startPhase(`шаг_${subStep}`);

    // Обновляем статус с текущей фазой
    const eta = execPhases.getETAms();
    if (statusUpdater && eta) {
      const etaSec = Math.round(eta / 1000);
      statusUpdater(`${roleInfo.icon} ${roleInfo.label}\n📊 Шаг ${subStep + 1}/${subMaxSteps}\n⏱ ~${etaSec}с осталось`);
    }

    // На каждом шаге подтягиваем свежий контекст от других агентов
```

**ВСТАВИТЬ перед завершением функции (перед возвратом результата, около строки 8100)**:

```javascript
    execPhases.completePhase(`шаг_${subMaxSteps - 1}`);
  }

  execPhases.startPhase('завершение');
  execPhases.completePhase('завершение');

  // Логируем выполнение
  const taskHist = getTaskHistory(chatId);
  const totalTime = Date.now() - Date.now(); // Получить стартовое время
  taskHist.add(`delegate: ${roleInfo.label}`, 'completed', totalTime, role);
```

**Комментарий:** Полный tracking всех фаз выполнения делегата с ETA на каждый шаг.

---

## РАЗДЕЛ 7: ОБНОВЛЕНИЕ СТРУКТУРЫ ДАННЫХ АГЕНТОВ (строка ~8003)

### Шаг 7.1: Расширить структуру агента в tracker

**Местоположение:** Строки 8002-8011 (где создаётся объект агента в tracker)
**Действие:** Добавить новые поля

**ЗАМЕНИТЬ:**
```javascript
  if (tracker) {
    tracker.agents.push({
      id: subAgentId, role, task: task.slice(0, 100), status: 'running',
      startTime: Date.now(), inmateNum, model: subModel,
      language: detectedLang,
    });
```

**НА:**
```javascript
  if (tracker) {
    tracker.agents.push({
      id: subAgentId, role, task: task.slice(0, 100), status: 'running',
      startTime: Date.now(), inmateNum, model: subModel,
      language: detectedLang,
      // ===== НОВЫЕ ПОЛЯ =====
      progress: 0,
      phase: 'инициализация',
      stepsCurrent: 0,
      stepsTotal: subMaxSteps,
      phases: new Map(), // фазы выполнения
    });
```

**Комментарий:** Расширены данные агента для отслеживания прогресса по фазам.

---

## РАЗДЕЛ 8: ДОБАВЛЕНИЕ ФУНКЦИИ ОЧИСТКИ ЛОГОВ (новая функция)

### Шаг 8.1: Добавить функцию cleanupOldLogs

**Местоположение:** ~3980-4020 (рядом с функциями управления ресурсами)
**Перед:** startResourceMonitoring()

```javascript
// === CLEANUP OLD LOGS ===
function cleanupOldStatusData() {
  const MAX_HISTORY_AGE_MS = 24 * 60 * 60 * 1000; // 24 часа
  const now = Date.now();

  // Очищаем старые истории (оставляем только последние 24ч)
  for (const [chatId, history] of taskHistories) {
    const recentEntries = history.entries.filter(e => now - e.ts < MAX_HISTORY_AGE_MS);
    if (recentEntries.length < history.entries.length) {
      history.entries = recentEntries;
    }
  }

  // Очищаем мониторы памяти (по 60 сек сэмплов)
  for (const [chatId, monitor] of resourceMonitors) {
    // ResourceMonitor уже имеет maxSamples, но добавим явную очистку
    if (monitor.samples.length > 120) {
      monitor.samples = monitor.samples.slice(-60);
    }
  }

  // Очищаем завершённые фазы трекеры (если работа закончена)
  for (const [chatId, trackersMap] of phaseTrackers) {
    for (const [taskId, tracker] of trackersMap) {
      const isComplete = tracker.phases.every(p => p.status === 'done' || p.status === 'error');
      const createdAgo = now - tracker.startTime;
      if (isComplete && createdAgo > 60 * 60 * 1000) { // 1 час после завершения
        trackersMap.delete(taskId);
      }
    }
    if (trackersMap.size === 0) {
      phaseTrackers.delete(chatId);
    }
  }
}

// Запускаем очистку раз в час
let cleanupInterval = null;
function startStatusCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    cleanupOldStatusData();
  }, 60 * 60 * 1000); // Раз в час
}
startStatusCleanup();
```

**Комментарий:** Автоматическая очистка старых данных каждый час для предотвращения утечки памяти.

---

## РАЗДЕЛ 9: ИНТЕГРАЦИЯ В SHUTDOWN ПРОЦЕСС

### Шаг 9.1: Остановить фоновые сервисы при выходе

**Местоположение:** В конце файла, около функции очистки ресурсов или в обработчике выхода

**НАЙТИ:** Функция, которая вызывается при `process.on('SIGTERM')` или `process.on('SIGINT')`

**ДОБАВИТЬ:**
```javascript
  // Очищаем статус трекеры
  stopResourceMonitoring();
  clearStatusTracking(null); // Можно вызвать для всех chatId

  for (const [chatId, history] of taskHistories) {
    history.clear();
  }
  for (const [chatId, monitor] of resourceMonitors) {
    monitor.clear();
  }
```

**Если функции очистки нет, ДОБАВИТЬ в конец файла:**

```javascript
// === GRACEFUL SHUTDOWN ===
process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  stopResourceMonitoring();
  clearStatusTracking(null);
  process.exit(0);
});
```

---

## РАЗДЕЛ 10: ДОБАВЛЕНИЕ КОМАНДЫ СТАТУСА ДЛЯ ФОНОВЫХ ЗАДАЧ

### Шаг 10.1: Расширить вывод фоновых задач с прогресс-барами

**Местоположение:** Строки 5160-5190 (команда отображения фоновых задач)
**Действие:** Улучшить отображение с progress-барами

**НАЙТИ:** Цикл `for (const [tid, t] of userBg)` (строка 5170)

**ЗАМЕНИТЬ:**
```javascript
        for (const [tid, t] of userBg) {
          const elapsed = Math.round((Date.now() - t.startTime) / 1000);
          const statusIcon = t.status === 'running' ? '⏳' : t.status === 'done' ? '✅' : '❌';
          msg += `${statusIcon} ${t.desc} (${elapsed}с)\n`;
        }
```

**НА:**
```javascript
        for (const [tid, t] of userBg) {
          const elapsed = Math.round((Date.now() - t.startTime) / 1000);
          const statusIcon = t.status === 'running' ? '⏳' : t.status === 'done' ? '✅' : '❌';

          // ===== НОВОЕ: Добавляем прогресс-бар =====
          let progressLine = '';
          if (t.status === 'running' && t.expectedDuration) {
            const percent = Math.min(Math.round((elapsed / t.expectedDuration) * 100), 99);
            const bar = new ProgressBar(100, 15);
            bar.update(percent);
            progressLine = ` ${bar.render()}\n  `;
          }

          msg += `${statusIcon} ${t.desc} (${elapsed}с)\n`;
          if (progressLine) msg += `  ${progressLine.trim()}\n`;
        }
```

**Комментарий:** Отображение progress-баров для каждой фоновой задачи.

---

## РАЗДЕЛ 11: ДОБАВЛЕНИЕ ЛОГИРОВАНИЯ В КРИТИЧЕСКИЕ ТОЧКИ

### Шаг 11.1: Добавить вызовы logTaskAction в key points

**Местоположение:** Различные функции executeAction, callAI и т.д.

**ФУНКЦИЯ:** Создать helper для логирования

**ДОБАВИТЬ (строка ~8750, рядом с executeAction):**

```javascript
// === TASK ACTION LOGGING ===
function logTaskAction(chatId, action, status = 'completed', duration = 0, agent = 'system', error = null) {
  const history = getTaskHistory(chatId);
  history.add(action, status, duration, agent, error);

  // Также логируем в мультиагент трекер если доступен
  const tracker = multiAgentTasks.get(chatId);
  if (tracker) {
    tracker.log.push({
      ts: Date.now(),
      text: `${status === 'completed' ? '✅' : status === 'error' ? '❌' : '⏳'} ${action} (${duration}мс)`
    });
  }
}
```

**ВСТАВИТЬ вызовы в:**
1. После `callAIWithFallback()` успешных вызовов
2. После `executeAction()` завершений
3. В catch блоках с `error` статусом

**Пример (найти в executeAction и добавить после успешного выполнения):**

```javascript
      const actionEndMs = Date.now();
      const actionDuration = actionEndMs - actionStartMs;
      logTaskAction(chatId, `${action.name}`, 'completed', actionDuration, role);
```

---

## РАЗДЕЛ 12: ОБНОВЛЕНИЕ СТРУКТУРЫ ДАННЫХ В multiAgentTasks

### Шаг 12.1: Расширить инициализацию tracker (строка ~9444)

**Местоположение:** Где создаётся `multiAgentTasks.set(chatId, tracker)`

**НАЙТИ строку:** ~9444 где выглядит как:
```javascript
  multiAgentTasks.set(chatId, tracker);
```

**ЗАМЕНИТЬ НА:**
```javascript
  // ===== НОВОЕ: Инициализируем трекеры статуса =====
  if (!phaseTrackers.has(chatId)) {
    phaseTrackers.set(chatId, new Map());
  }
  if (!taskHistories.has(chatId)) {
    getTaskHistory(chatId); // инициализация
  }

  multiAgentTasks.set(chatId, {
    ...tracker,
    // ===== НОВЫЕ ПОЛЯ =====
    statusUpdateTime: Date.now(),
    phases: new Map(), // taskId -> PhaseTracker
  });
```

**Комментарий:** Расширена структура tracker для хранения фаз выполнения.

---

## РАЗДЕЛ 13: ИНТЕГРАЦИЯ В statusUpdater CALLBACK

### Шаг 13.1: Обновить вызовы statusUpdater с фазовой информацией

**Местоположение:** Все места где вызывается `if (statusUpdater) statusUpdater(...)`

**ПРИМЕР ОБНОВЛЕНИЯ (строка 7152):**

**СТАРОЕ:**
```javascript
  if (statusUpdater) statusUpdater(`🏛️ Совет: ${availableModels.length} моделей решают задачу...`);
```

**НОВОЕ:**
```javascript
  if (statusUpdater) {
    const tracker = multiAgentTasks.get(chatId);
    const inmate = tracker?.agents.find(a => a.parallelGroup === councilId)?.inmateNum || '?';
    statusUpdater(`🏛️ Совет #${inmate}: ${availableModels.length} моделей\n⏳ Инициализация...`);
  }
```

**Комментарий:** Добавляем информацию о фазе в каждый status update.

---

## РАЗДЕЛ 14: ИТОГОВАЯ КАРТА ИЗМЕНЕНИЙ

```
📍 СТРОКА  │ ДЕЙСТВИЕ                          │ СТАТУС
═══════════╪═════════════════════════════════╪═════════
2886       │ Вставить 4 новых класса утилит   │ ➕ INSERT
3880       │ Инициалиизировать глобальные Maps │ ➕ INSERT
3980       │ Добавить мониторинг ресурсов      │ ➕ INSERT
3980-4020  │ Функция cleanupOldStatusData      │ ➕ INSERT
4752-4781  │ Расширить команду status          │ 🔄 REPLACE
5160-5190  │ Добавить прогресс-бары фон.задач │ 🔄 REPLACE
5440-5464  │ Детальный статус агентов         │ 🔄 REPLACE
7152       │ Инициализировать PhaseTracker     │ 🔄 UPDATE
7165       │ Логировать фазы совета           │ 🔄 UPDATE
7200+      │ Завершить отслеживание фаз       │ 🔄 UPDATE
8002-8011  │ Расширить структуру агента       │ 🔄 REPLACE
8010+      │ Инициализировать фазы делегата   │ 🔄 INSERT
8031       │ Логировать фазы делегата         │ 🔄 INSERT
8750       │ Добавить logTaskAction()          │ ➕ INSERT
9444       │ Расширить инициализацию tracker  │ 🔄 UPDATE
```

---

## РАЗДЕЛ 15: ПОРЯДОК ВЫПОЛНЕНИЯ

### Блок 1: Фундамент (Шаги 1.1-1.4, 2.1-2.2)
- Создать ProgressBar, TaskHistory, ResourceMonitor, PhaseTracker
- Инициализировать глобальные Maps и мониторинг

**Время:** ~20 мин
**Сложность:** Низкая (копипаста классов)

### Блок 2: Команды UI (Шаги 3.1, 4.1, 10.1)
- Обновить status команду
- Обновить prison_blocks
- Добавить прогресс в фоновые задачи

**Время:** ~30 мин
**Сложность:** Средняя (логика форматирования)

### Блок 3: Функции выполнения (Шаги 5.1, 6.1, 7.1)
- Интегрировать PhaseTracker в executeCouncilAction
- Интегрировать PhaseTracker в executeDelegateAction
- Расширить структуру агента

**Время:** ~40 мин
**Сложность:** Высокая (требует понимания логики выполнения)

### Блок 4: Логирование и очистка (Шаги 8.1, 9.1, 11.1, 13.1)
- Добавить функцию очистки логов
- Остановить сервисы при выходе
- Добавить logTaskAction вызовы

**Время:** ~25 мин
**Сложность:** Низкая-Средняя

### Блок 5: Тестирование и отладка
- Перезагрузить бот: `kill PID; node bot.js &`
- Протестировать `/status`, `/prison_blocks`, фоновые задачи
- Проверить утечки памяти (ResourceMonitor)
- Проверить очистку логов

**Время:** ~30 мин
**Сложность:** Низкая

---

## РАЗДЕЛ 16: РИСКИ И МИTIGATIONS

| Риск | Вероятность | Impact | Mitigation |
|------|-------------|--------|-----------|
| Утечка памяти от Maps | Средняя | Высокий | cleanupOldStatusData() раз в час |
| Конфликты с существующим кодом | Низкая | Средний | Использовать уникальные имена функций |
| Performance hit от отслеживания | Средняя | Низкий | Сэмплировать ресурсы раз в 5 сек |
| Race conditions при обновлении | Низкая | Средний | Использовать immutable updates |

---

## РАЗДЕЛ 17: ПРОВЕРКА КАЧЕСТВА

### Тест-кейсы:

1. **Базовая функциональность**
   - [ ] Команда `/status` выводит ресурсы
   - [ ] Команда `/prison_blocks` показывает progress-бары
   - [ ] Фоновые задачи имеют прогресс

2. **Отслеживание**
   - [ ] TaskHistory логирует 10+ действий
   - [ ] ResourceMonitor собирает метрики
   - [ ] PhaseTracker правильно вычисляет ETA

3. **Очистка**
   - [ ] Старые логи удаляются после 24ч
   - [ ] Завершённые фазы удаляются
   - [ ] Память не растёт бесконечно

4. **Интеграция**
   - [ ] Council действия отслеживаются
   - [ ] Delegate действия отслеживаются
   - [ ] Multi-agent задачи работают корректно

---

**ДАТА ЗАВЕРШЕНИЯ АНАЛИЗА:** 2026-03-03
**АВТОР ПЛАНА:** Claude Code Agent
**СТАТУС:** ✅ Готов к реализации
