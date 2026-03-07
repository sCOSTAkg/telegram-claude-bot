/**
 * Плагин: Перевод текста
 *
 * Переводит текст на любой язык через MyMemory API (бесплатно, без ключа).
 * Поддерживает автоопределение языка + популярные языки.
 *
 * Actions:
 *   [ACTION: translate] текст → язык — перевести на язык
 *   [ACTION: translate] текст — перевести на английский (по умолчанию)
 *
 * Команды:
 *   /translate текст → язык
 *   /tr текст → ru
 *
 * Примеры:
 *   [ACTION: translate] Привет как дела → en
 *   [ACTION: translate] Hello world → ru
 *   [ACTION: translate] Bonjour → ru
 *
 * Файл: plugins/translate.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');
const https = require('https');

const LANG_MAP = {
  // Русский
  'ru': 'ru', 'рус': 'ru', 'русский': 'ru', 'russian': 'ru',
  // Английский
  'en': 'en', 'eng': 'en', 'english': 'en', 'английский': 'en', 'англ': 'en',
  // Испанский
  'es': 'es', 'esp': 'es', 'spanish': 'es', 'испанский': 'es',
  // Немецкий
  'de': 'de', 'ger': 'de', 'german': 'de', 'немецкий': 'de',
  // Французский
  'fr': 'fr', 'fra': 'fr', 'french': 'fr', 'французский': 'fr',
  // Китайский
  'zh': 'zh', 'cn': 'zh', 'chinese': 'zh', 'китайский': 'zh',
  // Японский
  'ja': 'ja', 'jp': 'ja', 'japanese': 'ja', 'японский': 'ja',
  // Корейский
  'ko': 'ko', 'kr': 'ko', 'korean': 'ko', 'корейский': 'ko',
  // Арабский
  'ar': 'ar', 'arabic': 'ar', 'арабский': 'ar',
  // Турецкий
  'tr': 'tr', 'turkish': 'tr', 'турецкий': 'tr',
  // Итальянский
  'it': 'it', 'italian': 'it', 'итальянский': 'it',
  // Португальский
  'pt': 'pt', 'portuguese': 'pt', 'португальский': 'pt',
  // Польский
  'pl': 'pl', 'polish': 'pl', 'польский': 'pl',
  // Украинский
  'uk': 'uk', 'ua': 'uk', 'ukrainian': 'uk', 'украинский': 'uk',
  // Казахский
  'kk': 'kk', 'kz': 'kk', 'kazakh': 'kk', 'казахский': 'kk',
  // Кыргызский
  'ky': 'ky', 'kg': 'ky', 'kyrgyz': 'ky', 'кыргызский': 'ky',
};

const LANG_NAMES = {
  'ru': 'русский 🇷🇺', 'en': 'английский 🇬🇧', 'es': 'испанский 🇪🇸',
  'de': 'немецкий 🇩🇪', 'fr': 'французский 🇫🇷', 'zh': 'китайский 🇨🇳',
  'ja': 'японский 🇯🇵', 'ko': 'корейский 🇰🇷', 'ar': 'арабский 🇸🇦',
  'tr': 'турецкий 🇹🇷', 'it': 'итальянский 🇮🇹', 'pt': 'португальский 🇵🇹',
  'pl': 'польский 🇵🇱', 'uk': 'украинский 🇺🇦', 'kk': 'казахский 🇰🇿',
  'ky': 'кыргызский 🇰🇬',
};

class TranslatePlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'translate';
    this.version = '1.0.0';
    this.description = 'Перевод текста на любой язык';
    this.author = 'sCORP';
    this.icon = '🌐';
  }

  async onInit(ctx) {
    this.log('Плагин перевода загружен (MyMemory API)');
  }

  _fetch(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'sCORP-Bot/1.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Ошибка парсинга ответа')); }
        });
      }).on('error', reject);
    });
  }

  _parseLang(str) {
    if (!str) return 'en';
    const lower = str.toLowerCase().trim();
    return LANG_MAP[lower] || (str.length <= 5 ? str.toLowerCase() : 'en');
  }

  async _translate(text, toLang, fromLang = 'auto') {
    const encoded = encodeURIComponent(text.slice(0, 500));
    const langPair = fromLang === 'auto' ? `auto|${toLang}` : `${fromLang}|${toLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=${encodeURIComponent(langPair)}`;
    const data = await this._fetch(url);
    if (data.responseStatus === 200) {
      return {
        text: data.responseData.translatedText,
        detected: data.responseData.detectedLanguage || fromLang,
        quality: data.responseData.match || 0,
      };
    }
    throw new Error(data.responseDetails || 'Ошибка перевода');
  }

  _parseInput(body) {
    // Парсим: "текст → ru" или "текст -> ru" или просто "текст"
    const arrowMatch = body.match(/^([\s\S]+?)\s*(?:→|->|на|to)\s*(\w+)\s*$/i);
    if (arrowMatch) {
      return { text: arrowMatch[1].trim(), toLang: this._parseLang(arrowMatch[2]) };
    }
    return { text: body.trim(), toLang: 'en' };
  }

  actions() {
    return {
      'translate': {
        description: 'Перевести текст. Формат: текст → язык (или просто текст → переведёт на English)',
        format: 'текст → ru|en|de|fr|...',
        icon: '🌐',
        validate: (body) => ({ valid: !!body?.trim(), error: 'Укажи текст для перевода' }),
        handler: async (body, chatId, ctx) => {
          const { text, toLang } = this._parseInput(body);
          if (!text) return ctx.send(chatId, '❌ Укажи текст для перевода');

          const langName = LANG_NAMES[toLang] || toLang;
          const msgId = await ctx.send(chatId, `🔄 Перевожу на ${langName}...`);

          try {
            const result = await this._translate(text, toLang);
            const detectedName = LANG_NAMES[result.detected] || result.detected || 'авто';

            const msg = [
              `🌐 *Перевод*`,
              ``,
              `*Оригинал* (${detectedName}):`,
              `_${text}_`,
              ``,
              `*Перевод* → ${langName}:`,
              `${result.text}`,
            ].join('\n');

            if (msgId && ctx.editMessage) {
              try { await ctx.editMessage(chatId, msgId, msg, { parse_mode: 'Markdown' }); return; }
              catch (_) {}
            }
            ctx.send(chatId, msg, { parse_mode: 'Markdown' });
          } catch (e) {
            const errMsg = `❌ Ошибка перевода: ${e.message}`;
            if (msgId && ctx.editMessage) {
              try { await ctx.editMessage(chatId, msgId, errMsg); return; }
              catch (_) {}
            }
            ctx.send(chatId, errMsg);
          }
        },
      },
    };
  }

  commands() {
    const handler = async (chatId, args, ctx) => {
      if (!args) return ctx.send(chatId, [
        '🌐 *Переводчик*',
        '',
        'Использование:',
        '`/translate Привет → en`',
        '`/translate Hello world → ru`',
        '`/translate Bonjour → de`',
        '',
        'Или через [ACTION: translate]:',
        '`[ACTION: translate]`',
        '`Привет как дела → en`',
        '`[/ACTION]`',
        '',
        '🌍 Языки: ru, en, de, fr, es, it, pt, zh, ja, ko, ar, tr, pl, uk, kk, ky',
      ].join('\n'), { parse_mode: 'Markdown' });

      const { text, toLang } = this._parseInput(args);
      if (!text) return ctx.send(chatId, '❌ Укажи текст');

      const langName = LANG_NAMES[toLang] || toLang;
      const msgId = await ctx.send(chatId, `🔄 Перевожу на ${langName}...`);

      try {
        const result = await this._translate(text, toLang);
        const detectedName = LANG_NAMES[result.detected] || result.detected || 'авто';

        const msg = [
          `🌐 *Перевод*`,
          ``,
          `*Оригинал* (${detectedName}):`,
          `_${text}_`,
          ``,
          `*Перевод* → ${langName}:`,
          `${result.text}`,
        ].join('\n');

        if (msgId && ctx.editMessage) {
          try { await ctx.editMessage(chatId, msgId, msg, { parse_mode: 'Markdown' }); return; }
          catch (_) {}
        }
        ctx.send(chatId, msg, { parse_mode: 'Markdown' });
      } catch (e) {
        const errMsg = `❌ Ошибка: ${e.message}`;
        if (msgId && ctx.editMessage) {
          try { await ctx.editMessage(chatId, msgId, errMsg); return; }
          catch (_) {}
        }
        ctx.send(chatId, errMsg);
      }
    };

    return {
      'translate': {
        description: 'Перевод текста: /translate текст → язык',
        icon: '🌐',
        handler,
      },
      'tr': {
        description: 'Перевод (короткий): /tr текст → ru',
        icon: '🌐',
        handler,
      },
    };
  }
}

module.exports = TranslatePlugin;
