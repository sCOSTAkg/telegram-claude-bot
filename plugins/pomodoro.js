/**
 * Плагин: Pomodoro Timer
 *
 * Помидоры для фокуса - управление временем с методом Pomodoro.
 * По умолчанию: 25 минут работы + 5 минут отдыха.
 *
 * Actions:
 *   [ACTION: pomodoro] <мин_работы> <мин_отдыха> — запустить таймер (default: 25 5)
 *   [ACTION: pomodoro-stop] — остановить текущий таймер
 *   [ACTION: pomodoro-status] — статус таймера
 *   [ACTION: pomodoro-stats] — статистика сеансов
 *   [ACTION: pomodoro-reset] — очистить статистику
 *
 * Файл: plugins/pomodoro.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');

class PomodoroPlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'pomodoro';
    this.version = '1.0.0';
    this.description = 'Pomodoro Timer для фокуса (25/5 минут)';
    this.author = 'sCORP';
    this.icon = '🍅';
    this.timers = new Map(); // chatId -> { phase, startTime, workMins, breakMins, abortCtrl }
  }

  async onInit(ctx) {
    this.log('Pomodoro Timer загружен');
  }

  _key(chatId, suffix) {
    suffix = suffix || '';
    return `pomodoro_${chatId}${suffix ? '_' + suffix : ''}`;
  }

  _getStats(chatId) {
    return this.ctx?.getPluginData?.(this.name, this._key(chatId, 'stats')) || {
      sessionsCompleted: 0,
      totalWorkMins: 0,
      totalBreakMins: 0,
      startDate: new Date().toISOString(),
    };
  }

  _saveStats(chatId, stats) {
    this.ctx?.setPluginData?.(this.name, this._key(chatId, 'stats'), stats);
  }

  _getActiveSession(chatId) {
    return this.timers.get(chatId) || null;
  }

  _setActiveSession(chatId, session) {
    if (session === null) {
      this.timers.delete(chatId);
    } else {
      this.timers.set(chatId, session);
    }
  }

  _formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  actions() {
    return {
      'pomodoro': {
        description: 'Запустить Pomodoro таймер',
        format: '<мин_работы> <мин_отдыха> (default: 25 5)',
        icon: '🍅',

        validate: (body) => {
          if (!body) return { valid: true }; // использовать defaults
          const parts = body.trim().split(/\s+/).map(Number);
          if (parts.length > 2) return { valid: false, error: 'Максимум 2 параметра' };
          if (parts.some(isNaN)) return { valid: false, error: 'Параметры должны быть числами' };
          if (parts.some(n => n <= 0)) return { valid: false, error: 'Времени должно быть > 0' };
          if (parts.some(n => n > 120)) return { valid: false, error: 'Максимум 120 минут' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          // Проверяем, есть ли уже активный таймер
          const existing = this._getActiveSession(chatId);
          if (existing) {
            return { success: false, output: '⚠️ Таймер уже работает! Сначала останови: [ACTION: pomodoro-stop]' };
          }

          // Парсим параметры
          let workMins = 25, breakMins = 5;
          if (body && body.trim()) {
            const parts = body.trim().split(/\s+/).map(Number);
            if (parts.length >= 1) workMins = parts[0];
            if (parts.length >= 2) breakMins = parts[1];
          }

          // Стартуем таймер (work phase)
          const session = {
            phase: 'work', // work | break
            startTime: Date.now(),
            workMins,
            breakMins,
            abortCtrl: new AbortController(),
            cycleCount: 1,
          };

          this._setActiveSession(chatId, session);

          // Запускаем фоновый таймер
          const workMs = workMins * 60 * 1000;
          const breakMs = breakMins * 60 * 1000;

          const runCycle = async () => {
            try {
              // Work phase
              session.phase = 'work';
              session.startTime = Date.now();
              await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, workMs);
                session.abortCtrl.signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  reject(new Error('aborted'));
                });
              });

              // Уведомление о конце работы
              await ctx.send?.(chatId, `⏰ **Сеанс #${session.cycleCount} завершён!**\n\n🍅 ${workMins}м работы\n\nТеперь 5-минутный перерыв... ☕`);

              // Break phase
              session.phase = 'break';
              session.startTime = Date.now();
              await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, breakMs);
                session.abortCtrl.signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  reject(new Error('aborted'));
                });
              });

              // Уведомление о конце перерыва
              session.cycleCount++;
              const stats = this._getStats(chatId);
              stats.sessionsCompleted++;
              stats.totalWorkMins += workMins;
              stats.totalBreakMins += breakMins;
              this._saveStats(chatId, stats);

              await ctx.send?.(chatId, `✨ **Перерыв завершён!**\n\n☕ ${breakMins}м отдыха\n\nНовый сеанс начинается... 🍅`);

              // Продолжаем цикл
              await runCycle();
            } catch (e) {
              if (e.message !== 'aborted') {
                console.error('Pomodoro error:', e);
              }
              this._setActiveSession(chatId, null);
            }
          };

          // Запускаем асинхронно (не ждём завершения)
          runCycle().catch(() => {});

          return {
            success: true,
            output: [
              `🍅 **Pomodoro запущен!**`,
              ``,
              `⏱ Фаза: **Работа** (${workMins} мин)`,
              ``,
              `🔔 Уведомления приходят автоматически`,
              `⏹ Остановить: [ACTION: pomodoro-stop]`,
              `📊 Статистика: [ACTION: pomodoro-stats]`,
            ].join('\n')
          };
        }
      },

      'pomodoro-stop': {
        description: 'Остановить Pomodoro таймер',
        icon: '⏹',

        execute: async (chatId, body, ctx) => {
          const session = this._getActiveSession(chatId);
          if (!session) {
            return { success: false, output: '❌ Таймер не работает' };
          }

          // Сохраняем недоделанный сеанс
          const stats = this._getStats(chatId);
          stats.totalWorkMins += session.workMins * 0.5; // считаем как половину (не завершено)
          this._saveStats(chatId, stats);

          // Останавливаем таймер
          session.abortCtrl.abort();
          this._setActiveSession(chatId, null);

          const elapsed = Math.round((Date.now() - session.startTime) / 1000);
          return {
            success: true,
            output: [
              `⏹ **Taймер остановлен**`,
              ``,
              `⏱ Было сеанса: ${this._formatTime(elapsed)}`,
              `🔄 Сеанс #${session.cycleCount}`,
            ].join('\n')
          };
        }
      },

      'pomodoro-status': {
        description: 'Показать статус текущего таймера',
        icon: '📊',

        execute: async (chatId, body, ctx) => {
          const session = this._getActiveSession(chatId);
          if (!session) {
            return { success: false, output: '❌ Таймер не работает' };
          }

          const elapsed = Math.round((Date.now() - session.startTime) / 1000);
          const totalMs = session.phase === 'work'
            ? session.workMins * 60 * 1000
            : session.breakMins * 60 * 1000;
          const remaining = Math.max(0, Math.round((totalMs - (Date.now() - session.startTime)) / 1000));

          const phaseIcon = session.phase === 'work' ? '🍅' : '☕';
          const phaseName = session.phase === 'work' ? 'Работа' : 'Перерыв';

          return {
            success: true,
            output: [
              `${phaseIcon} **Текущий Pomodoro**`,
              ``,
              `📌 Фаза: ${phaseName}`,
              `⏱ Прошло: ${this._formatTime(elapsed)}`,
              `⏳ Осталось: ${this._formatTime(remaining)}`,
              `🔢 Сеанс: #${session.cycleCount}`,
            ].join('\n')
          };
        }
      },

      'pomodoro-stats': {
        description: 'Показать статистику Pomodoro',
        icon: '📈',

        execute: async (chatId, body, ctx) => {
          const stats = this._getStats(chatId);
          const hours = Math.floor(stats.totalWorkMins / 60);
          const mins = stats.totalWorkMins % 60;

          return {
            success: true,
            output: [
              `📊 **Статистика Pomodoro**`,
              ``,
              `✅ Сеансов завершено: ${stats.sessionsCompleted}`,
              `⏱ Всего работал: ${hours}ч ${mins}мин`,
              `☕ Всего отдыхал: ${Math.floor(stats.totalBreakMins / 60)}ч ${stats.totalBreakMins % 60}мин`,
              `📅 С: ${new Date(stats.startDate).toLocaleDateString('ru-RU')}`,
            ].join('\n')
          };
        }
      },

      'pomodoro-reset': {
        description: 'Очистить статистику Pomodoro',
        icon: '🔄',

        execute: async (chatId, body, ctx) => {
          const newStats = {
            sessionsCompleted: 0,
            totalWorkMins: 0,
            totalBreakMins: 0,
            startDate: new Date().toISOString(),
          };
          this._saveStats(chatId, newStats);

          return {
            success: true,
            output: `🔄 **Статистика очищена!**\n\nНовый отсчёт начинается с нуля 🍅`
          };
        }
      }
    };
  }

  commands() {
    return {
      'pomodoro': {
        description: 'Запустить Pomodoro (25/5)',
        handler: async (chatId, args, ctx) => {
          const existing = this._getActiveSession(chatId);
          if (existing) {
            await ctx.send(chatId, '⚠️ Таймер уже работает!');
            return;
          }

          let workMins = 25, breakMins = 5;
          if (args?.trim()) {
            const parts = args.trim().split(/\s+/).map(Number);
            if (parts.length >= 1) workMins = parts[0];
            if (parts.length >= 2) breakMins = parts[1];
          }

          const session = {
            phase: 'work',
            startTime: Date.now(),
            workMins,
            breakMins,
            abortCtrl: new AbortController(),
            cycleCount: 1,
          };

          this._setActiveSession(chatId, session);

          await ctx.send(chatId, `🍅 **Pomodoro запущен!**\n⏱ Работаем ${workMins} минут...`);
        }
      },
      'pstop': {
        description: 'Остановить Pomodoro',
        handler: async (chatId, args, ctx) => {
          const session = this._getActiveSession(chatId);
          if (!session) {
            await ctx.send(chatId, '❌ Таймер не работает');
            return;
          }
          session.abortCtrl.abort();
          this._setActiveSession(chatId, null);
          await ctx.send(chatId, '⏹ **Taймер остановлен**');
        }
      },
      'pstatus': {
        description: 'Статус Pomodoro',
        handler: async (chatId, args, ctx) => {
          const session = this._getActiveSession(chatId);
          if (!session) {
            await ctx.send(chatId, '❌ Таймер не работает');
            return;
          }
          const remaining = Math.max(0, Math.round(((session.phase === 'work' ? session.workMins : session.breakMins) * 60 * 1000 - (Date.now() - session.startTime)) / 1000));
          await ctx.send(chatId, `⏳ Осталось: ${this._formatTime(remaining)}`);
        }
      }
    };
  }
}

module.exports = PomodoroPlugin;
