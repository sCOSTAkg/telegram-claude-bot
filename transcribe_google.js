const fs = require('fs');

async function transcribe(filePath) {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    console.error("Ошибка: GEMINI_API_KEY не установлен.");
    process.exit(1);
  }

  const audioData = fs.readFileSync(filePath).toString('base64');
  
  const payload = {
    contents: [{
      parts: [
        { text: "Transcribe this audio to Russian text exactly as spoken. Output ONLY the transcription." },
        {
          inline_data: {
            mime_type: "audio/ogg",
            data: audioData
          }
        }
      ]
    }]
  };

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await response.json();
    if (json.candidates && json.candidates[0].content.parts[0].text) {
      console.log(json.candidates[0].content.parts[0].text.trim());
    } else {
      console.error("Ошибка API:", JSON.stringify(json));
    }
  } catch (err) {
    console.error("Ошибка выполнения запроса:", err.message);
  }
}

const path = process.argv[2];
if (!path) {
  console.error("Укажите путь к файлу.");
  process.exit(1);
}
transcribe(path);
