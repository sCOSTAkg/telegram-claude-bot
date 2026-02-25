const TelegramBot = require('node-telegram-bot-api');

const token = '8006856175:AAHcdqQd3G_E4tnKK1nk3rra9tHzDZ9TNcA';
const bot = new TelegramBot(token);

console.log('Отправляю тестовое сообщение...');

bot.sendMessage(5572422549, 'ТЕСТ: Это сообщение от простого скрипта')
  .then(result => {
    console.log('✅ Успешно! Message ID:', result.message_id);
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Ошибка:', error);
    process.exit(1);
  });
