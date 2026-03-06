---
name: scorp-bot-maintainer
description: Maintain, edit, and code the sCORP Telegram bot at /Users/guest1/Desktop/sCORP. Use when tasks require changing bot behavior, updating plugins, editing config/models/modes/agents, debugging bot runtime issues, reviewing logs/PID state, or implementing new code in this repository.
---

# sCORP Bot Maintainer

## Overview

Use this skill to make safe, production-aware changes in the `sCORP` bot codebase on Desktop. Work inside `/Users/guest1/Desktop/sCORP`, apply minimal targeted edits, and validate behavior before finishing.

## Default Scope

- Use `/Users/guest1/Desktop/sCORP` as the default working directory.
- Prefer primary source files over backups and duplicates (for example files with ` 2` in the name or `*.backup*`) unless the user explicitly asks.
- Treat `.env`, tokens, API keys, and personal identifiers as sensitive data; never expose or rewrite secrets unless requested.

## Core Workflow

1. Map the change quickly.
   - Check repository status and identify touched files first.
   - Read only the modules relevant to the request.
2. Implement the smallest correct fix or feature.
   - Keep style and patterns consistent with existing code.
   - Avoid broad refactors unless explicitly requested.
3. Validate before handoff.
   - Run syntax checks for changed JavaScript files (`node --check <file>`).
   - If startup/runtime logic changed, run a short local start check when possible.
4. Summarize clearly.
   - Report files changed, why the change works, and any gaps (for example, no full runtime test).

## Task Playbooks

### Edit Bot Core

- Start with `bot.js` and nearby config dependencies.
- Keep callback/action names and menu flow backward-compatible unless a breaking change is explicitly requested.
- Re-check startup-related sections (`dotenv`, PID handling, plugin initialization) after edits.

### Add or Update Plugin

- Edit files in `plugins/`.
- Confirm plugin hooks and command paths still match the plugin SDK behavior.
- Validate syntax of the plugin file and any touched SDK/helper file.

### Debug Runtime Problem

- Check recent logs and process state before changing code.
- Confirm whether issue is config/env, runtime crash, or logic regression.
- Fix root cause first; avoid masking with broad try/catch unless justified.

## Quality Bar

- Keep changes small and traceable.
- Preserve existing behavior outside requested scope.
- Prefer deterministic checks over assumptions.
- If full runtime verification is not possible, state it explicitly.

## References

- Read [references/project-map.md](references/project-map.md) for:
  - key files and ownership zones;
  - common command set for edits and diagnostics;
  - startup/log/PID troubleshooting flow.
