/**
 * Плагин: Задачи (Todo)
 *
 * Управление задачами прямо в Telegram боте.
 * Статусы: ожидает → в работе → готово.
 *
 * Actions:
 *   [ACTION: todo] текст — добавить задачу
 *   [ACTION: todos] — список задач
 *   [ACTION: todo-done] номер — отметить выполненной
 *   [ACTION: todo-del] номер — удалить задачу
 *   [ACTION: todo-start] номер — взять в работу
 *
 * Файл: plugins/todo.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');

class TodoPlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'todo';
    this.version = '1.0.0';
    this.description = 'Задачи со статусами (добавить, список, выполнить, удалить)';
    this.author = 'sCORP';
    this.icon = '✅';
  }

  async onInit(ctx) {
    this.log('Плагин задач загружен');
  }

  _key(chatId) { return `todos_${chatId}`; }

  _getTodos(chatId) {
    return this.ctx?.getPluginData?.(this.name, this._key(chatId)) || [];
  }

  _saveTodos(chatId, todos) {
    this.ctx?.setPluginData?.(this.name, this._key(chatId), todos);
  }

  _statusIcon(status) {
    return { pending: '⏳', in_progress: '🔄', done: '✅' }[status] || '⏳';
  }

  _formatTodo(todo, idx) {
    const icon = this._statusIcon(todo.status);
    const dateStr = todo.updatedAt
      ? `_${todo.updatedAt}_`
      : `_${todo.createdAt}_`;
    return `${icon} **${idx}.** ${todo.text}\n   ${dateStr}`;
  }

  actions() {
    return {
      'todo': {
        description: 'Добавить задачу в список',
        format: 'текст задачи',
        icon: '✅',

        validate: (body) => {
          if (!body?.trim()) return { valid: false, error: 'Напиши текст задачи' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const todos = this._getTodos(chatId);
          const todo = {
            id: Date.now(),
            text: body.trim(),
            status: 'pending',
            createdAt: new Date().toLocaleDateString('ru-RU'),
            updatedAt: null,
          };
          todos.push(todo);
          this._saveTodos(chatId, todos);

          const pending = todos.filter(t => t.status === 'pending').length;

          return {
            success: true,
            output: [
              `✅ **Задача добавлена** (#${todos.length})`,
              ``,
              `📌 "${todo.text}"`,
              ``,
              `📊 Всего задач: ${todos.length} (ожидает: ${pending})`,
            ].join('\n')
          };
        }
      },

      'todos': {
        description: 'Показать список задач',
        format: 'фильтр: all / pending / done / in_progress (по умолчанию — все активные)',
        icon: '📋',

        execute: async (chatId, body, ctx) => {
          const todos = this._getTodos(chatId);
          if (!todos.length) {
            return {
              success: true,
              output: `📋 Список задач пуст!\n\nДобавь первую задачу:\n[ACTION: todo]\nтекст задачи\n[/ACTION]`
            };
          }

          const filter = body?.trim().toLowerCase();
          let filtered = todos;

          if (!filter || filter === 'active') {
            filtered = todos.filter(t => t.status !== 'done');
          } else if (filter === 'all') {
            filtered = todos;
          } else if (['pending', 'done', 'in_progress'].includes(filter)) {
            filtered = todos.filter(t => t.status === filter);
          }

          const stats = {
            pending: todos.filter(t => t.status === 'pending').length,
            in_progress: todos.filter(t => t.status === 'in_progress').length,
            done: todos.filter(t => t.status === 'done').length,
          };

          const lines = filtered.map((t, i) => this._formatTodo(t, todos.indexOf(t) + 1));

          return {
            success: true,
            output: [
              `📋 **Задачи** (⏳${stats.pending} 🔄${stats.in_progress} ✅${stats.done})`,
              ``,
              ...lines,
            ].join('\n\n').replace(/\n\n\n/g, '\n\n')
          };
        }
      },

      'todo-done': {
        description: 'Отметить задачу выполненной',
        format: 'номер задачи',
        icon: '✅',

        validate: (body) => {
          const n = parseInt(body?.trim());
          if (!n || n < 1) return { valid: false, error: 'Укажи номер задачи' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const idx = parseInt(body.trim()) - 1;
          const todos = this._getTodos(chatId);

          if (idx < 0 || idx >= todos.length) {
            return { success: false, output: `❌ Задачи #${idx + 1} нет` };
          }

          const todo = todos[idx];
          if (todo.status === 'done') {
            return { success: true, output: `✅ Задача #${idx + 1} уже выполнена!` };
          }

          todo.status = 'done';
          todo.updatedAt = new Date().toLocaleDateString('ru-RU');
          this._saveTodos(chatId, todos);

          const remaining = todos.filter(t => t.status !== 'done').length;

          return {
            success: true,
            output: [
              `✅ **Задача выполнена!**`,
              ``,
              `"${todo.text}"`,
              ``,
              `📊 Осталось задач: ${remaining}`,
            ].join('\n')
          };
        }
      },

      'todo-start': {
        description: 'Взять задачу в работу',
        format: 'номер задачи',
        icon: '🔄',

        validate: (body) => {
          const n = parseInt(body?.trim());
          if (!n || n < 1) return { valid: false, error: 'Укажи номер задачи' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const idx = parseInt(body.trim()) - 1;
          const todos = this._getTodos(chatId);

          if (idx < 0 || idx >= todos.length) {
            return { success: false, output: `❌ Задачи #${idx + 1} нет` };
          }

          const todo = todos[idx];
          todo.status = 'in_progress';
          todo.updatedAt = new Date().toLocaleDateString('ru-RU');
          this._saveTodos(chatId, todos);

          return {
            success: true,
            output: `🔄 **Задача взята в работу** (#${idx + 1})\n\n"${todo.text}"`
          };
        }
      },

      'todo-del': {
        description: 'Удалить задачу',
        format: 'номер задачи',
        icon: '🗑',

        validate: (body) => {
          const n = parseInt(body?.trim());
          if (!n || n < 1) return { valid: false, error: 'Укажи номер задачи' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const idx = parseInt(body.trim()) - 1;
          const todos = this._getTodos(chatId);

          if (idx < 0 || idx >= todos.length) {
            return { success: false, output: `❌ Задачи #${idx + 1} нет` };
          }

          const deleted = todos.splice(idx, 1)[0];
          this._saveTodos(chatId, todos);

          return {
            success: true,
            output: `🗑 **Удалено:** "${deleted.text}"\n\nОсталось задач: ${todos.length}`
          };
        }
      }
    };
  }

  commands() {
    return {
      'todos': {
        description: 'Список задач',
        handler: async (chatId, args, ctx) => {
          const todos = this._getTodos(chatId);
          if (!todos.length) { await ctx.send(chatId, '📋 Задач нет. Добавь: /todo текст задачи'); return; }
          const active = todos.filter(t => t.status !== 'done');
          const lines = active.slice(0, 5).map((t, i) => {
            const icon = this._statusIcon(t.status);
            return `${icon} ${todos.indexOf(t) + 1}. ${t.text}`;
          });
          const more = active.length > 5 ? `\n...и ещё ${active.length - 5}` : '';
          await ctx.send(chatId, `📋 Активные задачи:\n${lines.join('\n')}${more}`);
        }
      },
      'todo': {
        description: 'Добавить задачу',
        handler: async (chatId, args, ctx) => {
          if (!args?.trim()) { await ctx.send(chatId, '✅ Пример: /todo Купить продукты'); return; }
          const todos = this._getTodos(chatId);
          todos.push({ id: Date.now(), text: args.trim(), status: 'pending', createdAt: new Date().toLocaleDateString('ru-RU'), updatedAt: null });
          this._saveTodos(chatId, todos);
          await ctx.send(chatId, `✅ Задача #${todos.length} добавлена!`);
        }
      }
    };
  }
}

module.exports = TodoPlugin;
