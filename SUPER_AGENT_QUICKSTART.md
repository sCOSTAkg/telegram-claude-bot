# 🚀 SUPER-AGENT FACTORY - БЫСТРЫЙ СТАРТ

## Шаг 1: Подключение в bot.js

Добавьте после импортов в начало `bot.js`:

```javascript
// ==========================================
// SUPER-AGENT FACTORY SYSTEM
// ==========================================
const { initSuperAgentSystem } = require('./modules/superAgentIntegration');

// Инициализируем систему
const superAgentFactory = initSuperAgentSystem(bot, {
  usersFile: './users.json',
  dataDir: './data'
});

console.log('[Bot] ✅ Система супагентов активирована');
// ==========================================
```

## Шаг 2: Перезагрузить бот

```bash
kill $(cat bot.pid); node bot.js &
```

## Шаг 3: Тестировать команды

Откройте чат с ботом и выполните:

```
/team Создать рекламную кампанию для интернет-магазина электроники
```

**Результат:**

```
⏳ Анализирую задачу и создаю команду супагентов...

✨ КОМАНДА СУПАГЕНТОВ СОЗДАНА И ВЫПОЛНИЛА ЗАДАЧУ

📋 Задача: Создать рекламную кампанию для интернет-магазина электроники

🤖 Созданные агенты:
   • task-coordinator (agent-task-coordinator-1741183456789)
   • executor (agent-executor-1741183456790)
   • reviewer (agent-reviewer-1741183456791)

💾 Агенты сохранены в память и будут переиспользоваться!

📊 Качество выполнения: 75.3%
```

---

## Все доступные команды

| Команда | Описание | Пример |
|---------|---------|--------|
| `/team` | Создать команду супагентов | `/team Создать кампанию для клининга` |
| `/agents` | Показать всех агентов | `/agents` |
| `/skills` | Показать все скиллы | `/skills` |
| `/team-status` | Статус команды | `/team-status` |
| `/task-history` | История задач | `/task-history` |

---

## 🔥 Примеры реальных задач

### Пример 1: Маркетинг для SaaS

```
/team Нужна полная маркетинг стратегия для SaaS продукта "облако для отзывов".
Включить:
- Копирайтинг для лендинга
- UX/UI дизайн
- SEO оптимизацию
- Content strategy
- Social media plan
```

**Система создаст агентов:**
- 📝 copywriter (написание текстов)
- 🎨 designer (дизайн)
- 🔍 seo-specialist (оптимизация)
- 📱 social-media-strategist (соцсети)
- 🎯 task-coordinator (управление)

**Сгенерирует скиллы:**
- content-creator (на основе best practices copywriting)
- photo-prompt (для создания рекламных фото)
- seo-optimization (на основе Google guidelines)

---

### Пример 2: Видео-продакшн

```
/team Помощь в создании YouTube видео на тему "как начать с нуля в программировании"
Нужны:
- Сценарист
- Видеограф
- Монтажер
- Озвучка
```

**Система создаст:**
- 📖 scriptwriter (сценарий)
- 📹 videographer (съемка)
- ✂️ video-editor (монтаж)
- 🎤 voice-actor (озвучка)

---

### Пример 3: Разработка приложения

```
/team Помощь в разработке мобильного приложения для трекинга привычек.
Что нужно:
- UI/UX дизайн
- Frontend разработка (React Native)
- Backend API (Node.js)
- База данных
- Тестирование
```

**Система создаст:**
- 🎨 ux-ui-designer (дизайн)
- 💻 frontend-developer (мобильный код)
- ⚙️ backend-developer (API)
- 🧪 qa-engineer (тестирование)

---

## 💻 Программное использование (в коде)

### Создать команду агентов программно

```javascript
const { createTeamProgrammatically } = require('./modules/superAgentIntegration');

const result = await createTeamProgrammatically(
  userId,
  'Написать блог-пост про AI'
);

console.log(result);
// {
//   success: true,
//   team: {
//     agents: [{id, role}, ...],
//     skills: ['content-creator', 'seo-optimization']
//   },
//   message: "Команда из N агентов выполнила задачу..."
// }
```

### Получить статистику пользователя

```javascript
const { getUserStats } = require('./modules/superAgentIntegration');

const stats = await getUserStats(userId);
// {
//   agentsCount: 5,
//   skillsCount: 8,
//   tasksCompleted: 12,
//   lastTaskDate: "2026-03-05T14:30:45Z",
//   totalTasksQuality: 87.5
// }
```

### Экспортировать отчет

```javascript
const { exportUserStats } = require('./modules/superAgentIntegration');

const report = exportUserStats(userId);
// Получить JSON отчет со всеми статистиками
```

---

## 📊 Мониторинг в логах

Когда команда выполняется, вы увидите в консоли:

```
[SuperAgentFactory] Анализирую задачу: "Создать рекламную кампанию..."
[SuperAgentFactory] Исследую документацию для: []
[SuperAgentFactory] 🤖 Создаю супагента: task-coordinator
   ✅ Агент создан: agent-task-coordinator-1741183456789
[SuperAgentFactory] 🤖 Создаю супагента: executor
   ✅ Агент создан: agent-executor-1741183456790
[SuperAgentFactory] 🚀 Запускаю команду из 2 агентов
   ▶️  task-coordinator начинает работу...
   ▶️  executor начинает работу...
[SuperAgentFactory] 📊 Синтезирую результаты команды...
[SuperAgentFactory] 💾 Сохраняю команду в память пользователя...
   ✅ Сохранено:
   - 2 агентов
   - 0 скиллов
   - История задачи
======================================================================
✨ ЗАДАЧА ЗАВЕРШЕНА КОМАНДОЙ СУПАГЕНТОВ
======================================================================
```

---

## 🛠️ Расширение: Добавить свою роль агента

Отредактируйте `modules/superAgentFactory.js`, функция `createSuperAgent()`:

```javascript
const agentConfigs = {
  // ... существующие роли ...

  'my-custom-role': {
    specialization: 'Описание роли',
    systemPrompt: `Ты мастер в области...
    
    Твои скиллы:
    - Скилл 1
    - Скилл 2
    
    Твоя задача: ${taskContext}`,
    capabilities: ['capability1', 'capability2'],
    maxSteps: 5
  }
};
```

Теперь команда `/team` сможет использовать эту роль!

---

## ⚙️ Настройка

### Изменить файл с пользователями

```javascript
const superAgentFactory = initSuperAgentSystem(bot, {
  usersFile: './my-custom-users.json',  // ← вместо ./users.json
  dataDir: './my-data'
});
```

### Программная настройка factory

```javascript
const SuperAgentFactory = require('./modules/superAgentFactory');

const factory = new SuperAgentFactory({
  usersFile: './users.json',
  dataDir: './data',
  customConfig: 'value'
});
```

---

## 🐛 Troubleshooting

### ❌ Ошибка: "Cannot find module superAgentFactory"

**Решение:** Убедитесь что файлы в `modules/` существуют:
```bash
ls -la modules/
# superAgentFactory.js
# superAgentCommands.js
# superAgentIntegration.js
```

### ❌ Ошибка: "users.json not found"

**Решение:** Убедитесь что файл `users.json` существует:
```bash
cat users.json
# { "123456789": {...}, ... }
```

Если файла нет, создайте:
```bash
echo '{}' > users.json
```

### ❌ Команды не работают

**Решение:** Проверьте что bot экспортируется в `bot.js`:
```javascript
module.exports = bot;
```

И что инициализация выполнена:
```javascript
const { initSuperAgentSystem } = require('./modules/superAgentIntegration');
initSuperAgentSystem(bot);
```

---

## 📈 Будущие улучшения

- ✅ Architecture (готово)
- ⏳ Real Claude API integration
- ⏳ NotebookLM research
- ⏳ Parallel task execution
- ⏳ Machine learning optimization
- ⏳ Agent versioning
- ⏳ Skill marketplace

---

**Система полностью готова к использованию! 🚀**

Просто добавьте 3 строки в bot.js и начните создавать супагентов!
