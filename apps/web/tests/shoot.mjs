// The screenshot harness: every page at desktop and phone widths, the top of each page, then each
// section of the site on its own, with console errors, page errors and failed requests collected.
// Usage: node tests/shoot.mjs <outDir> [baseUrl]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = process.argv[2] ?? "shots";
const base = (process.argv[3] ?? "http://localhost:5173").replace(/\/$/, "");
mkdirSync(`${out}/shots`, { recursive: true });
const pages = ["/", "/app/", "/app/#graph", "/app/#log", "/phone/"];
const browser = await chromium.launch();
const report = [];
for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  for (const p of pages) {
    const page = await ctx.newPage();
    const errors = [];
    const failed = [];
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on("requestfailed", (r) => failed.push(`${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 120)}`); });
    await page.goto(base + p, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => errors.push(`goto: ${e.message}`));
    await page.waitForTimeout(3500);
    const name = `${tag}-${p === "/" ? "site" : p.replace(/[\/#]/g, "") || "site"}`;
    await page.screenshot({ path: `${out}/shots/${name}-top.png` });
    if (p === "/") {
      const sections = await page.$$("main > section, footer");
      let i = 0;
      for (const s of sections) {
        await s.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1400);
        await s.screenshot({ path: `${out}/shots/${name}-s${i++}.png` }).catch(() => undefined);
      }
    }
    const doc = await page.evaluate(() => ({ ready: document.documentElement.className, width: document.documentElement.scrollWidth, inner: window.innerWidth, h: document.documentElement.scrollHeight }));
    report.push({ name, doc, errors: errors.slice(0, 12), failed: failed.slice(0, 12) });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
