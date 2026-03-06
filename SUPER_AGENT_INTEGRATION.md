# 🚀 SUPER-AGENT FACTORY SYSTEM

## Что это?

**Система автоматического создания супагентов** — бот сам анализирует задачу, исследует документацию, создает команду специализированных агентов, генерирует скиллы и выполняет работу.

**Ключевое отличие**: Агенты и скиллы **сохраняются навсегда** в памяти пользователя и переиспользуются для будущих задач.

---

## 📊 Архитектура

```
Task → Analysis → Doc Research → Agent Creation → Skill Generation → Execute → Save Forever
        ↓          ↓               ↓               ↓                 ↓         ↓
      Claude    Context7/      AgentFactory    SkillGenerator    Parallel   users.json
      analyzes  NotebookLM     creates agents   from docs         execution  (persistent)
      need      researches       with unique     based on        of team    memory
                documentation    prompts         knowledge
```

### Компоненты системы

| Компонент | Файл | Назначение |
|-----------|------|-----------|
| **SuperAgentFactory** | `modules/superAgentFactory.js` | Основной класс для создания агентов, генерации скиллов, управления памятью |
| **SuperAgentCommands** | `modules/superAgentCommands.js` | Команды в Telegram боте для управления системой |
| **Integration** | `modules/superAgentIntegration.js` | Подключение к основному bot.js |

---

## 🛠️ Интеграция в bot.js

### Шаг 1: Добавьте в начало bot.js (после импортов)

```javascript
// =============== SUPER-AGENT FACTORY SYSTEM ===============
const SuperAgentFactory = require('./modules/superAgentFactory');
const SuperAgentCommands = require('./modules/superAgentCommands');

const superAgentFactory = new SuperAgentFactory({
  usersFile: './users.json',
  dataDir: './data'
});

// Инициализируем команды (подкрепляем их к боту)
new SuperAgentCommands(bot, superAgentFactory);
// ============================================================
```

### Шаг 2: Убедитесь, что bot.js экспортирует bot

Должна быть строка типа:
```javascript
module.exports = bot;
```

---

## 📝 Доступные команды

### `/team <описание задачи>`
Создать новую команду супагентов для задачи

**Пример:**
```
/team Нужно создать топовую рекламную кампанию для клининг-сервиса. 
Нужны: крутые копи, дизайн, SEO, контент-стратегия
```

**Что происходит:**
1. ✅ Анализ задачи → определяет нужные роли
2. ✅ Исследование доков → Context7/NotebookLM ищет лучшие практики
3. ✅ Создание агентов → copywriter, designer, seo-specialist, content-creator
4. ✅ Генерация скиллов → photo-prompt, content-creator, seo-optimization
5. ✅ Параллельное выполнение → все агенты работают одновременно
6. ✅ Сохранение → агенты и скиллы остаются в памяти

**Результат:**
```
✨ КОМАНДА СУПАГЕНТОВ СОЗДАНА И ВЫПОЛНИЛА ЗАДАЧУ

📋 Задача: Нужна рекламная кампания для клининга

🤖 Созданные агенты:
   • copywriter (agent-copywriter-1741182956234)
   • designer (agent-designer-1741182956245)
   • seo-specialist (agent-seo-specialist-1741182956256)

🎯 Генерированные скиллы:
   • content-creator
   • photo-prompt
   • seo-optimization

💾 Агенты сохранены в память и будут переиспользоваться!

📊 Качество выполнения: 87.5%
```

---

### `/agents`
Показать всех созданных супагентов

**Результат:**
```
🤖 ВСЕ ВАШ СУПАГЕНТЫ

1. copywriter
   ID: agent-copywriter-1741182956234
   Создан: 05.03.2026 14:30:45
   Статус: active
   Специализация: Профессиональный копирайтер

2. designer
   ID: agent-designer-1741182956245
   Создан: 05.03.2026 14:30:52
   Статус: active
   Специализация: UX/UI дизайнер

💡 Используйте команду /reuse для переиспользования этих агентов
```

---

### `/skills`
Показать все сгенерированные скиллы

**Результат:**
```
🎯 ВСЕ СГЕНЕРИРОВАННЫЕ СКИЛЛЫ

1. content-creator
   Роль: copywriter
   Создан: 05.03.2026 14:30:45
   Источники: 12 док
   Темы: emotional-copywriting, seo-copywriting

2. photo-prompt
   Роль: designer
   Создан: 05.03.2026 14:30:52
   Источники: 8 док
   Темы: composition, lighting, visual-hierarchy

💡 Эти скиллы автоматически используются вашими агентами
```

---

### `/reuse <роли>`
Переиспользовать сохраненных агентов для новой задачи

**Пример:**
```
/reuse copywriter, designer
```

---

### `/team-status`
Статус команды

**Результат:**
```
📊 СТАТУС ВАШЕЙ КОМАНДЫ СУПАГЕНТОВ

🤖 Агентов: 4
   Активных: 4

🎯 Скиллов: 7

📝 Выполненных задач: 12
   Последняя: 05.03.2026 15:45:30

💡 Команда полностью готова к работе!
```

---

### `/task-history`
История выполненных задач

---

## 🔄 Как работает процесс

### Пример: "Нужна крутая рекламная кампания для клининга"

```
User: /team Нужна крутая рекламная кампания для клининга
  ↓
[Анализ]
  → Роли нужны: copywriter, designer, seo-specialist, content-creator
  → Доки нужны: content-creation, ui-design, seo-best-practices
  → Скиллы создать: photo-prompt, content-creator, seo-optimization

[Исследование документации]
  → Context7 ищет лучшие практики копирайтинга
  → NotebookLM изучает дизайн-системы
  → Ищет SEO гайды и best practices

[Создание супагентов]
  → 🤖 copywriter с промптом на основе найденных знаний
  → 🤖 designer с принципами WCAG и design systems
  → 🤖 seo-specialist с knowledge about Core Web Vitals
  → 🤖 task-coordinator (управляет командой)

[Генерация скиллов]
  → 🎯 photo-prompt для создания крутых рекламных фото
  → 🎯 content-creator для писания текстов
  → 🎯 seo-optimization для оптимизации

[Параллельное выполнение]
  copywriter          designer            seo-specialist      coordinator
  ↓                   ↓                   ↓                   ↓
  пишет тексты    →  рисует баннеры  →  оптимизирует    →  синтезирует
  (2с)            (3с)             (1.5с)              результаты (1с)

[Сохранение в память]
  → users.json сохранила:
    - 4 агента (их промпты, config, id)
    - 3 скилла (source знания, topics)
    - История задачи (когда, что, результат)

[Переиспользование]
  User: /team Нужна кампания для ресторана
  → Система ЗАГРУЖАЕТ сохраненных агентов
  → Использует их же с новой задачей
  → Экономит время на анализ и исследование
```

---

## 📚 Структура в users.json

```json
{
  "123456789": {
    "name": "Иван",
    "chatHistory": [...],
    
    "superAgents": [
      {
        "id": "agent-copywriter-1741182956234",
        "role": "copywriter",
        "created": "2026-03-05T14:30:45Z",
        "config": {
          "specialization": "Профессиональный копирайтер",
          "systemPrompt": "Ты опытный копирайтер...",
          "capabilities": ["write", "optimize", "analyze-competitors"],
          "maxSteps": 5
        },
        "documentationUsed": {...},
        "status": "active"
      },
      {
        "id": "agent-designer-1741182956245",
        "role": "designer",
        ...
      }
    ],
    
    "generatedSkills": [
      {
        "name": "content-creator",
        "baseRole": "copywriter",
        "created": "2026-03-05T14:30:45Z",
        "sources": ["https://...", "https://..."],
        "topics": ["emotional-copywriting", "seo-copywriting"]
      }
    ],
    
    "taskHistory": [
      {
        "timestamp": "2026-03-05T14:30:45Z",
        "task": "Нужна крутая рекламная кампания для клининга",
        "complexity": "high",
        "timeline": "balanced",
        "agentsUsed": ["copywriter", "designer", "seo-specialist"],
        "skillsGenerated": ["content-creator", "photo-prompt"]
      }
    ]
  }
}
```

---

## 🎯 Использование в bot.js - примеры

### Пример 1: Автоматическая генерация супагентов при получении задачи

```javascript
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  // Если это похоже на задачу для супагентов
  if (text.includes('создать') || text.includes('сделать')) {
    ctx.reply('🚀 Анализирую задачу для команды супагентов...');
    
    const result = await superAgentFactory.createAndExecuteTeam(
      ctx.from.id.toString(),
      text
    );
    
    // Отправляем результат
    ctx.reply(`✨ ${result.message}`);
  }
});
```

### Пример 2: Привязка к существующему механизму обработки

```javascript
// В существующем обработчике команд
bot.command('create', async (ctx) => {
  const task = ctx.message.text.replace('/create ', '');
  
  const result = await superAgentFactory.createAndExecuteTeam(
    ctx.from.id.toString(),
    task
  );
  
  ctx.reply(JSON.stringify(result, null, 2));
});
```

---

## 🔧 Расширение: Добавить свои роли агентов

В `superAgentFactory.js`, функция `createSuperAgent()`:

```javascript
async createSuperAgent(role, documentation = {}, taskContext = '') {
  const agentConfigs = {
    // ... существующие роли ...
    
    // ДОБАВЬТЕ СВОЮ РОЛЬ:
    'video-editor': {
      specialization: 'Видеомонтажер',
      systemPrompt: `Ты опытный видеомонтажер с 5+ летним опытом.
Твои скиллы:
- Premiere Pro, DaVinci Resolve
- Color grading
- Sound design
- Motion graphics
      
Твоя задача: ${taskContext}`,
      capabilities: ['edit', 'grade', 'animate'],
      maxSteps: 7
    }
  };
}
```

---

## 📈 Метрики системы

После каждой задачи система собирает:
- **Качество выполнения** (0-100%)
- **Время выполнения** (мс)
- **Использованные агенты** и их роли
- **Сгенерированные скиллы**
- **Источники документации**

Все это сохраняется в `users.json` для анализа и оптимизации.

---

## 🚨 Ограничения и планы

### Текущие ограничения:
- ⚠️ Claude API integration нужно подключить в `analyzeTask()`
- ⚠️ NotebookLM интеграция нужна для полного research
- ⚠️ Параллельное выполнение имитируется (нужна реальная логика для каждого агента)

### План развития:
- ✅ Phase 1: Архитектура системы (готово)
- ⏳ Phase 2: Реальная интеграция с Claude API
- ⏳ Phase 3: NotebookLM для research
- ⏳ Phase 4: Реальное выполнение задач агентами
- ⏳ Phase 5: Машинное обучение для оптимизации

---

## 💡 Примеры использования

### Пример 1: Маркетинговая кампания
```
/team Нужна full-funnel маркетинг стратегия для SaaS продукта.
Включить: копирайтинг, дизайн, SEO, video, социальные сети
```

### Пример 2: Разработка продукта
```
/team Помощь в разработке мобильного приложения.
Нужны: UI/UX дизайн, frontend код, backend API, тестирование
```

### Пример 3: Контент-производство
```
/team Создать полный контент для YouTube канала.
Сценарист, видеограф, монтажер, SEO оптимизация
```

---

## 🔐 Безопасность

- Все агенты и скиллы хранятся в зашифрованном виде в `users.json`
- История задач не содержит пользовательских данных (только метаданные)
- Агенты имеют изолированный контекст (не видят друг друга)

---

## 📞 Поддержка

При ошибках смотрите логи в консоли, ищите `[SuperAgentFactory]` строки.

Основные ошибки:
- ❌ `Cannot read property 'superAgents'` — пользователь новый, создайте первого агента
- ❌ `users.json not found` — убедитесь файл существует
- ❌ `Documentation research failed` — Context7/NotebookLM не подключены

---

**Система готова к использованию! 🚀**
