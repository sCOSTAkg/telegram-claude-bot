# Интеграция Progress Tracker в bot.js

## Обзор

Система состоит из 4 основных компонентов:

1. **ProgressTracker** - отслеживание операций в реальном времени
2. **StatusFormatter** - унифицированное форматирование статусов
3. **BackgroundTasksUI** - управление видимостью фоновых задач
4. **SpinnerManager** - управление частотой обновлений и спиннерами

## Установка

### 1. Импортировать в bot.js

```javascript
const {
  ProgressTracker,
  StatusFormatter,
  BackgroundTasksUI,
  SpinnerManager,
} = require('./progress-tracker');

// Создать глобальные инстансы
const backgroundTasksUI = new BackgroundTasksUI();
const spinnerManager = new SpinnerManager(500); // throttle 500мс по умолчанию
```

### 2. Добавить инстансы в глобальный скоуп

Добавить в начало bot.js после инициализации переменных:

```javascript
// === PROGRESS TRACKING ===
const backgroundTasksUI = new BackgroundTasksUI();
const spinnerManager = new SpinnerManager(500);

// Cleanup фоновых задач каждые 5 минут
setInterval(() => {
  backgroundTasksUI.cleanup(30); // удалить задачи старше 30 мин
}, 5 * 60 * 1000);

// Cleanup спиннер-менеджера при выходе
process.on('exit', () => {
  spinnerManager.cleanup();
});
```

## Примеры интеграции

### 1️⃣ Голосовая транскрипция (улучшено)

**Проблема:** 15 сек молчания без обновлений

**Решение:** Показывать спиннер каждые 500мс

```javascript
async function handleVoiceMessage(chatId, fileId) {
  // Создать трекер
  const tracker = new ProgressTracker('voice', 'Распознаю голосовое', {
    stages: ['инициализация', 'распознавание', 'завершение'],
  });

  let messageId = null;

  try {
    // Отправить начальное сообщение
    const initialMsg = await tgApi('sendMessage', {
      chat_id: chatId,
      text: StatusFormatter.formatQuick(tracker),
    });
    messageId = initialMsg.message_id;

    tracker.updateStage('распознавание');

    // Обновлять каждые 500мс (пока идёт транскрипция)
    const updateInterval = setInterval(() => {
      if (tracker.shouldUpdate()) {
        tgApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: StatusFormatter.formatQuick(tracker),
        }).catch(() => {}); // Игнорировать ошибки throttling
      }
    }, 500);

    // Скачать файл и отправить в Gemini
    const audioBuffer = await downloadFileFromTelegram(fileId);
    const text = await transcribeWithGemini(audioBuffer);

    clearInterval(updateInterval);

    tracker.complete(text);

    // Финальное сообщение с результатом
    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: StatusFormatter.formatQuick(tracker),
    });

    // Отправить результат отдельным сообщением (если нужно)
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `✅ \`${text}\``,
      parse_mode: 'Markdown',
    });

  } catch (error) {
    tracker.error(error.message);

    if (messageId) {
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: StatusFormatter.formatQuick(tracker),
      }).catch(() => {});
    }
  }
}
```

### 2️⃣ Видео-генерация с этапами (улучшено)

**Проблема:** Не видны стадии (rendering/encoding/upload)

**Решение:** Показывать переход между стадиями

```javascript
async function generateVideoHandler(prompt, chatId) {
  const tracker = new ProgressTracker('video', 'Генерация видео', {
    stages: ['инициализация', 'рендеринг', 'кодирование', 'загрузка', 'завершение'],
  });

  let messageId = null;

  try {
    // Начальное сообщение
    const msg = await tgApi('sendMessage', {
      chat_id: chatId,
      text: StatusFormatter.formatVideoGeneration(tracker),
    });
    messageId = msg.message_id;

    // Функция обновления
    const updateMsg = async () => {
      if (tracker.shouldUpdate()) {
        await tgApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: StatusFormatter.formatVideoGeneration(tracker),
        }).catch(() => {});
      }
    };

    // === Стадия 1: Инициализация ===
    tracker.updateStage('инициализация', 10);
    await updateMsg();

    // Запустить генерацию видео (например, Runway API)
    const jobId = await startVideoJob(prompt);

    // === Стадия 2: Рендеринг (наиболее долгая) ===
    tracker.updateStage('рендеринг', 30);
    await updateMsg();

    // Ждём завершения с обновлениями каждые 2 сек
    while (!(await isVideoStageComplete(jobId, 'rendered'))) {
      tracker.setProgress(30 + Math.random() * 10); // Симуляция прогресса
      await updateMsg();
      await sleep(2000);
    }

    // === Стадия 3: Кодирование ===
    tracker.updateStage('кодирование', 60);
    await updateMsg();

    while (!(await isVideoStageComplete(jobId, 'encoded'))) {
      tracker.setProgress(60 + Math.random() * 15);
      await updateMsg();
      await sleep(1500);
    }

    // === Стадия 4: Загрузка ===
    tracker.updateStage('загрузка', 80);
    await updateMsg();

    const videoBuffer = await downloadVideoFromJob(jobId);
    const tgFile = await uploadVideoToTelegram(videoBuffer);

    // === Стадия 5: Завершение ===
    tracker.updateStage('завершение');
    tracker.complete(tgFile.file_id);
    await updateMsg();

    // Отправить видео пользователю
    await tgApi('sendVideo', {
      chat_id: chatId,
      video: tgFile.file_id,
      caption: '✅ Видео готово!',
    });

  } catch (error) {
    tracker.error(error.message);

    if (messageId) {
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: StatusFormatter.formatQuick(tracker),
      }).catch(() => {});
    }
  }
}
```

### 3️⃣ NotebookLM с понятным форматом времени (улучшено)

**Проблема:** Неясный формат времени при обработке

**Решение:** Показывать progress (X/Y) и отформатированное время

```javascript
async function generateNotebookLMHandler(sourceUrls, chatId) {
  const tracker = new ProgressTracker('notebook', 'NotebookLM подкаст', {
    stages: ['инициализация', 'обработка', 'завершение'],
    metadata: {
      current: 0,
      total: sourceUrls.length,
    },
  });

  let messageId = null;

  try {
    const msg = await tgApi('sendMessage', {
      chat_id: chatId,
      text: StatusFormatter.formatNotebookLM(tracker),
    });
    messageId = msg.message_id;

    // === Инициализация ===
    tracker.updateStage('инициализация', 15);
    await updateProgress();
    await sleep(2000);

    // Создать ноутбук и загрузить источники
    const notebookId = await createNotebookLM(sourceUrls);

    // === Обработка ===
    tracker.updateStage('обработка', 30);
    await updateProgress();

    // Следить за обработкой каждого источника
    let processed = 0;
    const pollInterval = setInterval(async () => {
      const status = await getNotebookLMStatus(notebookId);
      if (status.processed > processed) {
        processed = status.processed;
        tracker.updateMetadata({
          current: processed,
          total: sourceUrls.length,
        });
        tracker.setProgress(30 + (processed / sourceUrls.length) * 60);
        await updateProgress();
      }
    }, 2000);

    // Ждём завершения обработки
    while (!(await isNotebookLMReady(notebookId))) {
      await sleep(1000);
    }
    clearInterval(pollInterval);

    tracker.setProgress(95);
    await updateProgress();
    await sleep(1000);

    // Генерировать подкаст (обычно 10-20 сек)
    const podcastUrl = await generatePodcast(notebookId);
    const fileSize = await getFileSizeFormatted(podcastUrl);

    tracker.complete('Подкаст готов');
    tracker.updateMetadata({ fileSize });
    await updateProgress();

    // Отправить подкаст пользователю
    await tgApi('sendAudio', {
      chat_id: chatId,
      audio: podcastUrl,
      title: 'NotebookLM Podcast',
      caption: `✅ Подкаст готов (${fileSize})`,
    });

  } catch (error) {
    tracker.error(error.message);
    if (messageId) {
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: StatusFormatter.formatNotebookLM(tracker),
      }).catch(() => {});
    }
  }

  async function updateProgress() {
    if (tracker.shouldUpdate() && messageId) {
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: StatusFormatter.formatNotebookLM(tracker),
      }).catch(() => {});
    }
  }
}
```

### 4️⃣ Фоновые задачи UI (НОВОЕ)

**Проблема:** Фоновые задачи совсем не видны пользователю

**Решение:** Команда /tasks показывает активные задачи

```javascript
// Обработчик команды /tasks
async function handleTasksCommand(msg) {
  const chatId = msg.chat.id;
  const tasksList = backgroundTasksUI.formatTasksList(chatId);

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: tasksList,
    parse_mode: 'HTML',
  });
}

// Пример: запустить фоновый task
async function startSyncTask(chatId) {
  const taskId = `sync_${Date.now()}`;

  backgroundTasksUI.addTask(taskId, {
    name: 'Синхронизация с облаком',
    icon: '💾',
    chatId: chatId,
    status: 'processing',
    progress: 0,
    startTime: Date.now(),
  });

  // Обновлять прогресс
  let progress = 0;
  const interval = setInterval(() => {
    progress += Math.random() * 15;
    if (progress >= 100) {
      clearInterval(interval);
      backgroundTasksUI.completeTask(taskId);
    } else {
      backgroundTasksUI.updateTask(taskId, { progress: Math.round(progress) });
    }
  }, 3000);
}

// Добавить обработчик команды
if (msg.text === '/tasks') {
  await handleTasksCommand(msg);
}
```

### 5️⃣ Prison Orchestration с частыми обновлениями (улучшено)

**Проблема:** Может запаздывать, редкие обновления

**Решение:** 300мс вместо 500мс, более детальный вывод

```javascript
async function executePrisonOrchestrationHandler(task, chatId) {
  const tracker = new ProgressTracker('prison', 'PRISON ORCHESTRATION', {
    stages: ['инициализация', 'планирование', 'выполнение', 'проверка', 'завершение'],
    metadata: {
      warden: 'Claude Opus',
      complexity: 'medium',
      currentStep: 1,
      totalSteps: 8,
      lastActions: [],
    },
  });

  let messageId = null;

  try {
    const msg = await tgApi('sendMessage', {
      chat_id: chatId,
      text: '🔄 Инициализация PRISON...',
    });
    messageId = msg.message_id;

    // Регистрировать в spinnerManager для частых обновлений
    spinnerManager.registerTracker(tracker, async (updatedTracker) => {
      const cellBlocksData = buildCellBlocksData(); // Твоя функция

      const formattedText = StatusFormatter.formatPrisonOrchestration(
        updatedTracker,
        cellBlocksData
      );

      try {
        await tgApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: formattedText,
        });
      } catch (err) {
        // Игнорировать Too Many Requests ошибки
        if (!err.message.includes('Too Many Requests')) {
          console.error('Update error:', err.message);
        }
      }
    });

    // === Выполнение стадий ===
    tracker.updateStage('инициализация', 10);
    await sleep(1500);

    tracker.updateStage('планирование', 25);
    tracker.updateMetadata({ currentAction: 'Planning steps...' });
    await sleep(2500);

    tracker.updateStage('выполнение', 50);
    for (let step = 2; step <= 7; step++) {
      tracker.updateMetadata({ currentStep: step });
      tracker.setProgress(25 + step * 10);
      await sleep(3000);
    }

    tracker.updateStage('проверка', 85);
    await sleep(2000);

    tracker.updateStage('завершение');
    tracker.complete('Task completed');

  } catch (error) {
    tracker.error(error.message);
    spinnerManager.unregisterTracker(tracker.id);

    if (messageId) {
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: StatusFormatter.formatQuick(tracker),
      }).catch(() => {});
    }
  }
}

// Helper для построения cellBlocks данных
function buildCellBlocksData() {
  // Твоя логика построения данных о cell blocks
  return [
    {
      icon: '💻',
      name: 'A-Wing',
      working: 1,
      queued: 5,
      tasks: [
        {
          id: 1,
          icon: '🔨',
          name: 'Coder',
          status: 'working',
          spinner: '◐',
          elapsed: '2.3с',
          info: 'Creating REST API',
        },
      ],
    },
    // ... дополнительные blocks
  ];
}
```

## Важные моменты

### 1. Throttling обновлений (КРИТИЧНО!)

`ProgressTracker.shouldUpdate()` гарантирует, что сообщения не будут обновляться чаще, чем нужно:

```javascript
if (tracker.shouldUpdate()) {
  await tgApi('editMessageText', {...}); // Обновить
}
```

### 2. Обработка ошибок Telegram API

Всегда оборачивай обновления в try-catch:

```javascript
await tgApi('editMessageText', {...}).catch(err => {
  // Игнорировать "message not modified" ошибки
  if (!err.message.includes('message is not modified')) {
    console.error('Update failed:', err.message);
  }
});
```

### 3. Спиннер обновляется автоматически

`tracker.getSpinner()` возвращает текущий спиннер на основе времени прошедшего:

```javascript
const spinner = tracker.getSpinner(); // '⏳' → '◐' → '◓' → '◑' → '◒'
```

### 4. SpinnerManager для частых операций

Для операций, которые требуют частых обновлений (типа Prison), используй:

```javascript
spinnerManager.registerTracker(tracker, async (tracker) => {
  // Будет вызвано каждые 500мс (или 300мс для prison)
  await updateMessage(tracker);
});
```

SpinnerManager автоматически отменит регистрацию после завершения.

### 5. Cleanup

Регулярно очищай фоновые задачи:

```javascript
// В стартапе бота
setInterval(() => {
  backgroundTasksUI.cleanup(30); // Удалить задачи старше 30 мин
}, 5 * 60 * 1000); // Каждые 5 минут
```

## Полезные функции

### ProgressTracker методы

```javascript
tracker.updateStage(stageName, progress)  // Перейти на новую стадию
tracker.setProgress(0-100)                // Установить прогресс
tracker.getSpinner()                      // Получить текущий спиннер
tracker.getElapsedFormatted()             // '3м45с', '15с'
tracker.shouldUpdate()                    // Нужно ли обновлять?
tracker.complete(result)                  // Отметить как завершённая
tracker.error(errorMsg)                   // Отметить ошибку
tracker.updateMetadata(data)              // Обновить метаданные
```

### StatusFormatter методы

```javascript
StatusFormatter.formatQuick(tracker)              // Краткий формат
StatusFormatter.formatMedium(tracker)             // Средний формат
StatusFormatter.formatFull(tracker)               // Полный с метаданными
StatusFormatter.formatVideoGeneration(tracker)    // Видео стадии
StatusFormatter.formatNotebookLM(tracker)         // NotebookLM формат
StatusFormatter.formatPrisonOrchestration(tracker, cellBlocks)
```

### BackgroundTasksUI методы

```javascript
backgroundTasksUI.addTask(taskId, taskInfo)       // Добавить задачу
backgroundTasksUI.updateTask(taskId, updates)    // Обновить
backgroundTasksUI.completeTask(taskId)           // Завершить
backgroundTasksUI.getActiveTasks(chatId)         // Получить активные
backgroundTasksUI.formatTasksList(chatId)        // Форматировать список
backgroundTasksUI.cleanup(maxAgeMinutes)         // Очистить старые
```

## Тестирование

Для тестирования используй примеры из `progress-tracker-examples.js`:

```bash
node -e "
const { ProgressTracker, StatusFormatter } = require('./progress-tracker');

const tracker = new ProgressTracker('voice', 'Распознаю голосовое');
console.log(StatusFormatter.formatQuick(tracker));

setTimeout(() => {
  tracker.updateStage('распознавание', 50);
  console.log(StatusFormatter.formatQuick(tracker));
}, 1000);

setTimeout(() => {
  tracker.complete('Привет, мир');
  console.log(StatusFormatter.formatQuick(tracker));
}, 3000);
"
```

## Итоги улучшений

| Проблема | Решение | Компонент |
|----------|---------|-----------|
| Дросселирование скрывает обновления | `shouldUpdate()` throttle 500мс | ProgressTracker |
| 15 сек молчания в голосе | Спиннер каждые 500мс | SpinnerManager |
| Видео: нет стадий | Показывать init→render→encode→upload | StatusFormatter |
| NotebookLM: неясное время | Формат `Xм Yс` + прогресс (X/Y) | StatusFormatter |
| Фоновые задачи невидимы | `/tasks` команда + UI | BackgroundTasksUI |
| Prison может запаздывать | 300мс вместо 500мс для prison | SpinnerManager |
