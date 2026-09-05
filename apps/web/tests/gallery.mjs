// The gallery harness: the stills the submission and the film use, taken from the deployed site at
// 1600x1000 and two device pixels per CSS pixel. The cockpit's token-bearing screens are unlocked with
// DASHBOARD_TOKEN (they show this account's own two numbers, both already public). Every site section,
// every cockpit screen, the phone page, and a 4:3 thumbnail of the hero.
// Usage: node --env-file=.env tests/gallery.mjs <outDir> [baseUrl]
import { mkdirSync, statSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = process.argv[2] ?? "gallery";
const base = (process.argv[3] ?? "https://preflight-web-nine.vercel.app").replace(/\/$/, "");
const token = process.env.DASHBOARD_TOKEN ?? "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const files = [];
const shot = async (page, name, options = {}) => {
  const path = `${out}/${name}.png`;
  await page.screenshot({ path, ...options });
  files.push({ name, bytes: statSync(path).size });
};
const settle = async (page, ms = 3000) => {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
};

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
if (token) await ctx.addInitScript((t) => sessionStorage.setItem("preflight:dashboard-token", t), token);

// The site: the hero at the top, then every section on its own after its motion has played.
{
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 60000 });
  await settle(page, 3500);
  await shot(page, "01-site-hero");
  // The fixed header would sit on top of every section still; it is part of the hero only.
  await page.addStyleTag({ content: "header.header { display: none !important; }" });
  // Playwright's DOM query helper (not JavaScript eval): it reads the section ids out of the page.
  const ids = await page.$$eval("main > section[id]", (els) => els.map((e) => e.id));
  let i = 2;
  for (const id of ids) {
    const section = page.locator(`#${id}`);
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);
    const path = `${out}/${String(i).padStart(2, "0")}-site-${id}.png`;
    await section.screenshot({ path, animations: "disabled" }).catch(() => undefined);
    try {
      files.push({ name: `${String(i).padStart(2, "0")}-site-${id}`, bytes: statSync(path).size });
    } catch {
      // A section that refused a screenshot is reported by its absence.
    }
    i += 1;
  }
  await page.close();
}

// The cockpit: six screens, each on a fresh page so the hash route mounts from scratch.
for (const [n, id] of [["10", "live"], ["11", "block"], ["12", "graph"], ["13", "held"], ["14", "log"], ["15", "setup"]]) {
  const page = await ctx.newPage();
  await page.goto(`${base}/app/#${id}`, { waitUntil: "networkidle", timeout: 60000 });
  await settle(page, 3500);
  await shot(page, `${n}-cockpit-${id}`);
  await page.close();
}

// The phone page.
{
  const page = await ctx.newPage();
  await page.goto(`${base}/phone/`, { waitUntil: "networkidle", timeout: 60000 });
  await settle(page, 2500);
  await shot(page, "16-phone");
  await page.close();
}
await ctx.close();

// A phone-width hero and phone page, three device pixels per CSS pixel.
{
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await mobile.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 60000 });
  await settle(page, 3500);
  await shot(page, "17-mobile-hero");
  await page.goto(`${base}/phone/`, { waitUntil: "networkidle", timeout: 60000 });
  await settle(page, 2500);
  await shot(page, "18-mobile-phone");
  await mobile.close();
}

// The 4:3 thumbnail: the hero framed at 1200x900.
{
  const thumb = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  const page = await thumb.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 60000 });
  await settle(page, 3500);
  await shot(page, "00-thumbnail-1200x900");
  await thumb.close();
}
await browser.close();
console.log(JSON.stringify({ base, out, unlocked: Boolean(token), files }, null, 1));
