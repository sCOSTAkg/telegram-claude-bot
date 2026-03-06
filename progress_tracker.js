/**
 * PROGRESS TRACKER MODULE
 * ========================
 * Расширенная система отслеживания прогресса с:
 * - ASCII прогресс-барами и процентами
 * - Фазами выполнения
 * - ETA (estimated time to arrival)
 * - Статусом ресурсов (память, CPU, GPU)
 * - История задач с логированием
 * - Batch-обновлениями для снижения нагрузки на editText
 *
 * USAGE:
 *   const tracker = new ProgressTracker();
 *   const taskId = tracker.startTask(chatId, 'Генерация изображения');
 *   tracker.updatePhase(taskId, 'Инициализация GPU');
 *   tracker.incrementProgress(taskId, 10); // +10% прогресса
 *   await tracker.sendStatusUpdate(chatId, msgId, tgApi); // Отправить одно сообщение
 */

const os = require('os');
const { exec } = require('child_process');

// ═════════════════════════════════════════════════════════════════════════════════════
// КЛАСС TRACKER - Основное ядро системы отслеживания
// ═════════════════════════════════════════════════════════════════════════════════════

class ProgressTracker {
  constructor() {
    // Основное хранилище активных задач
    // taskId -> {chatId, type, startTime, currentPhase, progress, maxProgress, ...}
    this.activeTasks = new Map();

    // История последних 50 выполненных задач для лога
    this.taskHistory = [];
    this.MAX_HISTORY = 50;

    // Настройки батчинга обновлений (чтобы не спамить editText)
    this.pendingUpdates = new Map(); // chatId -> {msgId, timer, updateData}
    this.BATCH_DELAY_MS = 800; // Ждём 800ms перед отправкой обновления

    // Для расчёта ресурсов (обновляется каждые 5 сек)
    this.resourceStats = {
      cpuUsage: 0,
      memoryUsage: 0,
      gpuUsage: 'idle',
      lastUpdate: Date.now()
    };
    this.startResourceMonitoring();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ОСНОВНЫЕ МЕТОДЫ УПРАВЛЕНИЯ ЗАДАЧАМИ
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Запустить отслеживание новой задачи
   * @param {number} chatId - ID чата пользователя
   * @param {string} taskName - Название задачи (напр. "Генерация изображения")
   * @param {object} opts - Опции {type, model, provider, estimatedDuration}
   * @returns {string} taskId для управления этой задачей
   */
  startTask(chatId, taskName, opts = {}) {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    this.activeTasks.set(taskId, {
      chatId,
      taskName,
      type: opts.type || 'generic',
      model: opts.model || 'unknown',
      provider: opts.provider || 'N/A',
      startTime: Date.now(),
      currentPhase: opts.initialPhase || 'Инициализация',
      progress: 0,
      maxProgress: opts.maxProgress || 100,
      phases: opts.phases || [],
      phaseIndex: 0,
      estimatedDuration: opts.estimatedDuration || 30000, // в мс
      completed: false,
      error: null,
      notes: [],
      metadata: opts.metadata || {}
    });

    console.log(`[ProgressTracker] Задача "${taskName}" запущена: ${taskId}`);
    return taskId;
  }

  /**
   * Обновить текущую фазу
   * @param {string} taskId
   * @param {string} phase - Текущая фаза (напр. "Обработка GPU")
   * @param {string} detail - Дополнительная информация
   */
  updatePhase(taskId, phase, detail = '') {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    task.currentPhase = phase;
    if (detail) task.notes.push(`[${new Date().toLocaleTimeString()}] ${phase}: ${detail}`);

    // Если есть список фаз, обновляем индекс
    if (task.phases.length > 0) {
      const idx = task.phases.findIndex(p => p.toLowerCase().includes(phase.toLowerCase()));
      if (idx >= 0) task.phaseIndex = idx;
    }
  }

  /**
   * Увеличить прогресс
   * @param {string} taskId
   * @param {number} amount - На сколько процентов увеличить (напр. 10 для +10%)
   */
  incrementProgress(taskId, amount = 1) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    task.progress = Math.min(task.progress + amount, task.maxProgress);
  }

  /**
   * Установить прогресс на точное значение
   * @param {string} taskId
   * @param {number} value - Новое значение (0-100)
   */
  setProgress(taskId, value) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    task.progress = Math.max(0, Math.min(value, task.maxProgress));
  }

  /**
   * Завершить задачу (успешно или с ошибкой)
   * @param {string} taskId
   * @param {boolean} success - Успешно ли завершена
   * @param {string} errorMsg - Текст ошибки (если не успешна)
   * @param {string} result - Результат операции
   */
  completeTask(taskId, success = true, errorMsg = '', result = '') {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    task.completed = true;
    task.progress = success ? task.maxProgress : task.progress;
    task.error = errorMsg;
    task.endTime = Date.now();
    task.result = result;

    // Добавить в историю
    this.taskHistory.unshift({
      taskName: task.taskName,
      type: task.type,
      duration: task.endTime - task.startTime,
      success,
      error: errorMsg.slice(0, 100),
      timestamp: new Date(task.endTime).toLocaleTimeString(),
      model: task.model
    });

    // Убрать излишки истории
    if (this.taskHistory.length > this.MAX_HISTORY) {
      this.taskHistory = this.taskHistory.slice(0, this.MAX_HISTORY);
    }

    console.log(`[ProgressTracker] Задача "${task.taskName}" завершена. Статус: ${success ? '✅' : '❌'}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // МЕТОДЫ ПОСТРОЕНИЯ ВИЗУАЛИЗАЦИИ
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Построить ASCII прогресс-бар
   * @param {number} percent - Процент выполнения (0-100)
   * @param {number} width - Ширина бара в символах (по умолчанию 20)
   * @returns {string} форматированный прогресс-бар
   *
   * ПРИМЕРЫ:
   *   35%  → [███████░░░░░░░░░░░░] 35%
   *   100% → [████████████████████] 100%
   */
  buildProgressBar(percent, width = 20) {
    const filled = Math.round((percent / 100) * width);
    const empty = Math.max(0, width - filled);

    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}] ${percent.toString().padStart(3)}%`;
  }

  /**
   * Построить расширенный прогресс-бар с фазами
   * @param {string} taskId
   * @returns {string} многоцветный бар с фазами
   */
  buildPhaseBar(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task || !task.phases.length) return '';

    const lines = [];
    const totalPhases = task.phases.length;
    const currentPhase = task.phaseIndex;

    // Визуализация фаз: ✓ завершённые, ► текущая, ○ предстоящие
    for (let i = 0; i < totalPhases; i++) {
      if (i < currentPhase) {
        lines.push(`✅ ${task.phases[i]}`);
      } else if (i === currentPhase) {
        lines.push(`▶️  ${task.phases[i]} (в процессе)`);
      } else {
        lines.push(`⭕ ${task.phases[i]}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Вычислить ETA (estimated time to arrival) - оставшееся время
   * @param {string} taskId
   * @returns {object} {remainingMs, remainingStr, etaStr}
   *
   * ПРИМЕРЫ:
   *   {remainingMs: 5000, remainingStr: "5 сек", etaStr: "14:32:45"}
   */
  calculateETA(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) return { remainingMs: 0, remainingStr: '0 сек', etaStr: '?' };

    const elapsed = Date.now() - task.startTime;
    const percent = Math.max(1, task.progress); // избежать деления на 0

    // Прогнозируем по скорости выполнения
    const estimatedTotal = (elapsed / percent) * 100;
    const remainingMs = Math.max(0, estimatedTotal - elapsed);

    const remainingStr = this.formatDuration(remainingMs);

    // Примерное время завершения
    const etaTime = new Date(Date.now() + remainingMs);
    const etaStr = etaTime.toLocaleTimeString('ru-RU');

    return { remainingMs, remainingStr, etaStr };
  }

  /**
   * Получить информацию о состоянии ресурсов
   * @returns {object} {cpuUsage, memoryUsage, gpuUsage, details}
   */
  getResourceStats() {
    return {
      ...this.resourceStats,
      details: `Память: ${Math.round(this.resourceStats.memoryUsage)}% | CPU: ${Math.round(this.resourceStats.cpuUsage)}% | GPU: ${this.resourceStats.gpuUsage}`
    };
  }

  /**
   * Построить строку статуса ресурсов
   * @returns {string}
   */
  buildResourceStatus() {
    const mem = this.resourceStats.memoryUsage;
    const cpu = this.resourceStats.cpuUsage;
    const gpu = this.resourceStats.gpuUsage;

    const memBar = this.buildProgressBar(mem, 10);
    const cpuBar = this.buildProgressBar(cpu, 10);

    return (
      `💾 Память: ${memBar}\n` +
      `⚙️  CPU: ${cpuBar}\n` +
      `🎮 GPU: ${gpu === 'busy' ? '🔴 busy' : '🟢 idle'}`
    );
  }

  /**
   * Построить полный статус одной задачи для отправки пользователю
   * @param {string} taskId
   * @returns {string} отформатированный статус
   */
  buildTaskStatusMessage(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) return '❌ Задача не найдена';

    const lines = [];
    const elapsed = Math.round((Date.now() - task.startTime) / 1000);
    const percent = Math.round((task.progress / task.maxProgress) * 100);
    const eta = this.calculateETA(taskId);

    // Заголовок
    const statusIcon = task.completed
      ? (task.error ? '❌' : '✅')
      : '⏳';
    lines.push(`${statusIcon} ${task.taskName}`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Основная информация
    lines.push(`📊 Модель: ${task.model} (${task.provider})`);
    lines.push(`⏱️  Прошло: ${this.formatDuration(elapsed * 1000)}`);

    // Прогресс
    lines.push(`\n${this.buildProgressBar(percent)}`);

    // ETA (если не завершена)
    if (!task.completed) {
      lines.push(`⏳ Осталось: ${eta.remainingStr}`);
      lines.push(`🕐 Завершится около: ${eta.etaStr}`);
    }

    // Текущая фаза
    if (task.currentPhase) {
      lines.push(`\n▶️  Фаза: ${task.currentPhase}`);
    }

    // Таблица фаз (если есть)
    if (task.phases && task.phases.length > 0) {
      lines.push(`\n📋 Этапы:`);
      for (let i = 0; i < task.phases.length; i++) {
        const icon = i < task.phaseIndex ? '✅' : i === task.phaseIndex ? '▶️' : '⭕';
        lines.push(`  ${icon} ${task.phases[i]}`);
      }
    }

    // Ресурсы
    lines.push(`\n${this.buildResourceStatus()}`);

    // Примечания (последние 3)
    if (task.notes.length > 0) {
      lines.push(`\n📝 События:`);
      const lastNotes = task.notes.slice(-3);
      for (const note of lastNotes) {
        lines.push(`  ${note}`);
      }
    }

    // Ошибка (если есть)
    if (task.error) {
      lines.push(`\n❌ Ошибка: ${task.error.slice(0, 100)}`);
    }

    return lines.join('\n');
  }

  /**
   * Построить список последних выполненных задач (история)
   * @returns {string}
   */
  buildTaskHistory() {
    if (this.taskHistory.length === 0) {
      return '📭 История пуста';
    }

    const lines = ['📋 Последние 10 задач:', '─────────────────────────'];

    const recentTasks = this.taskHistory.slice(0, 10);
    for (let i = 0; i < recentTasks.length; i++) {
      const t = recentTasks[i];
      const icon = t.success ? '✅' : '❌';
      const duration = this.formatDuration(t.duration);

      lines.push(
        `${icon} [${t.timestamp}] ${t.taskName} (${duration})\n` +
        `   Модель: ${t.model}${t.error ? ` | Ошибка: ${t.error.slice(0, 60)}` : ''}`
      );
    }

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // БАТЧИНГ И ОТПРАВКА ОБНОВЛЕНИЙ
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Запланировать обновление статуса (с батчингом)
   * Это позволяет коллекцировать несколько обновлений в одно editText вместо нескольких
   *
   * @param {number} chatId
   * @param {number} msgId - ID сообщения для editText
   * @param {string} taskId - ID отслеживаемой задачи
   * @param {function} editTextFn - Функция editText(chatId, msgId, text, opts)
   * @param {number} delayOverride - Опциональное переопределение задержки батча (мс)
   */
  scheduleStatusUpdate(chatId, msgId, taskId, editTextFn, delayOverride = null) {
    const delay = delayOverride || this.BATCH_DELAY_MS;

    // Если у этого чата уже есть ожидающее обновление, отмени его
    if (this.pendingUpdates.has(chatId)) {
      const pending = this.pendingUpdates.get(chatId);
      if (pending.timer) clearTimeout(pending.timer);
    }

    // Запланируй новое обновление
    const timer = setTimeout(async () => {
      const text = this.buildTaskStatusMessage(taskId);
      try {
        await editTextFn(chatId, msgId, text, { parse_mode: 'HTML' });
      } catch (e) {
        console.error(`[ProgressTracker] Ошибка при editText: ${e.message}`);
      }
      this.pendingUpdates.delete(chatId);
    }, delay);

    this.pendingUpdates.set(chatId, { msgId, taskId, timer, timestamp: Date.now() });
  }

  /**
   * Отправить обновление статуса немедленно (без батчинга)
   *
   * @param {number} chatId
   * @param {number} msgId - ID сообщения для editText
   * @param {string} taskId - ID задачи
   * @param {function} editTextFn - Функция editText
   * @param {boolean} immediate - Отправить ли сразу (игнорируя батч)
   */
  async sendStatusUpdate(chatId, msgId, taskId, editTextFn, immediate = false) {
    if (!immediate && this.BATCH_DELAY_MS > 0) {
      this.scheduleStatusUpdate(chatId, msgId, taskId, editTextFn);
      return;
    }

    const text = this.buildTaskStatusMessage(taskId);
    try {
      return await editTextFn(chatId, msgId, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error(`[ProgressTracker] Ошибка при editText: ${e.message}`);
    }
  }

  /**
   * Отменить ожидающее обновление (если нужно срочно отправить что-то другое)
   * @param {number} chatId
   */
  cancelPendingUpdate(chatId) {
    if (this.pendingUpdates.has(chatId)) {
      const pending = this.pendingUpdates.get(chatId);
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingUpdates.delete(chatId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Отформатировать длительность в читаемый формат
   * @param {number} ms - Миллисекунды
   * @returns {string} например "5м 32с" или "45с"
   */
  formatDuration(ms) {
    const totalSeconds = Math.round(ms / 1000);

    if (totalSeconds < 60) {
      return `${totalSeconds}с`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes < 60) {
      return `${minutes}м ${seconds}с`.trim();
    }

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}ч ${mins}м`.trim();
  }

  /**
   * Начать периодический мониторинг ресурсов системы
   * Обновляет каждые 5 секунд информацию о CPU, памяти, GPU
   */
  startResourceMonitoring() {
    // Обновление памяти (просто, без внешних команд)
    setInterval(() => {
      try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        this.resourceStats.memoryUsage = (usedMem / totalMem) * 100;

        // CPU usage - simple estimate
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        cpus.forEach(cpu => {
          for (const type in cpu.times) {
            totalTick += cpu.times[type];
          }
          totalIdle += cpu.times.idle;
        });
        const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);
        this.resourceStats.cpuUsage = cpuUsage;

        this.resourceStats.lastUpdate = Date.now();
      } catch (e) {
        console.error('[ProgressTracker] Ошибка мониторинга ресурсов:', e.message);
      }
    }, 5000);

    // GPU status check (если доступна система обнаружения)
    this.checkGPUStatus();
  }

  /**
   * Проверить статус GPU (макOS/Linux)
   * Пытается определить, используется ли GPU в текущий момент
   */
  checkGPUStatus() {
    // Простая проверка: если высокая нагрузка CPU и памяти => может быть GPU активен
    // Более точная реализация может использовать специализированные утилиты
    setInterval(() => {
      if (this.resourceStats.cpuUsage > 70 || this.resourceStats.memoryUsage > 80) {
        this.resourceStats.gpuUsage = 'busy';
      } else {
        this.resourceStats.gpuUsage = 'idle';
      }
    }, 10000);
  }

  /**
   * Получить информацию о задаче по ID
   * @param {string} taskId
   * @returns {object|null} Объект задачи или null
   */
  getTask(taskId) {
    return this.activeTasks.get(taskId) || null;
  }

  /**
   * Получить все активные задачи для чата
   * @param {number} chatId
   * @returns {array} Массив активных задач
   */
  getActiveTasks(chatId) {
    const tasks = [];
    for (const [taskId, task] of this.activeTasks) {
      if (task.chatId === chatId && !task.completed) {
        tasks.push({ taskId, ...task });
      }
    }
    return tasks;
  }

  /**
   * Очистить завершённые задачи (старше 1 часа)
   */
  cleanupOldTasks() {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);

    for (const [taskId, task] of this.activeTasks) {
      if (task.completed && task.endTime && task.endTime < oneHourAgo) {
        this.activeTasks.delete(taskId);
      }
    }
  }

  /**
   * Получить статистику по типам задач
   * @returns {object} {type: {count, avgDuration, successRate}, ...}
   */
  getStatistics() {
    const stats = {};

    for (const task of this.taskHistory) {
      if (!stats[task.type]) {
        stats[task.type] = {
          count: 0,
          totalDuration: 0,
          successful: 0
        };
      }
      stats[task.type].count++;
      stats[task.type].totalDuration += task.duration;
      if (task.success) stats[task.type].successful++;
    }

    // Вычислить производные метрики
    const result = {};
    for (const [type, data] of Object.entries(stats)) {
      result[type] = {
        count: data.count,
        avgDuration: this.formatDuration(data.totalDuration / data.count),
        successRate: Math.round((data.successful / data.count) * 100) + '%'
      };
    }

    return result;
  }

  /**
   * Экспортировать полный отчёт по истории и статистике
   * @returns {string} Форматированный отчёт
   */
  exportReport() {
    const lines = [];

    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('📊 ОТЧЁТ О ВЫПОЛНЕНИИ ЗАДАЧ');
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('');

    lines.push('📈 СТАТИСТИКА ПО ТИПАМ ЗАДАЧ:');
    lines.push('─────────────────────────────────────────────────────────');
    const stats = this.getStatistics();
    for (const [type, data] of Object.entries(stats)) {
      lines.push(
        `  ${type}:\n` +
        `    Всего: ${data.count} | Среднее время: ${data.avgDuration} | Успех: ${data.successRate}`
      );
    }

    lines.push('');
    lines.push('📋 ИСТОРИЯ ПОСЛЕДНИХ ЗАДАЧ:');
    lines.push('─────────────────────────────────────────────────────────');
    const recentTasks = this.taskHistory.slice(0, 20);
    for (const task of recentTasks) {
      const icon = task.success ? '✅' : '❌';
      const duration = this.formatDuration(task.duration);
      lines.push(
        `  ${icon} [${task.timestamp}] ${task.taskName}\n` +
        `     Модель: ${task.model} | Время: ${duration}`
      );
    }

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════');

    return lines.join('\n');
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════
// КЛАСС MULTI-TASK SUPERVISOR - Для отслеживания нескольких параллельных задач
// ═════════════════════════════════════════════════════════════════════════════════════

class MultiTaskSupervisor {
  constructor(tracker) {
    this.tracker = tracker; // Ссылка на основной ProgressTracker
    this.supervisedGroups = new Map(); // groupId -> {tasks: [], chatId, ...}
  }

  /**
   * Создать группу задач для совместного отслеживания
   * @param {number} chatId
   * @param {string} groupName - Название группы (напр. "Обработка 5 изображений")
   * @returns {string} groupId
   */
  createGroup(chatId, groupName) {
    const groupId = `group_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    this.supervisedGroups.set(groupId, {
      groupId,
      chatId,
      groupName,
      tasks: [],
      startTime: Date.now(),
      completed: false
    });

    return groupId;
  }

  /**
   * Добавить задачу в группу
   * @param {string} groupId
   * @param {string} taskId - ID задачи из ProgressTracker
   */
  addTaskToGroup(groupId, taskId) {
    const group = this.supervisedGroups.get(groupId);
    if (!group) return;

    if (!group.tasks.includes(taskId)) {
      group.tasks.push(taskId);
    }
  }

  /**
   * Построить статус всей группы
   * @param {string} groupId
   * @returns {string}
   */
  buildGroupStatus(groupId) {
    const group = this.supervisedGroups.get(groupId);
    if (!group) return '❌ Группа не найдена';

    const lines = [];
    const elapsed = Math.round((Date.now() - group.startTime) / 1000);

    lines.push(`👥 ${group.groupName}`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    let completed = 0;
    let errors = 0;
    let totalProgress = 0;

    for (const taskId of group.tasks) {
      const task = this.tracker.getTask(taskId);
      if (!task) continue;

      if (task.completed) {
        completed++;
        if (task.error) errors++;
      }

      totalProgress += task.progress;

      const icon = task.completed ? (task.error ? '❌' : '✅') : '⏳';
      const progress = Math.round((task.progress / task.maxProgress) * 100);
      lines.push(`${icon} ${task.taskName} — ${progress}%`);
    }

    const avgProgress = Math.round(totalProgress / Math.max(1, group.tasks.length));
    lines.push(`\n${this.tracker.buildProgressBar(avgProgress)}`);
    lines.push(`⏱️  Прошло: ${this.tracker.formatDuration(elapsed * 1000)}`);
    lines.push(`📊 Завершено: ${completed}/${group.tasks.length} | Ошибок: ${errors}`);

    return lines.join('\n');
  }

  /**
   * Завершить группу
   * @param {string} groupId
   * @param {boolean} success
   */
  completeGroup(groupId, success = true) {
    const group = this.supervisedGroups.get(groupId);
    if (!group) return;

    group.completed = true;
    group.endTime = Date.now();

    if (success) {
      console.log(`[MultiTaskSupervisor] Группа "${group.groupName}" успешно завершена`);
    } else {
      console.log(`[MultiTaskSupervisor] Группа "${group.groupName}" завершена с ошибками`);
    }
  }

  /**
   * Получить все группы для чата
   * @param {number} chatId
   * @returns {array}
   */
  getGroupsForChat(chatId) {
    const groups = [];
    for (const [groupId, group] of this.supervisedGroups) {
      if (group.chatId === chatId && !group.completed) {
        groups.push({ groupId, ...group });
      }
    }
    return groups;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════
// ЭКСПОРТИРОВАНИЕ МОДУЛЯ
// ═════════════════════════════════════════════════════════════════════════════════════

module.exports = {
  ProgressTracker,
  MultiTaskSupervisor
};
