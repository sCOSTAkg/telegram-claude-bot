const fs = require('fs');
let c = fs.readFileSync('bot.js', 'utf8');
c = c.replace(/`\\``/g, '```');
fs.writeFileSync('bot.js', c);
console.log('Fixed backticks');
