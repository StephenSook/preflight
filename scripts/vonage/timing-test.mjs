// The distinguishing-prediction test (plan Day 1 task 07): does the answer webhook arrive before or
// after the `ringing` event on an outbound call?
//   Prediction A (Vonage docs): answer fires when the call is ANSWERED, i.e. after ringing, so the
//     webhook path alone cannot keep an outbound phone silent and the create-call gateway is load-bearing.
//   Prediction B: answer fires before ringing, so the webhook path alone suffices.
// Usage: node scripts/vonage/timing-test.mjs <to e164> <from e164> <public base url of a running Preflight>
// The running Preflight records every webhook with a received-at timestamp; this script places one call
// through the platform directly (not the gateway) and then reads /health and the event store ordering.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv, vonageFetch } from "./jwt.mjs";

const [to, from, base] = process.argv.slice(2);
if (!to || !from || !base) {
  console.error("usage: node scripts/vonage/timing-test.mjs <to> <from> <public base url>");
  process.exit(1);
}
const { root } = loadEnv();
const t0 = Date.now();
const r = await vonageFetch("https://api.nexmo.com/v1/calls", {
  method: "POST",
  body: JSON.stringify({ to: [{ type: "phone", number: to.replace(/^\+/, "") }], from: { type: "phone", number: from.replace(/^\+/, "") }, answer_url: [`${base}/v/answer`], answer_method: "POST", event_url: [`${base}/v/event`], event_method: "POST", ringing_timer: 30, length_timer: 60 }),
});
const placedAt = new Date().toISOString();
mkdirSync(path.join(root, "results"), { recursive: true });
const out = path.join(root, "results", `timing-test-${placedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ placedAt, requestLatencyMs: Date.now() - t0, status: r.status, body: r.body, to: to.replace(/\d(?=\d{4})/g, "x") }, null, 2));
console.log(JSON.stringify({ status: r.status, uuid: r.body?.uuid, conversation_uuid: r.body?.conversation_uuid, placedAt, saved: path.relative(root, out) }));
console.log("Now answer the phone, then read the ordering with: node scripts/vonage/timing-read.mjs <uuid>");
process.exit(r.ok ? 0 : 2);
