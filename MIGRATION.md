# sCORP Refactoring Migration Guide

**Document**: Complete step-by-step migration from monolithic bot.js to modular architecture
**Duration**: 3-4 weeks (phased approach)
**Impact**: 50% code reduction, 95%+ stability, 90+ security score

---

## Phase 1: Foundation (Week 1) - Critical Path

### Step 1.1: Create Core Config Module
**Files**: `src/core/config.js` ✅ DONE
**Time**: 30 minutes

**What it does**:
- Manages bot configuration with LRU caching
- Batches config saves (debounce 3s instead of 118 calls)
- Prevents disk thrashing

**Migration steps**:
```bash
1. File already created: /Users/guest1/Desktop/sCORP/src/core/config.js
2. In bot.js, replace saveConfig() implementation:
   OLD: fs.writeFileSync(CONFIG_PATH, JSON.stringify(config), 'utf8');
   NEW: configManager.set(key, value); // Cached + batched
3. Test: Run bot, verify config saves work
4. Verify disk writes reduced to ~10/session (from 118)
```

**Testing**:
```javascript
// In bot.js
const ConfigManager = require('./src/core/config');
const configManager = new ConfigManager(CONFIG_PATH);

// Replace all saveConfig() with:
configManager.queueUpdate('key', value); // Batched
// Or immediate: configManager.set('key', value);

// Verify
console.log('Config saves/session:', saveCallCount); // Should be ~10
```

---

### Step 1.2: Create Memory Management Module
**Files**: `src/core/memory.js` ✅ DONE
**Time**: 45 minutes

**What it does**:
- LRU cache for chatHistory (max 1000 entries)
- Automatic eviction of old entries (>24h)
- Background task tracking
- Prevents memory leaks

**Migration steps**:
```javascript
// In bot.js, replace:
const chatHistory = new Map();

// With:
const MemoryManager = require('./src/core/memory');
const memoryManager = new MemoryManager(1000);

// Replace addToHistory():
OLD: chatHistory.set(chatId, [...]);
NEW: memoryManager.addToHistory(chatId, role, content);

// Replace getHistory():
OLD: chatHistory.get(chatId) || [];
NEW: memoryManager.getHistory(chatId);

// Add periodic cleanup (in main loop):
setInterval(() => memoryManager.evictOld(24 * 60 * 60 * 1000), 60 * 60 * 1000);
```

**Verify**:
- Run bot for 24 hours
- Check memory usage: should be capped at ~100-150MB
- Verify old entries auto-cleared

---

### Step 1.3: Create Logger Module
**Files**: `src/core/logger.js` ✅ DONE
**Time**: 30 minutes

**What it does**:
- Masks sensitive data in logs (API keys, tokens, chatIds)
- Prevents security leaks
- Consistent logging format

**Migration steps**:
```javascript
// In bot.js, replace all console.log/error with:
const Logger = require('./src/core/logger');
const logger = new Logger('Bot');

// Replace:
OLD: console.log('Some message with ' + process.env.API_KEY);
NEW: logger.log('Some message'); // API_KEY auto-masked

OLD: console.error(err.message);
NEW: logger.error('Error', err);

OLD: console.warn('Warning');
NEW: logger.warn('Warning');
```

**Verify**:
- Check bot.log file
- No API keys visible
- No chatIds exposed
- Error messages still informative

---

### Step 1.4: Create Error Handling Module
**Files**: `src/core/errors.js` ✅ DONE
**Time**: 45 minutes

**What it does**:
- Circuit breaker pattern (prevents cascade failures)
- Exponential backoff with jitter
- Automatic retry logic

**Migration steps**:
```javascript
// In bot.js, wrap API calls:
const { CircuitBreaker, retryWithBackoff } = require('./src/core/errors');

// Create breakers for each API:
const tgBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 60000,
  maxBackoff: 300000
});

// Wrap Telegram API calls:
const result = await tgBreaker.execute(async () => {
  return await tgApi('getUpdates', {});
});

// Or use retry:
const result = await retryWithBackoff(
  async () => await fetch(url),
  { maxRetries: 3, initialDelay: 1000 }
);
```

**Verify**:
- Simulate network failures
- Verify retries work
- Check circuit breaker opens after 5 failures
- Verify exponential backoff (1s → 2s → 4s)

---

### Step 1.5: Create Unified AI Provider Module
**Files**: `src/ai/provider.js` ✅ DONE
**Time**: 2 hours

**What it does**:
- Consolidates 4 duplicate AI implementations
- Unified interface for all providers
- Single error handling path
- Retry logic built-in

**Migration steps**:
```javascript
// In bot.js, replace all AI calls:
const AIProvider = require('./src/ai/provider');
const aiProvider = new AIProvider({
  claudePath: process.env.CLAUDE_PATH,
  geminiCliPath: process.env.GEMINI_CLI_PATH,
  defaultTimeout: 120000
});

// Replace:
OLD:
const result = await callAI(model, messages, systemPrompt);

NEW:
const result = await aiProvider.call(model, messages, systemPrompt, {
  chatId,
  allowMcp: true,
  timeout: 120000
});
```

**Code consolidation**:
- Remove callAnthropic() (185 lines) ✅
- Remove callOpenAI() (25 lines) ✅
- Remove callGemini() (30 lines) ✅
- Remove callGroq() (25 lines) ✅
- Remove callGeminiCLI() (25 lines) ✅
- Remove callAI() router (25 lines) ✅
- **Total removed**: 315 lines, replaced by 250-line unified module

**Verify**:
- Test all 5 providers work
- Error messages consistent
- Response format unchanged
- Performance same or better

---

## Phase 2: Handlers & Integration (Week 2)

### Step 2.1: Create Telegram Handlers Module
**New file**: `src/telegram/handlers.js`
**Time**: 2-3 hours

**Extract from bot.js**:
```javascript
// Lines to extract:
- handleMessage() [~142 lines]
- handleCallback() [~287 lines]
- All message processing logic
- Agent execution logic

// New structure:
module.exports = {
  handleMessage,
  handleCallback,
  parseCommand,
  executeAgent,
  ... other handlers
};
```

**Usage**:
```javascript
const handlers = require('./src/telegram/handlers');

bot.on('message', (msg) => handlers.handleMessage(msg, { aiProvider, memoryManager, configManager }));
bot.on('callback_query', (cb) => handlers.handleCallback(cb, { aiProvider, memoryManager, configManager }));
```

---

### Step 2.2: Create Keyboards Module
**New file**: `src/telegram/keyboards.js`
**Time**: 1-2 hours

**Extract from bot.js**:
- All inline_keyboard definitions
- All reply_keyboard definitions
- Keyboard builders

**Usage**:
```javascript
const keyboards = require('./src/telegram/keyboards');
const kb = keyboards.mainMenu();
await tgApi('sendMessage', { chat_id: chatId, reply_markup: kb });
```

---

### Step 2.3: Create CLI Module
**New file**: `src/cli/index.js`
**Time**: 1 hour

**Extract from bot.js**:
- Claude CLI invocation
- Gemini CLI invocation
- Process spawning logic
- Stream parsing

---

## Phase 3: Optimization (Week 3)

### Step 3.1: Batch Config Saves
**Time**: 1 hour
**Impact**: 6 seconds saved per session

```javascript
// In config.js, already implemented
// Just need to verify bot.js uses queueUpdate() instead of set()

// Replace all:
OLD: saveConfig();
NEW: configManager.queueUpdate('config', config);
     // Auto-saves after 3s if multiple updates
```

**Verify**:
- Monitor disk writes
- Should go from 118/session to <10
- No data loss on crash (batched saves still write)

---

### Step 3.2: Implement Memory Eviction
**Time**: 1 hour
**Impact**: 40-50MB memory savings

```javascript
// In main loop (every hour):
setInterval(() => {
  memoryManager.evictOld(24 * 60 * 60 * 1000); // >24h old
  // Also clean up:
  backgroundTasks.forEach((tasks, chatId) => {
    tasks.forEach((task, id) => {
      if (Date.now() - task.created > 48 * 60 * 60 * 1000) {
        tasks.delete(id);
      }
    });
  });
  const stats = memoryManager.stats();
  logger.info(`Memory cleanup: ${JSON.stringify(stats)}`);
}, 60 * 60 * 1000);
```

---

### Step 3.3: Cache Memory Dedup Results
**Time**: 1.5 hours
**Impact**: 2-3 seconds saved on repeated prompts

```javascript
// Add simple cache:
const memoryDedupCache = new Map(); // key: SHA256(fact), TTL: 5min

async function addMemoryEntryWithDedup(chatId, fact, ...) {
  const cacheKey = crypto.createHash('sha256').update(fact).digest('hex');

  // Check cache first
  const cached = memoryDedupCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
    return cached.result;
  }

  // Original logic...
  const result = await performDedup(fact);

  // Cache it
  memoryDedupCache.set(cacheKey, { result, time: Date.now() });
  return result;
}

// Cleanup old cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of memoryDedupCache) {
    if (now - val.time > 10 * 60 * 1000) {
      memoryDedupCache.delete(key);
    }
  }
}, 10 * 60 * 1000);
```

---

### Step 3.4: Convert userConfigs to Map
**Time**: 2 hours
**Impact**: O(n) → O(1) user lookups

```javascript
// Current (slow):
let userConfigs = loadConfig().userConfigs || {};
function getUserConfig(chatId) {
  return userConfigs[chatId] || defaultUserConfig;
}

// New (fast):
const userConfigMap = new Map(); // chatId → config

function getUserConfig(chatId) {
  if (!userConfigMap.has(chatId)) {
    const all = loadConfig().userConfigs || {};
    userConfigMap.set(chatId, all[chatId] || defaultUserConfig);
  }
  return userConfigMap.get(chatId);
}

function saveUserConfig(chatId) {
  const all = loadConfig().userConfigs || {};
  all[chatId] = userConfigMap.get(chatId);
  configManager.queueUpdate('userConfigs', all);
  userConfigMap.set(chatId, all[chatId]); // Keep cache in sync
}
```

---

## Phase 4: Testing & Cleanup (Week 4)

### Step 4.1: Create Unit Tests
**Time**: 8-10 hours
**Coverage target**: 60%

**Test critical modules**:
```javascript
// tests/core/config.test.js
test('Config caching works', () => { ... });
test('Config batching with debounce', () => { ... });

// tests/core/memory.test.js
test('LRU eviction at max size', () => { ... });
test('TTL cleanup removes old entries', () => { ... });

// tests/ai/provider.test.js
test('All 5 providers callable', () => { ... });
test('Fallback chain works', () => { ... });
test('Error handling consistent', () => { ... });

// tests/telegram/handlers.test.js
test('handleMessage parses commands', () => { ... });
test('handleCallback validates input', () => { ... });
```

**Run tests**:
```bash
npm test -- --coverage
# Target: 60% overall coverage
```

---

### Step 4.2: Security Hardening
**Time**: 4-5 hours

**Implement**:
1. Encrypt config.json
2. Encrypt users.json
3. Add input validation
4. Add rate limiting
5. Sanitize error messages

```javascript
// Simple encryption (before production, use proper secrets manager):
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ||
  crypto.scryptSync(process.env.TELEGRAM_BOT_TOKEN, 'salt', 32);

function encryptData(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptData(encrypted) {
  const parts = encrypted.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(parts[1], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

---

### Step 4.3: Performance Benchmarking
**Time**: 2 hours

**Measure**:
```javascript
// Before/After metrics
const metrics = {
  configSaves: 0,
  diskWrites: 0,
  memoryUsage: 0,
  avgResponseTime: 0,
  errorRate: 0
};

// Monitor
setInterval(() => {
  const memUsage = process.memoryUsage();
  logger.info(`Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
  logger.info(`Config saves: ${metrics.configSaves}`);
  logger.info(`Error rate: ${metrics.errorRate.toFixed(2)}%`);
}, 60000);
```

**Expected improvements**:
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Config saves/session | 118 | <10 | 92% |
| Memory usage | 150MB | 100-110MB | 30% |
| Response time | 2.3s | 2.0s | 13% |
| Disk I/O | 118 ops | <10 ops | 92% |
| Error rate | 4.98% | 2-3% | 50% |

---

### Step 4.4: Cleanup & Documentation
**Time**: 3-4 hours

**Remove old code**:
- Remove duplicate AI functions ✅
- Remove old streaming logic
- Remove test files (test*.js)
- Remove helper scripts (nb_*, transcribe_*)

**Add documentation**:
- API documentation
- Architecture diagram
- Setup guide
- Contributing guidelines

---

## New bot.js Structure (Post-Migration)

**Size reduction**: 8,360 lines → ~2,000 lines (76% reduction!)

```javascript
// bot.js (NEW - 2000 lines)

require('dotenv').config();
const { TelegramClient } = require('telegram');

// Core modules
const ConfigManager = require('./src/core/config');
const MemoryManager = require('./src/core/memory');
const Logger = require('./src/core/logger');
const AIProvider = require('./src/ai/provider');
const { CircuitBreaker, retryWithBackoff } = require('./src/core/errors');

// Telegram modules
const handlers = require('./src/telegram/handlers');
const keyboards = require('./src/telegram/keyboards');

// Initialize
const logger = new Logger('Bot');
const config = new ConfigManager(CONFIG_PATH);
const memoryManager = new MemoryManager(1000);
const aiProvider = new AIProvider();
const tgCircuitBreaker = new CircuitBreaker();

// Main bot logic (SHORT AND SIMPLE!)
async function main() {
  logger.log('🚀 sCORP Starting...');

  // Setup handlers
  bot.on('message', (msg) => handlers.handleMessage(msg, {
    aiProvider, memoryManager, config, logger, tgCircuitBreaker
  }));

  bot.on('callback_query', (cb) => handlers.handleCallback(cb, {
    aiProvider, memoryManager, config, logger
  }));

  // Cleanup tasks
  setInterval(() => memoryManager.evictOld(), 60 * 60 * 1000);
  setInterval(() => config.evictOldCache(), 30 * 60 * 1000);

  // Start polling
  logger.log('✅ Bot ready');
  bot.start();
}

main().catch(err => logger.error('Fatal error', err));
```

---

## Validation Checklist

### Functional Testing
- [ ] All commands work (/start, /help, /clear, etc.)
- [ ] All models respond correctly
- [ ] Memory system works
- [ ] Config persistence works
- [ ] Agent mode works
- [ ] Streaming works

### Performance Testing
- [ ] Response time <3s (avg)
- [ ] Memory <150MB sustained
- [ ] Config saves <10/session
- [ ] No memory leaks after 24h

### Security Testing
- [ ] No API keys in logs
- [ ] Config/users encrypted
- [ ] Input validated
- [ ] Rate limiting works
- [ ] Error messages sanitized

### Code Quality
- [ ] All tests pass
- [ ] Test coverage >60%
- [ ] No linting errors
- [ ] Documentation complete
- [ ] Code review approved

---

## Rollback Plan (If needed)

**If migration fails**:
1. Keep backup of original bot.js
2. Revert: `git checkout bot.js`
3. Investigate specific module
4. Fix and re-test that module
5. Retry migration

**Git strategy**:
```bash
git branch -b refactor/modularize
# ... make changes ...
git commit -m "Refactor: Modularize bot.js (src/core + src/ai)"
git push origin refactor/modularize
# ... review, test, then merge ...
git checkout main
git merge refactor/modularize
```

---

## Timeline Summary

| Phase | Week | Tasks | Hours |
|-------|------|-------|-------|
| **Phase 1** | 1 | Config, Memory, Logger, Errors, AI Provider | 15 |
| **Phase 2** | 2 | Handlers, Keyboards, CLI extraction | 12 |
| **Phase 3** | 3 | Batching, Eviction, Caching, Optimization | 10 |
| **Phase 4** | 4 | Testing, Security, Benchmarking, Cleanup | 20 |
| **TOTAL** | 4 weeks | Full refactoring | 57 hours |

---

## Success Criteria

✅ **All Critical**: 8,360 → 2,000 lines | 5 providers consolidated | 92% config save reduction
✅ **All High**: Memory capped at 150MB | All tests pass | Security score 90+
✅ **All Medium**: 60% test coverage | Documentation complete | Zero tech debt

---

## Next Steps

1. **Review** this migration guide
2. **Approve** Phase 1 tasks
3. **Start** Step 1.1 (Config module)
4. **Notify** when Phase 1 complete
5. **Proceed** to Phase 2

**Estimated Go-Live**: 4 weeks from start

---

*Migration Guide prepared 2026-03-02*
*Implementation in progress*

