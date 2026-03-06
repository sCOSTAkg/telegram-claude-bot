# sCORP Project Map

## Root

- Repository path: `/Users/guest1/Desktop/sCORP`
- Entry point: `bot.js`
- Package scripts: `npm start`, `npm run dev`

## Key Code Areas

- `bot.js`: Main runtime, Telegram handlers, callback routing, menu actions, model routing, process/PID flow.
- `plugins/*.js`: Feature plugins (todo, notes, weather, exchange, translate, qr, crypto, action logger).
- `src/core/plugin-sdk.js`: Plugin manager and hooks integration used by `bot.js`.
- `config/agents.js`: Agent roles and presets.
- `config/modes.js`: Specialized mode definitions and categories.
- `config/models.js`: Model/provider map and model lists.
- `src/core/config.js`: Shared config helpers.
- `zep_memory.js`: Memory integration used by runtime.

## Operational Files

- `.env`: Runtime secrets and environment values.
- `config.json`: Persistent bot runtime/user settings.
- `bot.log`: Runtime log output.
- `bot.pid`: PID file for current running process.
- `users.json`: User data persistence.
- `agent_experience.json`: Learned runtime patterns.

## Fast Command Set

Run from `/Users/guest1/Desktop/sCORP`.

```bash
git status --short
rg --files src plugins config
node --check bot.js
node --check plugins/<plugin>.js
tail -n 120 bot.log
cat bot.pid
ps -p "$(cat bot.pid)" -o pid,ppid,etime,command
```

## Debug Sequence

1. Confirm process state (`bot.pid` and `ps`) and inspect recent log tail.
2. Identify the narrow module likely responsible (`bot.js`, plugin, or config file).
3. Apply the smallest fix in source files only (avoid backup copies unless asked).
4. Run `node --check` on all edited `.js` files.
5. If startup path changed, run a short startup check and confirm no immediate crash.
6. Report what was changed and what was/was not validated.
