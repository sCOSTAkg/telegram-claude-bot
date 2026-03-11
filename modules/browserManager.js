/**
 * BrowserManager — per-chatId Chrome session manager via puppeteer-core.
 * Sessions auto-expire after 15 minutes of inactivity.
 * Cookies persist to disk across browser restarts.
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME_PATH = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSION_IDLE_TIMEOUT = 15 * 60 * 1000; // 15 min
const COOKIE_DIR = path.join(os.homedir(), '.scorp-browser-cookies');

class BrowserManager {
  constructor() {
    /** @type {Map<number, {browser: any, page: any, history: Array, createdAt: number, lastUsedAt: number}>} */
    this.sessions = new Map();
    this._cleanupTimer = setInterval(() => this._cleanupIdle(), 60_000);
  }

  async getOrCreate(chatId) {
    let session = this.sessions.get(chatId);
    if (session && session.browser?.connected) {
      session.lastUsedAt = Date.now();
      return session;
    }
    if (session) await this._closeSession(chatId);

    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    await this._restoreCookies(chatId, page);

    session = {
      browser,
      page,
      history: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.sessions.set(chatId, session);
    return session;
  }

  async getPage(chatId) {
    const session = await this.getOrCreate(chatId);
    if (session.page.isClosed()) {
      session.page = await session.browser.newPage();
      await session.page.setViewport({ width: 1920, height: 1080 });
    }
    session.lastUsedAt = Date.now();
    return session.page;
  }

  async close(chatId) {
    await this._closeSession(chatId);
  }

  async destroyAll() {
    clearInterval(this._cleanupTimer);
    const promises = [];
    for (const chatId of this.sessions.keys()) {
      promises.push(this._closeSession(chatId));
    }
    await Promise.allSettled(promises);
  }

  async saveCookies(chatId) {
    try {
      const session = this.sessions.get(chatId);
      if (!session?.page || session.page.isClosed()) return;
      const cookies = await session.page.cookies();
      if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(COOKIE_DIR, `${chatId}.json`),
        JSON.stringify(cookies, null, 2)
      );
    } catch (e) {
      console.warn(`[BrowserManager] saveCookies(${chatId}):`, e.message);
    }
  }

  async _restoreCookies(chatId, page) {
    try {
      const cookieFile = path.join(COOKIE_DIR, `${chatId}.json`);
      if (fs.existsSync(cookieFile)) {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        if (Array.isArray(cookies) && cookies.length > 0) {
          await page.setCookie(...cookies);
          console.log(`[BrowserManager] Restored ${cookies.length} cookies for ${chatId}`);
        }
      }
    } catch (e) {
      console.warn(`[BrowserManager] restoreCookies(${chatId}):`, e.message);
    }
  }

  async _closeSession(chatId) {
    const session = this.sessions.get(chatId);
    if (!session) return;
    try {
      await this.saveCookies(chatId);
      await session.browser.close();
    } catch (e) {
      console.warn(`[BrowserManager] close(${chatId}):`, e.message);
    }
    this.sessions.delete(chatId);
  }

  _cleanupIdle() {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT) {
        console.log(`[BrowserManager] Cleaning up idle session for ${chatId}`);
        this._closeSession(chatId);
      }
    }
  }

  listSessions() {
    const result = [];
    for (const [chatId, s] of this.sessions) {
      result.push({
        chatId,
        connected: s.browser?.connected ?? false,
        age: Math.round((Date.now() - s.createdAt) / 1000),
        idle: Math.round((Date.now() - s.lastUsedAt) / 1000),
        historyLength: s.history.length,
      });
    }
    return result;
  }
}

module.exports = { BrowserManager };
