const GEMINI_CLI_PATH = process.env.GEMINI_CLI_PATH || '/opt/homebrew/bin/gemini';

function buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs = []) {
  let prompt;
  if (messages.length === 1) {
    prompt = messages[0].content;
  } else {
    let ctx = 'Предыдущие сообщения в диалоге:
';
    for (let i = 0; i < messages.length - 1; i++) {
      ctx += `${messages[i].role === 'user' ? 'Пользователь' : 'Ассистент'}: ${messages[i].content}
`;
    }
    ctx += `
Текущее сообщение пользователя:
${messages[messages.length - 1].content}`;
    prompt = ctx;
  }
  if (systemPrompt) {
      prompt = `System instructions:
${systemPrompt}

User prompt:
${prompt}`;
  }
  const args = ['-p', '', '-y', ...extraArgs];
  if (modelId !== 'gemini-cli') {
    args.push('--model', modelId);
  }
  return { args, prompt };
}

async function callGeminiCLI(modelId, messages, systemPrompt, allowMcp = true, chatId = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const { args, prompt } = buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId);

  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(GEMINI_CLI_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Gemini CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `Gemini CLI exit code ${code}`));
      else resolve({ text: stdout.trim() || 'Готово (без вывода)', usage: null });
    });
  });
}

async function callGeminiCLIStream(modelId, messages, systemPrompt, onChunk, allowMcp = true, chatId = null, onEvent = null) {
  const uc = chatId ? getUserConfig(chatId) : defaultUserConfig;
  const useStreamJson = !!onEvent;
  const extraArgs = useStreamJson ? ['-o', 'stream-json'] : [];
  const { args, prompt } = buildGeminiCliArgs(modelId, messages, systemPrompt, allowMcp, chatId, extraArgs);

  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
    const child = spawn(GEMINI_CLI_PATH, args, { cwd: process.env.WORKING_DIR || os.homedir(), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => reject(new Error(`Gemini CLI: ${err.message}`)));
    child.stdin.write(prompt);
    child.stdin.end();

    let finalText = '';
    let stderr = '';
    let durationMs = null;
    let turns = 0;

    if (useStreamJson) {
      let lineBuf = '';
      child.stdout.on('data', (d) => {
        lineBuf += d.toString();
        const lines = lineBuf.split('
');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim() || !line.startsWith('{')) continue;
          try {
            const event = JSON.parse(line);
            
            if (event.type === 'message' && event.role === 'assistant' && event.content) {
              if (onEvent) onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: event.content }] } });
              finalText += event.content;
              if (onChunk) onChunk(finalText);
            } else if (event.type === 'tool_use') {
              turns++;
              if (onEvent) onEvent({ 
                type: 'assistant', 
                message: { content: [{ type: 'tool_use', name: event.tool_name, input: event.parameters }] } 
              });
            } else if (event.type === 'tool_result') {
              if (onEvent) onEvent({
                type: 'tool_result',
                is_error: event.status === 'error'
              });
            } else if (event.type === 'result') {
              if (event.stats) {
                durationMs = event.stats.duration_ms || null;
              }
              if (onEvent) onEvent({ type: 'result', duration_ms: durationMs, num_turns: turns, cost_usd: 0 });
            }
          } catch (e) { /* skip malformed JSON */ }
        }
      });
    } else {
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d;
        if (onChunk) onChunk(stdout.trim());
        finalText = stdout;
      });
    }

    child.stderr.on('data', d => { stderr += d; });

    const timeoutMs = (uc.timeout || 120) * 1000;
    const killTimer = setTimeout(() => { try { child.kill(); } catch(e) {} }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !finalText.trim()) reject(new Error(stderr.trim() || `Код ${code}`));
      else resolve({
        text: finalText.trim() || 'Готово (без вывода)',
        usage: { duration_ms: durationMs, num_turns: turns, cost_usd: null }
      });
    });
  });
}
