import { createSign, generateKeyPairSync } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { MemoryDecisionStore } from "../store/decisionStore.js";
import { MemoryEventStore } from "../store/eventStore.js";
import { MemoryGraphStore } from "../store/graphStore.js";
import { MemoryHoldStore } from "../store/holdStore.js";
import { MemoryLedgerStore } from "../store/ledgerStore.js";

const NOW = Date.parse("2026-09-04T16:00:00Z"); // 12:00 in Atlanta
const VONAGE = "https://vonage.test";
const resolver = NumberFactsResolver.load();
const DECLARATION = { identification: { phrases: ["This is a message from Preflight Demo Clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };
const APP_ID = "0634d503-32c0-4160-be3e-8c31f50e5bd6";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
function appToken(privateKey = keys.privateKey, applicationId = APP_ID): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ application_id: applicationId, iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 900, jti: "gw" });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `Bearer ${head}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}
const TOKEN = appToken();

const NONCOMPLIANT = [{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "talk", text: "Your appointment is tomorrow." }];
const CONNECT_ONLY = [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }];
const OPEN = [{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/webhooks/optout"] }];

describe("create-call gateway", () => {
  const origin = Fastify({ forceCloseConnections: true });
  let originUrl = "";
  let served = JSON.stringify(CONNECT_ONLY);
  const originRequests: Array<{ method: string; headers: Record<string, unknown>; query: Record<string, unknown>; body: unknown }> = [];
  const platformRequests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

  beforeAll(async () => {
    origin.route({ method: ["GET", "POST"], url: "/answer", handler: async (req, reply) => {
      originRequests.push({ method: req.method, headers: req.headers as Record<string, unknown>, query: req.query as Record<string, unknown>, body: req.body });
      return reply.type("application/json").send(served);
    } });
    origin.get("/slow", async (_req, reply) => { await new Promise((r) => setTimeout(r, 400)); return reply.send("[]"); });
    await origin.listen({ port: 0, host: "127.0.0.1" });
    const addr = origin.server.address();
    if (!addr || typeof addr === "string") throw new Error("origin did not bind");
    originUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => { await origin.close(); }, 15000);

  /** What the stub platform answers a create-call request with; a test can make it refuse. */
  let platformStatus = 201;
  /** Routes platform calls to a stub that records them; everything else reaches the in-process origin. */
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(VONAGE)) {
      platformRequests.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: String(init?.body ?? "") });
      if (platformStatus !== 201) return new Response(JSON.stringify({ type: "https://developer.vonage.com/api-errors#low-balance", title: "Low balance" }), { status: platformStatus, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ uuid: "vonage-uuid-1", status: "started", direction: "outbound", conversation_uuid: "CON-vonage-1" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };

  function app(overrides: Record<string, string> = {}) {
    const config = loadConfig({ VONAGE_API_KEY: "k", VONAGE_SIGNATURE_SECRET: "s", VONAGE_APPLICATION_ID: APP_ID, VONAGE_API_HOST: VONAGE, PUBLIC_BASE_URL: "https://preflight.example", ORIGIN_ANSWER_URL: `${originUrl}/answer`, ORIGIN_TIMEOUT_MS: "200", LOG_LEVEL: "silent", ...overrides });
    const decisions = new MemoryDecisionStore();
    const ledger = new MemoryLedgerStore();
    const holds = new MemoryHoldStore();
    const server = buildServer({ config, store: new MemoryEventStore(), decisions, ledger, graphStore: new MemoryGraphStore(), holds, resolver, declaration: DECLARATION, fetchImpl, now: () => NOW, applicationPublicKeyPem: APP_PUBLIC_PEM });
    return { server, decisions, ledger, holds };
  }
  const call = (server: ReturnType<typeof app>["server"], body: unknown, headers: Record<string, string> = { authorization: TOKEN }) =>
    server.inject({ method: "POST", url: "/v/calls", payload: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const BASE = { to: [{ type: "phone", number: "14042010000" }], from: { type: "phone", number: "14045550100" }, event_url: ["https://origin.example/webhooks/event"] };

  it("refuses a caller without a token signed by this application's key, and fetches nothing for them", async () => {
    const { server } = app();
    const before = platformRequests.length;
    const beforeOrigin = originRequests.length;
    expect((await call(server, { ...BASE, ncco: CONNECT_ONLY }, {})).statusCode).toBe(401);
    expect((await call(server, { ...BASE, answer_url: [`${originUrl}/answer`] }, { authorization: appToken(strangerKeys.privateKey) })).statusCode).toBe(401);
    expect((await call(server, { ...BASE, answer_url: [`${originUrl}/answer`] }, { authorization: appToken(keys.privateKey, "another-application") })).statusCode).toBe(401);
    expect((await call(server, { ...BASE, ncco: CONNECT_ONLY }, { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.not-a-real-token.sig" })).statusCode).toBe(401);
    expect(platformRequests.length).toBe(before);
    expect(originRequests.length).toBe(beforeOrigin);
  });

  it("pre-fetches only from the configured origin host, never from a caller-chosen address", async () => {
    const { server } = app();
    const beforeOrigin = originRequests.length;
    for (const bad of ["http://127.0.0.1:1/answer", "http://169.254.169.254/latest/meta-data", "https://attacker.example/answer", "file:///etc/passwd"]) {
      const res = await call(server, { ...BASE, answer_url: [bad] });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("configured origin host") });
    }
    expect(originRequests.length).toBe(beforeOrigin);
    // The configured origin host is reachable, and the origin serves a compliant connect-only object here.
    served = JSON.stringify(CONNECT_ONLY);
    expect((await call(server, { ...BASE, answer_url: [`${originUrl}/answer`] })).statusCode).toBe(201);
    expect(originRequests.length).toBe(beforeOrigin + 1);
  });

  it("refuses everyone when no application public key is configured", async () => {
    const config = loadConfig({ VONAGE_API_KEY: "k", VONAGE_SIGNATURE_SECRET: "s", VONAGE_APPLICATION_ID: APP_ID, VONAGE_API_HOST: VONAGE, ORIGIN_ANSWER_URL: `${originUrl}/answer`, LOG_LEVEL: "silent" });
    const server = buildServer({ config, store: new MemoryEventStore(), decisions: new MemoryDecisionStore(), ledger: new MemoryLedgerStore(), graphStore: new MemoryGraphStore(), holds: new MemoryHoldStore(), resolver, declaration: DECLARATION, fetchImpl, now: () => NOW });
    expect((await call(server, { ...BASE, ncco: CONNECT_ONLY })).statusCode).toBe(503);
  });

  it("rejects malformed create-call requests with 400", async () => {
    const { server } = app();
    expect((await call(server, "{not json")).statusCode).toBe(400);
    expect((await call(server, { from: BASE.from, ncco: CONNECT_ONLY })).statusCode).toBe(400);
    expect((await call(server, { to: BASE.to, ncco: CONNECT_ONLY })).statusCode).toBe(400);
    expect((await call(server, { ...BASE })).statusCode).toBe(400);
  });

  it("forwards a compliant inline flow to the platform byte for byte with the caller's own token, and records the platform's uuid", async () => {
    const { server, decisions, ledger } = app();
    const body = JSON.stringify({ ...BASE, ncco: CONNECT_ONLY, ringing_timer: 45 });
    const res = await server.inject({ method: "POST", url: "/v/calls", payload: body, headers: { "content-type": "application/json", authorization: TOKEN } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ uuid: "vonage-uuid-1", status: "started" });
    expect(res.headers["x-preflight-decision"]).toBe("pass");
    const last = platformRequests[platformRequests.length - 1];
    expect(last?.url).toBe(`${VONAGE}/v1/calls`);
    expect(last?.headers["authorization"]).toBe(TOKEN);
    expect(last?.body).toBe(body);
    const d = (await decisions.recent(1))[0];
    expect(d).toMatchObject({ decision: "pass", direction: "outbound", callUuid: "vonage-uuid-1", conversationUuid: "CON-vonage-1", humanParty: "14042010000", terminal: true });
    expect(JSON.stringify(d)).not.toContain("caller-owned-token");
    expect((await ledger.entries(0, 10))[0]).toMatchObject({ kind: "pass", call_uuid: "vonage-uuid-1", detail: { placed: true, platform_status: 201 } });
  });

  it("passes the platform's refusal through as its own status, and the entry says the call was not placed", async () => {
    const { server, ledger } = app();
    platformStatus = 402;
    try {
      const res = await call(server, { ...BASE, ncco: CONNECT_ONLY });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ title: "Low balance" });
      expect(res.headers["x-preflight-decision"]).toBe("pass");
    } finally {
      platformStatus = 201;
    }
    expect((await ledger.entries(0, 10))[0]).toMatchObject({ kind: "pass", decision: "pass", call_uuid: expect.stringMatching(/^preflight-dryrun-/), detail: { placed: false, platform_status: 402 } }); // no platform uuid: the dry-run id stays, which reconciliation treats as none
  });

  it("blocks a non-compliant inline flow with 409 and the verdicts; nothing reaches the platform", async () => {
    const { server, ledger } = app();
    const before = platformRequests.length;
    const res = await call(server, { ...BASE, ncco: NONCOMPLIANT });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ decision: "block", placed: false, reason: expect.stringContaining("47 CFR 64.1200(b)(3)"), facts: { state: "GA", rateCenter: "ATLANTA", withinHours: true } });
    expect((res.json() as { verdicts: Array<{ id: string; verdict: string }> }).verdicts.find((v) => v.id === "P3")?.verdict).toBe("false");
    expect(platformRequests.length).toBe(before);
    expect((await ledger.entries(0, 10))[0]).toMatchObject({ kind: "block", property: "P3", witness: ["talk#0", "talk#1"] });
  });

  it("pre-fetches an answer_url flow as a marked dry run with the parameters the platform would send", async () => {
    served = JSON.stringify(NONCOMPLIANT);
    const { server } = app();
    const before = originRequests.length;
    const res = await call(server, { ...BASE, answer_url: [`${originUrl}/answer`] });
    expect(res.statusCode).toBe(409);
    expect(res.headers["x-preflight-decision"]).toBe("block");
    expect(Number(res.headers["x-preflight-origin-ms"])).toBeGreaterThanOrEqual(0);
    const o = originRequests[before];
    expect(o?.method).toBe("GET");
    expect(o?.headers["x-preflight"]).toBe("dry-run");
    expect(o?.query).toMatchObject({ to: "14042010000", from: "14045550100", direction: "outbound", conversation_uuid: "preflight-dryrun" });
    expect(String(o?.query["uuid"])).toMatch(/^preflight-dryrun-/);
  });

  it("pre-fetches from the real origin when answer_url points at Preflight itself, honouring answer_method POST", async () => {
    served = JSON.stringify(CONNECT_ONLY);
    const { server } = app();
    const before = originRequests.length;
    const res = await call(server, { ...BASE, answer_url: ["https://preflight.example/v/answer"], answer_method: "POST" });
    expect(res.statusCode).toBe(201);
    const o = originRequests[before];
    expect(o?.method).toBe("POST");
    expect(o?.headers["x-preflight"]).toBe("dry-run");
    expect(o?.body).toMatchObject({ to: "14042010000", direction: "outbound" });
  });

  it("fails closed when the answer URL does not answer the pre-dial check", async () => {
    const { server } = app();
    const before = platformRequests.length;
    const res = await call(server, { ...BASE, answer_url: [`${originUrl}/slow`] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ decision: "block", reason: expect.stringContaining("pre-dial check") });
    expect(platformRequests.length).toBe(before);
  });

  it("holds an open flow under strict policy and places it under advisory", async () => {
    const strict = app();
    const held = await call(strict.server, { ...BASE, ncco: OPEN });
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ decision: "hold", placed: false, terminal: false });
    const advisory = app({ POLICY_MODE: "advisory" });
    const placed = await call(advisory.server, { ...BASE, ncco: OPEN });
    expect(placed.statusCode).toBe(201);
    expect(placed.headers["x-preflight-decision"]).toBe("pass");
  });

  it("a hold pushes to every subscribed phone after the response, with the number masked, and never waits on the push service", async () => {
    const { MemoryPushStore } = await import("../store/pushStore.js");
    const pushStore = new MemoryPushStore();
    await pushStore.upsert({ endpoint: "https://push.example/phone", keys: { p256dh: "p", auth: "a" } }, "phone", new Date(NOW).toISOString());
    const pushes: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const pushSender = async (sub: { endpoint: string }, payload: string) => {
      await gate; // the push service is slow; the decision must not wait for it
      pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
      return { statusCode: 201 };
    };
    const config = loadConfig({ VONAGE_API_KEY: "k", VONAGE_SIGNATURE_SECRET: "s", VONAGE_APPLICATION_ID: APP_ID, VONAGE_API_HOST: VONAGE, PUBLIC_BASE_URL: "https://preflight.example", ORIGIN_ANSWER_URL: `${originUrl}/answer`, ORIGIN_TIMEOUT_MS: "200", LOG_LEVEL: "silent", VAPID_PUBLIC_KEY: "B".repeat(87), VAPID_PRIVATE_KEY: "k".repeat(43), VAPID_SUBJECT: "mailto:ops@example.com", PUBLIC_WEB_URL: "https://preflight-web.example" });
    const server = buildServer({ config, store: new MemoryEventStore(), decisions: new MemoryDecisionStore(), ledger: new MemoryLedgerStore(), graphStore: new MemoryGraphStore(), holds: new MemoryHoldStore(), pushStore, pushSender, resolver, declaration: DECLARATION, fetchImpl, now: () => NOW, applicationPublicKeyPem: APP_PUBLIC_PEM });
    const held = await call(server, { ...BASE, ncco: OPEN });
    expect(held.statusCode).toBe(409);
    expect(pushes).toHaveLength(0); // answered before the push service did
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ endpoint: "https://push.example/phone", payload: { kind: "hold", title: "Held: xxxxxxx0000", url: expect.stringMatching(/^https:\/\/preflight-web\.example\/held\/hold-/) } });
    expect(String(pushes[0]?.payload["body"])).toContain("P3 inconclusive");
  });

  it("puts a held call in the queue, and places it only after a named person decides and the caller re-submits with the override", async () => {
    const { server, ledger } = app({ DASHBOARD_TOKEN: "dashboard-token-for-tests-1" });
    const held = await call(server, { ...BASE, ncco: OPEN });
    expect(held.statusCode).toBe(409);
    const { holdId } = held.json() as { holdId: string };
    expect(holdId).toMatch(/^hold-/);
    const auth = { authorization: "Bearer dashboard-token-for-tests-1" };
    expect((await server.inject({ method: "GET", url: "/api/held" })).statusCode).toBe(403);
    const queue = (await server.inject({ method: "GET", url: "/api/held", headers: auth })).json() as { holds: Array<{ holdId: string; status: string; humanParty: string }> };
    expect(queue.holds).toEqual([expect.objectContaining({ holdId, status: "open", humanParty: "14042010000" })]);
    // Re-submitting before anyone decides is still held.
    expect((await call(server, { ...BASE, ncco: OPEN }, { authorization: TOKEN, "x-preflight-override": holdId })).statusCode).toBe(409);
    const nameless = await server.inject({ method: "POST", url: `/api/held/${holdId}/decide`, payload: JSON.stringify({ action: "place" }), headers: { "content-type": "application/json", ...auth } });
    expect(nameless.statusCode).toBe(400);
    const decided = await server.inject({ method: "POST", url: `/api/held/${holdId}/decide`, payload: JSON.stringify({ action: "place", by: "S. Sookra" }), headers: { "content-type": "application/json", ...auth } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ hold: { status: "placed", decidedBy: "S. Sookra" } });
    expect((await ledger.entries(0, 20)).find((e) => e.kind === "override")).toMatchObject({ detail: { hold_id: holdId, action: "place", by: "S. Sookra" } });
    const placed = await call(server, { ...BASE, ncco: OPEN }, { authorization: TOKEN, "x-preflight-override": holdId });
    expect(placed.statusCode).toBe(201);
    expect(placed.headers["x-preflight-decision"]).toBe("pass");
    // An override is bound to its destination.
    const other = await call(server, { ...BASE, to: [{ type: "phone", number: "14042000000" }], ncco: OPEN }, { authorization: TOKEN, "x-preflight-override": holdId });
    expect(other.statusCode).toBe(409);
    expect((await server.inject({ method: "POST", url: `/api/held/${holdId}/decide`, payload: JSON.stringify({ action: "cancel", by: "x" }), headers: { "content-type": "application/json", ...auth } })).statusCode).toBe(404);
  });

  it("treats random_from_number as a present caller id", async () => {
    const { server } = app();
    const res = await call(server, { to: BASE.to, random_from_number: true, ncco: CONNECT_ONLY });
    expect(res.statusCode).toBe(201);
    expect(res.headers["x-preflight-decision"]).toBe("pass");
  });
});
