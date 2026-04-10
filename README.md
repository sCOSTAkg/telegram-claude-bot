# 🤖 sCORP — Многоагентный Telegram Bot с Claude, GPT, Gemini & Groq

Продвинутый Telegram бот с поддержкой нескольких AI моделей, автономными агентами, генерацией медиа и интеграциями с различными сервисами.

> **Актуально на 10 апреля 2026**
>
> Структура проекта и состав модулей активно развиваются. Если отдельные пути, команды или названия файлов отличаются от текущего состояния репозитория, ориентируйтесь на фактическую структуру в корне проекта и актуальные разделы документации ниже.


## ✨ Основные возможности

### 🧠 Multi-Model AI
- **Claude** (Anthropic) — основной модель для рассуждений
- **GPT-4** (OpenAI) — быстрые ответы и текст
- **Gemini** (Google) — голосовая транскрипция и медиа
- **Groq** (LPU) — сверхбыстрые ответы в реальном времени

### 🤖 Автономные агенты
- **Multi-agent система** с параллельным выполнением
- **Динамическое создание агентов** в runtime
- **Super Agent** с полным контролем над функциями
- **Skill Manager** для управления способностями
- **Knowledge Base** с долгосрочной памятью

### 📱 Мультимедиа генерация
- 🖼️ Генерация изображений (Imagen, Stable Diffusion)
- 🎥 Создание видео (Veo 3.1, Pika, Runway)
- 🎙️ Голосовая транскрипция (Gemini 2.5)
- 📝 Голосовое общение и аудио

### 🔌 Интеграции
- **Vercel** (развертывание мини-приложений)
- **Pixel Office Mini App** — визуализация статуса агентов
- **MCP протокол** (интеграция с 500+ сервисами)
- **NotebookLM** (глубокие исследования)
- **Webhook система** для входящих уведомлений

### ⚙️ Система плагинов
- 🔐 action-logger — логирование всех действий
- ₿ crypto-price — котировки криптовалют
- 💱 exchange — курсы валют
- 📝 notes — личные заметки
- 🍅 pomodoro — таймер фокуса
- 🔗 qr — генерация QR-кодов
- ✅ todo — управление задачами
- 🌐 translate — переводчик
- 🌤️ weather — прогноз погоды

### 📊 Продвинутые функции
- **Emotional Intelligence** модуль для анализа эмоций
- **Progress Tracker** для отслеживания задач
- **Status Monitoring** с real-time обновлениями
- **Memory System** с дедупликацией
- **Voice Transcription** встроенная в Gemini API

## 🚀 Быстрый старт

### Установка

```bash
# Клонируйте репозиторий
git clone https://github.com/sCOSTAkg/telegram-claude-bot.git
cd telegram-claude-bot

# Установите зависимости
npm install

# Создайте .env файл
cp .env.example .env
```

### Конфигурация

Отредактируйте `.env`:

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here
YOUR_TELEGRAM_ID=your_user_id

# AI Models
CLAUDE_API_KEY=your_claude_key
OPENAI_API_KEY=your_openai_key
GEMINI_API_KEY=your_gemini_key
GROQ_API_KEY=your_groq_key

# Опциональные сервисы
VERCEL_TOKEN=your_vercel_token
```

### Запуск

```bash
# Запустить бота
node bot.js

# Или с процесс-менеджером (PM2)
npm install -g pm2
pm2 start bot.js --name sCORP
pm2 save
pm2 startup
```

## 📚 Документация

- **[AGENT_DEV_INSTRUCTIONS.md](AGENT_DEV_INSTRUCTIONS.md)** — Полная инструкция для разработчиков агентов
- **[AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md)** — Быстрая справка
- **[SUPER_AGENT_README.md](SUPER_AGENT_README.md)** — Документация Super Agent
- **[BOT_INTEGRATION_EXAMPLE.js](BOT_INTEGRATION_EXAMPLE.js)** — Примеры интеграции
- **[MASTER_REPORT.md](MASTER_REPORT.md)** — Подробный обзор модулей и интеграций

## 🏗️ Архитектура

```
sCORP/
├── bot.js                          # Главный файл бота (7100+ строк)
├── config/                         # Конфигурация
│   ├── agents.js                  # Конфиги агентов
│   ├── models.js                  # Конфиги моделей
│   └── modes.js                   # Режимы работы
├── modules/                        # Основные модули
│   ├── orchestrator.js            # Оркестрация агентов
│   ├── parallelEngine.js          # Параллельное выполнение
│   ├── superAgentFactory.js       # Создание супер-агентов
│   ├── skillManager.js            # Управление навыками
│   └── knowledgeBase.js           # База знаний
├── plugins/                        # Плагины для функциональности
├── skills/                         # Специальные навыки
├── miniapp/                        # Pixel Office Mini App (React)
├── landing/                        # Лендинг страница
└── src/                           # Исходный код (модульная структура)
```

## 🔧 Разработка агентов

### Создать нового агента

```javascript
const agent = await botInstance.createAgent({
  name: 'MyAgent',
  model: 'claude',
  instructions: 'Your instructions here',
  tools: ['web_search', 'code_generation'],
  mode: 'autonomous'
});
```

### Запустить агента

```javascript
const result = await agent.execute(userMessage);
```

## 🔐 Безопасность

- ✅ ID-based доступ (только авторизованные пользователи)
- ✅ API ключи в `.env` (никогда не в коде)
- ✅ Логирование всех действий
- ✅ Аудит безопасности в [SECURITY_AUDIT.md](SECURITY_AUDIT.md)

## 📊 Система мониторинга

Bot отслеживает:
- 📈 Производительность агентов
- ⏱️ Время выполнения
- 🔄 Параллельные задачи
- 🎯 Выполнение целей
- 💾 Использование памяти

Визуализация доступна через **Pixel Office Mini App**.

## 🎯 Примеры использования

### Создание контента
```
/agent create_content
Напиши 10 идей для Telegram поста про AI
```

### Анализ данных
```
/agent analyze_data
CSV: [данные]
Найди тренды и аномалии
```

### Кодирование
```
/agent code
Напишите функцию для парсинга JSON
```

### Мультимодальные задачи
```
/parallel
- Агент 1: Напиши статью
- Агент 2: Создай изображение
- Агент 3: Сгенерируй видео
```

## 🤝 Контрибьютинг

1. Fork репозиторий
2. Создайте feature branch (`git checkout -b feature/amazing-feature`)
3. Commit изменения (`git commit -m 'Add amazing feature'`)
4. Push в branch (`git push origin feature/amazing-feature`)
5. Откройте Pull Request

## 📝 Лицензия

MIT — используйте свободно\!

## 🔗 Ссылки

- **GitHub**: https://github.com/sCOSTAkg/telegram-claude-bot
- **Telegram**: [@sCORPbot](https://t.me/sCORPbot)
- **Документация**: [Полная документация](MASTER_REPORT.md)

## 📞 Поддержка

Если у вас есть вопросы:
- 📖 Проверьте документацию
- 🐛 Создайте Issue на GitHub
- 💬 Напишите в Telegram бота

---

**Версия**: 2.1.0  
**Последнее обновление**: 2026-03-06  
**Статус**: ✅ Production Ready
