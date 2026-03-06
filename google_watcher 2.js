const fs = require('fs');
const { execSync } = require('child_process');
const folder = '/Users/guest1/Desktop/sCORP';
const apiKey = process.env.GEMINI_API_KEY;

fs.watch(folder, (eventType, filename) => {
  if (filename && filename.endsWith('.ogg') && eventType === 'rename') {
    const filePath = `${folder}/${filename}`;
    if (fs.existsSync(filePath)) {
      try {
        const b64 = execSync(`base64 -i "${filePath}"`).toString().trim();
        const response = execSync(`curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}" -H "Content-Type: application/json" -d '{"contents": [{"parts": [{"text": "Transcribe accurately to Russian."}, {"inline_data": {"mime_type": "audio/ogg", "data": "${b64}"}}]}]}'`).toString();
        const text = JSON.parse(response).candidates[0].content.parts[0].text;
        fs.writeFileSync(`${folder}/last_voice.txt`, text);
      } catch (e) {}
    }
  }
});
