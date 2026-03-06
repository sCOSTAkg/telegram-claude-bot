const { execSync } = require('child_process');
const fs = require('fs');

const filePath = process.argv[2];
const apiKey = process.env.GROQ_VOICE_KEY;

if (!filePath || !fs.existsSync(filePath)) {
    console.error(`Error: File ${filePath} not found.`);
    process.exit(1);
}

if (!apiKey) {
    console.error("Error: GROQ_VOICE_KEY is not set.");
    process.exit(1);
}

const models = ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'];

for (const model of models) {
    try {
        const cmd = `curl -s -X POST https://api.groq.com/openai/v1/audio/transcriptions \
            -H "Authorization: Bearer ${apiKey}" \
            -F "file=@${filePath}" \
            -F "model=${model}" \
            -F "response_format=json"`;
        
        const response = execSync(cmd).toString();
        const json = JSON.parse(response);
        
        if (json.text) {
            console.log(json.text);
            process.exit(0);
        }
    } catch (e) {
        continue;
    }
}

console.error("All models failed or limit reached.");
process.exit(1);
