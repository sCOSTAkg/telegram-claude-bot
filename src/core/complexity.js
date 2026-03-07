
function estimateComplexity(text, agentEnabled, chatId) {
  const t = text.toLowerCase();
  const len = text.length;

  // 1. Совсем простые фразы
  if (len < 30 || /^(привет|хай|ку|здравствуй|ок|да|нет|понял|ладно|hi|hello|hey|thanks|ok|yes|no)$/i.test(t.trim())) {
    return { complexity: 'none', maxSteps: 1 };
  }

  // 2. Инженерные задачи (нужны инструменты)
  const needsTools = /установи|запусти|выполни|команда|скрипт|install|run|execute|command|shell|npm|git|docker|файл|папк|путь|path|grep|glob|read|write|edit/i.test(t);

  if (needsTools) {
    return { complexity: 'complex', maxSteps: 30 };
  }

  // 3. Анализ или длинный текст
  if (len > 1000 || /проанализируй|анализ|разбери|подробно|детально|сравни|исследуй|review|analyze|explain in detail/i.test(t)) {
    return { complexity: 'medium', maxSteps: 20 };
  }

  // 4. По умолчанию для агента (если включен)
  if (agentEnabled) {
    return { complexity: 'simple', maxSteps: 10 };
  }

  return { complexity: 'none', maxSteps: 1 };
}
