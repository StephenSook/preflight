// One Verify v2 request over the VOICE channel: Vonage places a call that speaks a code.
// Usage: node scripts/vonage/verify-call.mjs <e164 number> [--check <code> <request_id>]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv, vonageFetch } from "./jwt.mjs";

const { root } = loadEnv();
const args = process.argv.slice(2);
mkdirSync(path.join(root, "results"), { recursive: true });
if (args[0] === "--check") {
  const [, code, requestId] = args;
  const r = await vonageFetch(`https://api.nexmo.com/v2/verify/${requestId}`, { method: "POST", body: JSON.stringify({ code }) });
  console.log(JSON.stringify({ status: r.status, body: r.body }));
  process.exit(r.ok ? 0 : 2);
}
const number = args[0];
if (!number) {
  console.error("usage: node scripts/vonage/verify-call.mjs <e164 number>");
  process.exit(1);
}
const t0 = Date.now();
const r = await vonageFetch("https://api.nexmo.com/v2/verify", { method: "POST", body: JSON.stringify({ brand: "Preflight", workflow: [{ channel: "voice", to: number.replace(/^\+/, "") }], code_length: 4, channel_timeout: 120 }) });
const record = { requestedAt: new Date(t0).toISOString(), to: number.replace(/\d(?=\d{4})/g, "x"), status: r.status, latencyMs: Date.now() - t0, body: r.body };
writeFileSync(path.join(root, "results", `verify-voice-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ status: r.status, request_id: r.body?.request_id, latencyMs: record.latencyMs, error: r.ok ? undefined : r.body }));
process.exit(r.ok ? 0 : 2);
