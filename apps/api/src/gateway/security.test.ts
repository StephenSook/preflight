import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { MemoryDecisionStore } from "../store/decisionStore.js";
import { MemoryEventStore } from "../store/eventStore.js";
import { MemoryGraphStore } from "../store/graphStore.js";
import { MemoryHoldStore } from "../store/holdStore.js";
import { MemoryLedgerStore } from "../store/ledgerStore.js";
import { mintApplicationJwt } from "../vonage/mintApplicationJwt.js";

const NOW = Date.parse("2026-09-08T16:00:00Z");
const APP_ID = "00000000-0000-4000-8000-000000000001";
const SECRET = "fixture-signature";
const API_KEY = "fixture-key";
const ANSWER = "https://preflight.example/v/answer";
const ORIGIN = "https://origin.example/answer";
const PLATFORM = "https://platform.example";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
const token = mintApplicationJwt(APP_ID, privateKey, NOW);
const resolver = NumberFactsResolver.load();
const base = { to: [{ type: "phone", number: "14042010000" }], from: { type: "phone", number: "14045550100" } };
const connect = [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }];
const open = [{ action: "talk", text: "This is the fixture clinic." }, { action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/optout"] }];
const servers: ReturnType<typeof buildServer>[] = [];

function fixture(origin: () => Promise<Response> = async () => new Response(JSON.stringify(connect)), platform: (init?: RequestInit) => Promise<Response> = async () => new Response(JSON.stringify({ uuid: "placed-call", conversation_uuid: "placed-conversation" }), { status: 201 }), env: Record<string, string> = {}) {
  const config = loadConfig({ VONAGE_API_KEY: API_KEY, VONAGE_SIGNATURE_SECRET: SECRET, VONAGE_APPLICATION_ID: APP_ID, VONAGE_API_HOST: PLATFORM, PUBLIC_BASE_URL: "https://preflight.example", ORIGIN_ANSWER_URL: ORIGIN, LOG_LEVEL: "silent", ...env });
  const decisions = new MemoryDecisionStore();
  const store = new MemoryEventStore();
  const graphStore = new MemoryGraphStore();
  const holds = new MemoryHoldStore();
  const ledger = new MemoryLedgerStore();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => String(input).startsWith(PLATFORM) ? platform(init) : origin());
  const server = buildServer({ config, decisions, store, graphStore, holds, ledger, resolver, declaration: { identification: { phrases: ["This is the fixture clinic"] }, optOut: { eventUrlPatterns: ["/optout"] } }, fetchImpl, now: () => NOW, applicationPublicKeyPem: publicKey, applicationPrivateKeyPem: privateKey });
  servers.push(server);
  const call = (body: unknown, override?: string, bearer = token) => server.inject({ method: "POST", url: "/v/calls", payload: JSON.stringify(body), headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...(override ? { "x-preflight-override": override } : {}) } });
  return { server, decisions, store, graphStore, holds, ledger, fetchImpl, call };
}

async function released(holds: MemoryHoldStore): Promise<void> {
  await holds.create({ holdId: "release", callUuid: "preflight-dryrun-held", humanParty: base.to[0]!.number, reason: "open branch", verdicts: [], status: "open", createdAt: new Date(NOW).toISOString(), decidedAt: undefined, decidedBy: undefined });
  await holds.decide("release", "placed", "fixture operator", new Date(NOW).toISOString());
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("gateway security boundaries", () => {
  it.each([
    { method: "GET", direction: "outbound" },
    { method: "POST", direction: "outbound" },
    { method: "GET", direction: undefined },
    { method: "POST", direction: undefined },
  ] as const)("binds a released call on its signed $method answer before201 with direction $direction", async ({ method, direction }) => {
    let capability: string | null = null;
    let earlyResult: unknown;
    const payload = { uuid: "early-release", conversation_uuid: "early-conversation", ...(direction ? { direction } : {}), from: base.from.number, to: base.to[0]!.number };
    const test = fixture(async () => new Response(JSON.stringify(open)), async (init) => {
      const forwarded = JSON.parse(String(init?.body)) as { answer_url: string[] };
      const answerUrl = new URL(forwarded.answer_url[0]!);
      capability = answerUrl.searchParams.get("pf_placement");
      expect(capability).toMatch(/^[a-f0-9]{64}$/);
      if (method === "GET") for (const [name, value] of Object.entries(payload)) answerUrl.searchParams.set(name, value);
      const raw = method === "POST" ? JSON.stringify(payload) : JSON.stringify(Object.fromEntries(answerUrl.searchParams));
      const response = await test.server.inject({ method, url: answerUrl.pathname + answerUrl.search, ...(method === "POST" ? { payload: JSON.stringify(payload) } : {}), headers: { "content-type": "application/json", authorization: signed(raw, APP_ID) } });
      earlyResult = { status: response.statusCode, decision: response.headers["x-preflight-decision"], record: (await test.decisions.recent(1))[0], hold: await test.holds.forCall(payload.uuid, undefined) };
      return new Response(JSON.stringify(payload), { status: 201 });
    });
    await released(test.holds);
    expect((await test.call({ ...base, answer_url: [ANSWER], answer_method: method }, "release")).statusCode).toBe(201);
    expect(earlyResult).toMatchObject({ status: 200, decision: "pass", record: { policy: "advisory", callUuid: payload.uuid, direction: "outbound" }, hold: { holdId: "release" } });
    expect(await test.holds.get("release")).toMatchObject({ placedCallUuid: payload.uuid, placedConversationUuid: payload.conversation_uuid });
    const other = JSON.stringify({ ...payload, uuid: "different-call" });
    expect((await test.server.inject({ method: "POST", url: `/v/answer?pf_placement=${capability}`, payload: other, headers: { "content-type": "application/json", authorization: signed(other, APP_ID) } })).statusCode).toBe(403);
    for (const [input, init] of test.fetchImpl.mock.calls.filter(([input]) => !String(input).startsWith(PLATFORM))) {
      expect(String(input)).not.toContain(capability);
      expect(String(init?.body)).not.toContain(capability);
    }
    expect(JSON.stringify(await test.store.recent(20))).not.toContain(capability);
  });

  it("does not replace a live answer path with the dry-run path after a delayed 201", async () => {
    let originRequests = 0;
    let livePath: string[] | undefined;
    const livePayload = { uuid: "racing-call", conversation_uuid: "racing-conversation", direction: "outbound", from: "14045550999", to: base.to[0]!.number };
    const test = fixture(async () => {
      originRequests += 1;
      return new Response(JSON.stringify([open[0], { action: "input", type: ["dtmf"], eventUrl: [`https://origin.example/${originRequests === 1 ? "dry" : "live"}`] }]));
    }, async () => {
      const raw = JSON.stringify(livePayload);
      const answer = await test.server.inject({ method: "POST", url: "/v/answer", payload: raw, headers: { "content-type": "application/json", authorization: signed(raw, APP_ID) } });
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["x-preflight-decision"]).toBe("pass");
      livePath = await test.graphStore.callPath(livePayload.uuid);
      expect(livePath).toHaveLength(2);
      return new Response(JSON.stringify({ uuid: livePayload.uuid, conversation_uuid: livePayload.conversation_uuid }), { status: 201 });
    }, { POLICY_MODE: "advisory" });
    const response = await test.call({ ...base, answer_url: [ANSWER] });
    expect(response.statusCode).toBe(201);
    expect(await test.graphStore.callPath(livePayload.uuid)).toEqual(livePath);
    expect(await test.graphStore.callContext(livePayload.uuid)).toEqual({ direction: "outbound", from: livePayload.from, to: livePayload.to });
    const lastNode = livePath?.at(-1);
    expect(lastNode).toBeDefined();
    expect(await test.graphStore.claimBranch(livePayload.uuid, lastNode!)).toBe(true);
  });

  it("still initializes successful inline-only calls for their branch callbacks", async () => {
    const test = fixture(undefined, undefined, { POLICY_MODE: "advisory" });
    expect((await test.call({ ...base, ncco: open })).statusCode).toBe(201);
    const path = await test.graphStore.callPath("placed-call");
    expect(path).toHaveLength(2);
    expect(await test.graphStore.callContext("placed-call")).toEqual({ direction: "outbound", from: base.from.number, to: base.to[0]!.number });
    expect(await test.graphStore.claimBranch("placed-call", path!.at(-1)!)).toBe(true);
  });

  it("does not initialize a path from an unsuccessful platform response", async () => {
    const test = fixture(undefined, async () => new Response(JSON.stringify({ uuid: "refused-call", conversation_uuid: "refused-conversation" }), { status: 403 }));
    expect((await test.call({ ...base, ncco: connect })).statusCode).toBe(403);
    expect(await test.graphStore.callPath("refused-call")).toBeUndefined();
  });

  it("does not bind a release from UUIDs in a401 response", async () => {
    const test = fixture(undefined, async () => new Response(JSON.stringify({ uuid: "refused-call", conversation_uuid: "refused-conversation" }), { status: 401 }));
    await released(test.holds);
    expect((await test.call({ ...base, ncco: connect }, "release")).statusCode).toBe(401);
    expect(await test.holds.get("release")).toMatchObject({ placementReserved: true });
    expect((await test.holds.get("release"))?.placedCallUuid).toBeUndefined();
    expect((await test.holds.get("release"))?.placedConversationUuid).toBeUndefined();
    expect(await test.holds.forCall("refused-call", "refused-conversation")).toBeUndefined();
    expect((await test.call({ ...base, ncco: connect }, "release")).statusCode).toBe(409);
  });

  it.each(["http", "network", "invalid"])("preserves hard %s refusal with random caller ID", async (failure) => {
    const test = fixture(async () => {
      if (failure === "network") throw new Error("fixture unavailable");
      return new Response(failure === "invalid" ? "not an NCCO" : "unavailable", { status: failure === "http" ? 503 : 200 });
    });
    const response = await test.call({ to: base.to, random_from_number: true, answer_url: [ANSWER] });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ decision: "block", placed: false });
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(test.fetchImpl.mock.calls[0]?.[0])).toContain(ORIGIN);
    expect((await test.decisions.recent(1))[0]).toMatchObject({ source: "gateway", decision: "block" });
    expect((await test.ledger.entries(0, 10))[0]).toMatchObject({ kind: "block" });
  });

  it("still permits a compliant random-caller-ID request", async () => {
    const test = fixture();
    expect((await test.call({ to: base.to, random_from_number: true, ncco: connect })).statusCode).toBe(201);
    expect((await test.decisions.recent(1))[0]).toMatchObject({ source: "gateway", platformStatus: 201 });
  });

  it.each([ORIGIN, "https://preflight.example/other/v/answer", "http://preflight.example/v/answer", "https://attacker.example/v/answer", `${ANSWER}?redirect=elsewhere`, `${ANSWER}#fragment`, "https://user:password@preflight.example/v/answer"])("rejects an unmediated answer URL %s", async (url) => {
    const test = fixture();
    expect((await test.call({ ...base, answer_url: [url] })).statusCode).toBe(400);
    expect(test.fetchImpl).not.toHaveBeenCalled();
    expect(await test.decisions.recent(1)).toEqual([]);
  });

  it.each([[ANSWER, ORIGIN], [], ANSWER])("rejects ambiguous answer_url %j even alongside inline NCCO", async (urls) => {
    const test = fixture();
    expect((await test.call({ ...base, answer_url: urls, ncco: connect })).statusCode).toBe(400);
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a configured public base for answer URLs", async () => {
    const test = fixture();
    const config = loadConfig({ VONAGE_API_KEY: API_KEY, VONAGE_SIGNATURE_SECRET: SECRET, VONAGE_APPLICATION_ID: APP_ID, ORIGIN_ANSWER_URL: ORIGIN, LOG_LEVEL: "silent" });
    const server = buildServer({ config, store: test.store, decisions: test.decisions, ledger: test.ledger, graphStore: test.graphStore, holds: test.holds, resolver, declaration: {}, fetchImpl: test.fetchImpl, now: () => NOW, applicationPublicKeyPem: publicKey });
    servers.push(server);
    const response = await server.inject({ method: "POST", url: "/v/calls", payload: JSON.stringify({ ...base, answer_url: [ANSWER] }), headers: { "content-type": "application/json", authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(400);
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses the token actually issued to a public judge before any gateway side effect", async () => {
    const test = fixture();
    const issued = await test.server.inject({ method: "POST", url: "/api/softphone/token", payload: "{}", headers: { "content-type": "application/json" } });
    expect(issued.statusCode).toBe(201);
    test.fetchImpl.mockClear();
    const response = await test.call({ ...base, ncco: open }, undefined, issued.json().token as string);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: "client_token" });
    expect(test.fetchImpl).not.toHaveBeenCalled();
    expect(await test.holds.list("all", 10)).toEqual([]);
    expect(await test.decisions.recent(1)).toEqual([]);
    expect((await test.graphStore.load()).nodes.size).toBe(0);
    expect(await test.ledger.entries(0, 10)).toEqual([]);
  });

  it("reserves a release once while its first platform response is still pending", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const test = fixture(undefined, async () => {
      entered();
      await pending;
      return new Response(JSON.stringify({ uuid: "first-call", conversation_uuid: "first-conversation" }), { status: 201 });
    });
    await released(test.holds);
    const first = test.call({ ...base, ncco: open }, "release").then((response) => response);
    try {
      await started;
      expect((await test.call({ ...base, ncco: open }, "release")).statusCode).toBe(409);
      expect(test.fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      finish();
    }
    expect((await first).statusCode).toBe(201);
    expect(await test.holds.get("release")).toMatchObject({ placementReserved: true, placedCallUuid: "first-call" });
  });

  it("never reuses a release after an ambiguous platform failure", async () => {
    const test = fixture(undefined, async () => { throw new Error("connection reset after request"); });
    await released(test.holds);
    expect((await test.call({ ...base, ncco: open }, "release")).statusCode).toBe(502);
    expect((await test.call({ ...base, ncco: open }, "release")).statusCode).toBe(409);
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await test.holds.get("release")).toMatchObject({ placementReserved: true });
    expect((await test.decisions.recent(1))[0]).toMatchObject({ source: "gateway", platformStatus: 502 });
  });

  it("does not reserve blocked flows and does not give sibling legs an override", async () => {
    const test = fixture();
    await released(test.holds);
    expect((await test.call({ ...base, ncco: [{ action: "talk", text: "Unidentified speech" }] }, "release")).statusCode).toBe(409);
    expect((await test.holds.get("release"))?.placementReserved).not.toBe(true);
    expect(await test.holds.reservePlacement("release")).toBe(true);
    await test.holds.placed("release", "leg-A", "shared-conversation");
    expect(await test.holds.forCall("leg-B", "shared-conversation")).toBeUndefined();
    expect(await test.holds.forCall("leg-A", "shared-conversation")).toMatchObject({ holdId: "release" });
    expect(await test.holds.forCall(undefined, "shared-conversation")).toMatchObject({ holdId: "release" });
  });
});

function signed(raw: string, applicationId: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: NOW / 1000, jti: "fixture", iss: "Vonage", api_key: API_KEY, application_id: applicationId, payload_hash: createHash("sha256").update(raw).digest("hex") })).toString("base64url");
  return `Bearer ${header}.${payload}.${createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url")}`;
}

describe("webhook application boundary", () => {
  it.each(["answer", "event", "fallback", "hook"])("refuses another application's %s before any side effect", async (route) => {
    const test = fixture();
    const raw = JSON.stringify({ uuid: "foreign-call", direction: "inbound", from: base.to[0]!.number, to: base.from.number });
    const response = await test.server.inject({ method: "POST", url: `/v/${route}`, payload: raw, headers: { "content-type": "application/json", authorization: signed(raw, "00000000-0000-4000-8000-000000000002") } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "wrong_application" });
    expect(test.fetchImpl).not.toHaveBeenCalled();
    expect(await test.store.count()).toBe(0);
    expect(await test.decisions.recent(1)).toEqual([]);
    expect((await test.graphStore.load()).nodes.size).toBe(0);
    expect(await test.ledger.entries(0, 10)).toEqual([]);
  });

  it.each([APP_ID, undefined])("accepts account-signed callbacks with application claim %s", async (applicationId) => {
    const test = fixture();
    const raw = JSON.stringify({ uuid: "local-call", direction: "inbound", from: base.to[0]!.number, to: base.from.number });
    const response = await test.server.inject({ method: "POST", url: "/v/answer", payload: raw, headers: { "content-type": "application/json", authorization: signed(raw, applicationId) } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-preflight-decision"]).toBe("pass");
    expect((await test.decisions.recent(1))[0]).toMatchObject({ source: "webhook", applicationId: APP_ID });
  });
});
