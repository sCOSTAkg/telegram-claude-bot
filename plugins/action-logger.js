/**
 * Плагин: Action Logger
 *
 * Middleware-плагин: логирует все действия в файл.
 * Демонстрирует middleware-систему Plugin SDK.
 *
 * Файл: plugins/action-logger.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');
const fs = require('fs');
const path = require('path');

class ActionLoggerPlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'action-logger';
    this.version = '1.0.0';
    this.description = 'Логирование всех действий бота';
    this.author = 'sCORP';
    this.icon = '📝';
    this._logFile = path.join(__dirname, '..', 'action-log.jsonl');
  }

  async onInit(ctx) {
    this.log(`Логирование в ${this._logFile}`);
  }

  _appendLog(entry) {
    try {
      fs.appendFileSync(this._logFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      this.warn('Ошибка записи лога:', e.message);
    }
  }

  middleware() {
    return {
      priority: 100, // Высокий приоритет — логгер работает первым

      beforeAction: async (action, chatId, ctx) => {
        this._appendLog({
          ts: new Date().toISOString(),
          event: 'beforeAction',
          chatId,
          action: action.name,
          bodyLength: action.body?.length || 0,
        });
        return action; // Пропускаем, не блокируем
      },

      afterAction: async (action, result, chatId, ctx) => {
        this._appendLog({
          ts: new Date().toISOString(),
          event: 'afterAction',
          chatId,
          action: action.name,
          success: result?.success,
          outputLength: result?.output?.length || 0,
        });
        return result; // Не модифицируем
      },
    };
  }

  actions() {
    return {
      'actionlog': {
        description: 'Показать последние N записей из лога действий',
        format: 'количество (по умолчанию 10)',
        icon: '📝',

        execute: async (chatId, body, ctx) => {
          const count = parseInt(body?.trim()) || 10;

          try {
            if (!fs.existsSync(this._logFile)) {
              return { success: true, output: '📝 Лог пуст — ещё нет записей' };
            }

            const lines = fs.readFileSync(this._logFile, 'utf-8')
              .split('\n')
              .filter(Boolean)
              .slice(-count);

            const formatted = lines.map(line => {
              try {
                const e = JSON.parse(line);
                const icon = e.success === false ? '❌' : e.success === true ? '✅' : '➡️';
                return `${icon} [${e.ts?.slice(11, 19)}] ${e.event} ${e.action || ''} (chat:${e.chatId})`;
              } catch {
                return line.slice(0, 80);
              }
            });

            return {
              success: true,
              output: `📝 Последние ${lines.length} записей:\n\n${formatted.join('\n')}`
            };
          } catch (e) {
            return { success: false, output: `Ошибка чтения лога: ${e.message}` };
          }
        }
      }
    };
  }
}

module.exports = ActionLoggerPlugin;
