// The web app, checked the way a visitor meets it: every page at desktop and phone widths, no
// console error, no failed request, no horizontal overflow, and the live counters filled from the
// host (the cross-origin read is the thing most likely to break silently). Exits 1 on any miss.
// Usage: node tests/live-check.mjs [baseUrl]
import { chromium } from "@playwright/test";

const base = (process.argv[2] ?? "https://preflight-web-nine.vercel.app").replace(/\/$/, "");
const pages = ["/", "/app/#graph", "/app/#log", "/phone/"];
const browser = await chromium.launch();
const misses = [];
for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  for (const p of pages) {
    const page = await ctx.newPage();
    const errors = [];
    const failed = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
    page.on("requestfailed", (r) => failed.push(`${r.url().slice(0, 100)} ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("/api/campaign")) failed.push(`${r.status()} ${r.url().slice(0, 100)}`); });
    try {
      await page.goto(base + p, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(3000);
      const doc = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, inner: window.innerWidth, head: document.querySelector("[data-live-head-seq]")?.textContent ?? null, graph: !!document.querySelector("[data-hero-graph] svg") }));
      if (doc.width > doc.inner + 1) misses.push(`${tag} ${p}: horizontal overflow ${doc.width} > ${doc.inner}`);
      if (p === "/" && !(doc.head && /^\d+$/.test(doc.head))) misses.push(`${tag} ${p}: the ledger head did not fill from the host (${doc.head})`);
      if (p === "/" && !doc.graph) misses.push(`${tag} ${p}: the hero graph did not render`);
    } catch (err) {
      misses.push(`${tag} ${p}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
    for (const e of errors) misses.push(`${tag} ${p}: console ${e}`);
    for (const f of failed) misses.push(`${tag} ${p}: request ${f}`);
    console.log(`${misses.length === 0 ? "ok  " : "seen"} ${tag} ${p}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
if (misses.length > 0) {
  console.error(`${misses.length} miss(es):\n  ${misses.join("\n  ")}`);
  process.exit(1);
}
console.log(`every page of ${base} is clean at both widths and reads the host`);
