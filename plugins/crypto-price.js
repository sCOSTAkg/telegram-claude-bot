/**
 * Плагин: Курсы криптовалют
 *
 * Показывает актуальные курсы криптовалют через CoinGecko API.
 * Пример более сложного плагина с внешним API.
 *
 * Action: [ACTION: crypto] — проверить курс крипты
 * Command: /crypto — быстрый курс BTC/ETH
 *
 * Файл: plugins/crypto-price.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');

class CryptoPlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'crypto-price';
    this.version = '1.0.0';
    this.description = 'Курсы криптовалют (CoinGecko)';
    this.author = 'sCORP';
    this.icon = '₿';
    this._cache = {};
    this._cacheTTL = 60000; // 60 сек кеш
  }

  async onInit(ctx) {
    this.log('Криптовалютный плагин загружен');
  }

  async _fetchPrice(symbol) {
    const now = Date.now();
    const cached = this._cache[symbol];
    if (cached && (now - cached.ts) < this._cacheTTL) {
      return cached.data;
    }

    const ids = {
      btc: 'bitcoin', eth: 'ethereum', sol: 'solana',
      ton: 'the-open-network', doge: 'dogecoin', xrp: 'ripple',
      bnb: 'binancecoin', ada: 'cardano', dot: 'polkadot',
      matic: 'matic-network', avax: 'avalanche-2', link: 'chainlink',
    };

    const coinId = ids[symbol.toLowerCase()] || symbol.toLowerCase();

    try {
      const { fetch } = await import('undici');
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd,rub&include_24hr_change=true`,
        { signal: AbortSignal.timeout(10000) }
      );
      const data = await resp.json();
      const coin = data[coinId];
      if (!coin) throw new Error(`Монета "${symbol}" не найдена`);

      const result = {
        symbol: symbol.toUpperCase(),
        usd: coin.usd,
        rub: coin.rub,
        change24h: coin.usd_24h_change,
      };

      this._cache[symbol] = { ts: now, data: result };
      return result;
    } catch (err) {
      throw new Error(`Не удалось получить курс ${symbol}: ${err.message}`);
    }
  }

  actions() {
    return {
      'crypto': {
        description: 'Показать курс криптовалюты. Поддерживает: BTC, ETH, SOL, TON, DOGE, XRP, BNB и другие',
        format: 'символ монеты (BTC, ETH, SOL, TON...)',
        icon: '₿',

        validate: (body) => {
          if (!body?.trim()) return { valid: false, error: 'Укажи символ монеты (например: BTC)' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const symbols = body.trim().split(/[\s,]+/).filter(Boolean);
          const results = [];

          for (const sym of symbols.slice(0, 5)) {
            try {
              const price = await this._fetchPrice(sym);
              const changeIcon = price.change24h >= 0 ? '📈' : '📉';
              const changeStr = price.change24h?.toFixed(2) || '?';
              results.push(
                `${changeIcon} **${price.symbol}**: $${price.usd?.toLocaleString()} | ₽${price.rub?.toLocaleString()} | ${changeStr}% (24h)`
              );
            } catch (err) {
              results.push(`❌ ${sym.toUpperCase()}: ${err.message}`);
            }
          }

          return {
            success: true,
            output: `₿ Курсы криптовалют:\n\n${results.join('\n')}`
          };
        }
      }
    };
  }

  commands() {
    return {
      'crypto': {
        description: 'Курс криптовалюты',
        handler: async (chatId, args, ctx) => {
          const sym = args?.trim() || 'BTC ETH SOL TON';
          const symbols = sym.split(/[\s,]+/).filter(Boolean);
          const lines = [];

          for (const s of symbols.slice(0, 5)) {
            try {
              const p = await this._fetchPrice(s);
              const icon = p.change24h >= 0 ? '📈' : '📉';
              lines.push(`${icon} ${p.symbol}: $${p.usd?.toLocaleString()} (${p.change24h?.toFixed(2)}%)`);
            } catch (e) {
              lines.push(`❌ ${s.toUpperCase()}: не найден`);
            }
          }

          await ctx.send(chatId, `₿ Курсы:\n${lines.join('\n')}`);
        }
      }
    };
  }
}

module.exports = CryptoPlugin;
