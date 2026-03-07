// Минимальный тест: получить сообщение и ответить через exec curl
require('dotenv').config();
const { execSync } = require('child_process');

const token = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${token}`;

function apiCall(method, body) {
  const json = JSON.stringify(body);
  const result = execSync(
    `curl -s -X POST '${API}/${method}' -H 'Content-Type: application/json' -d '${json.replace(/'/g, "'\\''")}'`,
    { encoding: 'utf8' }
  );
  return JSON.parse(result);
}

let offset = 0;

console.log('🤖 Минимальный бот запущен (через curl)');

setInterval(() => {
  try {
    const updates = apiCall('getUpdates', { offset, timeout: 1 });
    if (updates.ok && updates.result.length > 0) {
      for (const upd of updates.result) {
        offset = upd.update_id + 1;
        if (upd.message && upd.message.text) {
          const chatId = upd.message.chat.id;
          const text = upd.message.text;
          console.log(`📨 ${text}`);

          // Отвечаем через curl
          const reply = apiCall('sendMessage', {
            chat_id: chatId,
            text: `Вы написали: ${text}`
          });
          console.log(`📤 ok=${reply.ok} msg_id=${reply.result ? reply.result.message_id : 'ERR'}`);
        }
      }
    }
  } catch (e) {
    console.error('ERR:', e.message);
  }
}, 2000);
