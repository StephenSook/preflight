// Accessibility: axe-core over every page at desktop and phone widths; serious and critical
// violations fail the run. Usage: node tests/axe-check.mjs [baseUrl]
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const base = (process.argv[2] ?? "https://preflight-web-nine.vercel.app").replace(/\/$/, "");
const pages = ["/", "/app/#graph", "/app/#log", "/phone/"];
const browser = await chromium.launch();
let bad = 0;
for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce" });
  for (const p of pages) {
    const page = await ctx.newPage();
    await page.goto(base + p, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
    });
    const serious = result.filter((v) => v.impact === "serious" || v.impact === "critical");
    const minor = result.filter((v) => v.impact !== "serious" && v.impact !== "critical");
    console.log(`${serious.length === 0 ? "ok  " : "FAIL"} ${tag} ${p}: ${serious.length} serious/critical, ${minor.length} moderate/minor`);
    for (const v of serious) { bad += 1; console.log(`  ${v.impact} ${v.id}: ${v.help} -> ${v.nodes.join(" | ")}`); }
    for (const v of minor) console.log(`  (${v.impact}) ${v.id}: ${v.help} -> ${v.nodes.join(" | ")}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
process.exit(bad > 0 ? 1 : 0);
