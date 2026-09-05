// Walks docs/judges.md the way a stranger would (run by .github/workflows/itinerary.yml daily and
// on demand): every public endpoint the itinerary names, the evidence log recomputed by an
// independent clean-directory `npx preflight-interlock verify-ledger`, and the offline `check` on a
// file. Fails on anything that a judge following the page would hit. Nothing here needs a
// credential; that is the point of the page.
//
// Env: PREFLIGHT_API_URL (default the reference deployment).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The release on npm and what the README says its replay of the committed corpus prints. 0.1.0
// predates spec corrections 5 to 7, so 43 of 48 labels match; when 0.2.0 is published, pin it here
// and expect every label to match. A stale publish then fails this walk instead of a judge.
const PUBLISHED_CLI = "0.1.0";
const REPLAY_EXPECTED = /48 objects, 43 match their labels, 5 do not/;
const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../corpus/ncco");

const api = (process.env.PREFLIGHT_API_URL || "https://preflight-api-rc34.onrender.com").replace(/\/$/, "");
const failures = [];
const note = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(what);
};

async function getJson(p) {
  const t0 = Date.now();
  const r = await fetch(`${api}${p}`, { signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: r.status, body, ms: Date.now() - t0 };
}

// 1. alive, and holding real state
const health = await getJson("/health");
note(health.status === 200 && health.body?.ok === true && health.body?.store === "postgres", "GET /health answers 200 on the postgres store", `${health.status} in ${health.ms} ms`);
const summary = await getJson("/api/summary");
note(summary.status === 200 && summary.body?.ledger?.seq >= 1 && Array.isArray(summary.body?.coverage?.declared), "GET /api/summary carries a ledger head and coverage", `ledger seq ${summary.body?.ledger?.seq}`);

// 2. the evidence log, by the host and by a stranger's machine
const verify = await getJson("/api/ledger/verify");
note(verify.status === 200 && verify.body?.ok === true, "GET /api/ledger/verify recomputes the chain", `${verify.body?.entries} entries`);
const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-itinerary-"));
let cliVerify = "";
try {
  cliVerify = execFileSync("npx", ["-y", "preflight-interlock", "verify-ledger", api], { cwd: dir, encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "pipe"] });
  note(/^ok:/m.test(cliVerify) && cliVerify.includes(String(verify.body?.head)), "npx preflight-interlock verify-ledger agrees with the host from a clean directory", cliVerify.trim().split("\n")[0]);
} catch (err) {
  note(false, "npx preflight-interlock verify-ledger from a clean directory", (err.stdout || err.message || "").toString().slice(0, 200));
}

// 3. declared versus actual
const flow = await getJson("/api/flow");
note(flow.status === 200 && Array.isArray(flow.body?.nodes) && typeof flow.body?.counts?.undeclared === "number", "GET /api/flow serves the diff", `${flow.body?.counts?.states} states, ${flow.body?.counts?.undeclared} undeclared`);

// 4. the engine offline on a file, as the page shows
try {
  const file = path.join(dir, "flow.json");
  writeFileSync(file, '[{"action":"talk","text":"Buy now."}]');
  let out = "";
  let code = 0;
  try {
    out = execFileSync("npx", ["-y", "preflight-interlock", "check", file], { cwd: dir, encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    code = err.status ?? 1;
    out = (err.stdout || "").toString();
  }
  note(code === 2 && /decision: BLOCK/.test(out) && /P5/.test(out), "npx preflight-interlock check blocks the page's example with the Georgia citation", `exit ${code}`);
} catch (err) {
  note(false, "npx preflight-interlock check", String(err.message).slice(0, 200));
}

// 4b. the published CLI replays the committed corpus and prints what the README says it prints
try {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("npx", ["-y", `preflight-interlock@${PUBLISHED_CLI}`, "replay", CORPUS], { cwd: dir, encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    code = err.status ?? 1;
    out = (err.stdout || "").toString();
  }
  const summaryLine = out.split("\n").find((l) => /^\d+ objects,/.test(l)) ?? "";
  note(REPLAY_EXPECTED.test(summaryLine), `npx preflight-interlock@${PUBLISHED_CLI} replay prints the state the README states`, `exit ${code}: ${summaryLine}`);
} catch (err) {
  note(false, "npx preflight-interlock replay", String(err.message).slice(0, 200));
}

// 5. the rate properties and the reconciliation line
const campaign = await getJson("/api/campaign");
note(campaign.status === 200 && Array.isArray(campaign.body?.properties) && campaign.body.properties.length === 3, "GET /api/campaign answers P6 to P8", campaign.body?.properties?.map((p) => `${p.id} ${p.verdict}`).join(", "));
note(summary.body?.reconciliation === null || typeof summary.body?.reconciliation?.leaks === "number", "the summary carries the last reconciliation", summary.body?.reconciliation ? `${summary.body.reconciliation.carrier_records} records, ${summary.body.reconciliation.leaks} leaks` : "none yet");

// 6. the web app: the site serves the hero marker and the cockpit's public screens answer
const webUrl = (process.env.PREFLIGHT_WEB_URL || "https://preflight-web-nine.vercel.app").replace(/\/$/, "");
try {
  const site = await fetch(`${webUrl}/`, { signal: AbortSignal.timeout(30000) });
  const html = await site.text();
  note(site.status === 200 && html.includes("evaluated by the engine in this browser"), "the web app's site serves its hero", `${site.status} ${webUrl}`);
  const cockpit = await fetch(`${webUrl}/app/`, { signal: AbortSignal.timeout(30000) });
  note(cockpit.status === 200, "the cockpit answers", `${cockpit.status} ${webUrl}/app/`);
} catch (err) {
  note(false, "the web app", String(err.message).slice(0, 200));
}

// The page also names the VAPID key and the softphone; a stranger can read the key.
const vapid = await getJson("/api/push/vapid");
note(vapid.status === 200 && typeof vapid.body?.publicKey === "string", "GET /api/push/vapid serves the public key");

if (failures.length > 0) {
  console.error(`${failures.length} itinerary step(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("every itinerary step a stranger would take works");
