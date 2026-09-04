import { generateKeyPairSync } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { MemoryConsentStore } from "../store/consentStore.js";
import { MemoryDecisionStore } from "../store/decisionStore.js";
import { MemoryEventStore } from "../store/eventStore.js";
import { MemoryGraphStore } from "../store/graphStore.js";
import { MemoryHoldStore } from "../store/holdStore.js";
import { MemoryLedgerStore } from "../store/ledgerStore.js";
import { maskNumber, normalizeNumber, numberHash } from "./routes.js";

const NOW = Date.parse("2026-09-04T16:00:00Z"); // 12:00 in Atlanta
const VONAGE = "https://vonage.test";
const APP_ID = "0634d503-32c0-4160-be3e-8c31f50e5bd6";
const resolver = NumberFactsResolver.load();
const DECLARATION = { identification: { phrases: ["This is a message from Preflight Demo Clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
const PRIVATE_PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const NONCOMPLIANT = [{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "talk", text: "Your appointment is tomorrow." }];
const CONNECT_ONLY = [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }];
const NUMBER = "14042010000";

describe("number helpers", () => {
  it("normalises North American numbers and rejects everything else", () => {
    expect(normalizeNumber("+1 (404) 201-0000")).toBe(NUMBER);
    expect(normalizeNumber("4042010000")).toBe(NUMBER);
    expect(normalizeNumber("14042010000")).toBe(NUMBER);
    expect(normalizeNumber("+44 20 7946 0000")).toBeUndefined();
    expect(normalizeNumber("12345")).toBeUndefined();
    expect(normalizeNumber("11042010000")).toBeUndefined();
    expect(normalizeNumber(4042010000)).toBeUndefined();
  });

  it("masks all but the country code, area code and last four, and hashes without the digits", () => {
    expect(maskNumber(NUMBER)).toBe("+1 404 *** 0000");
    expect(numberHash(NUMBER)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(numberHash(NUMBER)).not.toContain("2010000");
  });
});

describe("consent gate", () => {
  const origin = Fastify({ forceCloseConnections: true });
  let originUrl = "";
  let served = JSON.stringify(NONCOMPLIANT);
  const verifyRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const platformRequests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  let nextRequest = 1;
  let clockMs = NOW;

  beforeAll(async () => {
    origin.route({ method: ["GET", "POST"], url: "/answer", handler: async (_req, reply) => reply.type("application/json").send(served) });
    await origin.listen({ port: 0, host: "127.0.0.1" });
    const addr = origin.server.address();
    if (!addr || typeof addr === "string") throw new Error("origin did not bind");
    originUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await origin.close();
  }, 15000);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url === `${VONAGE}/v2/verify`) {
      verifyRequests.push({ url, body });
      return new Response(JSON.stringify({ request_id: `req-${nextRequest++}`, check_url: `${VONAGE}/v2/verify/req` }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(`${VONAGE}/v2/verify/`)) {
      verifyRequests.push({ url, body });
      if (body["code"] === "1234") return new Response(JSON.stringify({ request_id: url.split("/").pop(), status: "completed" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ title: "Invalid Code", detail: "The code you provided does not match the expected value." }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (url === `${VONAGE}/v1/calls`) {
      platformRequests.push({ url, authorization: headers["authorization"] ?? "", body });
      return new Response(JSON.stringify({ uuid: `vonage-uuid-${platformRequests.length}`, status: "started", direction: "outbound", conversation_uuid: "CON-vonage-1" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };

  function app(overrides: Record<string, string> = {}, options: { privateKey?: boolean } = {}) {
    const config = loadConfig({
      VONAGE_API_KEY: "k",
      VONAGE_SIGNATURE_SECRET: "s",
      VONAGE_APPLICATION_ID: APP_ID,
      VONAGE_API_HOST: VONAGE,
      VONAGE_FROM_NUMBER: "12016131021",
      PUBLIC_BASE_URL: "https://preflight.example",
      ORIGIN_ANSWER_URL: `${originUrl}/answer`,
      ORIGIN_TIMEOUT_MS: "500",
      LOG_LEVEL: "silent",
      ...overrides,
    });
    const consents = new MemoryConsentStore();
    const ledger = new MemoryLedgerStore();
    const server = buildServer({
      config,
      store: new MemoryEventStore(),
      decisions: new MemoryDecisionStore(),
      ledger,
      graphStore: new MemoryGraphStore(),
      holds: new MemoryHoldStore(),
      consents,
      resolver,
      declaration: DECLARATION,
      fetchImpl,
      now: () => clockMs,
      applicationPublicKeyPem: PUBLIC_PEM,
      applicationPrivateKeyPem: options.privateKey === false ? undefined : PRIVATE_PEM,
    });
    return { server, consents, ledger };
  }
  const post = (server: ReturnType<typeof app>["server"], url: string, body: unknown) =>
    server.inject({ method: "POST", url, payload: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("answers 404 on every route when the process holds no private key", async () => {
    const { server } = app({}, { privateKey: false });
    expect((await post(server, "/api/consent/start", { number: NUMBER })).statusCode).toBe(404);
    expect((await post(server, "/api/consent/check", { request_id: "x", code: "1234" })).statusCode).toBe(404);
    expect((await post(server, "/api/demo/call", { request_id: "x" })).statusCode).toBe(404);
  });

  it("starts a verification call over the voice channel for a valid number, and refuses an invalid one", async () => {
    clockMs = NOW;
    const { server } = app();
    expect((await post(server, "/api/consent/start", { number: "12345" })).statusCode).toBe(400);
    const before = verifyRequests.length;
    const res = await post(server, "/api/consent/start", { number: "+1 (404) 201-0000" });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { request_id: string; channel: string; number: string };
    expect(body.channel).toBe("voice");
    expect(body.number).toBe("+1 404 *** 0000");
    expect(res.body).not.toContain(NUMBER);
    expect(verifyRequests.length).toBe(before + 1);
    expect(verifyRequests[before]?.body).toMatchObject({ brand: "Preflight", workflow: [{ channel: "voice", to: NUMBER }] });
  });

  it("refuses a second code request for the same number inside ten minutes, and allows it after", async () => {
    clockMs = NOW;
    const { server } = app();
    expect((await post(server, "/api/consent/start", { number: NUMBER })).statusCode).toBe(202);
    const again = await post(server, "/api/consent/start", { number: NUMBER });
    expect(again.statusCode).toBe(429);
    expect((again.json() as { retry_after_seconds: number }).retry_after_seconds).toBeGreaterThan(0);
    clockMs = NOW + 11 * 60 * 1000;
    expect((await post(server, "/api/consent/start", { number: NUMBER })).statusCode).toBe(202);
  });

  it("grants consent only on the right code and writes the number's hash, never its digits, to the ledger", async () => {
    clockMs = NOW;
    const { server, ledger } = app();
    const { request_id } = (await post(server, "/api/consent/start", { number: NUMBER })).json() as { request_id: string };
    const wrong = await post(server, "/api/consent/check", { request_id, code: "0000" });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { granted: boolean }).granted).toBe(false);
    expect((await post(server, "/api/consent/check", { request_id: "nope", code: "1234" })).statusCode).toBe(404);
    const right = await post(server, "/api/consent/check", { request_id, code: "1234" });
    expect(right.statusCode).toBe(200);
    const granted = right.json() as { granted: boolean; expires_at: string; ledger: { seq: number } };
    expect(granted.granted).toBe(true);
    expect(granted.expires_at).toBe(new Date(NOW + 15 * 60 * 1000).toISOString());
    const entries = await ledger.entries(0, 100);
    const consent = entries.find((e) => e.kind === "consent");
    expect(consent?.detail).toMatchObject({ request_id, channel: "voice", number_hash: numberHash(NUMBER) });
    expect(JSON.stringify(consent)).not.toContain(NUMBER);
    const twice = await post(server, "/api/consent/check", { request_id, code: "1234" });
    expect(twice.statusCode).toBe(200);
    expect((twice.json() as { used: boolean }).used).toBe(false);
  });

  it("places the demonstration call only with a checked, unexpired, unused consent, and a block does not spend it", async () => {
    clockMs = NOW;
    const { server } = app();
    const { request_id } = (await post(server, "/api/consent/start", { number: NUMBER })).json() as { request_id: string };
    const unchecked = await post(server, "/api/demo/call", { request_id });
    expect(unchecked.statusCode).toBe(403);
    expect((unchecked.json() as { reason: string }).reason).toContain("not been checked");
    expect((await post(server, "/api/consent/check", { request_id, code: "1234" })).statusCode).toBe(200);

    served = JSON.stringify(NONCOMPLIANT);
    const before = platformRequests.length;
    const blocked = await post(server, "/api/demo/call", { request_id });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.headers["x-preflight-decision"]).toBe("block");
    const b = blocked.json() as { placed: boolean; consent_remaining: boolean; number: string; result: { verdicts: Array<{ id: string; verdict: string }> } };
    expect(b.placed).toBe(false);
    expect(b.consent_remaining).toBe(true);
    expect(b.number).toBe("+1 404 *** 0000");
    expect(b.result.verdicts.some((v) => v.verdict === "false")).toBe(true);
    expect(platformRequests.length).toBe(before);

    served = JSON.stringify(CONNECT_ONLY);
    const placed = await post(server, "/api/demo/call", { request_id });
    expect(placed.statusCode).toBe(201);
    expect(placed.headers["x-preflight-decision"]).toBe("pass");
    expect((placed.json() as { placed: boolean }).placed).toBe(true);
    expect(platformRequests.length).toBe(before + 1);
    const sent = platformRequests[before];
    expect(sent?.authorization).toMatch(/^Bearer eyJ/);
    expect(sent?.body).toMatchObject({ to: [{ type: "phone", number: NUMBER }], from: { type: "phone", number: "12016131021" }, answer_url: ["https://preflight.example/v/answer"], answer_method: "POST" });

    const again = await post(server, "/api/demo/call", { request_id });
    expect(again.statusCode).toBe(403);
    expect((again.json() as { reason: string }).reason).toContain("already used");
  });

  it("refuses an expired consent", async () => {
    clockMs = NOW;
    const { server } = app();
    const { request_id } = (await post(server, "/api/consent/start", { number: NUMBER })).json() as { request_id: string };
    expect((await post(server, "/api/consent/check", { request_id, code: "1234" })).statusCode).toBe(200);
    clockMs = NOW + 16 * 60 * 1000;
    served = JSON.stringify(CONNECT_ONLY);
    const expired = await post(server, "/api/demo/call", { request_id });
    expect(expired.statusCode).toBe(403);
    expect((expired.json() as { reason: string }).reason).toContain("expired");
  });

  it("stops at the daily allowances", async () => {
    clockMs = NOW;
    const capped = app({ DEMO_CALLS_PER_DAY: "0" });
    const { request_id } = (await post(capped.server, "/api/consent/start", { number: NUMBER })).json() as { request_id: string };
    expect((await post(capped.server, "/api/consent/check", { request_id, code: "1234" })).statusCode).toBe(200);
    expect((await post(capped.server, "/api/demo/call", { request_id })).statusCode).toBe(429);
    const noStarts = app({ VERIFY_STARTS_PER_DAY: "0" });
    expect((await post(noStarts.server, "/api/consent/start", { number: NUMBER })).statusCode).toBe(429);
  });
});
