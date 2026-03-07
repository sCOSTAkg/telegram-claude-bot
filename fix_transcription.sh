#!/bin/bash
FILE=$(ls -t /Users/guest1/Desktop/sCORP/voice_*.ogg | head -n 1)
if [ -z "$FILE" ]; then echo "No voice files found"; exit 1; fi
echo "Processing $FILE via Gemini..."
curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY \
    -H 'Content-Type: application/json' \
    -X POST \
    -d '{
      "contents": [{
        "parts":[
          {"text": "Transcribe this audio to Russian text accurately."},
          {"inline_data": {
            "mime_type":"audio/ogg",
            "data": "'$(base64 -i "$FILE")'"
          }}
        ]
      }]
    }'
