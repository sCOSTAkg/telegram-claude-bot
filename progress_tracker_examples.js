/**
 * ПРИМЕРЫ ИНТЕГРАЦИИ PROGRESS TRACKER В BOT.JS
 * ================================================
 * Этот файл демонстрирует, как использовать ProgressTracker в различных сценариях.
 *
 * ДЛЯ ИНТЕГРАЦИИ В BOT.JS:
 * 1. В начало bot.js добавить:
 *    const { ProgressTracker, MultiTaskSupervisor } = require('./progress_tracker');
 *    const tracker = new ProgressTracker();
 *
 * 2. Заменить долгие операции на примеры ниже
 * 3. Вызывать tracker.scheduleStatusUpdate() вместо прямого editText()
 */

// ═════════════════════════════════════════════════════════════════════════════════════
// ПРИМЕР 1: ПРОСТАЯ ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЯ
// ═════════════════════════════════════════════════════════════════════════════════════

async function generateImageWithProgress(chatId, msgId, prompt, model = 'dall-e-3') {
  const tracker = global.progressTracker; // Ссылка на глобальный объект трекера

  // 1. Запустить отслеживание
  const taskId = tracker.startTask(chatId, `🎨 Генерация изображения`, {
    type: 'image_generation',
    model: model,
    provider: 'OpenAI',
    phases: ['Инициализация', 'Подготовка промпта', 'Отправка API', 'Обработка GPU', 'Загрузка результата'],
    estimatedDuration: 25000 // 25 сек в среднем
  });

  try {
    // 2. Сразу отправить начальный статус
    await tracker.sendStatusUpdate(chatId, msgId, taskId, editText, true);

    // 3. Фаза 1: Инициализация
    tracker.updatePhase(taskId, 'Инициализация');
    tracker.setProgress(taskId, 5);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    await new Promise(r => setTimeout(r, 500));

    // 4. Фаза 2: Подготовка промпта
    tracker.updatePhase(taskId, 'Подготовка промпта');
    tracker.setProgress(taskId, 15);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    await new Promise(r => setTimeout(r, 800));

    // 5. Фаза 3: Отправка API
    tracker.updatePhase(taskId, 'Отправка API');
    tracker.setProgress(taskId, 25);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

    // Реальный API запрос (пример)
    const result = await callOpenAIImageAPI(prompt, model);
    tracker.setProgress(taskId, 60);
    tracker.updatePhase(taskId, 'Обработка GPU', 'Нейросеть генерирует изображение...');
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

    // 6. Фаза 5: Загрузка результата
    tracker.updatePhase(taskId, 'Загрузка результата');
    tracker.incrementProgress(taskId, 30);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

    // 7. Завершение
    tracker.completeTask(taskId, true, '', result.url);

    // Отправить финальное сообщение с результатом
    await send(chatId, `✅ Готово!\n\n${result.url}`);

    return result;
  } catch (error) {
    tracker.completeTask(taskId, false, error.message);
    await send(chatId, `❌ Ошибка: ${error.message}`);
    throw error;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════
// ПРИМЕР 2: ОБРАБОТКА ВИДЕО (ДОЛГАЯ ОПЕРАЦИЯ)
// ═════════════════════════════════════════════════════════════════════════════════════

async function processVideoWithProgress(chatId, msgId, videoPath, operation = 'transcribe') {
  const tracker = global.progressTracker;

  const taskId = tracker.startTask(chatId, `🎬 Обработка видео: ${operation}`, {
    type: 'video_processing',
    model: 'Whisper/FFmpeg',
    provider: 'Local/OpenAI',
    phases: ['Загрузка видео', 'Извлечение аудио', 'Нормализация', 'Транскрипция', 'Форматирование результата'],
    estimatedDuration: 120000 // 2 минуты
  });

  try {
    await tracker.sendStatusUpdate(chatId, msgId, taskId, editText, true);

    // Фаза 1
    tracker.updatePhase(taskId, 'Загрузка видео');
    const fileSize = await getFileSizeInMB(videoPath);
    tracker.updatePhase(taskId, 'Загрузка видео', `${fileSize}MB`);
    tracker.setProgress(taskId, 10);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    await new Promise(r => setTimeout(r, 1000));

    // Фаза 2
    tracker.updatePhase(taskId, 'Извлечение аудио');
    tracker.setProgress(taskId, 25);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    const audioPath = await extractAudioFromVideo(videoPath);

    // Фаза 3
    tracker.updatePhase(taskId, 'Нормализация', 'Выравнивание громкости...');
    tracker.setProgress(taskId, 40);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    await normalizeAudio(audioPath);

    // Фаза 4 (ДОЛГАЯ)
    tracker.updatePhase(taskId, 'Транскрипция', 'Загрузка модели Whisper...');
    tracker.setProgress(taskId, 50);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

    // Это может занять 30-60 сек - обновляем прогресс во время процесса
    const transcriptPromise = transcribeAudio(audioPath);
    let progress = 50;
    const progressInterval = setInterval(() => {
      progress += Math.random() * 20; // Имитация прогресса
      if (progress > 90) progress = 90;
      tracker.setProgress(taskId, progress);
      tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    }, 3000);

    const transcript = await transcriptPromise;
    clearInterval(progressInterval);

    // Фаза 5
    tracker.updatePhase(taskId, 'Форматирование результата');
    tracker.setProgress(taskId, 95);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

    const formattedResult = formatTranscript(transcript);

    // Завершить
    tracker.completeTask(taskId, true, '', formattedResult.summary);
    await send(chatId, `✅ Транскрипция завершена!\n\n${formattedResult.preview}`);

    return formattedResult;
  } catch (error) {
    tracker.completeTask(taskId, false, error.message);
    await send(chatId, `❌ Ошибка обработки видео: ${error.message}`);
    throw error;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════
// ПРИМЕР 3: МУЛЬТИАГЕНТНАЯ СИСТЕМА (НЕСКОЛЬКО ПАРАЛЛЕЛЬНЫХ ЗАДАЧ)
// ═════════════════════════════════════════════════════════════════════════════════════

async function multiAgentAnalysisWithProgress(chatId, msgId, dataSet, numAgents = 5) {
  const tracker = global.progressTracker;
  const supervisor = new MultiTaskSupervisor(tracker);

  // Создать группу задач
  const groupId = supervisor.createGroup(chatId, `👥 Анализ данных ${numAgents} агентами`);

  try {
    // Отправить начальный статус группы
    await send(chatId, supervisor.buildGroupStatus(groupId), {
      parse_mode: 'HTML',
      message_id: msgId // Редактируемое сообщение
    });

    // Запустить агентов параллельно
    const agentTasks = [];
    for (let i = 0; i < numAgents; i++) {
      const taskId = tracker.startTask(chatId, `🤖 Агент #${i + 1}`, {
        type: 'analysis',
        model: `agent_${i + 1}`,
        provider: 'Internal',
        estimatedDuration: 15000
      });

      supervisor.addTaskToGroup(groupId, taskId);

      // Запустить агента в фоне
      agentTasks.push(
        runAgentAnalysis(i + 1, dataSet[i], taskId, tracker, chatId, msgId, supervisor, groupId)
      );
    }

    // Ждём всех агентов
    const results = await Promise.allSettled(agentTasks);

    // Завершить группу
    const allSuccess = results.every(r => r.status === 'fulfilled');
    supervisor.completeGroup(groupId, allSuccess);

    // Отправить финальный результат
    const finalText = supervisor.buildGroupStatus(groupId);
    await editText(chatId, msgId, finalText, { parse_mode: 'HTML' });

    return results.map(r => r.value);
  } catch (error) {
    supervisor.completeGroup(groupId, false);
    throw error;
  }
}

// Вспомогательная функция для одного агента
async function runAgentAnalysis(agentNum, data, taskId, tracker, chatId, msgId, supervisor, groupId) {
  try {
    tracker.updatePhase(taskId, 'Инициализация');
    tracker.setProgress(taskId, 10);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    await new Promise(r => setTimeout(r, 1000));

    tracker.updatePhase(taskId, 'Обработка данных');
    tracker.setProgress(taskId, 30);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

    // Имитация долгой операции
    const processingTime = Math.random() * 5000 + 5000; // 5-10 сек
    let progress = 30;
    while (progress < 90) {
      await new Promise(r => setTimeout(r, 500));
      progress += Math.random() * 15;
      tracker.setProgress(taskId, Math.min(progress, 90));
      tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    }

    tracker.updatePhase(taskId, 'Финализация');
    tracker.setProgress(taskId, 100);
    tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

    const result = { agentNum, data: 'processed', score: Math.random() * 100 };
    tracker.completeTask(taskId, true, '', JSON.stringify(result));

    // Обновить статус группы
    const groupStatus = supervisor.buildGroupStatus(groupId);
    await editText(chatId, msgId, groupStatus, { parse_mode: 'HTML' });

    return result;
  } catch (error) {
    tracker.completeTask(taskId, false, error.message);
    throw error;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════
// ПРИМЕР 4: МАССОВАЯ ОБРАБОТКА (БЫ́СТРЫЕ МНОГОЧИСЛЕННЫЕ ОПЕРАЦИИ)
// ═════════════════════════════════════════════════════════════════════════════════════

async function batchProcessFilesWithProgress(chatId, msgId, filePaths, processor) {
  const tracker = global.progressTracker;

  const taskId = tracker.startTask(chatId, `📦 Обработка ${filePaths.length} файлов`, {
    type: 'batch_processing',
    model: 'batch_processor',
    provider: 'Internal',
    estimatedDuration: filePaths.length * 1000
  });

  try {
    await tracker.sendStatusUpdate(chatId, msgId, taskId, editText, true);

    let processed = 0;
    const results = [];

    for (const filePath of filePaths) {
      // Обновить фазу с текущим файлом
      const fileName = filePath.split('/').pop();
      tracker.updatePhase(taskId, `Обработка файлов`, `${fileName} (${processed + 1}/${filePaths.length})`);

      // Обработать файл
      const result = await processor(filePath);
      results.push(result);

      processed++;
      const percent = Math.round((processed / filePaths.length) * 100);
      tracker.setProgress(taskId, percent);

      // Батчированное обновление - отправляется не более чем раз в 800мс
      tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
    }

    tracker.completeTask(taskId, true, '', `Обработано: ${processed} файлов`);
    await send(chatId, `✅ Готово! Обработано ${processed} файлов.`);

    return results;
  } catch (error) {
    tracker.completeTask(taskId, false, error.message);
    await send(chatId, `❌ Ошибка: ${error.message}`);
    throw error;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════
// ПРИМЕР 5: ПОЛУЧЕНИЕ ИСТОРИИ И СТАТИСТИКИ
// ═════════════════════════════════════════════════════════════════════════════════════

function handleTaskHistoryRequest(chatId) {
  const tracker = global.progressTracker;

  const history = tracker.buildTaskHistory();
  const stats = tracker.getStatistics();

  let message = '📊 *История и статистика задач*\n\n';
  message += history + '\n\n';

  message += '*Статистика по типам:*\n';
  for (const [type, data] of Object.entries(stats)) {
    message += `\n*${type}*:\n`;
    message += `  Всего: ${data.count}\n`;
    message += `  Среднее время: ${data.avgDuration}\n`;
    message += `  Успешность: ${data.successRate}\n`;
  }

  return message;
}

// ═════════════════════════════════════════════════════════════════════════════════════
// ИНТЕГРАЦИЯ В BOT.JS - КОД ИНИЦИАЛИЗАЦИИ
// ═════════════════════════════════════════════════════════════════════════════════════

/*
В начало bot.js добавить:

// ===== PROGRESS TRACKER INITIALIZATION =====
const { ProgressTracker, MultiTaskSupervisor } = require('./progress_tracker');
const progressTracker = new ProgressTracker();
global.progressTracker = progressTracker; // Сделать доступным везде

// Периодическая очистка старых задач (каждый час)
setInterval(() => {
  progressTracker.cleanupOldTasks();
  console.log('[ProgressTracker] Очищены старые завершённые задачи');
}, 60 * 60 * 1000);

// Экспортировать отчёт при выходе
process.on('SIGINT', () => {
  console.log('\n' + progressTracker.exportReport());
  process.exit(0);
});


Затем заменить старые вызовы:

// ДО:
const msgId = (await send(chatId, '⏳ Генерирую...', mainMenu(chatId))).message_id;
// ... долгие операции с прямым editText
await editText(chatId, msgId, '⏳ Обработка...', {});
await editText(chatId, msgId, '⏳ Финализация...', {});
await editText(chatId, msgId, '✅ Готово!', mainMenu(chatId));

// ПОСЛЕ:
const msgId = (await send(chatId, '⏳ Генерирую...', mainMenu(chatId))).message_id;
const taskId = progressTracker.startTask(chatId, 'Генерация изображения', {
  type: 'image_gen',
  model: 'dall-e-3',
  provider: 'OpenAI'
});
// ... долгие операции с батчированными обновлениями
progressTracker.updatePhase(taskId, 'Обработка');
progressTracker.setProgress(taskId, 50);
progressTracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);

// Финализация
progressTracker.completeTask(taskId, true);
await editText(chatId, msgId, '✅ Готово!', mainMenu(chatId));
*/

// ═════════════════════════════════════════════════════════════════════════════════════
// ДОПОЛНИТЕЛЬНЫЕ УТИЛИТЫ
// ═════════════════════════════════════════════════════════════════════════════════════

/**
 * Обёртка для любой async функции с отслеживанием прогресса
 */
async function withProgressTracking(chatId, msgId, taskName, asyncFn, tracker, opts = {}) {
  const taskId = tracker.startTask(chatId, taskName, opts);

  try {
    await tracker.sendStatusUpdate(chatId, msgId, taskId, editText, true);

    // Вызвать функцию, передав ей методы для обновления
    const result = await asyncFn({
      updatePhase: (phase, detail) => {
        tracker.updatePhase(taskId, phase, detail);
        tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
      },
      setProgress: (percent) => {
        tracker.setProgress(taskId, percent);
        tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
      },
      incrementProgress: (amount) => {
        tracker.incrementProgress(taskId, amount);
        tracker.scheduleStatusUpdate(chatId, msgId, taskId, editText);
      }
    });

    tracker.completeTask(taskId, true, '', result);
    return result;
  } catch (error) {
    tracker.completeTask(taskId, false, error.message);
    throw error;
  }
}

module.exports = {
  generateImageWithProgress,
  processVideoWithProgress,
  multiAgentAnalysisWithProgress,
  batchProcessFilesWithProgress,
  handleTaskHistoryRequest,
  withProgressTracking
};
