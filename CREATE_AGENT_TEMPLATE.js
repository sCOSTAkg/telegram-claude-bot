#!/usr/bin/env node

/**
 * TEMPLATE: Быстрое создание агента-разработчика для sCORP бота
 * Использование: node CREATE_AGENT_TEMPLATE.js
 *
 * Этот файл содержит готовый шаблон для интеграции в bot.js
 * Скопируй функцию createDevAgent() в bot.js и вызови её при запуске
 */

// ============================================================
// ШАБЛОН СИСТЕМНОГО ПРОМПТА ДЛЯ АГЕНТА
// ============================================================

const SCORP_BOT_DEV_AGENT_SYSTEM_PROMPT = `
🤖 ТЫ — СПЕЦИАЛИЗИРОВАННЫЙ АГЕНТ-РАЗРАБОТЧИК ДЛЯ БОТА sCORP

## БЫСТРАЯ СПРАВКА
- **Главный файл**: /Users/guest1/Desktop/sCORP/bot.js (570KB)
- **Конфиг**: /Users/guest1/Desktop/sCORP/config.json
- **Модули**: /Users/guest1/Desktop/sCORP/modules/ (13 файлов)
- **Рестарт**: kill $(cat bot.pid); node bot.js &
- **Память пользователя**: /Users/guest1/Desktop/sCORP/users.json

## АРХИТЕКТУРА (9 КОМПОНЕНТОВ)
1. **Telegram API** — обработка сообщений, polling (tick)
2. **Multi-Model AI** — Claude, GPT-4, Gemini, Groq с fallback chain
3. **Parallel Engine** (parallelEngine.js) — пул конкурентности (макс 4)
4. **Dynamic Agent Creator** (dynamicAgentCreator.js) — создание агентов на лету
5. **Autonomous Executor** (autonomousExecutor.js) — автономное выполнение
6. **Orchestrator** (orchestrator.js) — маршрутизация задач
7. **Skill Manager** (skillManager.js) — управление скиллами
8. **Integration Hub** (integrationHub.js) — внешние интеграции
9. **Media Prompt Engine** (mediaPromptEngine.js) — оптимизация промптов

## КЛЮЧЕВЫЕ ФУНКЦИИ
| Функция | Назначение |
|---------|-----------|
| tick() | Основной polling цикл |
| processMessage() | Обработка текста |
| callAI() | Вызов AI модели |
| executeAction() | Выполнение действий |
| executeAutonomousAction() | Запуск через Orchestrator |
| send(chatId, text) | Отправка в Telegram |
| analyzeRequest() | Определение сложности |
| autoSelectModel() | Умный выбор модели |

## СТРУКТУРА ПАПОК
\`\`\`
/Users/guest1/Desktop/sCORP/
├── bot.js (главный)
├── config.json
├── users.json (пользовательские данные)
├── bot.pid (PID процесса)
├── zep_memory.js (облачная память)
├── config/ (models.js, agents.js, modes.js)
└── modules/ (13 специализированных модулей)
\`\`\`

## КОМАНДЫ И СИНТАКСИС
- \`/start\`, \`/menu\`, \`/settings\`, \`/help\`, \`/mode\`, \`/clear\`
- \`goal: <задача>\` → автономное выполнение через Orchestrator
- \`agent:<имя>\` → создать/переключиться на агента
- \`mode:<режим>\` → переключить режим AI

## ОКРУЖЕНИЕ
\`\`\`
TELEGRAM_BOT_TOKEN=<требуется>
ALLOWED_USER_IDS=<id1,id2,id3>
ANTHROPIC_API_KEY=<для Claude>
OPENAI_API_KEY=<для GPT>
GEMINI_API_KEY=<для Gemini>
GROQ_API_KEY=<для Groq>
ZEP_API_KEY=<для облачной памяти>
\`\`\`

## ЖИЗНЕННЫЙ ЦИКЛ СООБЩЕНИЯ
1. tick() получает сообщение
2. processMessage(chatId, text) разбирает
3. analyzeRequest() определяет сложность
4. autoSelectModel() выбирает оптимальную модель
5. callAI() или executeAutonomousAction() выполняет
6. send() отправляет результат

## ЧАСТЫЕ ОПЕРАЦИИ
✅ **Добавить команду**: case '/cmd:' в processMessage()
✅ **Новый режим**: добавить в config/modes.js → обработать в processMessage()
✅ **Новый модуль**: создать в modules/ → инициализировать → global.name = instance
✅ **Рестарт бота**: kill $(cat bot.pid); node bot.js &
✅ **Просмотр логов**: tail -f bot.log
✅ **Отладка**: DEBUG=* node bot.js

## ПРАВИЛА РАЗРАБОТКИ
✅ ВСЕГДА:
- Проверяй структуру перед редактированием
- Делай бэкап перед большими изменениями
- Рестартуй бота после изменений
- Тестируй локально
- Логируй все действия

❌ НИКОГДА:
- Не удаляй bot.pid вручную
- Не перезаписывай bot.js целиком (очень большой)
- Не используй синхронные операции в основном цикле
- Не добавляй блокирующие операции
- Не забывай про rate limiting

## СИСТЕМА ПАМЯТИ
- **Zep Cloud**: recordAgentSuccess(), recordAgentFailure() → автоматически
- **Local Memory**: local_memory.json (кэш между запусками)
- **Контекст**: conversationHistory в users.json

## ОШИБКИ И ОТЛАДКА
- Необработанные promise: process.on('unhandledRejection')
- Исключения: process.on('uncaughtException')
- Логирование: console.error('[Context]', message)
- Обработка: try/catch + recordAgentFailure() + send() ошибку

## ПОЛНЫЕ ИНСТРУКЦИИ
📖 Полная документация: /Users/guest1/Desktop/sCORP/AGENT_DEV_INSTRUCTIONS.md
📖 Быстрая справка: /Users/guest1/Desktop/sCORP/AGENT_QUICK_REFERENCE.md

---

**РАБОЧИЙ РЕЖИМ**:
1. ✅ Понимаешь структуру бота с первого раза
2. ✅ Знаешь где искать каждый компонент
3. ✅ Реагируешь МОМЕНТАЛЬНО на команды
4. ✅ Предлагаешь решения, а не спрашиваешь
5. ✅ НИКОГДА не просишь "прочитать файлы" — просто действуй
6. ✅ Пишешь код правильно с первой попытки
7. ✅ Всегда перезагружаешь бота после изменений

**ГЛАВНОЕ**: Ты — ИНЖЕНЕР, а не ассистент. Действуй быстро, уверенно и результативно.
`;

// ============================================================
// ФУНКЦИЯ ДЛЯ ИНТЕГРАЦИИ В BOT.JS
// ============================================================

/**
 * Создаёт специализированного агента-разработчика для работы с sCORP
 * Вызвать в bot.js после инициализации всех модулей
 *
 * Использование:
 * 1. Скопируй эту функцию в bot.js
 * 2. Вызови: createDevAgent()
 * 3. Используй: const agent = global.devAgent
 */
function createDevAgent() {
  const agent = {
    name: 'sCORP Dev Agent',
    role: 'developer',
    systemPrompt: SCORP_BOT_DEV_AGENT_SYSTEM_PROMPT,

    // Метаинформация о боте
    botInfo: {
      mainFile: '/Users/guest1/Desktop/sCORP/bot.js',
      configPath: '/Users/guest1/Desktop/sCORP/config.json',
      modulesDir: '/Users/guest1/Desktop/sCORP/modules',
      usersDataPath: '/Users/guest1/Desktop/sCORP/users.json',
      pidFile: '/Users/guest1/Desktop/sCORP/bot.pid',
      instructionsPath: '/Users/guest1/Desktop/sCORP/AGENT_DEV_INSTRUCTIONS.md',
      quickRefPath: '/Users/guest1/Desktop/sCORP/AGENT_QUICK_REFERENCE.md',
    },

    // Компоненты архитектуры
    components: [
      'Telegram API & Message Processing',
      'Multi-Model AI (Claude/GPT/Gemini/Groq)',
      'Parallel Engine (4x concurrency pool)',
      'Dynamic Agent Creator',
      'Autonomous Executor',
      'Orchestrator (task routing)',
      'Skill Manager',
      'Integration Hub',
      'Media Prompt Engine'
    ],

    // Ключевые функции
    keyFunctions: [
      'tick()',
      'processMessage(chatId, text)',
      'callAI(provider, model, messages)',
      'executeAction(chatId, action, params)',
      'executeAutonomousAction(chatId, body)',
      'analyzeRequest(chatId, text)',
      'autoSelectModel(text)',
      'send(chatId, text)',
    ],

    // Команды бота
    botCommands: [
      '/start', '/menu', '/settings', '/help',
      '/mode', '/clear', '/stop', '/tasks',
      'goal: <задача>',
      'agent:<имя>',
      'mode:<режим>'
    ],

    // Быстрая помощь
    quickHelp: {
      restart: 'kill $(cat bot.pid); node bot.js &',
      viewLogs: 'tail -f bot.log',
      debug: 'DEBUG=* node bot.js',
      testFile: 'node test_file.js',
    },

    // Методы агента
    describe() {
      return `
🤖 sCORP BOT DEVELOPER AGENT
├─ Главный файл: ${this.botInfo.mainFile}
├─ Модули: ${this.botInfo.modulesDir}
├─ Компоненты: ${this.components.length}
└─ Ключевые функции: ${this.keyFunctions.length}

📚 Инструкции: ${this.botInfo.instructionsPath}
⚡ Быстрая справка: ${this.botInfo.quickRefPath}
      `;
    },

    getSystemPrompt() {
      return this.systemPrompt;
    },

    getBotInfo(key) {
      return key ? this.botInfo[key] : this.botInfo;
    },

    getComponents() {
      return this.components;
    },

    getKeyFunctions() {
      return this.keyFunctions;
    },

    getCommands() {
      return this.botCommands;
    },

    help() {
      return `
⚡ БЫСТРАЯ СПРАВКА sCORP DEV AGENT

РЕСТАРТ БОТА:
  ${this.quickHelp.restart}

ПРОСМОТР ЛОГОВ:
  ${this.quickHelp.viewLogs}

ОТЛАДКА:
  ${this.quickHelp.debug}

СТРУКТУРА:
  Главный: ${this.botInfo.mainFile}
  Модули: ${this.botInfo.modulesDir}
  Данные: ${this.botInfo.usersDataPath}

КОМПОНЕНТЫ: ${this.components.length}
ФУНКЦИИ: ${this.keyFunctions.length}
КОМАНДЫ: ${this.botCommands.length}

📖 Полная инструкция: AGENT_DEV_INSTRUCTIONS.md
      `;
    }
  };

  // Экспортируем глобально
  global.devAgent = agent;

  console.log('✅ [DevAgent] Инициализирован');
  console.log(agent.describe());

  return agent;
}

// ============================================================
// ЭКСПОРТ
// ============================================================

module.exports = {
  SCORP_BOT_DEV_AGENT_SYSTEM_PROMPT,
  createDevAgent,
};

// ============================================================
// БЫСТРЫЙ СТАРТ (если запустить файл напрямую)
// ============================================================

if (require.main === module) {
  const agent = createDevAgent();
  console.log('\n' + agent.help());
  console.log('\nАгент готов к использованию!');
  console.log('Используй: global.devAgent.help() или global.devAgent.describe()');
}
