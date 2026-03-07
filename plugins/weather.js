/**
 * Плагин: Погода
 *
 * Показывает текущую погоду в любом городе через Open-Meteo (без API ключа).
 * Используется geocoding API для поиска города.
 *
 * Action: [ACTION: weather] — погода в городе
 * Command: /weather — быстрая погода
 *
 * Файл: plugins/weather.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');
const https = require('https');

class WeatherPlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'weather';
    this.version = '1.0.0';
    this.description = 'Погода в любом городе';
    this.author = 'sCORP';
    this.icon = '🌤';
    this._cache = {};
    this._cacheTTL = 10 * 60 * 1000; // 10 минут
  }

  async onInit(ctx) {
    this.log('Плагин погоды загружен (Open-Meteo, без API ключа)');
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

  async _getCoords(city) {
    const encoded = encodeURIComponent(city);
    const data = await this._fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encoded}&count=1&language=ru&format=json`
    );
    if (!data.results?.length) throw new Error(`Город "${city}" не найден`);
    const r = data.results[0];
    return { lat: r.latitude, lon: r.longitude, name: r.name, country: r.country };
  }

  async _getWeather(city) {
    const cacheKey = city.toLowerCase();
    const now = Date.now();
    if (this._cache[cacheKey] && (now - this._cache[cacheKey].ts) < this._cacheTTL) {
      return this._cache[cacheKey].data;
    }

    const { lat, lon, name, country } = await this._getCoords(city);
    const data = await this._fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature` +
      `&wind_speed_unit=ms&timezone=auto`
    );

    const c = data.current;
    const result = {
      city: name,
      country,
      temp: Math.round(c.temperature_2m),
      feelsLike: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      wind: Math.round(c.wind_speed_10m * 10) / 10,
      code: c.weather_code,
      emoji: this._codeToEmoji(c.weather_code),
      desc: this._codeToDesc(c.weather_code),
    };

    this._cache[cacheKey] = { ts: now, data: result };
    return result;
  }

  _codeToEmoji(code) {
    if (code === 0) return '☀️';
    if (code <= 2) return '🌤';
    if (code <= 3) return '☁️';
    if (code <= 49) return '🌫';
    if (code <= 57) return '🌧';
    if (code <= 67) return '🌧';
    if (code <= 77) return '❄️';
    if (code <= 82) return '🌦';
    if (code <= 86) return '🌨';
    if (code <= 99) return '⛈';
    return '🌡';
  }

  _codeToDesc(code) {
    const map = {
      0: 'Ясно', 1: 'Преимущественно ясно', 2: 'Переменная облачность',
      3: 'Пасмурно', 45: 'Туман', 48: 'Гололедица',
      51: 'Лёгкая морось', 53: 'Умеренная морось', 55: 'Сильная морось',
      61: 'Лёгкий дождь', 63: 'Умеренный дождь', 65: 'Сильный дождь',
      71: 'Лёгкий снег', 73: 'Умеренный снег', 75: 'Сильный снег',
      80: 'Лёгкие ливни', 81: 'Умеренные ливни', 82: 'Сильные ливни',
      95: 'Гроза', 99: 'Гроза с градом'
    };
    return map[code] || 'Переменная погода';
  }

  actions() {
    return {
      'weather': {
        description: 'Показать погоду в городе',
        format: 'название города (например: Бишкек, Москва, London)',
        icon: '🌤',

        validate: (body) => {
          if (!body?.trim()) return { valid: false, error: 'Укажи город (например: Бишкек)' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const city = body.trim();
          try {
            const w = await this._getWeather(city);
            return {
              success: true,
              output: [
                `${w.emoji} **Погода в ${w.city}, ${w.country}**`,
                ``,
                `🌡 Температура: **${w.temp}°C** (ощущается ${w.feelsLike}°C)`,
                `💧 Влажность: ${w.humidity}%`,
                `💨 Ветер: ${w.wind} м/с`,
                `🌥 ${w.desc}`,
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
      'weather': {
        description: 'Погода в городе',
        handler: async (chatId, args, ctx) => {
          const city = args?.trim() || 'Бишкек';
          try {
            const w = await this._getWeather(city);
            await ctx.send(chatId,
              `${w.emoji} ${w.city}: ${w.temp}°C, ${w.desc}\n💧${w.humidity}% 💨${w.wind}м/с`
            );
          } catch (e) {
            await ctx.send(chatId, `❌ ${e.message}`);
          }
        }
      }
    };
  }
}

module.exports = WeatherPlugin;
