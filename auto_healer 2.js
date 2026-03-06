const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const PROJECT_DIR = '/Users/guest1/Desktop/sCORP';
const LOG_FILES = ['bot.log', 'bot_restart.log'];
const CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
const STATE_FILE = path.join(PROJECT_DIR, '.last_heal_check.json');
const ERROR_KEYWORDS = ['Error:', 'Exception', 'FAIL', 'Command failed', 'throw err'];

function getLastCheckState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

function saveLastCheckState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getFileStats(filePath) {
    if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        return { size: stats.size, mtimeMs: stats.mtimeMs };
    }
    return null;
}

function readNewLogContent(filePath, lastSize) {
    if (!fs.existsSync(filePath)) return '';
    const stats = fs.statSync(filePath);
    if (stats.size <= lastSize) return ''; // No new content or file shrunk/rotated

    const fd = fs.openSync(filePath, 'r');
    const bufferSize = stats.size - lastSize;
    const buffer = Buffer.alloc(bufferSize);
    fs.readSync(fd, buffer, 0, bufferSize, lastSize);
    fs.closeSync(fd);
    
    return buffer.toString('utf8');
}

function hasErrors(content) {
    return ERROR_KEYWORDS.some(keyword => content.includes(keyword));
}

function triggerSelfHealing(errorContext) {
    console.log(`
[${new Date().toISOString()}] 🚨 Errors detected. Initiating self-healing protocol...`);
    
    // Save error context to a temporary file for Claude to analyze
    const contextFile = path.join(PROJECT_DIR, 'latest_error_context.txt');
    fs.writeFileSync(contextFile, errorContext);

    try {
        console.log(`[${new Date().toISOString()}] 🤖 Asking Claude Code to analyze the error...`);
        const claudePrompt = `A system error occurred. Please analyze the error logs in latest_error_context.txt. Write a detailed, step-by-step plan on how to fix this issue in the current codebase. Save the plan to a file named 'claude_fix_plan.txt'. Do NOT apply the fix yourself.`;
        
        // Execute Claude Code (assuming 'claude' is in PATH)
        execSync(`cd "${PROJECT_DIR}" && claude -p "${claudePrompt}"`, { stdio: 'inherit' });
        
        console.log(`
[${new Date().toISOString()}] 🧠 Asking Gemini CLI to implement Claude's plan...`);
        // Execute Gemini CLI (assuming 'gemini' is in PATH)
        const geminiPrompt = `The system experienced an error. Claude Code has analyzed the issue and created a fix plan in 'claude_fix_plan.txt'. Please read this plan, implement the fix in the codebase, and verify it works.`;
        
        execSync(`cd "${PROJECT_DIR}" && gemini --prompt "${geminiPrompt}"`, { stdio: 'inherit' });
        
        console.log(`
[${new Date().toISOString()}] ✅ Self-healing protocol completed.`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] ❌ Failed during self-healing protocol:`, e.message);
    }
}

function checkLogs() {
    console.log(`[${new Date().toISOString()}] 🔍 Checking logs for errors...`);
    const state = getLastCheckState();
    let errorsFound = false;
    let combinedErrorContext = "";

    for (const logFile of LOG_FILES) {
        const fullPath = path.join(PROJECT_DIR, logFile);
        const stats = getFileStats(fullPath);
        
        if (!stats) continue;

        const fileState = state[logFile] || { size: 0, mtimeMs: 0 };
        
        // Check if file was rotated or truncated
        if (stats.size < fileState.size) {
            fileState.size = 0;
        }

        const newContent = readNewLogContent(fullPath, fileState.size);
        
        if (newContent && hasErrors(newContent)) {
            errorsFound = true;
            combinedErrorContext += `
--- Errors from ${logFile} ---
`;
            // Get last ~4000 characters of the new content to give enough context but not overflow
            const snippet = newContent.length > 4000 ? newContent.slice(-4000) : newContent;
            combinedErrorContext += snippet + "\n";
        }

        // Update state
        state[logFile] = { size: stats.size, mtimeMs: stats.mtimeMs };
    }

    saveLastCheckState(state);

    if (errorsFound) {
        triggerSelfHealing(combinedErrorContext);
    } else {
        console.log(`[${new Date().toISOString()}] ✅ No new errors found.`);
    }
}

// Initial check to prime the state file
checkLogs();

// Schedule repeated checks
setInterval(checkLogs, CHECK_INTERVAL);

console.log(`[${new Date().toISOString()}] 🚀 Auto-healer started. Checking logs every 30 minutes.`);
