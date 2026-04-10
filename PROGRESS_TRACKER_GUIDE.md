# 📊 PROGRESS TRACKER - Полное руководство по интеграции

## Обзор

**Progress Tracker** — это расширенная система отслеживания прогресса операций в Telegram боте, которая решает основные проблемы текущей реализации:

### Проблемы ДО:
- ❌ `editText()` вызывается много раз подряд → медленно и спамит API
- ❌ Только иконки ⏳/✅, нет визуальных прогресс-баров
- ❌ Нет информации о проценте выполнения
- ❌ Нет деталей о типе операции (GPU/CPU/память)
- ❌ История задач теряется, нет логирования

### Решения ПОСЛЕ:
- ✅ **Батчинг обновлений** — коллекция изменений в одно сообщение (макс. раз в 800мс)
- ✅ **ASCII прогресс-бары** — `[████████░░░░░░░░░░░░] 35%`
- ✅ **Фазы выполнения** — Инициализация → Обработка → Финализация
- ✅ **ETA и таймер** — "Осталось 5м 32с, завершится в 14:32"
- ✅ **Статус ресурсов** — "Память: 512MB/1GB | CPU: 85% | GPU: busy"
- ✅ **История и статистика** — лог последних 50 задач с метриками

---

## Архитектура

### ProgressTracker (основной класс)

```javascript
class ProgressTracker {
  // Запустить отслеживание новой задачи
  startTask(chatId, taskName, opts) → taskId

  // Управление фазами и прогрессом
  updatePhase(taskId, phase, detail)
  setProgress(taskId, percent)
  incrementProgress(taskId, amount)
  completeTask(taskId, success, errorMsg, result)

  // Визуализация
  buildProgressBar(percent, width) → string
  buildTaskStatusMessage(taskId) → string
  buildTaskHistory() → string

  // Батчинг
  scheduleStatusUpdate(chatId, msgId, taskId, editTextFn, delay)
  async sendStatusUpdate(chatId, msgId, taskId, editTextFn, immediate)

  // Утилиты
  calculateETA(taskId) → {remainingMs, remainingStr, etaStr}
  getResourceStats() → {cpuUsage, memoryUsage, gpuUsage}
  buildResourceStatus() → string
  getStatistics() → {type: {count, avgDuration, successRate}}
  exportReport() → string
}
```

### MultiTaskSupervisor (для групп задач)

Позволяет отслеживать несколько параллельных задач как единую группу:

```javascript
class MultiTaskSupervisor {
  createGroup(chatId, groupName) → groupId
  addTaskToGroup(groupId, taskId)
  buildGroupStatus(groupId) → string
  completeGroup(groupId, success)
}
```

---

## Структура данных задачи

```javascript
{
  // Идентификаторы
  taskId: "task_1699876543_abc123",
  chatId: 123456,
  taskName: "Генерация изображения",

  // Временные данные
  startTime: 1699876543000,
  endTime: 1699876564000,          // Заполняется при завершении

  // Метаданные
  type: "image_generation",
  model: "dall-e-3",
  provider: "OpenAI",

  // Прогресс
  progress: 35,                     // 0-100
  maxProgress: 100,
  currentPhase: "Обработка GPU",
  phases: ["Инициализация", "Подготовка", "API", "GPU", "Загрузка"],
  phaseIndex: 3,

  // Статус
  completed: false,
  error: "Connection timeout",

  // Логирование
  notes: [
    "[14:32:10] Инициализация: Загрузка модели",
    "[14:32:15] API: Отправка запроса (512x512)"
  ],

  // Опции
  estimatedDuration: 25000,         // в мс
  metadata: {custom: "data"}
}
```

---

## Интеграция в bot.js

### Шаг 1: Инициализация

В начало `bot.js` (после требуемых модулей) добавить:

```javascript
// ===== PROGRESS TRACKER =====
const { ProgressTracker, MultiTaskSupervisor } = require('./progress_tracker');
const progressTracker = new ProgressTracker();
global.progressTracker = progressTracker;

// Периодическая очистка старых задач (старше 1 часа)
setInterval(() => {
  progressTracker.cleanupOldTasks();
}, 60 * 60 * 1000);

// При выходе: экспортировать отчёт
process.on('SIGINT', () => {
  console.log('\n' + progressTracker.exportReport());
  process.exit(0);
});
```

### Шаг 2: Замена старого кода

**ДО (старый способ):**
```javascript
const msgId = (await send(chatId, '⏳ Генерирую...', mainMenu(chatId))).message_id;

// Долгие операции с многократным editText
await editText(chatId, msgId, '⏳ Инициализация...', {});
await new Promise(r => setTimeout(r, 1000));
await editText(chatId, msgId, '⏳ Загрузка модели...', {});
await new Promise(r => setTimeout(r, 2000));
await editText(chatId, msgId, '⏳ Генерация...', {});
const image = await generateImage(prompt);
await editText(chatId, msgId, '✅ Готово!', mainMenu(chatId));
```

**ПОСЛЕ (новый способ):**
```javascript
const msgId = (await send(chatId, '⏳ Генерирую...', mainMenu(chatId))).message_id;

// Запустить отслеживание
const taskId = progressTracker.startTask(chatId, '🎨 Генерация изображения', {
  type: 'image_generation',
  model: 'dall-e-3',
  provider: 'OpenAI',
  phases: ['Инициализация', 'Загрузка модели', 'Генерация', 'Загрузка результата'],
  estimatedDuration: 25000
});

// Отправить начальный статус сразу
await progressTracker.sendStatusUpdate(chatId, msgId, taskId, editText, true);

try {
  // Фаза 1
  progressTracker.updatePhase(taskId, 'Инициализация');
  progressTracker.setProgress(taskId, 10);
  progressTracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
  await new Promise(r => setTimeout(r, 1000));

  // Фаза 2
  progressTracker.updatePhase(taskId, 'Загрузка модели');
  progressTracker.setProgress(taskId, 30);
  progressTracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
  await new Promise(r => setTimeout(r, 2000));

  // Фаза 3
  progressTracker.updatePhase(taskId, 'Генерация', 'Обработка GPU...');
  progressTracker.setProgress(taskId, 60);
  progressTracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
  const image = await generateImage(prompt);

  // Фаза 4
  progressTracker.updatePhase(taskId, 'Загрузка результата');
  progressTracker.setProgress(taskId, 95);
  progressTracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

  // Завершить
  progressTracker.completeTask(taskId, true, '', image.url);
  await editText(chatId, msgId, `✅ Готово!\n\n${image.url}`, mainMenu(chatId));

} catch (error) {
  progressTracker.completeTask(taskId, false, error.message);
  await send(chatId, `❌ Ошибка: ${error.message}`);
}
```

### Шаг 3: Примеры для разных сценариев

#### Вариант A: Использование хелпера `withProgressTracking`

Самый простой способ для функций, которые уже асинхронные:

```javascript
const result = await withProgressTracking(
  chatId, msgId,
  'Обработка видео',
  async (progress) => {
    // progress.updatePhase(phase, detail)
    // progress.setProgress(percent)
    // progress.incrementProgress(amount)

    progress.updatePhase('Загрузка');
    progress.setProgress(20);

    progress.updatePhase('Обработка');
    for (let i = 20; i < 90; i += 10) {
      await processChunk();
      progress.setProgress(i);
    }

    progress.updatePhase('Завершение');
    return processVideo(videoPath);
  },
  progressTracker,
  {
    type: 'video_processing',
    model: 'Whisper',
    estimatedDuration: 120000
  }
);
```

#### Вариант B: Мультиагентная система

```javascript
const supervisor = new MultiTaskSupervisor(progressTracker);
const groupId = supervisor.createGroup(chatId, '👥 Анализ 5 агентами');

const agentTasks = [];
for (let i = 0; i < 5; i++) {
  const taskId = progressTracker.startTask(chatId, `🤖 Агент #${i+1}`);
  supervisor.addTaskToGroup(groupId, taskId);

  agentTasks.push(
    runAgent(i, taskId).then(result => {
      progressTracker.completeTask(taskId, true, '', result);
      return result;
    })
  );
}

await Promise.all(agentTasks);
supervisor.completeGroup(groupId, true);
```

#### Вариант C: Массовая обработка файлов

```javascript
const taskId = progressTracker.startTask(chatId, `📦 Обработка ${files.length} файлов`, {
  type: 'batch',
  estimatedDuration: files.length * 1000
});

for (let i = 0; i < files.length; i++) {
  progressTracker.updatePhase(
    taskId,
    'Обработка файлов',
    `${files[i].name} (${i+1}/${files.length})`
  );
  progressTracker.setProgress(taskId, Math.round((i / files.length) * 100));
  progressTracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

  await processFile(files[i]);
}

progressTracker.completeTask(taskId, true);
```

---

## Примеры вывода

### Прогресс простой задачи

```
⏳ Генерация изображения
════════════════════════════════════
📊 Модель: dall-e-3 (OpenAI)
⏱️  Прошло: 12с

[████████░░░░░░░░░░░░] 35%

⏳ Осталось: 25с
🕐 Завершится около: 14:32:15

▶️  Фаза: Обработка GPU

📋 Этапы:
  ✅ Инициализация
  ✅ Загрузка модели
  ✅ API
  ▶️  Обработка GPU
  ⭕ Загрузка результата

💾 Память: [██████░░] 60%
⚙️  CPU: [████████░░] 80%
🎮 GPU: 🔴 busy

📝 События:
  [14:31:58] Обработка GPU: Генерация пикселей...
  [14:32:00] API: Получен результат 512x512
  [14:32:03] Загрузка модели: Модель загружена в GPU
```

### История задач

```
📋 Последние 10 задач:
─────────────────────────
✅ [14:30:25] Генерация изображения (25с)
   Модель: dall-e-3
❌ [14:28:10] Транскрипция видео (45с)
   Модель: Whisper | Ошибка: API timeout
✅ [14:25:33] Анализ текста (8с)
   Модель: claude-opus-4
✅ [14:20:15] Генерация кода (15с)
   Модель: claude-opus-4
```

### Статистика

```
📈 СТАТИСТИКА ПО ТИПАМ ЗАДАЧ:
─────────────────────────────────────
  image_generation:
    Всего: 12 | Среднее время: 22с | Успех: 92%

  video_processing:
    Всего: 5 | Среднее время: 1м 15с | Успех: 80%

  text_analysis:
    Всего: 28 | Среднее время: 8с | Успех: 100%
```

---

## API Методов

### Управление задачами

| Метод | Описание | Примеры |
|-------|---------|---------|
| `startTask(chatId, name, opts)` | Запустить новую задачу | `tracker.startTask(123, 'Генерация')` |
| `updatePhase(taskId, phase, detail)` | Обновить текущую фазу | `tracker.updatePhase(taskId, 'GPU', 'Обработка...')` |
| `setProgress(taskId, percent)` | Установить прогресс (0-100) | `tracker.setProgress(taskId, 50)` |
| `incrementProgress(taskId, amount)` | Увеличить прогресс | `tracker.incrementProgress(taskId, 10)` |
| `completeTask(taskId, success, error, result)` | Завершить задачу | `tracker.completeTask(taskId, true)` |

### Визуализация

| Метод | Описание | Возвращает |
|-------|---------|-----------|
| `buildProgressBar(percent, width)` | ASCII прогресс-бар | `[████░░░░] 50%` |
| `buildTaskStatusMessage(taskId)` | Полный статус задачи | многострочный текст |
| `calculateETA(taskId)` | ETA и оставшееся время | `{remainingMs, remainingStr, etaStr}` |
| `buildResourceStatus()` | Статус памяти/CPU/GPU | многострочный текст |
| `buildTaskHistory()` | История последних 10 задач | многострочный текст |
| `getStatistics()` | Статистика по типам | объект с метриками |

### Батчинг

| Метод | Описание |
|-------|---------|
| `scheduleStatusUpdate(chatId, msgId, taskId, editTextFn, delay)` | Запланировать обновление (батч) |
| `sendStatusUpdate(chatId, msgId, taskId, editTextFn, immediate)` | Отправить немедленно или в батче |
| `cancelPendingUpdate(chatId)` | Отменить ожидающее обновление |

### Утилиты

| Метод | Описание |
|-------|---------|
| `getTask(taskId)` | Получить объект задачи |
| `getActiveTasks(chatId)` | Получить все активные задачи чата |
| `cleanupOldTasks()` | Очистить завершённые задачи старше 1ч |
| `exportReport()` | Экспортировать полный отчёт |

---

## Лучшие практики

### 1. Всегда используйте фазы для долгих операций

```javascript
// ✅ ХОРОШО
tracker.startTask(..., {
  phases: ['Инициализация', 'Обработка', 'Финализация']
});
tracker.updatePhase(taskId, 'Инициализация');

// ❌ ПЛОХО - нет информации о фазах
tracker.startTask(chatId, 'Что-то долгое');
```

### 2. Батчируйте частые обновления

```javascript
// ✅ ХОРОШО - батчированные обновления
for (let i = 0; i < 100; i++) {
  tracker.setProgress(taskId, i);
  tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText); // Ждёт 800мс
}

// ❌ ПЛОХО - много API запросов
for (let i = 0; i < 100; i++) {
  tracker.setProgress(taskId, i);
  await editText(chatId, msgId, text, {});  // Каждый раз сразу!
}
```

### 3. Всегда вызывайте `completeTask`

```javascript
// ✅ ХОРОШО
try {
  // операция
  tracker.completeTask(taskId, true, '', result);
} catch (error) {
  tracker.completeTask(taskId, false, error.message);
}

// ❌ ПЛОХО - задача остаётся в памяти
try {
  // операция
} catch (error) {
  // просто выход
}
```

### 4. Используйте правильную оценку длительности

```javascript
// Это помогает правильно вычислять ETA
tracker.startTask(chatId, name, {
  estimatedDuration: 25000,  // 25 секунд
  type: 'image_generation'
});
```

### 5. Для цепочки операций используйте MultiTaskSupervisor

```javascript
// ✅ ХОРОШО - видно общий прогресс
const supervisor = new MultiTaskSupervisor(tracker);
const groupId = supervisor.createGroup(chatId, 'Обработка 5 файлов');

for (const file of files) {
  const taskId = tracker.startTask(chatId, file.name);
  supervisor.addTaskToGroup(groupId, taskId);
  // обработка
}
```

---

## Отладка

### Просмотр активных задач

```javascript
const tasks = progressTracker.getActiveTasks(chatId);
console.log('Активные задачи:', tasks);
```

### Экспорт отчёта

```javascript
const report = progressTracker.exportReport();
console.log(report);
// Также автоматически печатается при выходе (SIGINT)
```

### Проверка статуса конкретной задачи

```javascript
const task = progressTracker.getTask(taskId);
console.log('Статус:', task.currentPhase, task.progress + '%');
```

---

## Возможные проблемы и решения

### Проблема: Обновления не отправляются

**Причина:** `BATCH_DELAY_MS = 0` отключает батчинг
**Решение:** Используйте `sendStatusUpdate(..., true)` для немедленной отправки

```javascript
// Немедленная отправка
await progressTracker.sendStatusUpdate(chatId, msgId, taskId, editText, true);
```

### Проблема: ETA неправильный

**Причина:** Прогресс не увеличивается линейно
**Решение:** Обновляйте `setProgress()` более часто

```javascript
// Вместо скачков 0% → 50% → 100%
// Делайте плавный прогресс
for (let i = 0; i <= 100; i += 5) {
  tracker.setProgress(taskId, i);
  await someWork();
}
```

### Проблема: Память растёт бесконечно

**Причина:** Задачи не удаляются
**Решение:** Убедитесь что `cleanupOldTasks()` вызывается

```javascript
// Должно быть в инициализации
setInterval(() => {
  progressTracker.cleanupOldTasks();
}, 60 * 60 * 1000);
```

---

## Файлы

- **`progress_tracker.js`** — основной модуль (ProgressTracker, MultiTaskSupervisor)
- **`progress_tracker_examples.js`** — примеры интеграции
- **`PROGRESS_TRACKER_GUIDE.md`** — этот файл
- **`progress-tracker.js`** — временный shim для обратной совместимости (`module.exports = require('./progress_tracker')`)

---

## Заключение

Progress Tracker значительно улучшает UX при долгих операциях:
- ✅ Быстрые обновления (батчинг)
- ✅ Понятный визуальный прогресс
- ✅ Информация о времени
- ✅ История и статистика
- ✅ Поддержка параллельных задач

Интеграция простая и не требует больших изменений в существующем коде!
