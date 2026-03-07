# 🤖 ИНСТРУКЦИЯ ДЛЯ АГЕНТА-РАЗРАБОТЧИКА sCORP

## ⚡ БЫСТРЫЙ СТАРТ
- **Главный файл**: `/Users/guest1/Desktop/sCORP/bot.js` (~570KB, ~7100 строк)
- **Конфиг**: `/Users/guest1/Desktop/sCORP/config.json`
- **Пользовательские данные**: `/Users/guest1/Desktop/sCORP/users.json`
- **Модули**: `/Users/guest1/Desktop/sCORP/modules/` (13 файлов)
- **PID файл**: `/Users/guest1/Desktop/sCORP/bot.pid`
- **Перезагрузка бота**: `kill $(cat bot.pid); node bot.js &`

---

## 📋 АРХИТЕКТУРА БОТА

### Основные компоненты

#### 1. **Telegram API & Обработка сообщений**
- Библиотека: `telegram-bot-api` (curl запросы)
- API Endpoint: `https://api.telegram.org/bot{TOKEN}`
- File API: `https://api.telegram.org/file/bot{TOKEN}`
- Основной обработчик: `tick()` функция — polling сообщений
- Rate limiting: `rateLimitMap` для callback queries (500ms min)

#### 2. **Система Multi-Model AI**
- **Поддерживаемые провайдеры**: Claude, GPT-4, Gemini, Groq
- **Конфиг моделей**: `./config/models.js`
  - `MODEL_MAP` — маппинг моделей
  - `PROVIDER_MODELS` — доступные модели по провайдерам
  - `IMAGE_MODELS` — генерация изображений
  - `VIDEO_MODELS` — генерация видео
- **Fallback chain**: автоматический откат если модель недоступна
- **Функции**:
  - `callAI()` — базовый вызов AI
  - `callAIWithFallback()` — с автоматическим откатом
  - `autoSelectModel()` — умный выбор модели по контексту

#### 3. **Параллельный движок (Parallel Engine)**
- **Модуль**: `./modules/parallelEngine.js`
- **Пул конкурентности**: `globalPool` (макс 4 параллельных AI-вызова)
- **Классы**:
  - `ConcurrencyPool` — управление одновременными вызовами
  - `ProgressAggregator` — агрегация прогресса
  - `TaskChain` — цепочка зависимых задач
- **Функции**:
  - `detectDomain()` — определение домена задачи
  - `detectRolesForTask()` — выбор ролей агентов
  - `autoDelegate()` — автоматическое делегирование задач
  - `shouldGenerateSkill()` — нужно ли генерировать скилл

#### 4. **Динамическое создание агентов**
- **Модуль**: `./modules/dynamicAgentCreator.js`
- **Класс**: `DynamicAgentCreator`
- **Возможности**: создание агентов с динамическими инструкциями на лету
- **Методы**: `createAgent()`, `listAgents()`, `getAgentPrompt()`

#### 5. **Автономное выполнение**
- **Модуль**: `./modules/autonomousExecutor.js`
- **Класс**: `AutonomousExecutor`
- **Функция**: `executeAutonomousAction()` — запуск автономных задач
- **Восстановление**: при старте бота восстанавливаются незавершённые задачи

#### 6. **Оркестратор**
- **Модуль**: `./modules/orchestrator.js`
- **Класс**: `Orchestrator`
- **Назначение**: умная маршрутизация задач между агентами
- **Метод**: `orchestrator.execute(chatId, goal, options)`

#### 7. **Менеджер скиллов**
- **Модуль**: `./modules/skillManager.js`
- **Класс**: `SkillManager`
- **Функции**: управление кастомными скиллами пользователей

#### 8. **Integration Hub**
- **Модуль**: `./modules/integrationHub.js`
- **Класс**: `IntegrationHub`
- **Функции**: интеграция с внешними сервисами

#### 9. **MediaPromptEngine**
- **Модуль**: `./modules/mediaPromptEngine.js`
- **Назначение**: генерация оптимальных промптов для изображений и видео
- **Поддерживает**: Midjourney, DALL-E, Stable Diffusion, Flux и др.

#### 10. **Zep Memory**
- **Файл**: `./zep_memory.js`
- **Назначение**: облачное хранилище памяти (агент experience)
- **Функции**:
  - `recordAgentSuccess()` — запись успешных выполнений
  - `recordAgentFailure()` — запись ошибок

---

## 🎯 КЛЮЧЕВЫЕ ФУНКЦИИ И КОМАНДЫ

### Обработка команд
```javascript
// Команды бота (в menu)
/start, /menu, /settings, /mode, /help, /tasks, /stop, /clear, /office
```

### Основные функции обработки

| Функция | Назначение |
|---------|-----------|
| `tick()` | Основной polling цикл |
| `processMessage(chatId, text, meta)` | Обработка текстовых сообщений |
| `executeAction(chatId, action, params)` | Выполнение действий |
| `callAI(provider, model, messages, ...)` | Вызов AI модели |
| `analyzeRequest(chatId, text, complexity)` | Анализ запроса на сложность |
| `autoSelectModel(text, autoMap, history)` | Умный выбор модели |
| `send(chatId, text, extra)` | Отправка сообщения |
| `edit(chatId, msgId, text, extra)` | Редактирование сообщения |
| `rewriteQuery(chatId, text)` | Переформулирование запроса (для поиска) |

### Специальные команды

| Команда | Эффект |
|---------|--------|
| `goal: <задача>` | Автономное выполнение (запуск Orchestrator) |
| `agent:<имя>` | Создать или переключиться на агента |
| `mode:<режим>` | Переключить режим AI |
| `/clear` | Очистить историю сообщений |
| `/stop` | Остановить текущую задачу |

---

## 📁 СТРУКТУРА ФАЙЛОВ

```
/Users/guest1/Desktop/sCORP/
├── bot.js                          # Главный файл (570KB)
├── config.json                     # Конфиг (mtproto, channels, reminders)
├── users.json                      # Пользовательские данные
├── bot.pid                         # PID текущего процесса
├── zep_memory.js                   # Облачная память (Zep)
├── local_memory.json               # Локальная память
│
├── config/
│   ├── models.js                   # Маппинг моделей AI
│   ├── agents.js                   # Предустановленные агенты
│   └── modes.js                    # Специализированные режимы
│
├── modules/
│   ├── parallelEngine.js           # Пул конкурентности (27KB)
│   ├── autonomousExecutor.js       # Автономное выполнение (15KB)
│   ├── orchestrator.js             # Маршрутизация задач (17KB)
│   ├── dynamicAgentCreator.js      # Создание агентов (9KB)
│   ├── skillManager.js             # Менеджер скиллов (17KB)
│   ├── integrationHub.js           # Интеграции (14KB)
│   ├── mediaPromptEngine.js        # Генерация промптов (26KB)
│   ├── knowledgeBase.js            # База знаний (6KB)
│   ├── superAgentFactory.js        # Фабрика super-агентов (10KB)
│   ├── superAgentCommands.js       # Команды super-агентов (10KB)
│   └── superAgentIntegration.js    # Интеграция super-агентов (3KB)
│
├── package.json                    # Зависимости
└── ecosystem.config.js             # PM2 конфиг
```

---

## 🔄 ЖИЗНЕННЫЙ ЦИКЛ БОТА

### Инициализация (startup)
1. Загрузка `.env` файла
2. Валидация `TELEGRAM_BOT_TOKEN`
3. Инициализация глобального пула конкурентности (`globalPool`)
4. Загрузка конфигов: models, agents, modes
5. Инициализация модулей в порядке:
   - `autonomousExecutor`
   - `superAgentFactory`
   - `dynamicAgentCreator`
   - `skillManager`
   - `integrationHub`
   - `orchestrator`
6. Восстановление незавершённых автономных задач
7. Запуск `initMTProto()` (для мониторинга каналов)
8. Регистрация команд бота (`setMyCommands`)
9. Очистка старых клавиатур
10. Запуск основного цикла `tick()`

### Обработка сообщения
1. `tick()` получает новое сообщение
2. `processMessage(chatId, text, meta)` разбирает текст
3. Если команда → специальный обработчик
4. Если `goal:` → `executeAutonomousAction()` → `orchestrator.execute()`
5. Если обычное сообщение → `analyzeRequest()` → выбор модели → `callAI()`
6. Результат отправляется пользователю

### Остановка
```bash
kill $(cat bot.pid)
```
- Сохраняются пользовательские данные в `users.json`
- Сохраняются незавершённые задачи
- PID файл удаляется

---

## 🛠 КОМАНДНАЯ СТРОКА

### Запуск бота
```bash
cd /Users/guest1/Desktop/sCORP
node bot.js &
```

### Остановка и перезагрузка
```bash
# Способ 1: через PID файл
kill $(cat bot.pid)
node bot.js &

# Способ 2: прямой kill
kill <PID>
node bot.js &
```

### Просмотр логов
```bash
# Последние 50 строк
tail -50 bot.log

# Динамический просмотр
tail -f bot.log
```

### Отладка
```bash
# С дополнительным дебугом
DEBUG=* node bot.js

# С сохранением в лог
node bot.js > bot.log 2>&1 &
```

---

## 🎭 АГЕНТЫ И РОЛИ

### Предустановленные роли (из `config/agents.js`)
```
AGENT_ROLES: {
  coder, developer, designer, analyst,
  researcher, writer, translator, executor,
  security_expert, devops, architect, ...
}
```

### Создание кастомного агента
```
message: "agent:MyCustomAgent"
описание: быстро создаёт нового агента с инструкциями
```

### Super-агенты
- Специальные агенты с расширенными возможностями
- Имеют доступ к `superAgentCommands`
- Управляются через `superAgentFactory` и `superAgentIntegration`

---

## 🧠 СИСТЕМА ПАМЯТИ

### Zep Cloud Memory
- Облачное хранилище опыта агентов
- Функции:
  - `recordAgentSuccess(action, body, output, model, ms)`
  - `recordAgentFailure(action, body, error, model)`
- **Автоматически** записывает в cloud при каждом выполнении

### Local Memory
- Файл: `local_memory.json`
- Используется для кэширования информации между запусками
- Ручное управление

### Контекст разговора
- Хранится в памяти пользователя в `users.json`
- Используется для `analyzeRequest()` и выбора модели

---

## 🔐 ПОЛЬЗОВАТЕЛЬСКИЕ ДАННЫЕ

### Структура `users.json`
```json
{
  "chatId": {
    "username": "string",
    "role": "user|admin",
    "conversationHistory": [...],
    "currentAgent": "string",
    "preferences": {
      "model": "string",
      "mode": "string"
    },
    "agents": {...},
    "skills": [...],
    "settings": {...}
  }
}
```

### Доступ к данным пользователя
```javascript
const userData = userConfigs.get(chatId);
userConfigs.set(chatId, updatedData);
```

---

## ⚙️ ОКРУЖЕНИЕ И ПЕРЕМЕННЫЕ

### Требуемые переменные окружения
```bash
TELEGRAM_BOT_TOKEN=<токен>
ALLOWED_USER_IDS=<id1,id2,id3>    # Список админов

# Для Claude
ANTHROPIC_API_KEY=<ключ>
CLAUDE_PATH=/opt/homebrew/bin/claude

# Для Gemini
GEMINI_API_KEY=<ключ>
GEMINI_CLI_PATH=/opt/homebrew/bin/gemini

# Для GPT
OPENAI_API_KEY=<ключ>

# Для Groq
GROQ_API_KEY=<ключ>

# Для Zep Memory
ZEP_API_KEY=<ключ>
ZEP_API_URL=<url>
```

---

## 🚀 БЫСТРЫЕ СОВЕТЫ ДЛЯ РАЗРАБОТЧИКА

### ✅ ВСЕГДА ДЕЛАЙ
1. **Проверь наличие файлов** перед редактированием
2. **Сохраняй backup** перед большими изменениями
3. **Перезагружай бота** после изменений: `kill $(cat bot.pid); node bot.js &`
4. **Проверяй логи** при ошибках
5. **Тестируй локально** перед деплоем
6. **Используй правильную кодировку** (UTF-8)

### ❌ НИКОГДА НЕ ДЕЛАЙ
1. ❌ Не удаляй `bot.pid` вручную (бот сам управляет)
2. ❌ Не изменяй структуру `users.json` без бэкапа
3. ❌ Не перезаписывай `bot.js` целиком (очень большой файл)
4. ❌ Не забывай про rate limiting при добавлении API запросов
5. ❌ Не используй синхронные операции в основном цикле
6. ❌ Не добавляй блокирующие операции без async/await

### 🎯 ЧАСТЫЕ ЗАДАЧИ

#### Добавить новую команду
```javascript
// В processMessage() добавить case:
case '/mycommand':
  await send(chatId, 'Результат');
  break;
```

#### Добавить новый режим AI
1. Добавить в `config/modes.js`
2. Добавить обработку в `processMessage()`
3. Передать режим в `callAI()` как параметр

#### Создать новый модуль
1. Создать файл в `modules/`
2. Экспортировать класс или объект
3. Инициализировать в основном файле
4. Добавить в глобальный namespace: `global.moduleName = instance`

#### Отладить конкретную функцию
```javascript
// Добавить console.log с меткой
console.log('[FunctionName]', 'message:', value);

// Или использовать DEBUG переменную
if (process.env.DEBUG) console.log('[Debug]', value);
```

---

## 📊 ОБРАБОТКА ОШИБОК

### Структура error handling
```javascript
try {
  // код
} catch (error) {
  console.error('[Context]', error.message);
  await send(chatId, `❌ Ошибка: ${error.message}`);
  recordAgentFailure('action', body, error, model);
}
```

### Глобальные обработчики
- `process.on('unhandledRejection', ...)` — необработанные promise отклонения
- `process.on('uncaughtException', ...)` — необработанные исключения

---

## 🔗 ИНТЕГРАЦИИ И EXTERNAL TOOLS

### Поддерживаемые CLI инструменты
- **Claude**: `/opt/homebrew/bin/claude`
- **Gemini**: `/opt/homebrew/bin/gemini`
- **Codex**: `/opt/homebrew/bin/codex`

### API Интеграции
- Telegram Bot API
- Zep Cloud Memory API
- OpenAI API (для GPT и Codex)
- Google Gemini API
- Groq API
- Anthropic Claude API

---

## 📝 ВЫВОДЫ

**Для эффективной работы агента над этим ботом:**

1. **Всегда** проверяй структуру файлов перед изменениями
2. **Помни** про PID файл при рестарте
3. **Используй** параллельный движок для одновременных операций
4. **Тестируй** каждое изменение перед продакшеном
5. **Логируй** все действия для отладки
6. **Документируй** изменения в комментариях
7. **Спрашивай** пользователя перед деструктивными операциями

---

**Версия документа**: 1.0
**Дата обновления**: 2026-03-06
**Статус**: ✅ Актуально
