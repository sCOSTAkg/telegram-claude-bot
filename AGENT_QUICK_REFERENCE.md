# sCORP Бот - Быстрая Справка для Агента

## 1. ГЛАВНЫЙ ФАЙЛ И РЕСТАРТ
- **Главный файл**: `/Users/guest1/Desktop/sCORP/bot.js` (~570KB, ~7100 строк)
- **PID файл**: `/Users/guest1/Desktop/sCORP/bot.pid`
- **Рестарт**: `kill $(cat bot.pid); node bot.js &`
- **Конфиги**: `config.json` (настройки), `users.json` (данные пользователей)

## 2. АРХИТЕКТУРА - ГЛАВНЫЕ КОМПОНЕНТЫ

| Компонент | Файл | Задача |
|-----------|------|--------|
| **Telegram API** | bot.js | Polling сообщений, обработка команд |
| **Multi-Model AI** | config/models.js | Claude, GPT-4, Gemini, Groq с fallback |
| **Parallel Engine** | modules/parallelEngine.js | Пул (макс 4 одновременных вызова) |
| **Autonomous Executor** | modules/autonomousExecutor.js | Автономное выполнение задач |
| **Orchestrator** | modules/orchestrator.js | Маршрутизация между агентами |
| **Dynamic Agents** | modules/dynamicAgentCreator.js | Создание агентов на лету |
| **Skill Manager** | modules/skillManager.js | Управление кастомными скиллами |
| **Media Prompt Engine** | modules/mediaPromptEngine.js | Генерация промптов для изображений/видео |
| **Zep Memory** | zep_memory.js | Облачная память опыта агентов |

## 3. СТРУКТУРА ПАПОК

```
/Users/guest1/Desktop/sCORP/
├── bot.js                    # Главный файл
├── config.json              # Конфигурация
├── users.json               # Данные пользователей
├── zep_memory.js            # Облачная память
├── local_memory.json        # Локальная память
│
├── config/
│   ├── models.js            # AI модели (MODEL_MAP, PROVIDER_MODELS)
│   ├── agents.js            # Предустановленные роли
│   └── modes.js             # Специализированные режимы
│
└── modules/                 # 13 модулей
    ├── parallelEngine.js
    ├── autonomousExecutor.js
    ├── orchestrator.js
    ├── dynamicAgentCreator.js
    ├── skillManager.js
    ├── integrationHub.js
    ├── mediaPromptEngine.js
    └── ... (остальные)
```

## 4. КЛЮЧЕВЫЕ ФУНКЦИИ И КОМАНДЫ

### Основные функции обработки
- `tick()` - основной polling цикл
- `processMessage(chatId, text, meta)` - обработка текстовых сообщений
- `callAI(provider, model, messages)` - вызов AI с fallback
- `autoSelectModel(text, history)` - умный выбор модели
- `analyzeRequest(chatId, text, complexity)` - анализ запроса
- `send(chatId, text, extra)` - отправка сообщения
- `executeAction(chatId, action, params)` - выполнение действий

### Команды бота
- `/start`, `/menu`, `/settings`, `/mode`, `/help`, `/tasks`, `/stop`, `/clear`, `/office`

### Специальный синтаксис
- `goal: <задача>` - автономное выполнение (запуск Orchestrator)
- `agent:<имя>` - создание/переключение на агента
- `mode:<режим>` - переключение режима AI

## 5. БЫСТРЫЕ СОВЕТЫ

### ✅ ВСЕГДА ДЕЛАЙ
1. Перезагружай бота после изменений: `kill $(cat bot.pid); node bot.js &`
2. Проверяй наличие файлов перед редактированием
3. Смотри логи при ошибках: `tail -f bot.log`
4. Сохраняй backup перед большими изменениями
5. Тестируй локально перед деплоем

### ❌ НИКОГДА НЕ ДЕЛАЙ
1. Не удаляй `bot.pid` вручную (бот управляет сам)
2. Не перезаписывай `bot.js` целиком (используй точечное редактирование)
3. Не забывай про rate limiting (rateLimitMap, 500ms min)
4. Не используй синхронные операции в основном цикле
5. Не добавляй блокирующие операции без async/await

## 6. ЖИЗНЕННЫЙ ЦИКЛ СООБЩЕНИЯ

1. `tick()` получает сообщение
2. `processMessage()` разбирает текст
3. Если команда → специальный обработчик
4. Если `goal:` → автономное выполнение → Orchestrator
5. Если текст → `analyzeRequest()` → выбор модели → `callAI()`
6. Результат отправляется пользователю

## 7. СИСТЕМА ПАМЯТИ

- **Zep Cloud**: облачное хранилище (`recordAgentSuccess()`, `recordAgentFailure()`)
- **Local Memory**: файл `local_memory.json` для кэширования
- **Контекст**: история разговора в `users.json` (chatId → conversationHistory)

## 8. ПОЛЬЗОВАТЕЛЬСКИЕ ДАННЫЕ (users.json)

```json
{
  "chatId": {
    "username": "string",
    "role": "user|admin",
    "conversationHistory": [...],
    "currentAgent": "string",
    "preferences": { "model": "...", "mode": "..." }
  }
}
```

Доступ: `const user = userConfigs.get(chatId)`;

## 9. ОКРУЖЕНИЕ

```bash
TELEGRAM_BOT_TOKEN=<токен>
ALLOWED_USER_IDS=<id1,id2,id3>
ANTHROPIC_API_KEY=<ключ>      # Claude
GEMINI_API_KEY=<ключ>         # Gemini
OPENAI_API_KEY=<ключ>         # GPT
GROQ_API_KEY=<ключ>           # Groq
ZEP_API_KEY=<ключ>            # Cloud Memory
ZEP_API_URL=<url>
```

## 10. ЧАСТЫЕ ЗАДАЧИ

### Добавить новую команду
```javascript
case '/mycommand':
  await send(chatId, 'Результат');
  break;
```

### Добавить новый модуль
1. Создать файл в `modules/`
2. Экспортировать класс
3. Инициализировать в bot.js
4. Добавить в глобальный namespace: `global.moduleName = instance`

### Отладить функцию
```javascript
// Со своей меткой:
console.log('[FunctionName]', 'value:', value);

// Или через DEBUG:
if (process.env.DEBUG) console.log('[Debug]', value);
```

## 11. РОЛИ АГЕНТОВ (из config/agents.js)

Доступные роли: `coder`, `developer`, `designer`, `analyst`, `researcher`, `writer`, `translator`, `executor`, `security_expert`, `devops`, `architect` и другие.

Создание кастомного агента: напишите `agent:MyCustomAgent`

---

**Версия**: 1.0
**Дата**: 2026-03-06
**Статус**: Актуально
