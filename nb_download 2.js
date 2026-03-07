// NotebookLM artifact downloader via Puppeteer
// Usage: node nb_download.js <notebook_id> <artifact_name> <output_path>
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const nbId = process.argv[2];
const artifactName = process.argv[3];
const outputPath = process.argv[4] || "/tmp/nb_download";

if (!nbId || !artifactName) {
  console.error("Usage: node nb_download.js <notebook_id> <artifact_name> <output_path>");
  process.exit(1);
}

const TIMEOUT = setTimeout(() => {
  console.error("GLOBAL_TIMEOUT");
  process.exit(1);
}, 120000);

(async () => {
  const authPath = path.join(process.env.HOME || "/Users/guest1", ".notebooklm-mcp", "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const cookies = Object.entries(auth.cookies).map(([name, value]) => {
    const c = { name, value, domain: ".google.com", path: "/" };
    if (name.startsWith("__Secure-")) c.secure = true;
    return c;
  });

  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1920,1080"]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setCookie(...cookies);

  // Set download path via CDP
  const client = await page.createCDPSession();
  const downloadDir = path.dirname(outputPath);
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir
  });

  // Track downloads
  let downloadStarted = false;
  let downloadFile = null;
  client.on("Page.downloadWillBegin", (params) => {
    console.log("Download started:", params.suggestedFilename);
    downloadFile = path.join(downloadDir, params.suggestedFilename);
    downloadStarted = true;
  });
  client.on("Page.downloadProgress", (params) => {
    if (params.state === "completed") {
      console.log("Download completed");
    }
  });

  // Also monitor for download via Browser.downloadWillBegin
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });
  client.on("Browser.downloadWillBegin", (params) => {
    console.log("Browser download:", params.suggestedFilename);
    downloadFile = path.join(downloadDir, params.suggestedFilename);
    downloadStarted = true;
  });
  client.on("Browser.downloadProgress", (params) => {
    if (params.state === "completed") {
      console.log("Browser download completed:", params.guid);
    }
  });

  // Navigate to notebook
  await page.goto("https://notebooklm.google.com/notebook/" + nbId, {
    waitUntil: "networkidle2",
    timeout: 30000
  });
  await new Promise(r => setTimeout(r, 3000));

  // Click Studio tab
  let btns = await page.$$("button");
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    if (txt === "Студия") { await btn.click(); break; }
  }
  await new Promise(r => setTimeout(r, 3000));

  // Click the artifact by name
  btns = await page.$$("button");
  let found = false;
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    if (txt.includes(artifactName)) {
      console.log("Clicking artifact:", txt.slice(0, 60));
      await btn.click();
      found = true;
      break;
    }
  }
  if (!found) {
    console.error("Artifact not found:", artifactName);
    await browser.close();
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 5000));

  // Click three dots menu (more_horiz)
  btns = await page.$$("button");
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    if (txt === "more_horiz") {
      const inPanel = await btn.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.y < 100 && rect.x > 1000;
      });
      if (inPanel) {
        await btn.click();
        console.log("Clicked more menu");
        break;
      }
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // Click "Скачать" or "Download"
  const menuItems = await page.$$("[role=menuitem], .cdk-overlay-pane button, [mat-menu-item]");
  for (const item of menuItems) {
    const txt = await item.evaluate(el => el.textContent.trim());
    if (txt.includes("Скачать") || txt.includes("Download") || txt.includes("save_alt")) {
      console.log("Clicking download:", txt);
      await item.click();
      break;
    }
  }

  // Wait for download
  console.log("Waiting for download...");
  await new Promise(r => setTimeout(r, 15000));

  if (downloadFile && fs.existsSync(downloadFile)) {
    // Rename to desired output path
    const ext = path.extname(downloadFile);
    const finalPath = outputPath + ext;
    fs.renameSync(downloadFile, finalPath);
    console.log("FILE:" + finalPath);
    console.log("SIZE:" + fs.statSync(finalPath).size);
  } else {
    // Check if any new file appeared in download dir
    const files = fs.readdirSync(downloadDir)
      .map(f => ({ name: f, time: fs.statSync(path.join(downloadDir, f)).mtimeMs }))
      .filter(f => f.time > Date.now() - 20000)
      .sort((a, b) => b.time - a.time);

    if (files.length > 0) {
      const downloaded = path.join(downloadDir, files[0].name);
      const ext = path.extname(downloaded);
      const finalPath = outputPath + ext;
      fs.renameSync(downloaded, finalPath);
      console.log("FILE:" + finalPath);
      console.log("SIZE:" + fs.statSync(finalPath).size);
    } else {
      console.error("NO_DOWNLOAD");
    }
  }

  await browser.close();
  clearTimeout(TIMEOUT);
})().catch(e => {
  console.error("ERR:", e.message);
  process.exit(1);
});
