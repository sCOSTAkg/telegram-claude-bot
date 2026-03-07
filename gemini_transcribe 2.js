const fs = require('fs');
const https = require('https');

const API_KEY = process.env.GEMINI_API_KEY;
const FILE_PATH = process.argv[2];

if (!FILE_PATH || !fs.existsSync(FILE_PATH)) {
    console.error(JSON.stringify({ error: "File not found" }));
    process.exit(1);
}

const audioData = fs.readFileSync(FILE_PATH).toString('base64');

const data = JSON.stringify({
    contents: [{
        parts: [
            { text: "Transcribe this audio to Russian text precisely. Output ONLY the transcription." },
            {
                inline_data: {
                    mime_type: "audio/ogg",
                    data: audioData
                }
            }
        ]
    }]
});

const options = {
    hostname: 'generativelanguage.googleapis.com',
    port: 443,
    path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => {
        try {
            const json = JSON.parse(body);
            const text = json.candidates[0].content.parts[0].text.trim();
            console.log(JSON.stringify({ text }));
        } catch (e) {
            console.error(JSON.stringify({ error: "Failed to parse Gemini response", raw: body }));
        }
    });
});

req.on('error', (e) => {
    console.error(JSON.stringify({ error: e.message }));
});

req.write(data);
req.end();
