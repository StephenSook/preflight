import { createHmac } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import { symbols } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { PLACEMENT_QUERY, placementDigest } from "./gateway/placement.js";
import { buildServer } from "./server.js";
import { MemoryDecisionStore } from "./store/decisionStore.js";
import { MemoryEventStore } from "./store/eventStore.js";
import { MemoryGraphStore } from "./store/graphStore.js";
import { MemoryHoldStore } from "./store/holdStore.js";
import { MemoryLedgerStore } from "./store/ledgerStore.js";
import { sha256Hex } from "./vonage/verifyWebhook.js";

const NOW = Date.parse("2026-09-04T16:00:00Z");
const SECRET = "placement-signature-test";
const CAPABILITY = "a3".repeat(32);
const TO = "14042010000";
const PAYLOAD = { uuid: "early-call", conversation_uuid: "early-conversation", to: TO, from: "14045550100" };
const resolver = NumberFactsResolver.load();
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

function sign(raw: string, secret = SECRET): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({ iat: NOW / 1000, jti: "placement", iss: "Vonage", api_key: "placement-key", payload_hash: sha256Hex(raw) });
  return `Bearer ${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

async function fixture(expiresAt = new Date(NOW + 600_000).toISOString()) {
  const holds = new MemoryHoldStore();
  await holds.create({ holdId: "released", callUuid: undefined, humanParty: TO, reason: "open branch", verdicts: [], status: "open", createdAt: new Date(NOW).toISOString(), decidedBy: undefined, decidedAt: undefined });
  await holds.decide("released", "placed", "test-operator", new Date(NOW).toISOString());
  expect(await holds.reservePlacement("released", { hash: placementDigest(CAPABILITY)!, expiresAt })).toBe(true);
  const graphStore = new MemoryGraphStore();
  const store = new MemoryEventStore();
  const decisions = new MemoryDecisionStore();
  const ledger = new MemoryLedgerStore();
  const hits: Array<{ url: string; body: unknown }> = [];
  const logs: string[] = [];
  const requests: unknown[] = [];
  const server = buildServer({
    config: loadConfig({ VONAGE_API_KEY: "placement-key", VONAGE_SIGNATURE_SECRET: SECRET, ORIGIN_ANSWER_URL: "https://origin.example/answer", PUBLIC_BASE_URL: "https://preflight.example", POLICY_MODE: "strict", LOG_LEVEL: "info" }),
    graphStore, store, decisions, ledger, holds, resolver, declaration: {}, now: () => NOW,
    fetchImpl: async (input, init) => {
      hits.push({ url: String(input), body: init?.body });
      return new Response(JSON.stringify([{ action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/question"] }]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  servers.push(server);
  const stream = (server.log as unknown as Record<symbol, { write(line: string): void }>)[symbols.streamSym]!;
  vi.spyOn(stream, "write").mockImplementation((line) => { logs.push(line); });
  server.addHook("onResponse", async (req) => { requests.push({ url: req.url, query: req.query, body: req.body }); });
  const send = (method: "GET" | "POST", payload: Record<string, unknown> = PAYLOAD, capability: string | null = CAPABILITY, queryName = PLACEMENT_QUERY, validSignature = true) => {
    const query = new URLSearchParams();
    if (capability !== null) query.set(PLACEMENT_QUERY, capability);
    if (method === "GET") for (const [key, value] of Object.entries(payload)) query.set(key, String(value));
    const raw = method === "GET" ? JSON.stringify(Object.fromEntries(query)) : JSON.stringify(payload);
    const queryText = query.toString().replace(PLACEMENT_QUERY, queryName);
    return server.inject({ method, url: `/v/answer?${queryText}`, ...(method === "POST" ? { payload: JSON.stringify(payload) } : {}), headers: { "content-type": "application/json", authorization: sign(raw, validSignature ? SECRET : "wrong") } });
  };
  return { server, holds, graphStore, store, decisions, ledger, hits, logs, requests, send };
}

describe("released placement answer correlation", () => {
  it("cannot attach a fresh release to an already answered UUID even when the replay is refused", async () => {
    const test = await fixture();
    expect((await test.send("POST", PAYLOAD, null)).statusCode).toBe(200);
    expect(await test.holds.forCall(PAYLOAD.uuid, undefined)).toBeUndefined();
    test.hits.length = 0;
    expect((await test.send("POST")).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
    expect(await test.holds.forCall(PAYLOAD.uuid, undefined)).toBeUndefined();
    expect((await test.holds.get("released"))?.placedCallUuid).toBeUndefined();
  });

  it.each(["POST", "GET"] as const)("binds a signed %s answer before 201 and runs the strict call on its recorded override", async (method) => {
    const test = await fixture();
    expect((await test.holds.get("released"))?.placedCallUuid).toBeUndefined();
    const result = await test.send(method);
    expect(result.statusCode).toBe(200);
    expect(result.headers["x-preflight-decision"]).toBe("pass");
    expect((await test.decisions.recent(1))[0]).toMatchObject({ callUuid: "early-call", policy: "advisory", source: "webhook", direction: "outbound" });
    expect((await test.store.recent(1))[0]?.payload).not.toHaveProperty("direction");
    expect(await test.graphStore.callContext("early-call")).toMatchObject({ direction: "outbound", to: TO });
    expect(await test.holds.get("released")).toMatchObject({ placedCallUuid: "early-call", placedConversationUuid: "early-conversation" });
    await test.holds.placed("released", "early-call", "early-conversation");
    await test.holds.placed("released", "different-call", "different-conversation");
    expect(await test.holds.get("released")).toMatchObject({ placedCallUuid: "early-call", placedConversationUuid: "early-conversation" });
    expect(test.hits).toHaveLength(1);
  });

  it("never finds an override by destination alone", async () => {
    const test = await fixture();
    expect((await test.send("POST", PAYLOAD, null)).headers["x-preflight-decision"]).toBe("hold");
    expect((await test.holds.get("released"))?.placedCallUuid).toBeUndefined();
  });

  it.each(["POST", "GET"] as const)("verifies the original signed %s bytes before binding", async (method) => {
    const test = await fixture();
    const bind = vi.spyOn(test.holds, "bindPlacement");
    const claim = vi.spyOn(test.graphStore, "claimAnswer");
    expect((await test.send(method, PAYLOAD, CAPABILITY, PLACEMENT_QUERY, false)).statusCode).toBe(403);
    expect(bind).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(test.hits).toEqual([]);
    expect((await test.send(method)).headers["x-preflight-decision"]).toBe("pass");
  });

  it.each([
    { direction: "inbound" }, { direction: "invalid" }, { from_user: "app-user" }, { endpoint_type: "app" }, { to: undefined }, { uuid: null },
  ])("refuses correlation for invalid signed call facts %j before answer claim or forward", async (fields) => {
    const test = await fixture();
    const claim = vi.spyOn(test.graphStore, "claimAnswer");
    expect((await test.send("POST", { ...PAYLOAD, ...fields })).statusCode).toBe(403);
    expect(claim).not.toHaveBeenCalled();
    expect(test.hits).toEqual([]);
    expect((await test.holds.get("released"))?.placedCallUuid).toBeUndefined();
    expect((await test.send("POST")).headers["x-preflight-decision"]).toBe("pass");
  });

  it("refuses expired capabilities and keeps the answer UUID consumed", async () => {
    const test = await fixture(new Date(NOW).toISOString());
    const claim = vi.spyOn(test.graphStore, "claimAnswer");
    expect((await test.send("POST")).statusCode).toBe(403);
    expect(claim).toHaveBeenCalledWith(PAYLOAD.uuid);
    expect(test.hits).toEqual([]);
    expect(await test.holds.forCall(PAYLOAD.uuid, undefined)).toBeUndefined();
    expect(await test.graphStore.claimAnswer(PAYLOAD.uuid)).toBe(false);
  });

  it.each(["", "invalid", "AB".repeat(32)])("refuses malformed capability %j before claim", async (capability) => {
    const test = await fixture();
    const claim = vi.spyOn(test.graphStore, "claimAnswer");
    expect((await test.send("POST", PAYLOAD, capability)).statusCode).toBe(403);
    expect(claim).not.toHaveBeenCalled();
    expect(test.hits).toEqual([]);
  });

  it.each([
    { capability: "b4".repeat(32), payload: PAYLOAD },
    { capability: CAPABILITY, payload: { ...PAYLOAD, to: "14045559999" } },
  ])("a failed binding consumes the answer without granting an override", async ({ capability, payload }) => {
    const test = await fixture();
    expect((await test.send("POST", payload, capability)).statusCode).toBe(403);
    expect(await test.holds.forCall(PAYLOAD.uuid, undefined)).toBeUndefined();
    expect((await test.send("POST")).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
    expect((await test.send("POST", { ...PAYLOAD, uuid: "fresh-call" })).headers["x-preflight-decision"]).toBe("pass");
  });

  it("refuses reuse for another signed UUID and cannot overwrite the first binding", async () => {
    const test = await fixture();
    expect((await test.send("POST")).headers["x-preflight-decision"]).toBe("pass");
    const claim = vi.spyOn(test.graphStore, "claimAnswer");
    test.hits.length = 0;
    expect((await test.send("POST", { ...PAYLOAD, uuid: "other-call" })).statusCode).toBe(403);
    expect(claim).toHaveBeenCalledWith("other-call");
    expect(test.hits).toEqual([]);
    expect(await test.holds.get("released")).toMatchObject({ placedCallUuid: "early-call" });
  });

  it.each(["POST", "GET"] as const)("removes an encoded capability name from %s logs, request state, origin and persisted evidence", async (method) => {
    const test = await fixture();
    expect((await test.send(method, PAYLOAD, CAPABILITY, "%70f_placement")).headers["x-preflight-decision"]).toBe("pass");
    expect(test.logs.some((line) => line.includes("incoming request"))).toBe(true);
    const persisted = { webhooks: await test.store.recent(10), decisions: await test.decisions.recent(10), ledger: await test.ledger.entries(0, 10) };
    expect(JSON.stringify({ logs: test.logs, requests: test.requests, hits: test.hits, persisted })).not.toContain(CAPABILITY);
    expect(JSON.stringify({ requests: test.requests, hits: test.hits, persisted })).not.toContain(PLACEMENT_QUERY);
  });

  it("refuses duplicate encoded capability parameters before binding and redacts the initial log", async () => {
    const test = await fixture();
    const bind = vi.spyOn(test.holds, "bindPlacement");
    const claim = vi.spyOn(test.graphStore, "claimAnswer");
    const raw = JSON.stringify(PAYLOAD);
    const result = await test.server.inject({ method: "POST", url: `/v/answer?pf_placement=${CAPABILITY}&%70f_placement=${CAPABILITY}`, payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
    expect(result.statusCode).toBe(403);
    expect(bind).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(test.hits).toEqual([]);
    expect(test.logs.some((line) => line.includes("incoming request"))).toBe(true);
    expect(JSON.stringify(test.logs)).not.toContain(CAPABILITY);
  });

  it("redacts capability URLs even when signature verification fails", async () => {
    const test = await fixture();
    expect((await test.send("GET", PAYLOAD, CAPABILITY, "%70f_placement", false)).statusCode).toBe(403);
    expect(test.logs.some((line) => line.includes("incoming request"))).toBe(true);
    expect(JSON.stringify({ logs: test.logs, requests: test.requests })).not.toContain(CAPABILITY);
    expect(await test.store.count()).toBe(0);
  });
});
