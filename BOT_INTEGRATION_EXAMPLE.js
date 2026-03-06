/**
 * BOT.JS INTEGRATION EXAMPLE
 * 
 * Пример как подключить Super-Agent Factory в ваш существующий bot.js
 * 
 * КОПИЙтеВЫЙРЕзкод из этого файла в ваш bot.js
 */

// ============================================================================
// STEP 1: ДОБАВЬТЕ ЭТИ ИМПОРТЫ в начало bot.js (после других импортов)
// ============================================================================

const { initSuperAgentSystem } = require('./modules/superAgentIntegration');

// ============================================================================
// STEP 2: ИНИЦИАЛИЗИРУЙТЕ СИСТЕМУ (после создания bot объекта)
// ============================================================================

// Пример: const bot = new Telegraf(process.env.BOT_TOKEN);

const superAgentFactory = initSuperAgentSystem(bot, {
  usersFile: './users.json',
  dataDir: './data'
});

console.log('[Bot] ✅ Super-Agent Factory система активирована');

// ============================================================================
// STEP 3: ГОТОВО! Команды уже подкреплены автоматически
// ============================================================================

// Доступные команды теперь:
// /team <описание>     - создать команду супагентов
// /agents             - показать всех агентов
// /skills             - показать все скиллы
// /team-status        - статус команды
// /task-history       - история задач

// ============================================================================
// ДОПОЛНИТЕЛЬНО: Если вы хотите добавить СВОИ команды для работы с системой
// ============================================================================

// Пример 1: Автоматическое создание супагентов для любой задачи
bot.on('text', async (ctx) => {
  const text = ctx.message.text.toLowerCase();

  // Если пользователь упоминает "помощь" или "создать" - предложить команду /team
  if ((text.includes('помощь') || text.includes('создать')) && !text.startsWith('/')) {
    ctx.reply(
      '💡 Может быть вы ищете: `/team <описание задачи>`?\n\n' +
      'Я помогу создать команду супагентов для вашей задачи!',
      { parse_mode: 'Markdown' }
    );
  }
});

// ============================================================================
// Пример 2: Команда для получения подробного отчета о команде
// ============================================================================

bot.command('report', async (ctx) => {
  const { exportUserStats } = require('./modules/superAgentIntegration');
  
  const userId = ctx.from.id.toString();
  const report = exportUserStats(userId);

  if (!report) {
    ctx.reply('📋 У вас пока нет команды. Создайте её командой `/team <задача>`');
    return;
  }

  const reportText = `
📊 ПОЛНЫЙ ОТЧЕТ О ВАШЕЙ КОМАНДЕ

📈 Статистика:
• Агентов создано: ${report.summary.totalAgents}
• Скиллов генерировано: ${report.summary.totalSkills}
• Задач выполнено: ${report.summary.totalTasksCompleted}

🤖 Агенты:
${report.agents.map(a => `• ${a.role} (${a.specialization})`).join('\n') || '• Нет агентов'}

🎯 Скиллы:
${report.skills.map(s => `• ${s.name} от ${s.baseRole}`).join('\n') || '• Нет скиллов'}

📝 Последние задачи:
${report.recentTasks.map(t => `• ${t.description.substring(0, 30)}...`).join('\n') || '• Нет задач'}

Создано: ${new Date(report.generatedAt).toLocaleString('ru-RU')}
  `;

  ctx.reply(reportText, { parse_mode: 'Markdown' });
});

// ============================================================================
// Пример 3: Интеграция с существующими командами
// ============================================================================

// Если у вас есть команда /start
bot.command('start', async (ctx) => {
  // ... ваш существующий код /start ...

  // Добавьте информацию о супагентах
  ctx.reply(
    '🤖 В этом боте есть уникальная система супагентов!\n\n' +
    'Команды:\n' +
    '`/team <задача>` - создать команду агентов\n' +
    '`/agents` - показать агентов\n' +
    '`/skills` - показать скиллы\n' +
    '`/team-status` - статус команды\n' +
    '`/report` - подробный отчет',
    { parse_mode: 'Markdown' }
  );
});

// ============================================================================
// Пример 4: Предложить создать команду при определенных условиях
// ============================================================================

bot.command('help', async (ctx) => {
  const { getFactory } = require('./modules/superAgentIntegration');
  const factory = getFactory();
  const agents = await factory.loadUserAgents(ctx.from.id.toString());

  let helpText = '🆘 ПОМОЩЬ\n\n';

  if (agents.length === 0) {
    helpText += '💡 У вас нет команды супагентов.\n\n' +
               'Создайте её:\n' +
               '`/team Опишите вашу задачу`\n\n' +
               'Система создаст специалистов для вашей работы!';
  } else {
    helpText += `✅ У вас уже есть ${agents.length} агентов.\n\n` +
               'Используйте их для новых задач:\n' +
               '`/team Новая задача`\n\n' +
               'Смотрите статус:\n' +
               '`/team-status`';
  }

  ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// ============================================================================
// Пример 5: Экспорт статистики в файл
// ============================================================================

bot.command('export', async (ctx) => {
  const { exportUserStats } = require('./modules/superAgentIntegration');
  
  const userId = ctx.from.id.toString();
  const report = exportUserStats(userId);

  if (!report) {
    ctx.reply('📋 У вас пока нет данных для экспорта');
    return;
  }

  // Отправить как JSON файл
  const fs = require('fs');
  const fileName = `report-${userId}-${Date.now()}.json`;
  const filePath = `./exports/${fileName}`;

  // Убедимся что папка существует
  if (!fs.existsSync('./exports')) {
    fs.mkdirSync('./exports');
  }

  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));

  // Отправляем файл
  ctx.replyWithDocument({
    source: filePath,
    filename: fileName
  });

  // Удаляем файл после отправки
  fs.unlinkSync(filePath);
});

// ============================================================================
// Пример 6: Улучшенная обработка ошибок для супагентов
// ============================================================================

bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('[Bot] Ошибка:', err);

    if (err.message.includes('SuperAgentFactory')) {
      ctx.reply('❌ Ошибка в системе супагентов:\n' + err.message);
    } else {
      ctx.reply('❌ Неизвестная ошибка');
    }
  }
});

// ============================================================================
// Пример 7: Планирование автоматического создания агентов
// ============================================================================

// Если вы хотите автоматически предлагать создание команды:
// (например, каждому новому пользователю)

bot.command('onboarding', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { getFactory } = require('./modules/superAgentIntegration');
  
  const factory = getFactory();
  const agents = await factory.loadUserAgents(userId);

  if (agents.length === 0) {
    ctx.reply(
      '🎉 Добро пожаловать в систему супагентов!\n\n' +
      'Давайте создадим вашу первую команду!\n\n' +
      'Пример:\n' +
      '`/team Помощь в создании маркетинговой кампании для моего стартапа`',
      { parse_mode: 'Markdown' }
    );
  } else {
    ctx.reply(`✅ У вас уже есть ${agents.length} агентов! Используйте их!`);
  }
});

// ============================================================================
// Пример 8: Middleware для логирования всех операций с супагентами
// ============================================================================

const { getFactory } = require('./modules/superAgentIntegration');

const superAgentLogger = async (ctx, next) => {
  if (ctx.message?.text?.startsWith('/team') ||
      ctx.message?.text?.startsWith('/agents') ||
      ctx.message?.text?.startsWith('/skills')) {
    
    const userId = ctx.from.id.toString();
    const command = ctx.message.text.split(' ')[0];
    
    console.log(`[SuperAgent] ${userId} выполнил ${command}`);
  }

  await next();
};

bot.use(superAgentLogger);

// ============================================================================
// ГОТОВО! Система полностью интегрирована
// ============================================================================

// Теперь просто запустите бот:
// node bot.js

// И используйте команды в Telegram:
// /team Создать рекламную кампанию
// /agents
// /skills
// /team-status
// /task-history

module.exports = bot;
