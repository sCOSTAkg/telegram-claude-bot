const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WATCH_DIR = '/Users/guest1/Desktop/sCORP';
const LOG_FILE = path.join(WATCH_DIR, 'transcription_log.txt');

console.log('Мониторинг запущен...');

fs.watch(WATCH_DIR, (eventType, filename) => {
  if (filename && filename.endsWith('.ogg') && eventType === 'rename') {
    const filePath = path.join(WATCH_DIR, filename);
    if (fs.existsSync(filePath)) {
      try {
        console.log(`Обнаружен файл: ${filename}`);
        const audioData = fs.readFileSync(filePath).toString('base64');
        
        const payload = {
          contents: [{
            parts: [
              { text: "Transcribe this audio to Russian text." },
              { inline_data: { mime_type: "audio/ogg", data: audioData } }
            ]
          }]
        };

        const cmd = `curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}" -H "Content-Type: application/json" -d @-`;
        const response = execSync(cmd, { input: JSON.stringify(payload) }).toString();
        const json = JSON.parse(response);
        const text = json.candidates[0].content.parts[0].text;
        
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${filename}: ${text}\n`);
        console.log(`Успешно расшифровано: ${text}`);
      } catch (e) {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Ошибка ${filename}: ${e.message}\n`);
      }
    }
  }
});
