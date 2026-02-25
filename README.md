# 🤖 Telegram Bot для Claude Code

Telegram бот для удаленного доступа к Claude Code CLI на вашем Mac.

## 📋 Возможности

- ✉️ Отправляйте команды Claude через Telegram
- 🔒 Защита по ID пользователя
- ⚡ Быстрые ответы в реальном времени
- 📱 Работает откуда угодно

## 🚀 Установка

### Шаг 1: Установка зависимостей

```bash
cd ~/telegram-claude-bot
npm install
```

### Шаг 2: Создание бота в Telegram

1. Откройте Telegram и найдите бота **@BotFather**
2. Отправьте команду `/newbot`
3. Следуйте инструкциям:
   - Введите имя бота (например: "My Claude Bot")
   - Введите username бота (должен заканчиваться на "bot", например: "my_claude_code_bot")
4. BotFather отправит вам токен в формате: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`
5. **Скопируйте этот токен!**

### Шаг 3: Получение вашего Telegram ID

1. Найдите в Telegram бота **@userinfobot**
2. Отправьте ему `/start`
3. Он покажет ваш ID (например: 123456789)
4. **Скопируйте этот ID!**

### Шаг 4: Настройка конфигурации

```bash
# Создайте файл .env из шаблона
cp .env.example .env

# Откройте .env в редакторе
nano .env
```

Вставьте ваши данные:
```
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
ALLOWED_USER_IDS=123456789
WORKING_DIR=/Users/guest1
```

Сохраните файл (Ctrl+O, Enter, Ctrl+X в nano).

## ▶️ Запуск бота

```bash
npm start
```

Вы должны увидеть:
```
🤖 Telegram-Claude Bot запущен!
🔒 Разрешенные пользователи: 123456789
```

## 📱 Использование

1. Найдите вашего бота в Telegram (по username, который вы создали)
2. Отправьте `/start`
3. Начните отправлять команды!

### Примеры команд:

```
Создай файл test.txt с текстом "Hello World"
```

```
Покажи содержимое текущей директории
```

```
Помоги мне исправить ошибку в коде
```

### Команды бота:

- `/start` - Приветственное сообщение
- `/help` - Помощь по использованию
- `/status` - Проверить статус бота
- `/clear` - Очистить текущую сессию

## 🔄 Автозапуск при старте системы (опционально)

### Создание launchd service для macOS:

```bash
# Создайте файл plist
nano ~/Library/LaunchAgents/com.telegram.claude.bot.plist
```

Вставьте следующее содержимое:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.telegram.claude.bot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/guest1/telegram-claude-bot/bot.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/Users/guest1/telegram-claude-bot</string>
    <key>StandardOutPath</key>
    <string>/Users/guest1/telegram-claude-bot/bot.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/guest1/telegram-claude-bot/bot.error.log</string>
</dict>
</plist>
```

Загрузите службу:

```bash
launchctl load ~/Library/LaunchAgents/com.telegram.claude.bot.plist
```

Проверьте статус:

```bash
launchctl list | grep claude
```

Для остановки:

```bash
launchctl unload ~/Library/LaunchAgents/com.telegram.claude.bot.plist
```

## 🔒 Безопасность

- Бот проверяет ID пользователя перед выполнением команд
- Только пользователи из `ALLOWED_USER_IDS` могут использовать бота
- Храните токен бота в секрете!
- Не делитесь файлом `.env` с другими

## 🐛 Решение проблем

### Бот не отвечает:
- Проверьте, запущен ли бот (`npm start`)
- Проверьте правильность токена в `.env`
- Убедитесь, что ваш ID добавлен в `ALLOWED_USER_IDS`

### Команды не выполняются:
- Проверьте, установлен ли Claude Code CLI
- Проверьте путь `WORKING_DIR` в `.env`
- Убедитесь, что у процесса есть права на выполнение команд

### Ошибка "command not found: claude":
- Убедитесь, что Claude Code установлен
- Проверьте PATH в переменных окружения

## 📝 Логи

Логи бота сохраняются в:
- `bot.log` - обычный вывод
- `bot.error.log` - ошибки

## 📄 Лицензия

ISC
