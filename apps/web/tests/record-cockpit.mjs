// Records the cockpit while the two beats of the demonstration run for real on the deployed host:
// the broken flow refused through the gateway and the line silent for a minute, then the fixed flow
// placed and its legs decided. The screen recording is the film's B-roll of the live monitor, the
// block detail and the evidence log, in real time, uncut. The call is placed by
// scripts/vonage/daily-call.mjs with DAILY_CALL_PLACE on (one real call between the account's two
// numbers), and the cockpit is unlocked with DASHBOARD_TOKEN.
// Usage (from the repository root): node --env-file=.env apps/web/tests/record-cockpit.mjs <outDir>
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = process.argv[2] ?? "recordings";
const base = "https://preflight-web-nine.vercel.app";
const api = process.env.PREFLIGHT_API_URL ?? "https://preflight-api-rc34.onrender.com";
const token = process.env.DASHBOARD_TOKEN ?? "";
if (!token) {
  console.error("DASHBOARD_TOKEN is needed to unlock the cockpit");
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: 1600, height: 1000 } } });
await ctx.addInitScript((t) => sessionStorage.setItem("preflight:dashboard-token", t), token);
const page = await ctx.newPage();
await page.goto(`${base}/app/#live`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(6000);

// The two beats, for real, on the host.
const started = Date.now();
const run = spawn(process.execPath, ["--env-file=.env", "scripts/vonage/daily-call.mjs"], { env: { ...process.env, PREFLIGHT_API_URL: api, DAILY_CALL_PLACE: "on" }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
run.stdout.on("data", (d) => { log += d.toString(); });
run.stderr.on("data", (d) => { log += d.toString(); });
const exited = new Promise((resolve) => run.on("exit", (code) => resolve(code)));

// The refusal lands within a second; show its detail, then come back for the silence and the fixed call.
await page.waitForTimeout(9000);
await page.goto(`${base}/app/#block`);
await page.waitForTimeout(16000);
await page.goto(`${base}/app/#live`);
const code = await exited;
await page.waitForTimeout(4000);
await page.goto(`${base}/app/#log`);
await page.waitForTimeout(12000);
const seconds = Math.round((Date.now() - started) / 1000);
await page.close();
await ctx.close();
await browser.close();

// Playwright names the file by a random id; give it the take's name.
const webm = readdirSync(out).filter((f) => f.endsWith(".webm")).map((f) => `${out}/${f}`).sort()[0];
const named = `${out}/cockpit-two-beats-${new Date(started).toISOString().replace(/[:.]/g, "-")}.webm`;
if (webm) renameSync(webm, named);
writeFileSync(`${named}.log.txt`, log);
console.log(JSON.stringify({ video: named, seconds, dailyCallExit: code, log: log.trim().split("\n") }, null, 1));
