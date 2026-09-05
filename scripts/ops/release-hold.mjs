// Releases a held call from the command line, the way an operator would from the cockpit's held
// queue: the named decision (POST /api/held/:id/decide, dashboard token), then the same create-call
// request re-submitted through the gateway with the override. The call is placed and both of its legs
// run on the override: an inconclusive verdict passes for that call only, a false verdict still
// blocks, and every branch the call reaches is observed at the hook. This is how a flow's untraced
// branch gets onto the graph under strict policy without anyone changing the host's policy.
//
// Usage: node --env-file=.env scripts/ops/release-hold.mjs <hold-id | latest> "<your name>"
// Env: PREFLIGHT_API_URL (or PUBLIC_BASE_URL), DASHBOARD_TOKEN, VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY_PATH,
//      VONAGE_PUBLIC_NUMBER, VONAGE_FROM_NUMBER.
import { appJwt, loadEnv } from "../vonage/jwt.mjs";

const { env } = loadEnv();
// The host: PREFLIGHT_API_URL as the workflows set it, else the PUBLIC_BASE_URL a local .env carries.
const api = (env.PREFLIGHT_API_URL || env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const token = env.DASHBOARD_TOKEN;
const to = env.VONAGE_PUBLIC_NUMBER;
const from = env.VONAGE_FROM_NUMBER;
const [holdArg, by] = process.argv.slice(2);
if (!api || !token || !to || !from || !holdArg || !by) {
  console.error('usage: node --env-file=.env scripts/ops/release-hold.mjs <hold-id | latest> "<your name>" (PREFLIGHT_API_URL, DASHBOARD_TOKEN, VONAGE_PUBLIC_NUMBER, VONAGE_FROM_NUMBER set)');
  process.exit(1);
}
const dash = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const queue = await (await fetch(`${api}/api/held?status=open&limit=50`, { headers: dash })).json();
const open = (queue.holds || []).filter((h) => h.humanParty === to);
const hold = holdArg === "latest" ? open[0] : open.find((h) => h.holdId === holdArg);
if (!hold) {
  console.error(`no open hold ${holdArg} for ${to}; open holds for that number: ${open.map((h) => h.holdId).join(", ") || "none"}`);
  process.exit(2);
}
console.log(JSON.stringify({ hold: hold.holdId, reason: hold.reason, createdAt: hold.createdAt }));

const decided = await fetch(`${api}/api/held/${hold.holdId}/decide`, { method: "POST", headers: dash, body: JSON.stringify({ action: "place", by }) });
const decidedBody = await decided.json();
if (!decided.ok) {
  console.error(`the decision was refused: ${decided.status} ${JSON.stringify(decidedBody).slice(0, 200)}`);
  process.exit(3);
}
console.log(JSON.stringify({ decided: decidedBody.hold?.status, by: decidedBody.hold?.decidedBy, ledger: decidedBody.ledger }));

const request = { to: [{ type: "phone", number: to }], from: { type: "phone", number: from }, answer_url: [`${api}/v/answer`], event_url: [`${api}/v/event`] };
const t0 = Date.now();
const res = await fetch(`${api}/v/calls`, { method: "POST", headers: { authorization: `Bearer ${appJwt()}`, "content-type": "application/json", "x-preflight-override": hold.holdId }, body: JSON.stringify(request) });
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text.slice(0, 200) };
}
console.log(JSON.stringify({ status: res.status, decision: res.headers.get("x-preflight-decision"), latencyMs: Date.now() - t0, uuid: body.uuid, conversation_uuid: body.conversation_uuid, reason: body.reason }));
process.exit(res.status === 201 ? 0 : 4);
