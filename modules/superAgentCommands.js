/**
 * SUPER-AGENT COMMANDS
 * 
 * Команды для управления системой супагентов в Telegram боте
 * Интегрируется в основной bot.js
 */

const SuperAgentFactory = require('./superAgentFactory');

class SuperAgentCommands {
  constructor(bot, factory) {
    this.bot = bot;
    this.factory = factory;
    this.registerCommands();
  }

  registerCommands() {
    // /team <описание задачи> - создать команду супагентов
    this.bot.command('team', this.createTeam.bind(this));

    // /agents - показать всех своих супагентов
    this.bot.command('agents', this.listAgents.bind(this));

    // /skills - показать все созданные скиллы
    this.bot.command('skills', this.listSkills.bind(this));

    // /reuse <роли> - переиспользовать агентов для новой задачи
    this.bot.command('reuse', this.reuseAgents.bind(this));

    // /team-status - статус текущей команды
    this.bot.command('team-status', this.getTeamStatus.bind(this));

    // /task-history - история выполненных задач
    this.bot.command('task-history', this.getTaskHistory.bind(this));
  }

  /**
   * /team <описание задачи>
   * 
   * Создать новую команду супагентов для задачи
   * Пример: /team Нужно создать крутую рекламную кампанию для клининга
   */
  async createTeam(ctx) {
    const userId = ctx.from.id.toString();
    const taskDescription = ctx.message.text.replace('/team ', '').trim();

    if (!taskDescription) {
      ctx.reply('📋 Пример: `/team Создать рекламную кампанию для клининга`', {
        parse_mode: 'Markdown'
      });
      return;
    }

    const msg = await ctx.reply('⏳ Анализирую задачу и создаю команду супагентов...');

    try {
      const result = await this.factory.createAndExecuteTeam(userId, taskDescription);

      let response = '✨ КОМАНДА СУПАГЕНТОВ СОЗДАНА И ВЫПОЛНИЛА ЗАДАЧУ\n\n';

      if (result.success) {
        response += `📋 Задача: ${taskDescription}\n\n`;
        response += `🤖 Созданные агенты:\n`;
        result.team.agents.forEach(agent => {
          response += `   • ${agent.role} (${agent.id})\n`;
        });

        response += `\n🎯 Генерированные скиллы:\n`;
        if (result.team.skills.length > 0) {
          result.team.skills.forEach(skill => {
            response += `   • ${skill}\n`;
          });
        } else {
          response += '   (нет новых скиллов)\n';
        }

        response += `\n💾 Агенты сохранены в память и будут переиспользоваться для будущих задач!\n`;
        response += `\n📊 Качество выполнения: ${result.result.quality}%`;
      } else {
        response = `❌ Ошибка: ${result.error}`;
      }

      if (msg && msg.message_id && ctx.deleteMessage) {
        await ctx.deleteMessage(msg.message_id).catch(() => {});
      }
      ctx.reply(response, { parse_mode: 'Markdown' });

    } catch (err) {
      ctx.reply(`❌ Критическая ошибка: ${err.message}`);
    }
  }

  /**
   * /agents
   * 
   * Показать всех созданных супагентов пользователя
   */
  async listAgents(ctx) {
    const userId = ctx.from.id.toString();

    try {
      const agents = await this.factory.loadUserAgents(userId);

      if (agents.length === 0) {
        ctx.reply('🤖 У вас пока нет супагентов. Создайте их командой `/team <задача>`', {
          parse_mode: 'Markdown'
        });
        return;
      }

      let response = '🤖 ВСЕ ВАШ СУПАГЕНТЫ\n\n';

      agents.forEach((agent, idx) => {
        response += `${idx + 1}. **${agent.role}**\n`;
        response += `   ID: \`${agent.id}\`\n`;
        response += `   Создан: ${new Date(agent.created).toLocaleString('ru-RU')}\n`;
        response += `   Статус: ${agent.status}\n`;
        response += `   Специализация: ${agent.config.specialization}\n\n`;
      });

      response += `💡 Используйте команду \`/reuse\` для переиспользования этих агентов`;

      ctx.reply(response, { parse_mode: 'Markdown' });

    } catch (err) {
      ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  }

  /**
   * /skills
   * 
   * Показать все сгенерированные скиллы
   */
  async listSkills(ctx) {
    const userId = ctx.from.id.toString();

    try {
      const usersData = require('fs').readFileSync('./users.json', 'utf8');
      const users = JSON.parse(usersData);
      const userData = users[userId];

      if (!userData?.generatedSkills || userData.generatedSkills.length === 0) {
        ctx.reply('🎯 У вас пока нет сгенерированных скиллов. Создайте их командой `/team`', {
          parse_mode: 'Markdown'
        });
        return;
      }

      let response = '🎯 ВСЕ СГЕНЕРИРОВАННЫЕ СКИЛЛЫ\n\n';

      userData.generatedSkills.forEach((skill, idx) => {
        response += `${idx + 1}. **${skill.name}**\n`;
        response += `   Роль: ${skill.baseRole}\n`;
        response += `   Создан: ${new Date(skill.created).toLocaleString('ru-RU')}\n`;
        
        if (skill.sources.length > 0) {
          response += `   Источники: ${skill.sources.length} док\n`;
        }
        if (skill.topics.length > 0) {
          response += `   Темы: ${skill.topics.slice(0, 2).join(', ')}\n`;
        }
        response += '\n';
      });

      response += `💡 Эти скиллы автоматически используются вашими агентами`;

      ctx.reply(response, { parse_mode: 'Markdown' });

    } catch (err) {
      ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  }

  /**
   * /reuse <роли через запятую или пусто для всех>
   * 
   * Переиспользовать сохраненных агентов для новой задачи
   * Пример: /reuse copywriter, designer
   */
  async reuseAgents(ctx) {
    const userId = ctx.from.id.toString();
    const args = ctx.message.text.replace('/reuse', '').trim();

    if (!args) {
      ctx.reply('📝 Пример: `/reuse copywriter, designer` или просто `/reuse` для всех', {
        parse_mode: 'Markdown'
      });
      return;
    }

    // Если это просто команда без аргументов - спросим задачу
    if (args === ctx.message.text.replace('/reuse', '').trim()) {
      ctx.reply('📋 Опишите новую задачу для вашей команды агентов (или используйте /team <задача>)');
      return;
    }

    ctx.reply('⏳ Переиспользую агентов для новой задачи...');
  }

  /**
   * /team-status
   * 
   * Статус команды - сколько агентов активно, какие скиллы созданы
   */
  async getTeamStatus(ctx) {
    const userId = ctx.from.id.toString();

    try {
      const agents = await this.factory.loadUserAgents(userId);
      const usersData = require('fs').readFileSync('./users.json', 'utf8');
      const users = JSON.parse(usersData);
      const userData = users[userId];

      let response = '📊 СТАТУС ВАШЕЙ КОМАНДЫ СУПАГЕНТОВ\n\n';

      response += `🤖 Агентов: ${agents.length}\n`;
      response += `   Активных: ${agents.filter(a => a.status === 'active').length}\n`;

      response += `\n🎯 Скиллов: ${userData?.generatedSkills?.length || 0}\n`;

      response += `\n📝 Выполненных задач: ${userData?.taskHistory?.length || 0}\n`;

      if (userData?.taskHistory && userData.taskHistory.length > 0) {
        const lastTask = userData.taskHistory[userData.taskHistory.length - 1];
        response += `   Последняя: ${new Date(lastTask.timestamp).toLocaleString('ru-RU')}\n`;
      }

      response += `\n💡 Команда полностью готова к работе!`;

      ctx.reply(response, { parse_mode: 'Markdown' });

    } catch (err) {
      ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  }

  /**
   * /task-history
   * 
   * История выполненных задач
   */
  async getTaskHistory(ctx) {
    const userId = ctx.from.id.toString();

    try {
      const usersData = require('fs').readFileSync('./users.json', 'utf8');
      const users = JSON.parse(usersData);
      const userData = users[userId];

      if (!userData?.taskHistory || userData.taskHistory.length === 0) {
        ctx.reply('📋 История задач пуста. Создайте первую команду командой `/team <задача>`', {
          parse_mode: 'Markdown'
        });
        return;
      }

      let response = '📋 ИСТОРИЯ ВЫПОЛНЕННЫХ ЗАДАЧ\n\n';

      userData.taskHistory.slice(-10).reverse().forEach((task, idx) => {
        response += `${idx + 1}. ${new Date(task.timestamp).toLocaleString('ru-RU')}\n`;
        response += `   Задача: ${task.task?.substring(0, 40)}...\n`;
        response += `   Агентов: ${task.agentsUsed?.length || 0}\n`;
        response += `   Скиллов: ${task.skillsGenerated?.length || 0}\n\n`;
      });

      response += `💡 Всего задач выполнено: ${userData.taskHistory.length}`;

      ctx.reply(response, { parse_mode: 'Markdown' });

    } catch (err) {
      ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  }
}

module.exports = SuperAgentCommands;
