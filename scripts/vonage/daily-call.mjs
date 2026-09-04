// The daily real-path check against the deployed host (run by .github/workflows/daily-call.yml).
//
// 1. With the reference application in broken mode, a create-call request through the gateway must be
//    refused (HTTP 409, decision block or hold) before the platform is touched.
// 2. With DAILY_CALL_PLACE=on, the reference application is switched to fixed mode, one real call is
//    placed from the outbound number to the public number (both ours), and the mode is switched back.
//
// Env: PREFLIGHT_API_URL, VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY (PEM) or VONAGE_PRIVATE_KEY_PATH,
//      VONAGE_PUBLIC_NUMBER, VONAGE_FROM_NUMBER, REFERENCE_ADMIN_TOKEN, DAILY_CALL_PLACE (on | off).
import { appJwt, loadEnv } from "./jwt.mjs";

const { env } = loadEnv();
const api = (env.PREFLIGHT_API_URL || "").replace(/\/$/, "");
const to = env.VONAGE_PUBLIC_NUMBER;
const from = env.VONAGE_FROM_NUMBER;
const placeEnabled = (env.DAILY_CALL_PLACE || "off") === "on";
if (!api || !to || !from) {
  console.error("PREFLIGHT_API_URL, VONAGE_PUBLIC_NUMBER and VONAGE_FROM_NUMBER are required");
  process.exit(1);
}
const jwt = appJwt();
const request = { to: [{ type: "phone", number: to }], from: { type: "phone", number: from }, answer_url: [`${api}/v/answer`], event_url: [`${api}/v/event`] };

async function createCall(label) {
  const t0 = Date.now();
  const res = await fetch(`${api}/v/calls`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(request) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  const out = { label, status: res.status, decision: res.headers.get("x-preflight-decision"), latencyMs: Date.now() - t0, reason: body.reason, placed: body.placed, uuid: body.uuid };
  console.log(JSON.stringify(out));
  return out;
}

async function setMode(mode) {
  if (!env.REFERENCE_ADMIN_TOKEN) throw new Error("REFERENCE_ADMIN_TOKEN is required to switch the reference application's mode");
  const res = await fetch(`${api}/reference/mode`, { method: "POST", headers: { authorization: `Bearer ${env.REFERENCE_ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ mode }) });
  if (!res.ok) throw new Error(`switching the reference application to ${mode} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(JSON.stringify({ referenceMode: mode }));
}

const state = await (await fetch(`${api}/reference/state`)).json();
if (state.mode !== "broken") await setMode("broken");
const refused = await createCall("broken flow through the gateway");
if (refused.status !== 409 || !["block", "hold"].includes(refused.decision ?? "")) {
  console.error(`expected the gateway to refuse the broken flow with 409 and a block or hold decision, got ${refused.status} ${refused.decision}`);
  process.exit(2);
}
if (!placeEnabled) {
  console.log(JSON.stringify({ realCall: "not placed", why: "the DAILY_CALL_PLACE variable is not on" }));
  process.exit(0);
}
await setMode("fixed");
let exit = 0;
try {
  const placed = await createCall("fixed flow through the gateway");
  if (placed.status !== 201 || placed.decision !== "pass" || !placed.uuid) {
    console.error(`expected the fixed flow to be placed (201, pass, a call uuid), got ${placed.status} ${placed.decision}`);
    exit = 3;
  }
} finally {
  await setMode("broken");
}
process.exit(exit);
