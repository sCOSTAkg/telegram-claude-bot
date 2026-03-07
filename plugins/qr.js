/**
 * Плагин: QR-коды
 *
 * Генерирует QR-коды для любого текста, ссылки или данных.
 * Использует qr-image (npm) или goqr.me API (без ключа).
 *
 * Action: [ACTION: qr] текст/ссылка — сгенерировать QR-код
 * Command: /qr — быстрый QR
 *
 * Файл: plugins/qr.js
 */

const { PluginBase } = require('../src/core/plugin-sdk');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

class QrPlugin extends PluginBase {
  constructor() {
    super();
    this.name = 'qr';
    this.version = '1.0.0';
    this.description = 'Генерация QR-кодов для ссылок и текста';
    this.author = 'sCORP';
    this.icon = '🔗';
  }

  async onInit(ctx) {
    this.log('Плагин QR-кодов загружен');
  }

  async _generateQR(text) {
    // Используем goqr.me API — бесплатно, без ключа
    const encoded = encodeURIComponent(text);
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}&format=png&margin=10`;

    return new Promise((resolve, reject) => {
      const tmpFile = path.join(os.tmpdir(), `qr_${Date.now()}.png`);
      const file = fs.createWriteStream(tmpFile);

      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`API вернул ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(tmpFile);
        });
      }).on('error', (err) => {
        fs.unlink(tmpFile, () => {});
        reject(err);
      });
    });
  }

  actions() {
    return {
      'qr': {
        description: 'Сгенерировать QR-код для ссылки или текста',
        format: 'текст или URL (например: https://t.me/scorp или "Привет мир")',
        icon: '🔗',

        validate: (body) => {
          if (!body?.trim()) return { valid: false, error: 'Укажи текст или ссылку для QR-кода' };
          if (body.trim().length > 2000) return { valid: false, error: 'Текст слишком длинный (макс. 2000 символов)' };
          return { valid: true };
        },

        execute: async (chatId, body, ctx) => {
          const text = body.trim();

          try {
            const tmpFile = await this._generateQR(text);

            // Определяем тип содержимого
            let typeHint = '';
            if (text.startsWith('http://') || text.startsWith('https://')) {
              typeHint = '🌐 URL';
            } else if (text.startsWith('tel:') || /^\+?\d[\d\s-]{6,}$/.test(text)) {
              typeHint = '📞 Телефон';
            } else if (text.includes('@')) {
              typeHint = '📧 Email';
            } else {
              typeHint = '📝 Текст';
            }

            // Отправляем фото через ctx
            if (ctx?.sendPhoto) {
              await ctx.sendPhoto(chatId, tmpFile, `🔗 QR-код\n${typeHint}: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`);
              // Чистим временный файл
              setTimeout(() => fs.unlink(tmpFile, () => {}), 5000);
              return {
                success: true,
                output: `🔗 QR-код создан!\n${typeHint}: ${text.slice(0, 80)}`
              };
            }

            // Fallback — возвращаем ссылку на QR
            fs.unlink(tmpFile, () => {});
            const encoded = encodeURIComponent(text);
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}`;

            return {
              success: true,
              output: `🔗 **QR-код сгенерирован**\n\n${typeHint}: ${text.slice(0, 100)}\n\n[Открыть QR](${qrUrl})`
            };
          } catch (e) {
            // Fallback без скачивания
            const encoded = encodeURIComponent(text);
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}`;
            return {
              success: true,
              output: `🔗 **QR-код:**\n\n[Открыть/скачать](${qrUrl})\n\n_Данные: ${text.slice(0, 100)}_`
            };
          }
        }
      }
    };
  }

  commands() {
    return {
      'qr': {
        description: 'Создать QR-код',
        handler: async (chatId, args, ctx) => {
          if (!args?.trim()) {
            await ctx.send(chatId, '🔗 Пример: /qr https://t.me/scorp');
            return;
          }
          const text = args.trim();
          try {
            const tmpFile = await this._generateQR(text);
            if (ctx?.sendPhoto) {
              await ctx.sendPhoto(chatId, tmpFile, `🔗 QR: ${text.slice(0, 50)}`);
              setTimeout(() => fs.unlink(tmpFile, () => {}), 5000);
            } else {
              const encoded = encodeURIComponent(text);
              await ctx.send(chatId, `🔗 QR-код: https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}`);
            }
          } catch (e) {
            const encoded = encodeURIComponent(text);
            await ctx.send(chatId, `🔗 QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encoded}`);
          }
        }
      }
    };
  }
}

module.exports = QrPlugin;
