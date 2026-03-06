/**
 * УЛУЧШЕННАЯ СИСТЕМА УПРАВЛЕНИЯ ПРОГРЕССОМ ДЛЯ TELEGRAM БОТА
 *
 * Компоненты:
 * 1. ProgressTracker - отслеживание состояния операций
 * 2. StatusFormatter - унифицированное форматирование статусов
 * 3. BackgroundTasksUI - управление видимостью фоновых задач
 * 4. SpinnerManager - управление спиннерами и обновлениями
 */

// ============================================================================
// 1️⃣ PROGRESS TRACKER - основной класс отслеживания прогресса
// ============================================================================

class ProgressTracker {
  constructor(operationType, operationName, options = {}) {
    this.id = `${operationType}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.type = operationType; // 'voice', 'video', 'notebook', 'ai', 'background', 'prison'
    this.name = operationName;
    this.status = 'init'; // init → processing → done
    this.startTime = Date.now();
    this.lastUpdateTime = Date.now();
    this.lastSpinnerFrame = 0;

    // Прогресс и стадии
    this.currentStage = options.initialStage || 'инициализация';
    this.stages = options.stages || this.getDefaultStages();
    this.currentStageIndex = 0;
    this.progress = 0; // 0-100
    this.progressSimulation = options.simulateProgress !== false; // по умолчанию включена
    this.progressStep = options.progressStep || 2; // % в сек для симуляции

    // Метаданные
    this.metadata = options.metadata || {};
    this.error = null;
    this.result = null;

    // История для логирования
    this.history = [];
    this._addHistory(`START: ${operationName}`, 'init');
  }

  /**
   * Получить стадии по умолчанию в зависимости от типа операции
   */
  getDefaultStages() {
    const stageMap = {
      voice: ['инициализация', 'распознавание', 'завершение'],
      video: ['инициализация', 'рендеринг', 'кодирование', 'загрузка', 'завершение'],
      notebook: ['инициализация', 'обработка', 'завершение'],
      ai: ['инициализация', 'обработка', 'завершение'],
      background: ['инициализация', 'обработка', 'завершение'],
      prison: ['инициализация', 'планирование', 'выполнение', 'проверка', 'завершение'],
    };
    return stageMap[this.type] || ['инициализация', 'обработка', 'завершение'];
  }

  /**
   * Обновить текущий статус и стадию
   */
  updateStage(stageName, progress = null) {
    if (!this.stages.includes(stageName)) {
      console.warn(`⚠️ Неизвестная стадия: ${stageName}`);
      return;
    }
    this.currentStage = stageName;
    this.currentStageIndex = this.stages.indexOf(stageName);
    this.status = stageName === 'завершение' ? 'done' : 'processing';

    if (progress !== null) {
      this.progress = Math.min(100, Math.max(0, progress));
    } else {
      // Автоматический расчёт прогресса по стадиям
      this.progress = Math.round((this.currentStageIndex / Math.max(1, this.stages.length - 1)) * 100);
    }

    this._addHistory(`STAGE: ${stageName}`, this.status);
    this.lastUpdateTime = Date.now();
  }

  /**
   * Установить произвольный прогресс (0-100)
   */
  setProgress(value) {
    this.progress = Math.min(100, Math.max(0, value));
    this.lastUpdateTime = Date.now();
    if (this.status === 'init') this.status = 'processing';
  }

  /**
   * Пометить как завершённую
   */
  complete(result = null) {
    this.status = 'done';
    this.progress = 100;
    this.result = result;
    this.currentStage = 'завершение';
    this._addHistory(`COMPLETE: ${this.name}`, 'done');
  }

  /**
   * Пометить как ошибка
   */
  error(errorMsg) {
    this.status = 'error';
    this.error = errorMsg;
    this._addHistory(`ERROR: ${errorMsg}`, 'error');
  }

  /**
   * Обновить метаданные
   */
  updateMetadata(data) {
    this.metadata = { ...this.metadata, ...data };
    this.lastUpdateTime = Date.now();
  }

  /**
   * Получить затраченное время в мс
   */
  getElapsedMs() {
    return Date.now() - this.startTime;
  }

  /**
   * Получить затраченное время в секундах с форматированием
   */
  getElapsedFormatted() {
    const ms = this.getElapsedMs();
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const secs = sec % 60;

    if (min > 0) {
      return `${min}м${secs}с`;
    }
    return `${sec}с`;
  }

  /**
   * Получить текущий спиннер (обновляется каждые 500мс)
   */
  getSpinner() {
    const spinners = ['⏳', '◐', '◓', '◑', '◒'];
    const elapsed = this.getElapsedMs();
    const frameIndex = Math.floor(elapsed / 500) % spinners.length;
    return spinners[frameIndex];
  }

  /**
   * Нужно ли обновлять сообщение (throttle 500мс)
   */
  shouldUpdate() {
    const now = Date.now();
    if (now - this.lastUpdateTime >= 500) {
      this.lastUpdateTime = now;
      return true;
    }
    return false;
  }

  /**
   * Добавить в историю
   */
  _addHistory(event, status) {
    this.history.push({
      timestamp: Date.now(),
      elapsed: this.getElapsedMs(),
      event,
      status,
    });
    // Ограничить размер истории (последние 50 событий)
    if (this.history.length > 50) {
      this.history.shift();
    }
  }

  /**
   * Получить полную информацию
   */
  getInfo() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      status: this.status,
      currentStage: this.currentStage,
      progress: this.progress,
      elapsed: this.getElapsedFormatted(),
      elapsedMs: this.getElapsedMs(),
      metadata: this.metadata,
      error: this.error,
      result: this.result,
      history: this.history,
    };
  }

  /**
   * Логирование в консоль
   */
  log() {
    console.log(`[${this.type.toUpperCase()}] ${this.name}`);
    console.log(`  Status: ${this.status} | Stage: ${this.currentStage}`);
    console.log(`  Progress: ${this.progress}% | Elapsed: ${this.getElapsedFormatted()}`);
    if (this.error) console.log(`  Error: ${this.error}`);
    if (Object.keys(this.metadata).length > 0) {
      console.log(`  Metadata:`, this.metadata);
    }
  }
}

// ============================================================================
// 2️⃣ STATUS FORMATTER - унифицированное форматирование статусов
// ============================================================================

class StatusFormatter {
  // Иконки для типов операций
  static ICONS = {
    voice: '🎙',
    video: '🎬',
    notebook: '📓',
    ai: '🤖',
    background: '📌',
    prison: '⛓️',
  };

  // Иконки для статусов
  static STATUS_ICONS = {
    init: '⏳',
    processing: '🔄',
    done: '✅',
    error: '❌',
  };

  /**
   * Форматировать кратко (для quick updates в чатах)
   *
   * Формат: 🎙 Операция | ⏳ Статус | ⏱ Время
   */
  static formatQuick(tracker) {
    if (!tracker) return '';

    const icon = this.ICONS[tracker.type] || '📊';
    const spinner = tracker.getSpinner();
    const elapsed = tracker.getElapsedFormatted();

    let text = `${icon} ${tracker.name}`;

    // Добавить статус в зависимости от стадии
    if (tracker.status === 'done') {
      text += ` | ✅ ${tracker.currentStage}`;
    } else if (tracker.status === 'error') {
      text += ` | ❌ ${tracker.error}`;
    } else {
      text += ` | ${spinner} ${tracker.currentStage}`;
    }

    // Показывать время только если прошло > 3 сек
    if (tracker.getElapsedMs() > 3000) {
      text += ` | ⏱ ${elapsed}`;
    }

    return text;
  }

  /**
   * Форматировать средний формат (для нормальных операций)
   *
   * 🎙 Распознаю голосовое... ⏳ 6с
   * 🎙 Распознаю голосовое... ⏳ 9с
   * ✅ «Привет, мир»
   */
  static formatMedium(tracker, additionalInfo = '') {
    if (!tracker) return '';

    const icon = this.ICONS[tracker.type] || '📊';
    const spinner = tracker.getSpinner();
    const elapsed = tracker.getElapsedFormatted();

    let text = `${icon} ${tracker.currentStage}`;

    if (tracker.status === 'done') {
      text = `✅ ${tracker.result || 'Готово'}`;
      if (additionalInfo) text += ` | ${additionalInfo}`;
    } else if (tracker.status === 'error') {
      text = `❌ ${tracker.error}`;
    } else {
      text += `... ${spinner} ${elapsed}`;
    }

    return text;
  }

  /**
   * Форматировать полный формат с метаданными
   *
   * 🎬 Генерация видео: рендеринг ⏳ 15с
   * ├─ 📊 Прогресс: [████████░░░░░░░░░░] 42%
   * ├─ 📈 Разрешение: 1920x1080
   * └─ 💾 FPS: 30
   */
  static formatFull(tracker) {
    if (!tracker) return '';

    const icon = this.ICONS[tracker.type] || '📊';
    const spinner = tracker.getSpinner();
    const elapsed = tracker.getElapsedFormatted();

    let lines = [];

    // Основная строка
    if (tracker.status === 'done') {
      lines.push(`✅ ${tracker.name} | ${elapsed}`);
    } else if (tracker.status === 'error') {
      lines.push(`❌ ${tracker.name} | ${tracker.error}`);
    } else {
      lines.push(`${icon} ${tracker.name}: ${tracker.currentStage} ${spinner} ${elapsed}`);
    }

    // Прогресс бар
    if (tracker.status !== 'error') {
      const barLen = 20;
      const filledLen = Math.round((tracker.progress / 100) * barLen);
      const bar = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);
      lines.push(`├─ 📊 Прогресс: [${bar}] ${tracker.progress}%`);
    }

    // Метаданные
    const metaEntries = Object.entries(tracker.metadata);
    if (metaEntries.length > 0) {
      metaEntries.forEach(([key, value], idx) => {
        const isLast = idx === metaEntries.length - 1;
        const prefix = isLast ? '└─' : '├─';
        lines.push(`${prefix} 📈 ${key}: ${value}`);
      });
    }

    return lines.join('\n');
  }

  /**
   * Форматировать для видео-генерации с этапами
   *
   * 🎬 Генерация видео: инициализация ⏳ 5с
   * 🎬 Генерация видео: rendering ⏳ 15с
   * 🎬 Генерация видео: encoding ⏳ 28с
   * ✅ Видео готово | 45с
   */
  static formatVideoGeneration(tracker) {
    const icon = this.ICONS.video || '🎬';
    const spinner = tracker.getSpinner();
    const elapsed = tracker.getElapsedFormatted();

    if (tracker.status === 'done') {
      return `✅ Видео готово | ${elapsed}`;
    } else if (tracker.status === 'error') {
      return `❌ Ошибка видео: ${tracker.error}`;
    } else {
      let stageText = tracker.currentStage;
      // Переводы стадий для видео
      const stageNames = {
        'инициализация': 'инициализация',
        'рендеринг': 'rendering',
        'кодирование': 'encoding',
        'загрузка': 'uploading',
      };
      stageText = stageNames[stageText] || stageText;

      return `${icon} Генерация видео: ${stageText} ${spinner} ${elapsed}`;
    }
  }

  /**
   * Форматировать для NotebookLM
   *
   * 🎙 NotebookLM подкаст: инициализация ⏳ 8с
   * 🎙 NotebookLM подкаст: processing (3/20) ⏳ 45с
   * ✅ Подкаст готов | 3м15с | 18 МБ
   */
  static formatNotebookLM(tracker) {
    const icon = '📓';
    const spinner = tracker.getSpinner();
    const elapsed = tracker.getElapsedFormatted();

    if (tracker.status === 'done') {
      let result = `✅ ${tracker.name} готов | ${elapsed}`;
      if (tracker.metadata.fileSize) {
        result += ` | ${tracker.metadata.fileSize}`;
      }
      return result;
    } else if (tracker.status === 'error') {
      return `❌ ${tracker.name}: ${tracker.error}`;
    } else {
      let text = `${icon} ${tracker.name}: ${tracker.currentStage} ${spinner} ${elapsed}`;
      if (tracker.metadata.current && tracker.metadata.total) {
        text += ` (${tracker.metadata.current}/${tracker.metadata.total})`;
      }
      return text;
    }
  }

  /**
   * Форматировать для Prison Orchestration
   *
   * ⛓️ PRISON ORCHESTRATION · ◐ LIVE (обновление каждые 300мс)
   * [██████░░░░░░░░░░░░] 37% | ⏱ 1м23с | Step 3/8
   *
   * 👮 Warden (Claude Opus) | 🟡 medium complexity
   *   └─ ⚡ Analyzing task structure... ⏳ 2.3с
   *
   * ┌─ 🏢 Active Cell Blocks ─┐
   * │ 💻 A-Wing: 1 working, 5 queued
   * │   └─ #1 🔨 Coder ⏳ 2.3с | Creating REST API
   * │ 🔬 B-Wing: 0 working, 2 completed
   * │   └─ ✅ #5 Data Analyst | 0.8с
   * └────────────────────────┘
   */
  static formatPrisonOrchestration(tracker, cellBlocksData = null) {
    const spinner = tracker.getSpinner();
    const elapsed = tracker.getElapsedFormatted();

    let lines = [];

    // Заголовок
    lines.push(`⛓️ PRISON ORCHESTRATION · ${spinner} LIVE`);

    // Прогресс бар
    const barLen = 20;
    const filledLen = Math.round((tracker.progress / 100) * barLen);
    const bar = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);
    lines.push(`[${bar}] ${tracker.progress}% | ⏱ ${elapsed} | Step ${tracker.metadata.currentStep || '?'}/${tracker.metadata.totalSteps || '?'}`);

    lines.push('');

    // Warden информация
    if (tracker.metadata.warden) {
      const complexityEmoji = {
        'simple': '🟢',
        'medium': '🟡',
        'complex': '🔴',
      }[tracker.metadata.complexity] || '⚪';

      lines.push(`👮 Warden (${tracker.metadata.warden}) | ${complexityEmoji} ${tracker.metadata.complexity}`);

      if (tracker.metadata.currentAction) {
        const actionSpinner = tracker.getSpinner();
        const actionTime = tracker.metadata.actionElapsedSec || '?';
        lines.push(`  └─ ⚡ ${tracker.metadata.currentAction}... ${actionSpinner} ${actionTime}с`);
      }
      lines.push('');
    }

    // Cell Blocks
    if (cellBlocksData) {
      lines.push('┌─ 🏢 Active Cell Blocks ─┐');

      cellBlocksData.forEach((block, idx) => {
        const isLast = idx === cellBlocksData.length - 1;
        const blockPrefix = isLast ? '└' : '│';

        lines.push(`${blockPrefix} ${block.icon} ${block.name}: ${block.working} working, ${block.queued} queued`);

        if (block.tasks && block.tasks.length > 0) {
          block.tasks.forEach((task, taskIdx) => {
            const taskIsLast = taskIdx === block.tasks.length - 1;
            const taskPrefix = isLast ? '  ' : '│ ';
            const taskIcon = taskIsLast ? '└─' : '├─';

            let taskLine = `${taskPrefix}${taskIcon} #${task.id} ${task.icon} ${task.name}`;

            if (task.status === 'done') {
              taskLine += ` | ${task.elapsed}`;
            } else if (task.status === 'working') {
              taskLine += ` ${task.spinner} ${task.elapsed}`;
              if (task.info) taskLine += ` | ${task.info}`;
            }
            lines.push(taskLine);
          });
        }
      });

      lines.push('└────────────────────────┘');
    }

    // Последние действия
    if (tracker.metadata.lastActions && tracker.metadata.lastActions.length > 0) {
      lines.push('');
      lines.push('📋 Last actions:');
      tracker.metadata.lastActions.slice(-3).forEach(action => {
        const statusIcon = action.status === 'done' ? '✅' : '❌';
        lines.push(`${statusIcon} ${action.name} +${action.time}с`);
      });
    }

    return lines.join('\n');
  }

  /**
   * Получить подходящий форматер в зависимости от типа
   */
  static getFormatter(tracker) {
    if (tracker.type === 'video') return this.formatVideoGeneration;
    if (tracker.type === 'notebook') return this.formatNotebookLM;
    if (tracker.type === 'prison') return this.formatPrisonOrchestration;
    return this.formatMedium;
  }
}

// ============================================================================
// 3️⃣ BACKGROUND TASKS UI - управление видимостью фоновых задач
// ============================================================================

class BackgroundTasksUI {
  constructor() {
    this.tasks = new Map(); // taskId -> taskInfo
    this.chatTasks = new Map(); // chatId -> Set<taskId>
  }

  /**
   * Добавить фоновую задачу
   */
  addTask(taskId, taskInfo) {
    // taskInfo = {
    //   name, icon, chatId, status: 'processing'|'done'|'error',
    //   progress, elapsed, startTime, details?
    // }
    this.tasks.set(taskId, {
      ...taskInfo,
      addedAt: Date.now(),
    });

    if (taskInfo.chatId) {
      if (!this.chatTasks.has(taskInfo.chatId)) {
        this.chatTasks.set(taskInfo.chatId, new Set());
      }
      this.chatTasks.get(taskInfo.chatId).add(taskId);
    }
  }

  /**
   * Обновить прогресс задачи
   */
  updateTask(taskId, updates) {
    if (this.tasks.has(taskId)) {
      const task = this.tasks.get(taskId);
      this.tasks.set(taskId, { ...task, ...updates, modifiedAt: Date.now() });
    }
  }

  /**
   * Завершить и удалить задачу из активных
   */
  completeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'done';
      task.completedAt = Date.now();
      // Удалить из активных через 2 сек
      setTimeout(() => {
        if (task.chatId && this.chatTasks.has(task.chatId)) {
          this.chatTasks.get(task.chatId).delete(taskId);
        }
        this.tasks.delete(taskId);
      }, 2000);
    }
  }

  /**
   * Получить активные задачи для чата
   */
  getActiveTasks(chatId) {
    const taskIds = this.chatTasks.get(chatId) || new Set();
    const activeTasks = [];

    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task && task.status !== 'done') {
        activeTasks.push({ id: taskId, ...task });
      }
    }

    return activeTasks.sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * Форматировать список активных задач
   *
   * 📌 Активные фоновые задачи (3):
   *   1️⃣ 🎬 Видео | ⏱ 1м23с | 67%
   *   2️⃣ 🎙 Подкаст | ⏱ 3м05с | 45%
   *   3️⃣ 💾 Синхронизация | ⏱ 42с | 89%
   */
  formatTasksList(chatId) {
    const tasks = this.getActiveTasks(chatId);

    if (tasks.length === 0) {
      return '✅ Нет активных фоновых задач';
    }

    let lines = [`📌 Активные фоновые задачи (${tasks.length}):`];

    tasks.forEach((task, idx) => {
      const num = idx + 1;
      const icon = task.icon || '📦';
      const elapsed = this._formatElapsed(task.startTime);
      const progress = task.progress ? `${task.progress}%` : '...';

      let line = `  ${this._getNumberEmoji(num)} ${icon} ${task.name}`;

      if (task.status === 'error') {
        line += ` | ❌ ${task.error || 'Ошибка'}`;
      } else {
        line += ` | ⏱ ${elapsed} | ${progress}`;
      }

      if (task.details) {
        line += ` | ${task.details}`;
      }

      lines.push(line);
    });

    return lines.join('\n');
  }

  /**
   * Форматировать компактный вывод для inline кнопок
   */
  formatCompact(chatId) {
    const tasks = this.getActiveTasks(chatId);

    if (tasks.length === 0) {
      return '✅ Все готово!';
    }

    return `📌 ${tasks.length} задач${tasks.length > 1 ? 'и' : 'а'}... /tasks`;
  }

  /**
   * Форматировать время выполнения
   */
  _formatElapsed(startTime) {
    const ms = Date.now() - startTime;
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const secs = sec % 60;

    if (min > 0) {
      return `${min}м${secs}с`;
    }
    return `${sec}с`;
  }

  /**
   * Получить emoji числа
   */
  _getNumberEmoji(num) {
    const emojis = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
    return emojis[Math.min(num, 9)] || `${num}️⃣`;
  }

  /**
   * Очистить задачи старше N минут
   */
  cleanup(maxAgeMinutes = 30) {
    const now = Date.now();
    const maxAge = maxAgeMinutes * 60 * 1000;

    for (const [taskId, task] of this.tasks) {
      if (now - task.addedAt > maxAge) {
        this.tasks.delete(taskId);
        if (task.chatId && this.chatTasks.has(task.chatId)) {
          this.chatTasks.get(task.chatId).delete(taskId);
        }
      }
    }
  }
}

// ============================================================================
// 4️⃣ SPINNER MANAGER - управление спиннерами и throttling обновлений
// ============================================================================

class SpinnerManager {
  constructor(throttleMs = 500) {
    this.throttleMs = throttleMs;
    this.trackers = new Map(); // trackerId -> ProgressTracker
    this.updateCallbacks = new Map(); // chatId -> callback
    this.lastUpdates = new Map(); // trackerId -> lastUpdateTime
    this.updateIntervals = new Map(); // trackerId -> intervalId
  }

  /**
   * Зарегистрировать трекер для обновления
   */
  registerTracker(tracker, updateCallback) {
    this.trackers.set(tracker.id, tracker);

    if (tracker.type === 'prison') {
      // Prison использует более частые обновления (300мс вместо 500мс)
      this.throttleMs = 300;
    }

    // Начать интервал обновления
    const intervalId = setInterval(() => {
      if (tracker.status === 'done') {
        this.unregisterTracker(tracker.id);
      } else if (tracker.shouldUpdate()) {
        updateCallback(tracker);
      }
    }, this.throttleMs);

    this.updateIntervals.set(tracker.id, intervalId);
  }

  /**
   * Отменить регистрацию трекера
   */
  unregisterTracker(trackerId) {
    const intervalId = this.updateIntervals.get(trackerId);
    if (intervalId) {
      clearInterval(intervalId);
      this.updateIntervals.delete(trackerId);
    }
    this.trackers.delete(trackerId);
    this.lastUpdates.delete(trackerId);
  }

  /**
   * Проверить, нужно ли обновлять (с учётом throttle)
   */
  shouldUpdate(trackerId) {
    const now = Date.now();
    const lastUpdate = this.lastUpdates.get(trackerId) || 0;
    return now - lastUpdate >= this.throttleMs;
  }

  /**
   * Пометить как обновлённый
   */
  markUpdated(trackerId) {
    this.lastUpdates.set(trackerId, Date.now());
  }

  /**
   * Очистить все
   */
  cleanup() {
    for (const intervalId of this.updateIntervals.values()) {
      clearInterval(intervalId);
    }
    this.trackers.clear();
    this.updateCallbacks.clear();
    this.lastUpdates.clear();
    this.updateIntervals.clear();
  }

  /**
   * Получить статистику
   */
  getStats() {
    return {
      activeTrackers: this.trackers.size,
      trackers: Array.from(this.trackers.values()).map(t => ({
        id: t.id,
        type: t.type,
        name: t.name,
        status: t.status,
        progress: t.progress,
        elapsed: t.getElapsedFormatted(),
      })),
    };
  }
}

// ============================================================================
// ЭКСПОРТ
// ============================================================================

module.exports = {
  ProgressTracker,
  StatusFormatter,
  BackgroundTasksUI,
  SpinnerManager,
};
