/**
 * ПРИМЕРЫ ИСПОЛЬЗОВАНИЯ PROGRESS TRACKER
 *
 * Интеграция в bot.js для различных операций
 */

const {
  ProgressTracker,
  StatusFormatter,
  BackgroundTasksUI,
  SpinnerManager,
} = require('./progress-tracker');

// ============================================================================
// 📌 ПРИМЕР 1: Голосовая транскрипция
// ============================================================================

/**
 * Улучшено: раньше было 15 сек молчания без обновлений
 * Теперь: показываем спиннер каждые 500мс
 *
 * Вывод:
 * 🎙 Распознаю голосовое...
 * 🎙 Распознаю голосовое... ⏳ 3с
 * 🎙 Распознаю голосовое... ⏳ 6с
 * 🎙 Распознаю голосовое... ⏳ 9с
 * ✅ «Привет, мир»
 */
async function transcribeVoiceWithProgress(voiceFilePath, chatId, tgApi) {
  // Создать трекер
  const tracker = new ProgressTracker('voice', 'Распознаю голосовое', {
    stages: ['инициализация', 'распознавание', 'завершение'],
    metadata: { filePath: voiceFilePath },
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

    // Обновлять сообщение каждые 500мс
    const updateInterval = setInterval(() => {
      if (tracker.shouldUpdate()) {
        tgApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: StatusFormatter.formatQuick(tracker),
        }).catch(err => console.error('Edit failed:', err.message));
      }
    }, 500);

    // Вызвать Gemini для транскрипции
    // (это может занять 10-30 секунд)
    const result = await callGeminiVoiceTranscription(voiceFilePath);

    clearInterval(updateInterval);

    tracker.complete(result);

    // Финальное сообщение
    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: StatusFormatter.formatQuick(tracker),
    });

    return result;
  } catch (error) {
    tracker.error(error.message);

    if (messageId) {
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: StatusFormatter.formatQuick(tracker),
      }).catch(e => console.error('Error message update failed:', e));
    }

    throw error;
  }
}

// ============================================================================
// 📌 ПРИМЕР 2: Видео-генерация с этапами
// ============================================================================

/**
 * Улучшено: раньше не было видно этапов
 * Теперь: показываем init → rendering → encoding → uploading → done
 *
 * Вывод:
 * 🎬 Генерация видео: инициализация ⏳ 5с
 * 🎬 Генерация видео: rendering ⏳ 15с
 * 🎬 Генерация видео: encoding ⏳ 28с
 * 🎬 Генерация видео: uploading ⏳ 35с
 * ✅ Видео готово | 45с
 */
async function generateVideoWithProgress(prompt, chatId, tgApi) {
  const tracker = new ProgressTracker('video', 'Генерация видео', {
    stages: ['инициализация', 'рендеринг', 'кодирование', 'загрузка', 'завершение'],
  });

  let messageId = null;

  try {
    // Начальное сообщение
    const initialMsg = await tgApi('sendMessage', {
      chat_id: chatId,
      text: StatusFormatter.formatVideoGeneration(tracker),
    });
    messageId = initialMsg.message_id;

    // Стадия 1: Инициализация (обычно 2-5 сек)
    tracker.updateStage('инициализация', 10);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);
    await sleep(3000);

    // Вызвать API генерации видео (может быть дорогой запрос)
    // например, Runway или Leonardo
    const jobId = await initializeVideoGeneration(prompt);

    // Стадия 2: Рендеринг (обычно 10-20 сек)
    tracker.updateStage('рендеринг', 30);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);

    // Ждём завершения рендеринга с обновлениями каждые 2 сек
    let renderComplete = false;
    let renderAttempts = 0;
    while (!renderComplete && renderAttempts < 30) {
      const status = await checkVideoJobStatus(jobId);
      if (status.stage === 'rendered') {
        renderComplete = true;
        tracker.setProgress(50);
        await updateProgressMessage(tracker, chatId, messageId, tgApi);
      } else {
        renderAttempts++;
        await sleep(2000);
        tracker.setProgress(30 + (renderAttempts * 0.5));
        if (tracker.shouldUpdate()) {
          await updateProgressMessage(tracker, chatId, messageId, tgApi);
        }
      }
    }

    // Стадия 3: Кодирование (обычно 5-15 сек)
    tracker.updateStage('кодирование', 60);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);
    await sleep(5000);
    tracker.setProgress(75);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);

    // Стадия 4: Загрузка
    tracker.updateStage('загрузка', 80);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);

    const videoUrl = await uploadVideoToTelegram(jobId, chatId);

    // Стадия 5: Завершение
    tracker.updateStage('завершение');
    tracker.complete(videoUrl);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);

    return videoUrl;
  } catch (error) {
    tracker.error(error.message);
    if (messageId) {
      await updateProgressMessage(tracker, chatId, messageId, tgApi);
    }
    throw error;
  }
}

// ============================================================================
// 📌 ПРИМЕР 3: NotebookLM генерация подкаста
// ============================================================================

/**
 * Улучшено: раньше был неясный формат времени
 * Теперь: показываем инициализацию и прогресс обработки
 *
 * Вывод:
 * 🎙 NotebookLM подкаст: инициализация ⏳ 8с
 * 🎙 NotebookLM подкаст: processing (3/20) ⏳ 45с
 * 🎙 NotebookLM подкаст: processing (7/20) ⏳ 105с
 * ✅ Подкаст готов | 3м15с | 18 МБ
 */
async function generateNotebookLMWithProgress(sources, chatId, tgApi) {
  const tracker = new ProgressTracker('notebook', 'NotebookLM подкаст', {
    stages: ['инициализация', 'обработка', 'завершение'],
    metadata: {
      sourcesCount: sources.length,
      current: 0,
      total: sources.length,
    },
  });

  let messageId = null;

  try {
    // Начальное сообщение
    const initialMsg = await tgApi('sendMessage', {
      chat_id: chatId,
      text: StatusFormatter.formatNotebookLM(tracker),
    });
    messageId = initialMsg.message_id;

    // Стадия 1: Инициализация (загрузка источников)
    tracker.updateStage('инициализация', 15);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);
    await sleep(3000);

    // Стадия 2: Обработка
    tracker.updateStage('обработка', 30);

    // Запустить обработку в NotebookLM
    const notebookId = await createNotebookLMNotebook(sources);

    // Обновлять прогресс по мере обработки
    let processed = 0;
    while (processed < sources.length) {
      processed++;
      tracker.updateMetadata({ current: processed, total: sources.length });
      tracker.setProgress(30 + (processed / sources.length) * 60);

      if (tracker.shouldUpdate()) {
        await updateProgressMessage(tracker, chatId, messageId, tgApi);
      }

      await sleep(1000);
    }

    tracker.setProgress(95);
    await updateProgressMessage(tracker, chatId, messageId, tgApi);

    // Генерировать подкаст
    const podcastUrl = await generateNotebookLMPodcast(notebookId);
    const fileSize = await getFileSizeFormatted(podcastUrl);

    tracker.complete('Подкаст готов');
    tracker.updateMetadata({ fileSize });

    await updateProgressMessage(tracker, chatId, messageId, tgApi);

    return podcastUrl;
  } catch (error) {
    tracker.error(error.message);
    if (messageId) {
      await updateProgressMessage(tracker, chatId, messageId, tgApi);
    }
    throw error;
  }
}

// ============================================================================
// 📌 ПРИМЕР 4: Фоновые задачи
// ============================================================================

/**
 * Улучшено: фоновые задачи теперь видны пользователю
 *
 * Команда /tasks показывает:
 * 📌 Активные фоновые задачи (3):
 *   1️⃣ 🎬 Видео | ⏱ 1м23с | 67%
 *   2️⃣ 🎙 Подкаст | ⏱ 3м05с | 45%
 *   3️⃣ 💾 Синхронизация | ⏱ 42с | 89%
 */

const backgroundTasksUI = new BackgroundTasksUI();

// Функция для добавления фоновой задачи
function startBackgroundTask(taskName, icon, chatId) {
  const taskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  backgroundTasksUI.addTask(taskId, {
    name: taskName,
    icon: icon,
    chatId: chatId,
    status: 'processing',
    progress: 0,
    startTime: Date.now(),
  });

  return taskId;
}

// Функция для обновления прогресса фоновой задачи
function updateBackgroundTask(taskId, progress, details = null) {
  backgroundTasksUI.updateTask(taskId, {
    progress: Math.min(100, Math.max(0, progress)),
    details: details,
  });
}

// Функция для завершения фоновой задачи
function completeBackgroundTask(taskId) {
  backgroundTasksUI.completeTask(taskId);
}

// Команда /tasks - показать активные задачи
async function commandTasks(chatId, tgApi) {
  const tasksList = backgroundTasksUI.formatTasksList(chatId);
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: tasksList,
  });
}

// Пример использования в фоновом процессе
async function exampleBackgroundTask(chatId) {
  const taskId = startBackgroundTask('Синхронизация с облаком', '💾', chatId);

  try {
    for (let i = 0; i <= 100; i += 10) {
      updateBackgroundTask(taskId, i, `${i}% завершено`);
      await sleep(2000);
    }

    completeBackgroundTask(taskId);
  } catch (error) {
    backgroundTasksUI.updateTask(taskId, {
      status: 'error',
      error: error.message,
    });
  }
}

// ============================================================================
// 📌 ПРИМЕР 5: Prison Orchestration
// ============================================================================

/**
 * Улучшено: более частые обновления (300мс вместо 500мс)
 *
 * Вывод:
 * ⛓️ PRISON ORCHESTRATION · ◐ LIVE
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
 *
 * 📋 Last actions:
 * ✅ read:config.json +1.2с | ✅ bash:npm install +0.5с
 */
async function executePrisonOrchestrationWithProgress(
  task,
  chatId,
  tgApi,
  spinnerManager
) {
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
    // Начальное сообщение
    const initialMsg = await tgApi('sendMessage', {
      chat_id: chatId,
      text: 'Инициализация PRISON...',
    });
    messageId = initialMsg.message_id;

    // Регистрировать трекер в SpinnerManager для частых обновлений
    spinnerManager.registerTracker(tracker, async (updatedTracker) => {
      const cellBlocksData = [
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
              spinner: tracker.getSpinner(),
              elapsed: '2.3с',
              info: 'Creating REST API',
            },
          ],
        },
        {
          icon: '🔬',
          name: 'B-Wing',
          working: 0,
          queued: 2,
          tasks: [
            {
              id: 5,
              icon: '📊',
              name: 'Data Analyst',
              status: 'done',
              elapsed: '0.8с',
            },
          ],
        },
      ];

      const formattedText = StatusFormatter.formatPrisonOrchestration(
        updatedTracker,
        cellBlocksData
      );

      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: formattedText,
        parse_mode: 'HTML',
      }).catch(err => {
        // Игнорировать ошибки throttling от Telegram
        if (!err.message.includes('Too Many Requests')) {
          console.error('Edit failed:', err.message);
        }
      });
    });

    // Стадия 1: Инициализация
    tracker.updateStage('инициализация', 10);
    tracker.updateMetadata({ currentAction: 'Loading task...' });
    await sleep(2000);

    // Стадия 2: Планирование
    tracker.updateStage('планирование', 25);
    tracker.updateMetadata({
      currentAction: 'Planning execution steps...',
      actionElapsedSec: 1.2,
    });
    await sleep(3000);

    // Стадия 3: Выполнение
    tracker.updateStage('выполнение', 50);

    for (let step = 2; step <= 7; step++) {
      tracker.updateMetadata({
        currentStep: step,
        currentAction: `Executing step ${step}...`,
        actionElapsedSec: (Math.random() * 3).toFixed(1),
      });

      tracker.setProgress(25 + (step * 10));
      await sleep(2000);
    }

    // Стадия 4: Проверка
    tracker.updateStage('проверка', 85);
    tracker.updateMetadata({
      currentAction: 'Verifying results...',
      actionElapsedSec: 0.8,
    });
    await sleep(2000);

    // Стадия 5: Завершение
    tracker.updateStage('завершение');
    tracker.complete('Task completed successfully');

    // Спинер сам отменит регистрацию после завершения
  } catch (error) {
    tracker.error(error.message);
    spinnerManager.unregisterTracker(tracker.id);

    if (messageId) {
      const cellBlocksData = [];
      const formattedText = StatusFormatter.formatPrisonOrchestration(
        tracker,
        cellBlocksData
      );

      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: formattedText,
      }).catch(e => console.error('Error message update failed:', e));
    }
    throw error;
  }
}

// ============================================================================
// 📌 УТИЛИТЫ
// ============================================================================

async function updateProgressMessage(tracker, chatId, messageId, tgApi) {
  try {
    const text = StatusFormatter.formatVideoGeneration(tracker);
    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
    });
  } catch (error) {
    if (!error.message.includes('message is not modified')) {
      console.error('Update message error:', error.message);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Макеты функций для примеров (заменить на реальные реализации)
async function callGeminiVoiceTranscription(filePath) {
  await sleep(Math.random() * 20000 + 5000);
  return 'Привет, мир';
}

async function initializeVideoGeneration(prompt) {
  return `job_${Date.now()}`;
}

async function checkVideoJobStatus(jobId) {
  const stages = ['initialized', 'rendering', 'rendered', 'encoding', 'encoded', 'uploading'];
  return { stage: stages[Math.floor(Math.random() * stages.length)] };
}

async function uploadVideoToTelegram(jobId, chatId) {
  return 'https://example.com/video.mp4';
}

async function createNotebookLMNotebook(sources) {
  return `notebook_${Date.now()}`;
}

async function generateNotebookLMPodcast(notebookId) {
  return 'https://example.com/podcast.mp3';
}

async function getFileSizeFormatted(url) {
  const sizes = ['12 МБ', '18 МБ', '25 МБ', '8 МБ'];
  return sizes[Math.floor(Math.random() * sizes.length)];
}

// ============================================================================
// ЭКСПОРТ
// ============================================================================

module.exports = {
  transcribeVoiceWithProgress,
  generateVideoWithProgress,
  generateNotebookLMWithProgress,
  backgroundTasksUI,
  startBackgroundTask,
  updateBackgroundTask,
  completeBackgroundTask,
  commandTasks,
  executePrisonOrchestrationWithProgress,
  sleep,
};
