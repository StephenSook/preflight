import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { MemoryEventStore } from "./store/eventStore.js";
import { sha256Hex } from "./vonage/verifyWebhook.js";

const SECRET = "test-signature-secret";
const API_KEY = "a1b2c3d";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}
function sign(raw: string, secret = SECRET, apiKey = API_KEY): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000), jti: "j", iss: "Vonage", payload_hash: sha256Hex(raw), api_key: apiKey }));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `Bearer ${head}.${body}.${sig}`;
}

/** A stand-in for the developer's real server: returns a fixed NCCO with deliberately odd spacing. */
const ORIGIN_NCCO = '[{"action":"talk",  "text":"Hello from the origin"} ,{"action":"hangup"}]';

describe("preflight api ingress", () => {
  const origin = Fastify({ forceCloseConnections: true });
  let originUrl = "";
  let originHits = 0;
  beforeAll(async () => {
    origin.route({ method: ["GET", "POST"], url: "/answer", handler: async (_req, reply) => { originHits += 1; return reply.type("application/json").send(ORIGIN_NCCO); } });
    origin.post("/slow", async (_req, reply) => { await new Promise((r) => setTimeout(r, 400)); return reply.send("[]"); });
    await origin.listen({ port: 0, host: "127.0.0.1" });
    const addr = origin.server.address();
    if (!addr || typeof addr === "string") throw new Error("origin did not bind");
    originUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => { await origin.close(); }, 15000);

  function app(overrides: Record<string, string> = {}) {
    const config = loadConfig({
      VONAGE_API_KEY: API_KEY,
      VONAGE_SIGNATURE_SECRET: SECRET,
      ORIGIN_ANSWER_URL: `${originUrl}/answer`,
      ORIGIN_TIMEOUT_MS: "200",
      LOG_LEVEL: "silent",
      ...overrides,
    });
    const store = new MemoryEventStore();
    return { server: buildServer({ config, store }), store };
  }

  it("reports health", async () => {
    const { server } = app();
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "preflight-api" });
  });

  it("refuses an unsigned answer webhook with 403 and touches no state", async () => {
    const { server, store } = app();
    const before = originHits;
    const res = await server.inject({ method: "POST", url: "/v/answer", payload: '{"uuid":"x"}', headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(403);
    expect(await store.count()).toBe(0);
    expect(originHits).toBe(before);
  });

  it("refuses a forged token (wrong secret) with 403", async () => {
    const { server, store } = app();
    const raw = '{"uuid":"x"}';
    const res = await server.inject({ method: "POST", url: "/v/answer", payload: raw, headers: { "content-type": "application/json", authorization: sign(raw, "wrong") } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "bad_signature" });
    expect(await store.count()).toBe(0);
  });

  it("forwards a signed POST answer webhook and returns the origin bytes untouched", async () => {
    const { server, store } = app();
    const raw = JSON.stringify({ uuid: "call-1", conversation_uuid: "CON-1", to: "14045550100", from: "14045550199" });
    const res = await server.inject({ method: "POST", url: "/v/answer", payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ORIGIN_NCCO);
    expect(Number(res.headers["x-preflight-origin-ms"])).toBeGreaterThanOrEqual(0);
    expect(Number(res.headers["x-preflight-verify-ms"])).toBeGreaterThanOrEqual(0);
    const rows = await store.recent(1);
    expect(rows[0]).toMatchObject({ kind: "answer", callUuid: "call-1", conversationUuid: "CON-1", decision: "forwarded" });
    expect(rows[0]?.originLatencyMs).not.toBeNull();
  });

  it("forwards a signed GET answer webhook with its query string", async () => {
    const { server } = app();
    const qs = "to=14045550100&from=14045550199&uuid=call-2&conversation_uuid=CON-2";
    const res = await server.inject({ method: "GET", url: `/v/answer?${qs}`, headers: { authorization: sign(qs) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ORIGIN_NCCO);
  });

  it("fails closed with a safe NCCO when the origin exceeds the timeout", async () => {
    const { server, store } = app({ ORIGIN_ANSWER_URL: `${originUrl}/slow` });
    const raw = '{"uuid":"call-3"}';
    const res = await server.inject({ method: "POST", url: "/v/answer", payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
    expect(res.statusCode).toBe(200);
    const ncco = res.json() as Array<{ action: string; text?: string }>;
    expect(ncco[0]?.action).toBe("talk");
    expect(ncco[0]?.text).toContain("stopped by Preflight");
    const rows = await store.recent(1);
    expect(rows[0]?.decision).toBe("block");
  });

  it("stores every signed event webhook body and acknowledges with 204", async () => {
    const { server, store } = app();
    const raw = JSON.stringify({ uuid: "call-4", status: "ringing", direction: "outbound", timestamp: "2026-09-04T00:00:00.000Z" });
    const res = await server.inject({ method: "POST", url: "/v/event", payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
    expect(res.statusCode).toBe(204);
    const rows = await store.recent(1);
    expect(rows[0]).toMatchObject({ kind: "event", callUuid: "call-4", raw, decision: "stored" });
  });

  it("answers a signed fallback webhook with the safe NCCO", async () => {
    const { server } = app();
    const raw = '{"uuid":"call-5","reason":"answer url timeout"}';
    const res = await server.inject({ method: "POST", url: "/v/fallback", payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ action: string }>)[0]?.action).toBe("talk");
  });
});
