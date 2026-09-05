// Proves the two lines of the phone page against the live host, in a real Chrome under Playwright:
// (1) a real Web Push subscription from this browser receives the host's test push (the push
// service accepts it and the service worker shows the notification); (2) the browser softphone
// starts a Client SDK session on a judge token and places the reference call, which the interlock
// then decides (read back from the ledger). Fake microphone, no credential typed into any page:
// the dashboard token is used by this script's own API calls only.
// Usage: DASHBOARD_TOKEN=... node tests/phone-proof.mjs [siteUrl] [apiUrl]
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const site = (process.argv[2] ?? "https://preflight-web-nine.vercel.app").replace(/\/$/, "");
const api = (process.argv[3] ?? "https://preflight-api-rc34.onrender.com").replace(/\/$/, "");
const token = process.env.DASHBOARD_TOKEN;
if (!token) throw new Error("DASHBOARD_TOKEN is needed for the subscribe and test-push requests (this script's own calls)");
const j = async (path, init = {}) => {
  const r = await fetch(api + path, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
};
const report = { site, api, at: new Date().toISOString() };

// A persistent (non-incognito) profile: Chrome refuses push registrations in incognito contexts, which is
// what a plain browser context is. Playwright's default flags also switch off background networking,
// which Chrome's push client needs, so those are not passed.
const profile = mkdtempSync(path.join(os.tmpdir(), "preflight-phone-proof-"));
const context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: process.env.HEADED ? false : true, ignoreDefaultArgs: ["--disable-background-networking", "--disable-component-update"], args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"], viewport: { width: 1280, height: 900 } });
await context.grantPermissions(["notifications", "microphone"], { origin: site });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
await page.goto(`${site}/phone/`, { waitUntil: "networkidle", timeout: 60000 });

// (1) Push: a real subscription from this browser, stored on the host, then the host's test push.
const { body: vapid } = await j("/api/push/vapid");
const subscription = await page.evaluate(async (publicKey) => {
  const pad = "=".repeat((4 - (publicKey.length % 4)) % 4);
  const raw = atob((publicKey + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(`notification permission ${permission}`);
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  return sub.toJSON();
}, vapid.publicKey);
report.push = { endpointHost: new URL(subscription.endpoint).host };
const stored = await j("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription, label: "phone-proof (real Chrome under Playwright)" }), token });
report.push.subscribe = { status: stored.status, subscriptions: stored.body?.subscriptions };
const test = await j("/api/push/test", { method: "POST", token });
report.push.test = { status: test.status, ...test.body };
await page.waitForTimeout(4000);
report.push.shown = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  const list = await reg.getNotifications();
  return list.map((n) => ({ title: n.title, body: n.body, tag: n.tag }));
});
// Leave the table as it was: this browser will not live on.
const removed = await j("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }), token });
report.push.removed = removed.body?.removed;
await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; const s = await reg.pushManager.getSubscription(); if (s) await s.unsubscribe(); });

// (2) Softphone: a judge token, a Client SDK session, one call to the reference flow.
const before = (await j("/api/summary")).body;
const headBefore = (await j("/api/ledger/head")).body.seq;
await page.getByRole("button", { name: "Start a session" }).click();
const status = page.locator(".card").nth(1).locator(".status");
await page.waitForFunction(() => { const el = document.querySelectorAll(".card")[1]?.querySelector(".status"); return el && /session|error|refused|502|429/.test(el.textContent || ""); }, null, { timeout: 60000 });
report.softphone = { session: (await status.textContent())?.trim() };
const callButton = page.getByRole("button", { name: "Call the reference flow" });
if (await callButton.isEnabled()) {
  await callButton.click();
  await page.waitForFunction(() => { const el = document.querySelectorAll(".card")[1]?.querySelector(".status"); return el && /placed|error|failed|refused/.test(el.textContent || ""); }, null, { timeout: 60000 });
  report.softphone.call = (await status.textContent())?.trim();
  // Let the platform ask the interlock and the flow speak, then hang up.
  await page.waitForTimeout(20000);
  report.softphone.state = (await page.locator(".call-state").textContent())?.trim();
  const hangup = page.getByRole("button", { name: "Hang up" });
  if (await hangup.isEnabled()) await hangup.click();
  await page.waitForTimeout(5000);
}
const after = (await j("/api/summary")).body;
const headAfter = (await j("/api/ledger/head")).body.seq;
const entries = headAfter > headBefore ? (await j(`/api/ledger/entries?after=${headBefore}&limit=20`)).body.entries : [];
report.interlock = { decisionsBefore: before.decisions, decisionsAfter: after.decisions, ledgerBefore: headBefore, ledgerAfter: headAfter, newEntries: entries.map((e) => ({ seq: e.seq, kind: e.kind, decision: e.decision, property: e.property, citation: e.citation, call_uuid: e.call_uuid ? e.call_uuid.slice(0, 8) : null, detail: e.detail ? Object.fromEntries(Object.entries(e.detail).slice(0, 4)) : null })) };
report.consoleErrors = consoleErrors.slice(0, 8);
await context.close();
console.log(JSON.stringify(report, null, 1));
