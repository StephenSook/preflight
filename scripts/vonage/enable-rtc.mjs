// Adds the RTC capability to the application so Client SDK users (the browser softphone) can place and
// receive in-app calls. The voice capability and its webhooks are read first and written back unchanged;
// the RTC event URL is Preflight's /v/rtc sink. Reads the application back and refuses to report success
// unless the capability is there. Basic auth with VONAGE_API_KEY and VONAGE_API_SECRET from .env; neither
// value is printed.
//
//   node scripts/vonage/enable-rtc.mjs            (uses PUBLIC_BASE_URL from .env)
//   node scripts/vonage/enable-rtc.mjs <base url>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "./jwt.mjs";

const { env, root, applicationId } = loadEnv();
if (!env.VONAGE_API_KEY || !env.VONAGE_API_SECRET) {
  console.error("VONAGE_API_KEY and VONAGE_API_SECRET are required in .env");
  process.exit(1);
}
const base = (process.argv[2] || env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
if (!base.startsWith("https://")) {
  console.error("a public https base URL is required (argument or PUBLIC_BASE_URL)");
  process.exit(1);
}
const basic = Buffer.from(`${env.VONAGE_API_KEY}:${env.VONAGE_API_SECRET}`).toString("base64");
const url = `https://api.nexmo.com/v2/applications/${applicationId}`;
const headers = { authorization: `Basic ${basic}`, accept: "application/json", "content-type": "application/json" };

const before = await (await fetch(url, { headers })).json();
if (!before?.capabilities) {
  console.error(`could not read the application: ${JSON.stringify(before).slice(0, 200)}`);
  process.exit(1);
}
mkdirSync(path.join(root, "results"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(path.join(root, "results", `application-before-rtc-${stamp}.json`), JSON.stringify(before, null, 2));
console.log(JSON.stringify({ capabilities: Object.keys(before.capabilities), rtc: before.capabilities.rtc ?? null, voice: before.capabilities.voice?.webhooks ?? null }));

if (before.capabilities.rtc) {
  console.log("rtc capability already present; nothing written");
  process.exit(0);
}
const capabilities = { ...before.capabilities, rtc: { webhooks: { event_url: { address: `${base}/v/rtc`, http_method: "POST" } } } };
const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ name: before.name, capabilities }) });
const putBody = await put.json();
if (!put.ok) {
  console.error(`PUT application failed: ${put.status} ${JSON.stringify(putBody).slice(0, 300)}`);
  process.exit(2);
}
const after = await (await fetch(url, { headers })).json();
const w = after.capabilities?.voice?.webhooks ?? {};
const voiceKept = w.answer_url?.address === before.capabilities.voice.webhooks.answer_url.address && w.event_url?.address === before.capabilities.voice.webhooks.event_url.address && w.fallback_answer_url?.address === before.capabilities.voice.webhooks.fallback_answer_url.address && after.capabilities.voice.signed_callbacks === true;
console.log(JSON.stringify({ after: { capabilities: Object.keys(after.capabilities ?? {}), rtc: after.capabilities?.rtc ?? null, voiceKept } }));
if (!after.capabilities?.rtc || !voiceKept) {
  console.error("the application read back does not carry the RTC capability with the voice webhooks intact");
  process.exit(3);
}
