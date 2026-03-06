/**
 * Плагин: Курсы валют
 *
 * Показывает актуальные курсы валют через exchangerate-api.com (без API ключа).
 * Поддерживает USD, EUR, RUB, KZT, KGS, CNY, GBP, TRY и другие.
 *
 * Action: [ACTION: exchange] — курс валюты
 * Command: /exchange — быстрый курс
 *
 * Файл: plugins/exchange.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');
const https = require('https');

class ExchangePlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'exchange';
    this.version = '1.0.0';
    this.description = 'Курсы валют (USD, EUR, RUB, KZT, KGS...)';
    this.author = 'sCORP';
    this.icon = '💱';
    this._cache = null;
    this._cacheTs = 0;
    this._cacheTTL = 30 * 60 * 1000; // 30 минут
  }

  async onInit(ctx) {
    this.log('Плагин курсов валют загружен');
  }

  _fetch(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'sCORP-Bot/1.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Ошибка парсинга')); }
        });
      }).on('error', reject);
    });
  }

  async _getRates() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTs) < this._cacheTTL) {
      return this._cache;
    }
    // Используем бесплатный API (не требует ключ)
    const data = await this._fetch('https://open.er-api.com/v6/latest/USD');
    if (data.result !== 'success') throw new Error('Ошибка получения курсов');
    this._cache = data.rates;
    this._cacheTs = now;
    return data.rates;
  }

  _parseQuery(body) {
    // Форматы: "USD RUB", "100 USD в RUB", "EUR", "USD EUR KZT"
    const text = body.trim().toUpperCase();
    const numMatch = text.match(/^(\d+\.?\d*)\s+([A-Z]+)\s+(?:В|IN|TO)?\s*([A-Z]+)$/);
    if (numMatch) {
      return { amount: parseFloat(numMatch[1]), from: numMatch[2], to: numMatch[3] };
    }
    const pairMatch = text.match(/^([A-Z]+)\s+(?:В|IN|TO)?\s*([A-Z]+)$/);
    if (pairMatch) {
      return { amount: 1, from: pairMatch[1], to: pairMatch[2] };
    }
    // Список валют для показа относительно USD
    const currencies = text.split(/[\s,]+/).filter(c => /^[A-Z]{2,5}$/.test(c));
    if (currencies.length > 0) return { amount: 1, from: 'USD', list: currencies };
    return null;
  }

  _currencyFlag(code) {
    const flags = {
      USD: '🇺🇸', EUR: '🇪🇺', RUB: '🇷🇺', KZT: '🇰🇿', KGS: '🇰🇬',
      GBP: '🇬🇧', CNY: '🇨🇳', TRY: '🇹🇷', UAH: '🇺🇦', AED: '🇦🇪',
      JPY: '🇯🇵', CHF: '🇨🇭', CAD: '🇨🇦', AUD: '🇦🇺', INR: '🇮🇳',
    };
    return flags[code] || '💰';
  }

  actions() {
    return {
      'exchange': {
        description: 'Показать курсы валют. Форматы: "USD RUB", "100 EUR в KZT", "USD EUR KGS"',
        format: 'валюта или пара (USD RUB / 100 EUR в KZT / EUR KZT KGS)',
        icon: '💱',

        validate: (body) => {
          if (!body?.trim()) return { valid: false, error: 'Укажи валюту. Пример: USD RUB или 100 EUR в KZT' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          try {
            const parsed = this._parseQuery(body);
            if (!parsed) return { success: false, output: '❌ Не понял запрос. Примеры: "USD RUB", "100 EUR в KZT"' };

            const rates = await this._getRates();

            if (parsed.list) {
              // Показываем список валют относительно USD
              const lines = [`💱 **Курсы к USD:**`, ``];
              for (const cur of parsed.list.slice(0, 8)) {
                if (!rates[cur]) { lines.push(`❓ ${cur}: не найден`); continue; }
                const rate = rates[cur];
                const flag = this._currencyFlag(cur);
                lines.push(`${flag} **1 USD** = ${rate.toFixed(2)} ${cur}`);
              }
              return { success: true, output: lines.join('\n') };
            }

            // Конвертация пары
            const { amount, from, to } = parsed;
            if (!rates[from]) return { success: false, output: `❌ Валюта "${from}" не найдена` };
            if (!rates[to]) return { success: false, output: `❌ Валюта "${to}" не найдена` };

            // Конвертируем через USD как базу
            const inUSD = amount / rates[from];
            const result = inUSD * rates[to];

            return {
              success: true,
              output: [
                `💱 **Конвертация валют**`,
                ``,
                `${this._currencyFlag(from)} ${amount} ${from}`,
                `= ${this._currencyFlag(to)} **${result.toFixed(2)} ${to}**`,
                ``,
                `📊 Курс: 1 ${from} = ${(rates[to] / rates[from]).toFixed(4)} ${to}`,
              ].join('\n')
            };
          } catch (e) {
            return { success: false, output: `❌ ${e.message}` };
          }
        }
      }
    };
  }

  commands() {
    return {
      'exchange': {
        description: 'Курсы валют',
        handler: async (chatId, args, ctx) => {
          try {
            const query = args?.trim() || 'USD EUR RUB KZT KGS';
            const parsed = this._parseQuery(query);
            if (!parsed) { await ctx.send(chatId, '❌ Пример: /exchange USD RUB или /exchange 100 EUR в KZT'); return; }

            const rates = await this._getRates();

            if (parsed.list) {
              const lines = parsed.list.slice(0, 5).map(cur => {
                if (!rates[cur]) return `❓ ${cur}: нет данных`;
                return `${this._currencyFlag(cur)} 1 USD = ${rates[cur].toFixed(2)} ${cur}`;
              });
              await ctx.send(chatId, `💱 Курсы:\n${lines.join('\n')}`);
            } else {
              const { amount, from, to } = parsed;
              const result = (amount / rates[from]) * rates[to];
              await ctx.send(chatId, `💱 ${amount} ${from} = ${result.toFixed(2)} ${to}`);
            }
          } catch (e) {
            await ctx.send(chatId, `❌ ${e.message}`);
          }
        }
      }
    };
  }
}

module.exports = ExchangePlugin;
