const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const TIMEOUT = setTimeout(() => { process.exit(1); }, 90000);

(async () => {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".notebooklm-mcp/auth.json"), "utf8"));

  // Set cookies on BOTH google.com AND googleusercontent.com
  const makeCookies = (domain) => Object.entries(auth.cookies).map(([name, value]) => {
    const c = { name, value, domain, path: "/" };
    if (name.startsWith("__Secure-")) c.secure = true;
    return c;
  });

  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new",
    args: [
      "--no-sandbox", "--disable-gpu", "--window-size=1920,1080",
      "--disable-web-security",  // Disable CORS
      "--disable-features=IsolateOrigins,site-per-process"
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Set cookies on both domains
  await page.setCookie(
    ...makeCookies(".google.com"),
    ...makeCookies(".googleusercontent.com")
  );

  // Also try setting user-agent to a regular Chrome
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  // Go directly to the infographic image URL first
  const imgUrl = "https://lh3.googleusercontent.com/notebooklm/ANHLwAw96vuvn8ADQSpzsuRg4XH2A0_ycY6hs_WmC-J1ZYo9GOEyWyslc4ZEqPVpW4AoQL7tVxGEp6dx9OXfxdD8aawty-QGUaeHxgzC-lDjN-DXCMnzCSqXlygvEJFSw1PqHV8ih0G_b4-XvvZiJZRiHbz";

  const resp = await page.goto(imgUrl, { waitUntil: "load", timeout: 15000 });
  const status = resp.status();
  const ct = resp.headers()["content-type"] || "";
  console.log("Direct image URL - Status:", status, "Type:", ct);

  if (status === 200 && ct.includes("image")) {
    const buf = await resp.buffer();
    fs.writeFileSync("/tmp/nb_infographic_direct.png", buf);
    console.log("SAVED image:", buf.length, "bytes");
  }

  // Also try the three dots menu on the infographic page
  await page.goto("https://notebooklm.google.com/notebook/2d63cc03-12df-4cc1-b159-1ceba68804ad", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Click Studio
  let btns = await page.$$("button");
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    if (txt === "Студия") { await btn.click(); break; }
  }
  await new Promise(r => setTimeout(r, 3000));

  // Click infographic
  btns = await page.$$("button");
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    if (txt.includes("кузница бойцов")) { await btn.click(); break; }
  }
  await new Promise(r => setTimeout(r, 5000));

  // Click three dots (...) menu on the infographic panel
  btns = await page.$$("button");
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    const ariaLabel = await btn.evaluate(el => el.getAttribute("aria-label") || "");
    if (txt === "more_horiz" || txt === "..." || ariaLabel.includes("More") || ariaLabel.includes("Ещё") || ariaLabel.includes("Другие")) {
      const isInPanel = await btn.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.y < 100 && rect.x > 1000; // Top-right area
      });
      if (isInPanel) {
        console.log("Clicking three dots:", txt || ariaLabel);
        await btn.click();
        break;
      }
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  await page.screenshot({ path: "/tmp/nb_dots_menu.png" });

  // Check menu items
  const menuItems = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll("[role=menuitem], [role=option], .cdk-overlay-pane button, mat-menu button, [mat-menu-item]").forEach(el => {
      items.push(el.textContent.trim().slice(0, 50));
    });
    return items;
  });
  console.log("Menu items:", menuItems);

  await browser.close();
  clearTimeout(TIMEOUT);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
