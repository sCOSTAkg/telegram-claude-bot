/**
 * Плагин: Личные заметки
 *
 * Позволяет сохранять и просматривать личные заметки прямо в боте.
 * Заметки хранятся локально (plugin-data), у каждого пользователя свои.
 *
 * Actions:
 *   [ACTION: note] добавить — сохранить заметку
 *   [ACTION: notes] — список всех заметок
 *   [ACTION: note-del] номер — удалить заметку по номеру
 *
 * Файл: plugins/notes.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');

class NotesPlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'notes';
    this.version = '1.0.0';
    this.description = 'Личные заметки — добавить, просмотреть, удалить';
    this.author = 'sCORP';
    this.icon = '📓';
  }

  async onInit(ctx) {
    this.log('Плагин заметок загружен');
  }

  _key(chatId) { return `notes_${chatId}`; }

  _getNotes(chatId) {
    return this.ctx?.getPluginData?.(this.name, this._key(chatId)) || [];
  }

  _saveNotes(chatId, notes) {
    this.ctx?.setPluginData?.(this.name, this._key(chatId), notes);
  }

  actions() {
    return {
      'note': {
        description: 'Добавить личную заметку',
        format: 'текст заметки',
        icon: '📓',

        validate: (body) => {
          if (!body?.trim()) return { valid: false, error: 'Напиши текст заметки' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const notes = this._getNotes(chatId);
          const newNote = {
            id: Date.now(),
            text: body.trim(),
            date: new Date().toLocaleDateString('ru-RU'),
          };
          notes.push(newNote);
          this._saveNotes(chatId, notes);

          return {
            success: true,
            output: `📓 **Заметка сохранена** (#${notes.length})\n\n"${newNote.text}"`
          };
        }
      },

      'notes': {
        description: 'Показать все сохранённые заметки',
        format: '(пусто — показать все, или номер для поиска)',
        icon: '📋',

        execute: async (chatId, body, ctx) => {
          const notes = this._getNotes(chatId);

          if (!notes.length) {
            return {
              success: true,
              output: `📋 У тебя пока нет заметок.\n\nДобавь первую:\n[ACTION: note]\nтекст заметки\n[/ACTION]`
            };
          }

          const filter = body?.trim().toLowerCase();
          const filtered = filter
            ? notes.filter(n => n.text.toLowerCase().includes(filter))
            : notes;

          if (!filtered.length) {
            return { success: true, output: `🔍 Заметок по запросу "${filter}" не найдено` };
          }

          const lines = filtered.map((n, i) => {
            const idx = notes.indexOf(n) + 1;
            return `**${idx}.** ${n.text}\n   _${n.date}_`;
          });

          return {
            success: true,
            output: `📋 **Твои заметки** (${filtered.length}):\n\n${lines.join('\n\n')}`
          };
        }
      },

      'note-del': {
        description: 'Удалить заметку по номеру',
        format: 'номер заметки (например: 3)',
        icon: '🗑',

        validate: (body) => {
          const n = parseInt(body?.trim());
          if (!n || n < 1) return { valid: false, error: 'Укажи номер заметки (число)' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const idx = parseInt(body.trim()) - 1;
          const notes = this._getNotes(chatId);

          if (idx < 0 || idx >= notes.length) {
            return { success: false, output: `❌ Заметки #${idx + 1} нет. Всего заметок: ${notes.length}` };
          }

          const deleted = notes.splice(idx, 1)[0];
          this._saveNotes(chatId, notes);

          return {
            success: true,
            output: `🗑 **Заметка удалена:**\n\n"${deleted.text}"\n\nОсталось заметок: ${notes.length}`
          };
        }
      }
    };
  }

  commands() {
    return {
      'note': {
        description: 'Добавить или показать заметки',
        handler: async (chatId, args, ctx) => {
          if (!args?.trim()) {
            const notes = this._getNotes(chatId);
            if (!notes.length) {
              await ctx.send(chatId, '📋 Заметок нет. Добавь: /note текст заметки');
              return;
            }
            const lines = notes.slice(-5).map((n, i) => `${notes.length - 4 + i}. ${n.text}`);
            await ctx.send(chatId, `📋 Последние заметки:\n${lines.join('\n')}`);
          } else {
            const notes = this._getNotes(chatId);
            notes.push({ id: Date.now(), text: args.trim(), date: new Date().toLocaleDateString('ru-RU') });
            this._saveNotes(chatId, notes);
            await ctx.send(chatId, `📓 Заметка #${notes.length} сохранена!`);
          }
        }
      }
    };
  }
}

module.exports = NotesPlugin;
