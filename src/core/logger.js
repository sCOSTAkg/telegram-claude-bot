/**
 * Logger module with sensitive data masking
 */

const SENSITIVE_PATTERNS = [
  /TELEGRAM_BOT_TOKEN[=:]\s*[^\s]+/gi,
  /API_KEY[=:]\s*[^\s]+/gi,
  /sk-[a-zA-Z0-9]+/g,
  /Bearer\s+[a-zA-Z0-9_\-]+/g,
  /"apiKey"\s*:\s*"[^"]+"/gi,
  /"token"\s*:\s*"[^"]+"/gi,
  /chatId:\s*\d+/gi,
];

class Logger {
  constructor(name = 'Bot') {
    this.name = name;
  }

  _mask(text) {
    let masked = String(text);
    for (const pattern of SENSITIVE_PATTERNS) {
      masked = masked.replace(pattern, '[MASKED]');
    }
    return masked;
  }

  log(msg) {
    console.log(`[${this.name}] ${this._mask(msg)}`);
  }

  error(msg, err = null) {
    console.error(`[${this.name}] ERROR: ${this._mask(msg)}`);
    if (err) console.error(this._mask(err.message));
  }

  warn(msg) {
    console.warn(`[${this.name}] WARN: ${this._mask(msg)}`);
  }

  debug(msg) {
    if (process.env.DEBUG) {
      console.log(`[${this.name}] DEBUG: ${this._mask(msg)}`);
    }
  }

  info(msg) {
    console.log(`[${this.name}] INFO: ${this._mask(msg)}`);
  }
}

module.exports = Logger;
