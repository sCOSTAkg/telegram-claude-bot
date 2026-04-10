/**
 * sCORP Telegram Bot — Plugin SDK v1.0
 *
 * Позволяет создавать плагины как отдельные файлы в папке plugins/
 * Плагины могут:
 *  - Регистрировать новые [ACTION: ...] обработчики
 *  - Регистрировать Telegram-команды (/mycommand)
 *  - Добавлять middleware (before/after action, prompt modification)
 *  - Иметь собственный конфиг и состояние
 *  - Использовать API бота (send, sendPhoto, sendVideo, etc.)
 *
 * Использование:
 *   const { PluginBase } = require('../src/core/plugin-sdk');
 *   class MyPlugin extends PluginBase { ... }
 *   module.exports = MyPlugin;
 */

'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// ═══════════════════════════════════════════════
// PluginBase — базовый класс для всех плагинов
// ═══════════════════════════════════════════════

class PluginBase {
  constructor() {
    /** @type {string} Уникальное имя плагина (kebab-case) */
    this.name = 'unnamed-plugin';
    /** @type {string} Версия плагина */
    this.version = '1.0.0';
    /** @type {string} Описание плагина */
    this.description = '';
    /** @type {string} Автор плагина */
    this.author = '';
    /** @type {string} Иконка плагина (emoji) */
    this.icon = '🔌';
    /** @type {boolean} Активен ли плагин */
    this.enabled = true;
    /** @type {object} Конфиг плагина (загружается автоматически) */
    this.config = {};
    /** @type {object} Контекст бота (инжектится при загрузке) */
    this._ctx = null;
    /** @type {string} Путь к файлу плагина */
    this._filePath = '';
  }

  // ─── Lifecycle ───────────────────────────────

  /**
   * Вызывается при загрузке плагина.
   * Используй для инициализации, подключений, таймеров.
   * @param {PluginContext} ctx - контекст бота
   */
  async onInit(ctx) {}

  /**
   * Вызывается при выгрузке плагина.
   * Используй для очистки ресурсов.
   */
  async onDestroy() {}

  // ─── Actions ─────────────────────────────────

  /**
   * Возвращает объект с действиями плагина.
   * Ключ = имя action (будет доступно как [ACTION: key])
   *
   * @returns {Object.<string, ActionDefinition>}
   *
   * @example
   * actions() {
   *   return {
   *     'weather': {
   *       description: 'Показать погоду в городе',
   *       format: 'название города',
   *       icon: '🌤',
   *       validate: (body) => ({ valid: !!body }),
   *       execute: async (chatId, body, ctx) => {
   *         return { success: true, output: `Погода в ${body}: +25°C` };
   *       }
   *     }
   *   };
   * }
   */
  actions() {
    return {};
  }

  // ─── Commands ────────────────────────────────

  /**
   * Возвращает объект с Telegram-командами.
   * Ключ = команда (без /)
   *
   * @returns {Object.<string, CommandDefinition>}
   *
   * @example
   * commands() {
   *   return {
   *     'weather': {
   *       description: 'Показать погоду',
   *       handler: async (chatId, args, ctx) => {
   *         await ctx.send(chatId, `Погода: ${args}`);
   *       }
   *     }
   *   };
   * }
   */
  commands() {
    return {};
  }

  // ─── Middleware ───────────────────────────────

  /**
   * Возвращает middleware-функции.
   * Все middleware опциональны.
   *
   * @returns {MiddlewareDefinition}
   *
   * @example
   * middleware() {
   *   return {
   *     beforeAction: async (action, chatId) => {
   *       console.log(`Action: ${action.name}`);
   *       return action; // return null чтобы заблокировать
   *     },
   *     afterAction: async (action, result, chatId) => {
   *       return result; // можно модифицировать результат
   *     },
   *     beforePrompt: async (prompt, chatId) => {
   *       return prompt + '\nExtra instruction';
   *     }
   *   };
   * }
   */
  middleware() {
    return {};
  }

  // ─── Helpers (доступны в плагине) ────────────

  /** Логирование с именем плагина */
  log(...args) {
    console.log(`[plugin:${this.name}]`, ...args);
  }

  warn(...args) {
    console.warn(`[plugin:${this.name}] ⚠`, ...args);
  }

  error(...args) {
    console.error(`[plugin:${this.name}] ❌`, ...args);
  }

  /** Получить контекст бота */
  get ctx() {
    return this._ctx;
  }
}


// ═══════════════════════════════════════════════
// PluginContext — API бота, доступный плагинам
// ═══════════════════════════════════════════════

class PluginContext {
  /**
   * @param {Object} botApi - функции бота
   */
  constructor(botApi = {}) {
    this._api = botApi;
  }

  /** Отправить текстовое сообщение */
  async send(chatId, text, options = {}) {
    return this._api.send?.(chatId, text, options);
  }

  /** Отправить фото */
  async sendPhoto(chatId, photoPath, caption = '') {
    return this._api.sendPhoto?.(chatId, photoPath, caption);
  }

  /** Отправить видео */
  async sendVideo(chatId, videoPath, caption = '') {
    return this._api.sendVideo?.(chatId, videoPath, caption);
  }

  /** Отправить файл/документ */
  async sendDocument(chatId, filePath, caption = '') {
    return this._api.sendDocument?.(chatId, filePath, caption);
  }

  /** Получить конфиг пользователя */
  getUserConfig(chatId) {
    return this._api.getUserConfig?.(chatId) ?? {};
  }

  /** Сохранить конфиг пользователя */
  saveUserConfig(chatId, config) {
    return this._api.saveUserConfig?.(chatId, config);
  }

  /** Проверить, является ли пользователь админом */
  isAdmin(chatId) {
    return this._api.isAdmin?.(chatId) || false;
  }

  /** Выполнить bash-команду */
  async execBash(command, options = {}) {
    return this._api.execBash?.(command, options);
  }

  /** Вызвать AI (claude/gemini/gpt) */
  async callAI(prompt, options = {}) {
    return this._api.callAI?.(prompt, options);
  }

  /** Выполнить веб-поиск */
  async webSearch(query) {
    return this._api.webSearch?.(query);
  }

  /** Получить MCP клиент */
  async getMcpClient(chatId, serverId) {
    return this._api.getMcpClient?.(chatId, serverId);
  }

  /** Редактировать сообщение */
  async editMessage(chatId, messageId, text) {
    return this._api.editMessage?.(chatId, messageId, text);
  }

  /** Получить данные из хранилища плагина */
  getPluginData(pluginName, key) {
    return this._api.getPluginData?.(pluginName, key);
  }

  /** Сохранить данные в хранилище плагина */
  setPluginData(pluginName, key, value) {
    return this._api.setPluginData?.(pluginName, key, value);
  }
}


// ═══════════════════════════════════════════════
// PluginManager — загрузка и управление плагинами
// ═══════════════════════════════════════════════

class PluginManager extends EventEmitter {
  /**
   * @param {string} pluginsDir - путь к директории с плагинами
   * @param {Object} botApi - функции бота для PluginContext
   */
  constructor(pluginsDir, botApi = {}) {
    super();
    this.pluginsDir = pluginsDir;
    this.ctx = new PluginContext(botApi);

    /** @type {Map<string, PluginBase>} Загруженные плагины */
    this.plugins = new Map();

    /** @type {Map<string, ActionDefinition>} Зарегистрированные actions */
    this.actions = new Map();

    /** @type {Map<string, CommandDefinition>} Зарегистрированные команды */
    this.commands = new Map();

    /** @type {Array<MiddlewareEntry>} Middleware стек */
    this.middlewareStack = [];

    /** @type {string} Путь к файлу данных плагинов */
    this.dataFile = path.join(pluginsDir, '.plugin-data.json');

    /** @type {Object} Персистентные данные плагинов */
    this._data = this._loadData();

    /** @type {number} Debounce таймер для сохранения данных */
    this._saveTimer = null;
  }

  // ─── Загрузка плагинов ───────────────────────

  /**
   * Загрузить все плагины из директории
   */
  async loadAll() {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      return { loaded: 0, errors: [] };
    }

    const files = fs.readdirSync(this.pluginsDir)
      .filter(f => f.endsWith('.js') && !f.startsWith('.') && !f.startsWith('_'))
      .sort();

    const results = { loaded: 0, errors: [] };

    for (const file of files) {
      try {
        await this.load(path.join(this.pluginsDir, file));
        results.loaded++;
      } catch (err) {
        results.errors.push({ file, error: err.message });
        console.error(`[PluginManager] ❌ Ошибка загрузки ${file}:`, err.message);
      }
    }

    console.log(`[PluginManager] ✅ Загружено ${results.loaded} плагинов, ${results.errors.length} ошибок`);
    return results;
  }

  /**
   * Загрузить один плагин
   * @param {string} filePath - путь к файлу плагина
   */
  async load(filePath) {
    const fullPath = path.resolve(filePath);

    // Очистить кеш require (для hot-reload)
    delete require.cache[fullPath];

    const PluginClass = require(fullPath);

    // Поддержка и class и объект
    let plugin;
    if (typeof PluginClass === 'function') {
      plugin = new PluginClass();
    } else if (typeof PluginClass === 'object' && PluginClass.name) {
      // Объектный формат (без наследования)
      plugin = Object.assign(new PluginBase(), PluginClass);
    } else {
      throw new Error(`Плагин должен экспортировать класс (extends PluginBase) или объект с полем name`);
    }

    if (!plugin.name || plugin.name === 'unnamed-plugin') {
      plugin.name = path.basename(filePath, '.js');
    }

    // Проверка дубликатов
    if (this.plugins.has(plugin.name)) {
      await this.unload(plugin.name);
    }

    // Инжект контекста
    plugin._ctx = this.ctx;
    plugin._filePath = fullPath;

    // Загрузить сохраненный конфиг плагина
    const pluginState = this._data[plugin.name];
    if (
      pluginState
      && Object.prototype.hasOwnProperty.call(pluginState, 'config')
      && pluginState.config !== null
      && typeof pluginState.config === 'object'
    ) {
      plugin.config = { ...plugin.config, ...pluginState.config };
    }

    // Инициализация
    try {
      await plugin.onInit(this.ctx);
    } catch (err) {
      throw new Error(`onInit() failed: ${err.message}`);
    }

    // Регистрация actions
    const pluginActions = plugin.actions?.() || {};
    for (const [actionName, actionDef] of Object.entries(pluginActions)) {
      const fullDef = {
        ...actionDef,
        pluginName: plugin.name,
        pluginIcon: plugin.icon,
      };
      this.actions.set(actionName, fullDef);
    }

    // Регистрация commands
    const pluginCommands = plugin.commands?.() || {};
    for (const [cmdName, cmdDef] of Object.entries(pluginCommands)) {
      const name = cmdName.startsWith('/') ? cmdName.slice(1) : cmdName;
      this.commands.set(name, {
        ...cmdDef,
        pluginName: plugin.name,
      });
    }

    // Регистрация middleware
    const mw = plugin.middleware?.() || {};
    if (Object.keys(mw).length > 0) {
      this.middlewareStack.push({
        pluginName: plugin.name,
        priority: mw.priority || 0,
        ...mw,
      });
      // Сортировка по приоритету (больше = раньше)
      this.middlewareStack.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    // Сохранить плагин
    this.plugins.set(plugin.name, plugin);
    this.emit('pluginLoaded', plugin);

    console.log(`[PluginManager] 🔌 ${plugin.icon} ${plugin.name} v${plugin.version} загружен (${Object.keys(pluginActions).length} actions, ${Object.keys(pluginCommands).length} commands)`);
    return plugin;
  }

  /**
   * Выгрузить плагин
   * @param {string} pluginName
   */
  async unload(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;

    // Lifecycle: destroy
    try {
      await plugin.onDestroy?.();
    } catch (err) {
      console.error(`[PluginManager] ⚠ onDestroy() error for ${pluginName}:`, err.message);
    }

    // Удалить actions
    for (const [name, def] of this.actions.entries()) {
      if (def.pluginName === pluginName) this.actions.delete(name);
    }

    // Удалить commands
    for (const [name, def] of this.commands.entries()) {
      if (def.pluginName === pluginName) this.commands.delete(name);
    }

    // Удалить middleware
    this.middlewareStack = this.middlewareStack.filter(m => m.pluginName !== pluginName);

    // Очистить require cache
    if (plugin._filePath) {
      delete require.cache[plugin._filePath];
    }

    this.plugins.delete(pluginName);
    this.emit('pluginUnloaded', pluginName);

    console.log(`[PluginManager] 🔌 ${pluginName} выгружен`);
    return true;
  }

  /**
   * Перезагрузить плагин (hot-reload)
   * @param {string} pluginName
   */
  async reload(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) throw new Error(`Плагин ${pluginName} не найден`);

    const filePath = plugin._filePath;
    await this.unload(pluginName);
    return this.load(filePath);
  }

  /**
   * Перезагрузить все плагины
   */
  async reloadAll() {
    const names = [...this.plugins.keys()];
    for (const name of names) {
      try {
        await this.reload(name);
      } catch (err) {
        console.error(`[PluginManager] ❌ Ошибка перезагрузки ${name}:`, err.message);
      }
    }
  }

  // ─── Execution ───────────────────────────────

  /**
   * Выполнить action плагина
   * @returns {{ success: boolean, output: string }} | null (если action не найден)
   */
  async executeAction(actionName, chatId, body, statusUpdater) {
    const actionDef = this.actions.get(actionName);
    if (!actionDef) return null;

    // Валидация
    if (actionDef.validate) {
      const validation = actionDef.validate(body);
      if (!validation.valid) {
        return { success: false, output: `Ошибка валидации [${actionName}]: ${validation.error || 'неверный формат'}` };
      }
    }

    // Execute
    try {
      const result = await actionDef.execute(chatId, body, this.ctx, statusUpdater);
      return result;
    } catch (err) {
      console.error(`[PluginManager] ❌ Action ${actionName} error:`, err);
      return { success: false, output: `Ошибка плагина ${actionDef.pluginName}: ${err.message}` };
    }
  }

  /**
   * Проверить, является ли action плагиновым
   */
  hasAction(actionName) {
    return this.actions.has(actionName);
  }

  /**
   * Выполнить команду плагина
   * @returns {boolean} true если команда обработана
   */
  async executeCommand(cmdName, chatId, args) {
    const cmdDef = this.commands.get(cmdName);
    if (!cmdDef) return false;

    try {
      await cmdDef.handler(chatId, args, this.ctx);
      return true;
    } catch (err) {
      console.error(`[PluginManager] ❌ Command /${cmdName} error:`, err);
      await this.ctx.send(chatId, `❌ Ошибка команды /${cmdName}: ${err.message}`);
      return true; // handled (with error)
    }
  }

  /**
   * Проверить, является ли команда плагиновой
   */
  hasCommand(cmdName) {
    return this.commands.has(cmdName);
  }

  // ─── Middleware ───────────────────────────────

  /**
   * Выполнить middleware стек: beforeAction
   * @returns {object|null} action (возможно модифицированный) или null (заблокирован)
   */
  async runBeforeAction(action, chatId) {
    let current = action;
    for (const mw of this.middlewareStack) {
      if (mw.beforeAction) {
        try {
          current = await mw.beforeAction(current, chatId, this.ctx);
          if (!current) return null; // action заблокирован
        } catch (err) {
          console.error(`[PluginManager] ⚠ middleware beforeAction error (${mw.pluginName}):`, err.message);
        }
      }
    }
    return current;
  }

  /**
   * Выполнить middleware стек: afterAction
   * @returns {object} result (возможно модифицированный)
   */
  async runAfterAction(action, result, chatId) {
    let current = result;
    for (const mw of this.middlewareStack) {
      if (mw.afterAction) {
        try {
          current = await mw.afterAction(action, current, chatId, this.ctx);
        } catch (err) {
          console.error(`[PluginManager] ⚠ middleware afterAction error (${mw.pluginName}):`, err.message);
        }
      }
    }
    return current;
  }

  /**
   * Выполнить middleware стек: beforePrompt
   * @returns {string} системный промпт (возможно модифицированный)
   */
  async runBeforePrompt(prompt, chatId) {
    let current = prompt;
    for (const mw of this.middlewareStack) {
      if (mw.beforePrompt) {
        try {
          current = await mw.beforePrompt(current, chatId, this.ctx);
        } catch (err) {
          console.error(`[PluginManager] ⚠ middleware beforePrompt error (${mw.pluginName}):`, err.message);
        }
      }
    }
    return current;
  }

  // ─── Prompt generation ───────────────────────

  /**
   * Сгенерировать блок для системного промпта с описанием plugin actions
   */
  getPluginActionsPrompt() {
    if (this.actions.size === 0) return '';

    let prompt = '\n\n## Плагины (дополнительные действия)\n\n';

    // Группировать по плагину
    const byPlugin = new Map();
    for (const [actionName, def] of this.actions) {
      const key = def.pluginName;
      if (!byPlugin.has(key)) byPlugin.set(key, []);
      byPlugin.get(key).push({ actionName, ...def });
    }

    for (const [pluginName, actions] of byPlugin) {
      const plugin = this.plugins.get(pluginName);
      const icon = plugin?.icon || '🔌';
      prompt += `### ${icon} ${pluginName}${plugin?.description ? ` — ${plugin.description}` : ''}\n\n`;

      for (const action of actions) {
        prompt += `[ACTION: ${action.actionName}]\n`;
        if (action.format) {
          prompt += `${action.format}\n`;
        }
        prompt += `[/ACTION]\n`;
        if (action.description) {
          prompt += `↳ ${action.description}\n`;
        }
        prompt += '\n';
      }
    }

    return prompt;
  }

  /**
   * Получить валидацию для action (если есть в плагине)
   */
  getValidation(actionName, body) {
    const actionDef = this.actions.get(actionName);
    if (!actionDef?.validate) return { valid: true };
    return actionDef.validate(body);
  }

  // ─── Plugin Data persistence ─────────────────

  _loadData() {
    try {
      if (fs.existsSync(this.dataFile)) {
        return JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
      }
    } catch (err) {
      console.error('[PluginManager] ⚠ Ошибка загрузки данных плагинов:', err.message);
    }
    return {};
  }

  _saveData() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.dataFile, JSON.stringify(this._data, null, 2));
      } catch (err) {
        console.error('[PluginManager] ⚠ Ошибка сохранения данных:', err.message);
      }
    }, 1000);
  }

  getPluginData(pluginName, key) {
    return this._data[pluginName]?.data?.[key];
  }

  setPluginData(pluginName, key, value) {
    if (!this._data[pluginName]) this._data[pluginName] = { data: {} };
    if (!this._data[pluginName].data) this._data[pluginName].data = {};
    this._data[pluginName].data[key] = value;
    this._saveData();
  }

  // ─── Info ────────────────────────────────────

  /**
   * Получить информацию о всех плагинах
   */
  getInfo() {
    const list = [];
    for (const [name, plugin] of this.plugins) {
      const pluginActions = [...this.actions.entries()].filter(([, d]) => d.pluginName === name);
      const pluginCommands = [...this.commands.entries()].filter(([, d]) => d.pluginName === name);
      list.push({
        name,
        version: plugin.version,
        description: plugin.description,
        icon: plugin.icon,
        enabled: plugin.enabled,
        actions: pluginActions.map(([n]) => n),
        commands: pluginCommands.map(([n]) => `/${n}`),
      });
    }
    return list;
  }

  /**
   * Красивый вывод списка плагинов
   */
  formatPluginList() {
    const info = this.getInfo();
    if (info.length === 0) return '🔌 Нет загруженных плагинов';

    let text = '🔌 **Плагины:**\n';
    for (const p of info) {
      const status = p.enabled ? '✅' : '❌';
      text += `\n${status} ${p.icon} **${p.name}** v${p.version}\n`;
      if (p.description) text += `   ${p.description}\n`;
      if (p.actions.length) text += `   Actions: ${p.actions.map(a => `[${a}]`).join(', ')}\n`;
      if (p.commands.length) text += `   Commands: ${p.commands.join(', ')}\n`;
    }
    return text;
  }
}


// ═══════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════

module.exports = {
  PluginBase,
  PluginContext,
  PluginManager,
};
