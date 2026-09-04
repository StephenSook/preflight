// Reads or repoints the Vonage application's voice webhooks through the Application API.
//
//   node scripts/vonage/application.mjs get
//   node scripts/vonage/application.mjs set-webhooks <base url> [answer method GET|POST]
//
// set-webhooks writes the previous configuration to results/application-before-<time>.json first,
// so the exact prior state is on disk before anything changes, then reads the application back and
// prints the voice webhooks as the API reports them. Basic auth with VONAGE_API_KEY and
// VONAGE_API_SECRET from .env; neither value is printed.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "./jwt.mjs";

const { env, root, applicationId } = loadEnv();
if (!env.VONAGE_API_KEY || !env.VONAGE_API_SECRET) {
  console.error("VONAGE_API_KEY and VONAGE_API_SECRET are required in .env");
  process.exit(1);
}
const basic = Buffer.from(`${env.VONAGE_API_KEY}:${env.VONAGE_API_SECRET}`).toString("base64");
const url = `https://api.nexmo.com/v2/applications/${applicationId}`;
const headers = { authorization: `Basic ${basic}`, accept: "application/json", "content-type": "application/json" };

async function read() {
  const r = await fetch(url, { headers });
  const body = await r.json();
  if (!r.ok) throw new Error(`GET application failed: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function voiceView(app) {
  const w = app.capabilities?.voice?.webhooks ?? {};
  return {
    answer: `${w.answer_url?.http_method ?? "-"} ${w.answer_url?.address ?? "-"}`,
    event: `${w.event_url?.http_method ?? "-"} ${w.event_url?.address ?? "-"}`,
    fallback: `${w.fallback_answer_url?.http_method ?? "-"} ${w.fallback_answer_url?.address ?? "-"}`,
    signed_callbacks: app.capabilities?.voice?.signed_callbacks,
  };
}

const [command, base, methodArg] = process.argv.slice(2);
if (command === "get") {
  const app = await read();
  console.log(JSON.stringify({ id: app.id, name: app.name, voice: voiceView(app) }, null, 1));
  process.exit(0);
}
if (command !== "set-webhooks" || !base) {
  console.error("usage: node scripts/vonage/application.mjs get | set-webhooks <base url> [GET|POST]");
  process.exit(1);
}
const method = (methodArg ?? "POST").toUpperCase();
if (method !== "GET" && method !== "POST") {
  console.error("answer method must be GET or POST");
  process.exit(1);
}
const before = await read();
mkdirSync(path.join(root, "results"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const beforePath = path.join(root, "results", `application-before-${stamp}.json`);
writeFileSync(beforePath, JSON.stringify(before, null, 2));
console.log(JSON.stringify({ before: voiceView(before), saved: path.relative(root, beforePath) }));

const trimmed = base.replace(/\/$/, "");
const voice = { ...(before.capabilities?.voice ?? {}) };
voice.webhooks = {
  ...(voice.webhooks ?? {}),
  answer_url: { address: `${trimmed}/v/answer`, http_method: method },
  event_url: { address: `${trimmed}/v/event`, http_method: "POST" },
  fallback_answer_url: { address: `${trimmed}/v/fallback`, http_method: method },
};
voice.signed_callbacks = true;
const payload = { name: before.name, capabilities: { ...(before.capabilities ?? {}), voice } };
const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify(payload) });
const putBody = await put.json();
if (!put.ok) {
  console.error(`PUT application failed: ${put.status} ${JSON.stringify(putBody).slice(0, 300)}`);
  process.exit(2);
}
const after = await read();
console.log(JSON.stringify({ after: voiceView(after) }, null, 1));
const w = after.capabilities?.voice?.webhooks ?? {};
const ok = w.answer_url?.address === `${trimmed}/v/answer` && w.answer_url?.http_method === method && w.event_url?.address === `${trimmed}/v/event` && w.fallback_answer_url?.address === `${trimmed}/v/fallback`;
if (!ok) {
  console.error("the application read back does not match what was written");
  process.exit(3);
}
