// One Identity Insights lookup (Number Insight's successor). Usage: node scripts/vonage/identity-insights.mjs <number> [insights...]
// Costs money per insight; run deliberately. Output is written to results/identity-insights-<ts>.json (ignored).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv, vonageFetch } from "./jwt.mjs";

const number = process.argv[2];
const insights = process.argv.slice(3).length ? process.argv.slice(3) : ["format", "current_carrier", "original_carrier"];
if (!number) {
  console.error("usage: node scripts/vonage/identity-insights.mjs <e164 number> [format current_carrier original_carrier ...]");
  process.exit(1);
}
const { env, root } = loadEnv();
const host = env.IDENTITY_INSIGHTS_HOST || "https://api-eu.vonage.com";
const t0 = Date.now();
// insights is an object keyed by insight name; each value is an options object (empty for these three).
const r = await vonageFetch(`${host}/identity-insights/v1/requests`, { method: "POST", body: JSON.stringify({ phone_number: number, insights: Object.fromEntries(insights.map((k) => [k, {}])) }) });
const ms = Date.now() - t0;
mkdirSync(path.join(root, "results"), { recursive: true });
const out = path.join(root, "results", `identity-insights-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ requestedAt: new Date(t0).toISOString(), number: number.replace(/\d(?=\d{4})/g, "x"), insights, status: r.status, latencyMs: ms, body: r.body }, null, 2));
console.log(JSON.stringify({ status: r.status, latencyMs: ms, saved: path.relative(root, out) }));
if (r.ok) {
  const b = r.body.insights ?? r.body;
  const summary = { request_id: r.body.request_id, format: b.format ? { international: b.format.international ?? b.format.number?.international, time_zones: b.format.time_zones ?? b.format.location?.time_zones, is_valid: b.format.is_format_valid ?? b.format.is_valid, status: b.format.status } : undefined, current_carrier: b.current_carrier ? { name: b.current_carrier.name ?? b.current_carrier.carrier?.name, network_type: b.current_carrier.network_type ?? b.current_carrier.carrier?.network_type, status: b.current_carrier.status } : undefined, original_carrier: b.original_carrier ? { name: b.original_carrier.name ?? b.original_carrier.carrier?.name, network_type: b.original_carrier.network_type ?? b.original_carrier.carrier?.network_type, status: b.original_carrier.status } : undefined };
  console.log(JSON.stringify(summary, null, 2));
} else console.log(JSON.stringify(r.body).slice(0, 600));
process.exit(r.ok ? 0 : 2);
