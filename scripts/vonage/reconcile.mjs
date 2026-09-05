// Nightly carrier-side reconciliation (run by .github/workflows/reconcile.yml).
//
// Pulls every voice call record for the window from the platform's Reports API (basic auth with the
// account key and secret, neither printed), posts them to the deployed interlock's /api/reconcile,
// prints the report the interlock recorded in its evidence log, and fails the job when any record was
// placed around the interlock (exit 3) or leaked past a refusal (exit 2). A green run is the sponsor's
// own records agreeing that nothing the gateway refused ever reached the carrier.
//
// Env: PREFLIGHT_API_URL, VONAGE_API_KEY, VONAGE_API_SECRET, SEAL_TOKEN, WINDOW_HOURS (default 26).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const env = process.env;
const api = (env.PREFLIGHT_API_URL || "").replace(/\/$/, "");
const key = env.VONAGE_API_KEY;
const secret = env.VONAGE_API_SECRET;
const token = env.SEAL_TOKEN;
const hours = Number(env.WINDOW_HOURS || "26");
if (!api || !key || !secret || !token || !Number.isFinite(hours) || hours <= 0) {
  console.error("PREFLIGHT_API_URL, VONAGE_API_KEY, VONAGE_API_SECRET and SEAL_TOKEN are required; WINDOW_HOURS must be a positive number");
  process.exit(1);
}
const end = new Date();
const start = new Date(end.getTime() - hours * 3600_000);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const basic = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");

async function pull(direction) {
  const out = [];
  let url = `https://api.nexmo.com/v2/reports/records?account_id=${encodeURIComponent(key)}&product=VOICE-CALL&direction=${direction}&date_start=${encodeURIComponent(iso(start))}&date_end=${encodeURIComponent(iso(end))}`;
  for (let page = 0; url && page < 20; page += 1) {
    const r = await fetch(url, { headers: { authorization: basic, accept: "application/json" } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Reports API ${direction} page ${page}: ${r.status} ${text.slice(0, 200)}`);
    const body = JSON.parse(text);
    if (body.request_status && body.request_status !== "SUCCESS") throw new Error(`Reports API ${direction}: request_status ${body.request_status}`);
    for (const rec of body.records ?? []) out.push({ call_id: rec.call_id, direction: rec.direction ?? direction, from: rec.from, to: rec.to, date_start: rec.date_start, status: rec.status, duration: rec.duration });
    url = body._links?.next?.href ?? null;
  }
  return out;
}

const records = [...(await pull("outbound")), ...(await pull("inbound"))];
console.log(JSON.stringify({ window: { start: iso(start), end: iso(end) }, pulled: records.length }));

const res = await fetch(`${api}/api/reconcile`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ window: { start: iso(start), end: iso(end) }, records }) });
const text = await res.text();
if (res.status !== 201) {
  console.error(`the interlock refused the reconciliation: ${res.status} ${text.slice(0, 300)}`);
  process.exit(1);
}
const { report, ledger } = JSON.parse(text);
console.log(JSON.stringify({ report, ledger }));
if (report.leaks > 0) {
  console.error(`LEAK: ${report.leaks} carrier record(s) match a request the gateway refused: ${report.leaked_ids.join(", ")}`);
  process.exit(2);
}
if (report.unmatched > 0) {
  console.error(`${report.unmatched} carrier record(s) were placed around the interlock: ${report.unmatched_ids.join(", ")}`);
  process.exit(3);
}
if (report.decided_not_in_records > 0) {
  console.error(`${report.decided_not_in_records} call(s) the interlock decided with a platform uuid came back in no carrier record: ${report.missing_ids.join(", ")}; the pull is empty or mis-filtered, not clean`);
  process.exit(4);
}
console.log(`ok: ${report.carrier_records} carrier record(s), every one a call the interlock decided; ${report.refused_in_window} refusal(s) in the window reached nothing`);
