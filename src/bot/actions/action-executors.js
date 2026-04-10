function createActionExecutors(deps) {
  const {
    fetch,
    AbortSignal,
    URL,
    isAdmin,
    isPrivateHost,
    truncateOutput,
    browserManager,
    sendPhoto,
    fs,
  } = deps;

  async function executeWebFetchAction(body) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    let url = lines[0];
    for (const line of lines) {
      const um = line.match(/^url:\s*(.+)/i);
      if (um) url = um[1].trim();
    }
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return { success: false, output: 'web_fetch: требуется валидный URL (http/https)' };
    }
    try {
      const urlObj = new URL(url);
      if (isPrivateHost(urlObj.hostname)) {
        return { success: false, output: 'web_fetch: запросы к локальным/приватным адресам запрещены' };
      }
    } catch (e) { return { success: false, output: `web_fetch: невалидный URL: ${e.message}` }; }

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sCORP-Bot/1.0)', 'Accept': 'text/html,application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(30000), redirect: 'follow'
      });
      if (!res.ok) return { success: false, output: `web_fetch: HTTP ${res.status} ${res.statusText}` };
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json();
        return { success: true, output: truncateOutput(`[JSON ${url}]\n${JSON.stringify(json, null, 2)}`) };
      }
      const text = await res.text();
      return { success: true, output: truncateOutput(`[WEB: ${url}]\n${text}`) };
    } catch (e) {
      return { success: false, output: `web_fetch ошибка: ${e.message?.slice(0, 300)}` };
    }
  }

  async function executeHttpRequestAction(chatId, body) {
    const methodMatch = body.match(/^method:\s*(\w+)/im);
    const urlMatch = body.match(/^url:\s*(.+)/im);
    const headersMatch = body.match(/^headers:\s*(\{[\s\S]*?\})\s*$/im);
    const bodyMatch = body.match(/^body:\s*([\s\S]*?)$/im);
    const method = (methodMatch ? methodMatch[1].trim() : 'GET').toUpperCase();
    const url = urlMatch ? urlMatch[1].trim() : null;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return { success: false, output: 'http_request: требуется поле "url:" с валидным URL' };
    }
    if (!isAdmin(chatId)) {
      try {
        const urlObj = new URL(url);
        if (isPrivateHost(urlObj.hostname)) {
          return { success: false, output: 'http_request: запросы к локальным/приватным адресам запрещены' };
        }
      } catch (e) { return { success: false, output: `http_request: невалидный URL: ${e.message}` }; }
    }

    let headers = {};
    if (headersMatch) {
      try { headers = JSON.parse(headersMatch[1]); }
      catch (e) { return { success: false, output: `http_request: невалидный JSON в headers: ${e.message}` }; }
    }

    const fetchOpts = { method, headers, signal: AbortSignal.timeout(30000) };
    if (['POST', 'PUT', 'PATCH'].includes(method) && bodyMatch) fetchOpts.body = bodyMatch[1].trim();

    try {
      const res = await fetch(url, fetchOpts);
      const ct = res.headers.get('content-type') || '';
      const output = ct.includes('json') ? JSON.stringify(await res.json(), null, 2) : await res.text();
      const statusInfo = `HTTP ${res.status} ${res.statusText}`;
      return { success: res.ok, output: truncateOutput(`[${method} ${url}] ${statusInfo}\n${output}`) };
    } catch (e) {
      return { success: false, output: `http_request ошибка: ${e.message?.slice(0, 300)}` };
    }
  }

  async function executeBrowseAction(chatId, body) {
    if (!isAdmin(chatId)) return { success: false, output: 'browse: доступ только для администраторов' };

    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const params = {};
    for (const line of lines) {
      const kv = line.match(/^(\w+):\s*([\s\S]+)/);
      if (kv) params[kv[1].toLowerCase()] = kv[2].trim();
    }
    const action = params.action || lines[0]?.split(/\s+/)[0]?.toLowerCase();
    if (action !== 'goto') return { success: false, output: 'browse: в модуле поддержан goto (legacy остаётся в bot.js)' };

    const url = params.url || lines[0]?.replace(/^goto\s+/i, '').trim();
    const page = await browserManager.getPage(chatId);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120_000 });
    const title = await page.title();
    const screenshotPath = `/tmp/browse_${chatId}_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    try { await sendPhoto(chatId, screenshotPath, `🌐 ${title}`); } catch (_) {}
    try { fs.unlinkSync(screenshotPath); } catch (_) {}
    return { success: true, output: `Navigated to: ${url}\nTitle: ${title}` };
  }

  return { executeWebFetchAction, executeHttpRequestAction, executeBrowseAction };
}

module.exports = { createActionExecutors };
