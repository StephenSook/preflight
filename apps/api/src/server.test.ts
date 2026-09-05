import { createHmac, generateKeyPairSync } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declarationFrom, loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { MemoryDecisionStore } from "./store/decisionStore.js";
import { MemoryLedgerStore } from "./store/ledgerStore.js";
import { MemoryEventStore } from "./store/eventStore.js";
import { MemoryGraphStore } from "./store/graphStore.js";
import { MemoryHoldStore } from "./store/holdStore.js";
import { MemoryInsightStore } from "./store/insightStore.js";
import { sha256Hex } from "./vonage/verifyWebhook.js";

const SECRET = "test-signature-secret";
const API_KEY = "a1b2c3d";
/** Fri Sep 4 2026, 16:00 UTC = 12:00 in Atlanta, inside calling hours. The same clock signs the tokens. */
const NOW = Date.parse("2026-09-04T16:00:00Z");
const resolver = NumberFactsResolver.load();
const DECLARATION = { identification: { phrases: ["This is a message from Preflight Demo Clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}
function sign(raw: string, secret = SECRET, apiKey = API_KEY): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: Math.floor(NOW / 1000), jti: "j", iss: "Vonage", payload_hash: sha256Hex(raw), api_key: apiKey }));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `Bearer ${head}.${body}.${sig}`;
}

/** Flows the stand-in origin can serve. Odd spacing on purpose: pass-through must be byte-exact. */
const FLOWS = {
  connectOnly: '[{"action":"connect",  "endpoint":[{"type":"phone","number":"14045550123"}]} ]',
  syntheticNoOptOut: '[{"action":"talk","text":"This is a message from Preflight Demo Clinic."},{"action":"talk","text":"Your appointment is tomorrow."}]',
  syntheticWithOptOut: '[{"action":"talk","text":"This is a message from Preflight Demo Clinic. Press nine to stop these calls."},{"action":"input","type":["dtmf"],"eventUrl":["https://origin.example/webhooks/optout"]}]',
  notAnNcco: '{"action":"talk","text":"hello"}',
};
const OUTBOUND = { uuid: "call-1", conversation_uuid: "CON-1", direction: "outbound", to: "14042010000", from: "14045550100" };

describe("preflight api ingress", () => {
  const origin = Fastify({ forceCloseConnections: true });
  let originUrl = "";
  let originHits = 0;
  let served: string = FLOWS.connectOnly;
  let servedQuestion = "";
  /** The reference application on its own listener, switched through its own admin endpoint. */
  const ref = Fastify({ forceCloseConnections: true });
  let refUrl = "";
  const REF_ADMIN = "reference-admin-token-for-tests";
  beforeAll(async () => {
    const { referenceApp } = await import("@preflight/reference");
    ref.addContentTypeParser(["application/json", "text/plain"], { parseAs: "string" }, (_req, body, done) => done(null, body));
    await ref.register(referenceApp, { prefix: "/reference", selfBaseUrl: () => `${refUrl}/reference`, mode: "broken", adminToken: REF_ADMIN });
    await ref.listen({ port: 0, host: "127.0.0.1" });
    const refAddr = ref.server.address();
    if (!refAddr || typeof refAddr === "string") throw new Error("reference app did not bind");
    refUrl = `http://127.0.0.1:${refAddr.port}`;
    origin.route({ method: ["GET", "POST"], url: "/answer", handler: async (_req, reply) => { originHits += 1; return reply.type("application/json").send(served); } });
    origin.route({ method: ["GET", "POST"], url: "/question", handler: async (_req, reply) => (servedQuestion.length === 0 ? reply.code(204).send() : reply.type("application/json").send(servedQuestion)) });
    origin.post("/slow", async (_req, reply) => { await new Promise((r) => setTimeout(r, 400)); return reply.send("[]"); });
    await origin.listen({ port: 0, host: "127.0.0.1" });
    const addr = origin.server.address();
    if (!addr || typeof addr === "string") throw new Error("origin did not bind");
    originUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => { await origin.close(); await ref.close(); }, 15000);

  function app(overrides: Record<string, string> = {}) {
    const config = loadConfig({
      VONAGE_API_KEY: API_KEY,
      VONAGE_SIGNATURE_SECRET: SECRET,
      ORIGIN_ANSWER_URL: `${originUrl}/answer`,
      ORIGIN_TIMEOUT_MS: "200",
      PUBLIC_BASE_URL: "https://preflight.example",
      LOG_LEVEL: "silent",
      ...overrides,
    });
    const store = new MemoryEventStore();
    const decisions = new MemoryDecisionStore();
    const ledger = new MemoryLedgerStore();
    const graphStore = new MemoryGraphStore();
    const holds = new MemoryHoldStore();
    const declaration = config.FLOW_DECLARATION_JSON ? declarationFrom(config) : DECLARATION;
    return { server: buildServer({ config, store, decisions, ledger, graphStore, holds, resolver, declaration, now: () => NOW }), store, decisions, ledger, graphStore, holds };
  }
  const post = (server: ReturnType<typeof app>["server"], url: string, payload: Record<string, unknown>) => {
    const raw = JSON.stringify(payload);
    return server.inject({ method: "POST", url, payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
  };

  it("reports health with the store, the decision counts and the number-facts vintage", async () => {
    const { server } = app();
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "preflight-api", store: "memory", decisions: { pass: 0, block: 0, hold: 0 }, numfacts: { nanpaFileUpdated: expect.stringMatching(/\d{2}\/\d{2}\/\d{4}/) } });
  });

  it("refuses an unsigned answer webhook with 403 and touches no state", async () => {
    const { server, store, decisions } = app();
    const before = originHits;
    const res = await server.inject({ method: "POST", url: "/v/answer", payload: '{"uuid":"x"}', headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(403);
    expect(await store.count()).toBe(0);
    expect((await decisions.recent(1)).length).toBe(0);
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

  it("passes a compliant flow through byte for byte, with both latencies and the decision on the headers", async () => {
    served = FLOWS.connectOnly;
    const { server, store, decisions } = app();
    const res = await post(server, "/v/answer", OUTBOUND);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(FLOWS.connectOnly);
    expect(res.headers["x-preflight-decision"]).toBe("pass");
    expect(Number(res.headers["x-preflight-origin-ms"])).toBeGreaterThanOrEqual(0);
    expect(Number(res.headers["x-preflight-verify-ms"])).toBeGreaterThan(0);
    expect((await store.recent(1))[0]).toMatchObject({ kind: "answer", callUuid: "call-1", conversationUuid: "CON-1", decision: "pass" });
    const d = (await decisions.recent(1))[0];
    expect(d).toMatchObject({ decision: "pass", direction: "outbound", humanParty: "14042010000", terminal: true, policy: "strict", facts: { state: "GA", rateCenter: "ATLANTA", lineType: "wireless", withinHours: true } });
    expect(d?.nccoHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d?.verdicts.map((v) => v.verdict)).toEqual(["true", "true", "true", "true", "true"]);
  });

  it("passes a signed GET answer webhook with its query string", async () => {
    served = FLOWS.connectOnly;
    const { server } = app();
    const qs = "to=14042010000&from=14045550100&uuid=call-2&conversation_uuid=CON-2&direction=outbound";
    const res = await server.inject({ method: "GET", url: `/v/answer?${qs}`, headers: { authorization: sign(qs) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(FLOWS.connectOnly);
  });

  it("blocks a synthetic flow with no opt-out: safe object with the citation, verdict and witness stored", async () => {
    served = FLOWS.syntheticNoOptOut;
    const { server, decisions } = app();
    const res = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-3" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-preflight-decision"]).toBe("block");
    const ncco = res.json() as Array<{ action: string; text: string }>;
    expect(ncco).toHaveLength(1);
    expect(ncco[0]?.action).toBe("talk");
    expect(ncco[0]?.text).toContain("stopped by Preflight");
    expect(ncco[0]?.text).toContain("47 CFR 64.1200(b)(3)");
    const d = (await decisions.recent(1))[0];
    expect(d).toMatchObject({ decision: "block", callUuid: "call-3", terminal: true });
    expect(d?.verdicts.find((v) => v.id === "P3")).toMatchObject({ verdict: "false", atEnd: true, witness: [expect.objectContaining({ label: "talk#0" }), expect.objectContaining({ label: "talk#1" })] });
  });

  it("holds an open flow under strict policy and passes it under advisory, recording which", async () => {
    served = FLOWS.syntheticWithOptOut;
    const strict = app();
    const held = await post(strict.server, "/v/answer", { ...OUTBOUND, uuid: "call-4" });
    expect(held.headers["x-preflight-decision"]).toBe("hold");
    expect((held.json() as Array<{ text: string }>)[0]?.text).toMatch(/held for review.*not been observed/);
    expect((await strict.decisions.recent(1))[0]).toMatchObject({ decision: "hold", terminal: false, policy: "strict" });

    const advisory = app({ POLICY_MODE: "advisory" });
    const passed = await post(advisory.server, "/v/answer", { ...OUTBOUND, uuid: "call-5" });
    expect(passed.headers["x-preflight-decision"]).toBe("pass");
    // On pass the branch callback is routed through Preflight so its replacement is observed; everything else is untouched.
    expect(passed.headers["x-preflight-routed"]).toBe("1");
    const routed = passed.json() as Array<{ action: string; text?: string; eventUrl?: string[] }>;
    expect(routed[0]).toEqual({ action: "talk", text: "This is a message from Preflight Demo Clinic. Press nine to stop these calls." });
    const hook = new URL(routed[1]?.eventUrl?.[0] ?? "");
    expect(hook.origin + hook.pathname).toBe("https://preflight.example/v/hook");
    // Only the node id and the method travel; the origin callback is read back from the graph.
    expect(hook.searchParams.get("u")).toBeNull();
    expect(hook.searchParams.get("n")).toMatch(/^[0-9a-f]{24}$/);
    expect(hook.searchParams.get("m")).toBe("POST");
    expect((await advisory.decisions.recent(1))[0]).toMatchObject({ decision: "pass", terminal: false, policy: "advisory" });
  });

  it("blocks when the origin returns something that is not a call-control object, under either policy", async () => {
    served = FLOWS.notAnNcco;
    for (const mode of ["strict", "advisory"]) {
      const { server } = app({ POLICY_MODE: mode });
      const res = await post(server, "/v/answer", { ...OUTBOUND, uuid: `call-6-${mode}` });
      expect(res.headers["x-preflight-decision"]).toBe("block");
      expect((res.json() as Array<{ text: string }>)[0]?.text).toContain("not a call-control object");
    }
  });

  it("blocks a synthetic flow outside calling hours at the destination and names the rule", async () => {
    served = FLOWS.syntheticWithOptOut;
    const config = loadConfig({ VONAGE_API_KEY: API_KEY, VONAGE_SIGNATURE_SECRET: SECRET, ORIGIN_ANSWER_URL: `${originUrl}/answer`, ORIGIN_TIMEOUT_MS: "200", LOG_LEVEL: "silent" });
    const lateNight = Date.parse("2026-09-05T02:30:00Z"); // 22:30 in Atlanta
    const decisions = new MemoryDecisionStore();
    const server = buildServer({ config, store: new MemoryEventStore(), decisions, ledger: new MemoryLedgerStore(), graphStore: new MemoryGraphStore(), holds: new MemoryHoldStore(), resolver, declaration: DECLARATION, now: () => lateNight });
    const raw = JSON.stringify({ ...OUTBOUND, uuid: "call-7" });
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: Math.floor(lateNight / 1000), jti: "j", iss: "Vonage", payload_hash: sha256Hex(raw), api_key: API_KEY }));
    const auth = `Bearer ${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
    const res = await server.inject({ method: "POST", url: "/v/answer", payload: raw, headers: { "content-type": "application/json", authorization: auth } });
    expect(res.headers["x-preflight-decision"]).toBe("block");
    expect((res.json() as Array<{ text: string }>)[0]?.text).toContain("47 CFR 64.1200(c)(1)");
    expect((await decisions.recent(1))[0]?.verdicts.find((v) => v.id === "P1")).toMatchObject({ verdict: "false", witness: [expect.objectContaining({ label: "talk#0" })] });
  });

  it("writes every decision to the evidence log as a linked entry and serves head, entries and verify", async () => {
    served = FLOWS.syntheticNoOptOut;
    const { server, ledger } = app();
    await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-L1" });
    served = FLOWS.connectOnly;
    await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-L2" });
    const head = (await server.inject({ method: "GET", url: "/api/ledger/head" })).json() as { seq: number; entry_hash: string };
    expect(head.seq).toBe(2);
    expect(head.entry_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const page = (await server.inject({ method: "GET", url: "/api/ledger/entries?after=0&limit=10" })).json() as { entries: Array<Record<string, unknown>> };
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toMatchObject({ seq: 1, kind: "block", call_uuid: "call-L1", property: "P3", citation: "47 CFR 64.1200(b)(3)", witness: ["talk#0", "talk#1"], line_type: { value: "wireless", source: "nanpa", conf: "low" } });
    expect(page.entries[1]).toMatchObject({ seq: 2, kind: "pass", call_uuid: "call-L2", property: null, prev_hash: page.entries[0]?.["entry_hash"] });
    expect((await server.inject({ method: "GET", url: "/api/ledger/verify" })).json()).toMatchObject({ ok: true, entries: 2, head: head.entry_hash });
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("records a transparency-log seal only with the seal token, and refuses without it", async () => {
    const { server } = app({ SEAL_TOKEN: "a-seal-token-of-sufficient-length" });
    const seal = { rekor_uuid: "24296fb2" + "0".repeat(72), rekor_log_index: 123456, sealed: { seq: 0, entry_hash: "sha256:" + "0".repeat(64) }, signature_b64: "MEUCIQ==" };
    const forbidden = await server.inject({ method: "POST", url: "/api/ledger/seals", payload: JSON.stringify(seal), headers: { "content-type": "application/json", authorization: "Bearer wrong-token-wrong-token-wrong" } });
    expect(forbidden.statusCode).toBe(403);
    const created = await server.inject({ method: "POST", url: "/api/ledger/seals", payload: JSON.stringify(seal), headers: { "content-type": "application/json", authorization: "Bearer a-seal-token-of-sufficient-length" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ seq: 1, kind: "seal", detail: { rekor_uuid: seal.rekor_uuid, rekor_log_index: 123456, sealed_seq: 0 } });
    const disabled = app();
    expect((await disabled.server.inject({ method: "POST", url: "/api/ledger/seals", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(404);
  });

  it("replays the spec example through HTTP: the branch nobody traced speaks synthetically and is caught at the hook, then at answer time", async () => {
    // The answer object: identification, then a question whose callback the developer has not traced.
    const question = `${originUrl}/question`;
    served = JSON.stringify([{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "input", type: ["dtmf"], eventUrl: [question], dtmf: { maxDigits: 1, timeOut: 5 } }]);
    const { server, graphStore, decisions, ledger } = app({ POLICY_MODE: "advisory", FLOW_DECLARATION_JSON: JSON.stringify({ ...DECLARATION, endpoints: ["/question", "/voicemail-fallback"] }) });
    const first = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-H1" });
    expect(first.headers["x-preflight-decision"]).toBe("pass");
    const hookUrl = new URL((first.json() as Array<{ eventUrl?: string[] }>)[1]?.eventUrl?.[0] ?? "");
    expect(await graphStore.callPath("call-H1")).toHaveLength(2);

    // Vonage calls the hook with the input result; the origin's question handler returns the untraced branch.
    servedQuestion = JSON.stringify([{ action: "talk", text: "We could not reach you. Goodbye." }]);
    const hookRaw = JSON.stringify({ uuid: "call-H1", conversation_uuid: "CON-1", dtmf: { digits: "", timed_out: true }, direction: "outbound", to: OUTBOUND.to, from: OUTBOUND.from });
    const hook = await server.inject({ method: "POST", url: hookUrl.pathname + hookUrl.search, payload: hookRaw, headers: { "content-type": "application/json", authorization: sign(hookRaw) } });
    expect(hook.statusCode).toBe(200);
    expect(hook.headers["x-preflight-decision"]).toBe("block");
    expect((hook.json() as Array<{ text: string }>)[0]?.text).toContain("47 CFR 64.1200(b)(3)");
    const d = (await decisions.recent(1))[0];
    expect(d?.verdicts.find((v) => v.id === "P3")?.witness?.map((w) => w.label)).toEqual(["talk#0", "input#1", "talk#0'"]);
    expect((await ledger.entries(0, 10)).find((e) => e.call_uuid === "call-H1" && e.kind === "block")?.witness).toEqual(["talk#0", "input#1", "talk#0'"]);

    // The graph now knows the branch: the next call is blocked at answer time, before it runs.
    const second = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-H2" });
    expect(second.headers["x-preflight-decision"]).toBe("block");
    const coverage = (await server.inject({ method: "GET", url: "/api/coverage" })).json() as { observed: string[]; unobserved: string[]; branchPoints: number; openBranches: string[] };
    expect(coverage).toMatchObject({ observed: ["answer", "/question"], unobserved: ["/voicemail-fallback"], branchPoints: 1, openBranches: [] });
    const summary = (await server.inject({ method: "GET", url: "/api/summary" })).json() as { decisions: Record<string, number>; latency: { sample: number; verifyP50Ms: number } };
    expect(summary.decisions.block).toBe(2);
    expect(summary.latency.sample).toBe(3);
    expect(summary.latency.verifyP50Ms).toBeGreaterThan(0);
  });

  it("treats an empty callback as a continuation and decides the rest of the object from what the call already ran", async () => {
    const question = `${originUrl}/question`;
    served = JSON.stringify([{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "input", type: ["dtmf"], eventUrl: [question] }, { action: "talk", text: "Thank you. Goodbye." }]);
    const { server, graphStore } = app({ POLICY_MODE: "advisory", FLOW_DECLARATION_JSON: JSON.stringify({ ...DECLARATION, optOut: { eventUrlPatterns: ["/question"] } }) });
    const first = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-C1" });
    const hookUrl = new URL((first.json() as Array<{ eventUrl?: string[] }>)[1]?.eventUrl?.[0] ?? "");
    servedQuestion = "";
    const hookRaw = JSON.stringify({ uuid: "call-C1", dtmf: { digits: "1" }, direction: "outbound", to: OUTBOUND.to, from: OUTBOUND.from });
    const hook = await server.inject({ method: "POST", url: hookUrl.pathname + hookUrl.search, payload: hookRaw, headers: { "content-type": "application/json", authorization: sign(hookRaw) } });
    expect(hook.statusCode).toBe(204);
    expect(hook.headers["x-preflight-decision"]).toBe("pass");
    expect(await graphStore.callPath("call-C1")).toHaveLength(3);
    // Strict policy on a fresh call now decides the whole flow, because the continuation has been observed.
    const strict = app({ FLOW_DECLARATION_JSON: JSON.stringify({ ...DECLARATION, optOut: { eventUrlPatterns: ["/question"] } }) });
    await strict.graphStore.save([...(await graphStore.load()).nodes.values()], [...(await graphStore.load()).edges.values()]);
    const decided = await post(strict.server, "/v/answer", { ...OUTBOUND, uuid: "call-C2" });
    expect(decided.headers["x-preflight-decision"]).toBe("pass");
  });

  it("runs the demonstration loop: the mounted reference application is blocked on its untraced branch, then passes once fixed", async () => {
    const { referenceDeclaration } = await import("@preflight/reference");
    const decl = referenceDeclaration();
    const setMode = (mode: string) => ref.inject({ method: "POST", url: "/reference/mode", payload: JSON.stringify({ mode }), headers: { "content-type": "application/json", authorization: `Bearer ${REF_ADMIN}` } });
    const { server, ledger } = app({ POLICY_MODE: "advisory", ORIGIN_ANSWER_URL: `${refUrl}/reference/answer`, FLOW_DECLARATION_JSON: JSON.stringify(decl) });
    expect((await setMode("broken")).statusCode).toBe(200);
    const first = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-D1" });
    expect(first.headers["x-preflight-decision"]).toBe("pass");
    const hookUrl = new URL((first.json() as Array<{ eventUrl?: string[] }>)[1]?.eventUrl?.[0] ?? "");
    const timeoutRaw = JSON.stringify({ uuid: "call-D1", dtmf: { digits: "", timed_out: true }, direction: "outbound", to: OUTBOUND.to, from: OUTBOUND.from });
    const hook = await server.inject({ method: "POST", url: hookUrl.pathname + hookUrl.search, payload: timeoutRaw, headers: { "content-type": "application/json", authorization: sign(timeoutRaw) } });
    expect(hook.headers["x-preflight-decision"]).toBe("block");
    expect((hook.json() as Array<{ text: string }>)[0]?.text).toContain("stopped by Preflight");
    // The next call is refused before it runs; the ledger names the branch.
    const second = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-D2" });
    expect(second.headers["x-preflight-decision"]).toBe("block");
    expect((await ledger.entries(0, 10)).filter((e) => e.kind === "block").map((e) => e.witness)).toEqual([["talk#0", "input#1", "talk#0'"], ["talk#0", "input#1", "talk#0'"]]);
    // The fix: the keypress is routed to the declared opt-out handler. The graph observes the new object.
    expect((await setMode("fixed")).statusCode).toBe(200);
    const third = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-D3" });
    expect(third.headers["x-preflight-decision"]).toBe("pass");
    const fixedHook = new URL((third.json() as Array<{ eventUrl?: string[] }>)[1]?.eventUrl?.[0] ?? "");
    const nineRaw = JSON.stringify({ uuid: "call-D3", dtmf: { digits: "9" }, direction: "outbound", to: OUTBOUND.to, from: OUTBOUND.from });
    const nine = await server.inject({ method: "POST", url: fixedHook.pathname + fixedHook.search, payload: nineRaw, headers: { "content-type": "application/json", authorization: sign(nineRaw) } });
    expect(nine.headers["x-preflight-decision"]).toBe("pass");
    expect((nine.json() as Array<{ text: string }>)[0]?.text).toContain("will not receive these calls again");

    // The declared-versus-actual diff over what discovery saw: the timeout branch is the one state the
    // developer never declared, and it is the one that speaks; the press-1 branches were declared and never seen.
    const diff = (await server.inject({ method: "GET", url: "/api/flow" })).json() as { nodes: Array<{ endpoint: string; label: string; status: string; speaksSynthetic: boolean; text?: string }>; missing: Array<{ endpoint: string; index: number | null; action: string | null }>; counts: Record<string, number>; roots: string[]; openBranches: string[] };
    const undeclared = diff.nodes.filter((n) => n.status === "undeclared");
    expect(undeclared).toEqual([expect.objectContaining({ endpoint: "/reference/menu", label: "talk#0", speaksSynthetic: true, text: expect.stringContaining("We could not reach you") })]);
    expect(diff.nodes.filter((n) => n.endpoint === "/reference/optout")).toEqual([expect.objectContaining({ label: "talk#0", status: "declared" })]);
    expect(diff.missing).toEqual(expect.arrayContaining([{ endpoint: "/reference/menu", index: 0, action: "connect" }, { endpoint: "/reference/optout", index: 0, action: "connect" }]));
    expect(diff.counts).toMatchObject({ undeclared: 1, undeclaredSpeaking: 1, neverObserved: 2, endpointsDeclared: 3, endpointsObserved: 3 });
    expect(diff.roots).toHaveLength(2); // the broken and the fixed answer objects each start a path
    expect(diff.openBranches).toEqual([]);
  });

  it("reconciles the carrier's records against its own decisions behind the workflow token, and the summary carries the last result", async () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect((await app().server.inject({ method: "POST", url: "/api/reconcile", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(404);
    const token = "workflow-token-for-tests-1";
    const { server, ledger } = app({ SEAL_TOKEN: token });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await server.inject({ method: "POST", url: "/api/reconcile", payload: "{}", headers: { ...headers, authorization: "Bearer wrong" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/reconcile", payload: JSON.stringify({ records: [] }), headers })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/api/reconcile", payload: JSON.stringify({ window: { start: at(0), end: at(1000) }, records: [{ call_id: "x" }] }), headers })).statusCode).toBe(400);

    // One call the interlock passed (with its uuid), one request it refused before any uuid existed.
    served = FLOWS.connectOnly;
    expect((await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-R1" })).headers["x-preflight-decision"]).toBe("pass");
    served = FLOWS.syntheticNoOptOut;
    expect((await post(server, "/v/answer", { direction: "outbound", to: OUTBOUND.to, from: OUTBOUND.from })).headers["x-preflight-decision"]).toBe("block");

    const records = [
      { call_id: "call-R1", direction: "outbound", from: OUTBOUND.from, to: OUTBOUND.to, date_start: at(1000), status: "ANSWERED" },
      { call_id: "ghost-1", direction: "outbound", from: `+${OUTBOUND.from}`, to: OUTBOUND.to, date_start: at(3000) },
      { call_id: "stranger", direction: "inbound", from: "14045550100", to: "14045550199", date_start: at(4000) },
    ];
    const res = await server.inject({ method: "POST", url: "/api/reconcile", payload: JSON.stringify({ window: { start: at(-3600_000), end: at(3600_000) }, records }), headers });
    expect(res.statusCode).toBe(201);
    const { report, ledger: link } = res.json() as { report: Record<string, unknown>; ledger: { seq: number } };
    expect(report).toMatchObject({ carrier_records: 3, matched: 1, unmatched: 2, leaks: 1, refused_in_window: 1, unmatched_ids: ["ghost-1", "stranger"], leaked_ids: ["ghost-1"] });
    expect(link.seq).toBe(3);
    const entry = (await ledger.entries(2, 1))[0];
    expect(entry).toMatchObject({ kind: "reconciliation", detail: { carrier_records: 3, leaks: 1, records_hash: expect.stringMatching(/^sha256:/) } });
    expect((await ledger.verify()).ok).toBe(true);
    const summary = (await server.inject({ method: "GET", url: "/api/summary" })).json() as { reconciliation: Record<string, unknown> };
    expect(summary.reconciliation).toMatchObject({ seq: 3, carrier_records: 3, matched: 1, unmatched: 2, leaks: 1, refused_in_window: 1, window: { start: at(-3600_000), end: at(3600_000) } });
  });

  it("resolves a hold the free tables could not with one Identity Insights lookup after the response, never inside a decision", async () => {
    // 208 320 spans America/Boise and America/Los_Angeles; at 14:30Z they disagree (08:30 open, 07:30 closed), so strict policy holds.
    const AT = Date.parse("2026-09-05T14:30:00Z");
    const signAt = (raw: string): string => {
      const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const body = b64url(JSON.stringify({ iat: Math.floor(AT / 1000), jti: "j", iss: "Vonage", payload_hash: sha256Hex(raw), api_key: API_KEY }));
      return `Bearer ${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
    };
    const platformCalls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/identity-insights/")) {
        platformCalls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] });
        return new Response(JSON.stringify({ request_id: "r-1", insights: { format: { time_zones: ["America/Boise"], is_valid: true }, current_carrier: { name: "Verizon", network_type: "MOBILE" } } }), { status: 200 });
      }
      return fetch(url, init);
    }) as typeof fetch;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const insights = new MemoryInsightStore();
    const decisions = new MemoryDecisionStore();
    const config = loadConfig({ VONAGE_API_KEY: API_KEY, VONAGE_SIGNATURE_SECRET: SECRET, VONAGE_APPLICATION_ID: "00000000-0000-4000-8000-000000000001", ORIGIN_ANSWER_URL: `${originUrl}/answer`, ORIGIN_TIMEOUT_MS: "200", PUBLIC_BASE_URL: "https://preflight.example", LOG_LEVEL: "silent", IDENTITY_INSIGHTS: "on", INSIGHTS_PER_DAY: "1" });
    const server = buildServer({ config, store: new MemoryEventStore(), decisions, ledger: new MemoryLedgerStore(), graphStore: new MemoryGraphStore(), holds: new MemoryHoldStore(), insights, resolver, declaration: DECLARATION, applicationPrivateKeyPem: pem, fetchImpl, now: () => AT });
    served = FLOWS.connectOnly;
    const raw = JSON.stringify({ ...OUTBOUND, uuid: "call-I1", to: "12083200100" });
    const first = await server.inject({ method: "POST", url: "/v/answer", payload: raw, headers: { "content-type": "application/json", authorization: signAt(raw) } });
    expect(first.headers["x-preflight-decision"]).toBe("hold");
    expect((await decisions.recent(1))[0]?.facts).toMatchObject({ withinHours: null, hoursBasis: expect.stringContaining("disagree"), lineTypeSource: "nanpa", lineTypeConfidence: "low" });
    // The response went out before the platform was asked; the answer lands in the cache moments later.
    let cached = await insights.get("2083200100");
    for (let i = 0; i < 200 && cached?.status !== "ok"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      cached = await insights.get("2083200100");
    }
    expect(cached).toMatchObject({ status: "ok", httpStatus: 200, insight: { timeZones: ["America/Boise"], lineType: "wireless", carrier: "Verizon" } });
    expect(platformCalls).toHaveLength(1);
    expect(platformCalls[0]).toMatchObject({ url: "https://api-eu.vonage.com/identity-insights/v1/requests", body: { phone_number: "+12083200100", insights: { format: {}, current_carrier: {}, original_carrier: {} } }, auth: expect.stringMatching(/^Bearer /) });
    // The same line, the next call: decided from the cache, no second lookup.
    const raw2 = JSON.stringify({ ...OUTBOUND, uuid: "call-I2", to: "12083200100" });
    const second = await server.inject({ method: "POST", url: "/v/answer", payload: raw2, headers: { "content-type": "application/json", authorization: signAt(raw2) } });
    expect(second.headers["x-preflight-decision"]).toBe("pass");
    expect((await decisions.recent(1))[0]?.facts).toMatchObject({ zones: ["America/Boise"], withinHours: true, hoursBasis: "America/Boise by Identity Insights", lineType: "wireless", lineTypeSource: "identity_insights", lineTypeConfidence: "high" });
    expect(platformCalls).toHaveLength(1);
    // The daily allowance (one) is spent: another split line holds and is not looked up.
    const raw3 = JSON.stringify({ ...OUTBOUND, uuid: "call-I3", to: "12083250100" });
    const third = await server.inject({ method: "POST", url: "/v/answer", payload: raw3, headers: { "content-type": "application/json", authorization: signAt(raw3) } });
    expect(third.headers["x-preflight-decision"]).toBe("hold");
    await new Promise((r) => setTimeout(r, 30));
    expect(platformCalls).toHaveLength(1);
    expect(await insights.get("2083250100")).toBeUndefined();
  });

  it("installs and rolls back an application through the Application API from Setup, records both in the ledger, and keeps the secret nowhere", async () => {
    const APP_ID = "0634d503-32c0-4160-be3e-8c31f50e5bd6";
    const origin = { answer: { address: "https://app.example/answer", http_method: "POST" }, event: { address: "https://app.example/event", http_method: "POST" }, fallback: { address: "https://app.example/fallback", http_method: "POST" } };
    let application: Record<string, unknown> = { id: APP_ID, name: "gate1-spike", capabilities: { voice: { signed_callbacks: true, webhooks: { answer_url: origin.answer, event_url: origin.event, fallback_answer_url: origin.fallback } }, rtc: { webhooks: {} } } };
    const platform: Array<{ method: string; auth: string | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(`https://api.nexmo.com/v2/applications/${APP_ID}`)) {
        const method = init?.method ?? "GET";
        platform.push({ method, auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] });
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as { name: string; capabilities: unknown };
          application = { ...application, name: body.name, capabilities: body.capabilities };
        }
        return new Response(JSON.stringify(application), { status: 200 });
      }
      return fetch(url, init);
    }) as typeof fetch;
    const token = "dashboard-token-for-tests-3";
    const ledger = new MemoryLedgerStore();
    const config = loadConfig({ VONAGE_API_KEY: API_KEY, VONAGE_SIGNATURE_SECRET: SECRET, ORIGIN_ANSWER_URL: `${originUrl}/answer`, ORIGIN_TIMEOUT_MS: "200", PUBLIC_BASE_URL: "https://preflight.example", LOG_LEVEL: "silent", DASHBOARD_TOKEN: token });
    const server = buildServer({ config, store: new MemoryEventStore(), decisions: new MemoryDecisionStore(), ledger, graphStore: new MemoryGraphStore(), holds: new MemoryHoldStore(), resolver, declaration: DECLARATION, fetchImpl, now: () => NOW });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const body = { application_id: APP_ID, api_key: "4d4ed5c0", api_secret: "s3cr3t-value", by: "S. Sookra" };
    expect((await server.inject({ method: "POST", url: "/api/setup/install", payload: JSON.stringify(body), headers: { "content-type": "application/json" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/setup/install", payload: JSON.stringify({ ...body, api_secret: "" }), headers })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/api/setup/install", payload: JSON.stringify({ ...body, application_id: "not-a-uuid" }), headers })).statusCode).toBe(400);

    const install = await server.inject({ method: "POST", url: "/api/setup/install", payload: JSON.stringify(body), headers });
    expect(install.statusCode).toBe(200);
    const preflight = { answer: { address: "https://preflight.example/v/answer", http_method: "GET" }, event: { address: "https://preflight.example/v/event", http_method: "POST" }, fallback: { address: "https://preflight.example/v/fallback", http_method: "GET" } };
    expect(install.json()).toMatchObject({ action: "install", application: { id: APP_ID, name: "gate1-spike" }, previous: origin, current: preflight, signed_callbacks: true, ledger: { seq: 1 } });
    expect(install.body).not.toContain("s3cr3t-value");
    const e1 = (await ledger.entries(0, 1))[0];
    expect(e1).toMatchObject({ kind: "setup", detail: { action: "install", application_id: APP_ID, by: "S. Sookra", previous: origin, current: preflight } });
    expect(JSON.stringify(e1)).not.toContain("s3cr3t-value");
    expect(((application["capabilities"] as Record<string, unknown>)["voice"] as Record<string, unknown>)["webhooks"]).toMatchObject({ answer_url: preflight.answer, event_url: preflight.event, fallback_answer_url: preflight.fallback });
    expect((application["capabilities"] as Record<string, unknown>)["rtc"]).toEqual({ webhooks: {} });

    expect((await server.inject({ method: "POST", url: "/api/setup/rollback", payload: JSON.stringify({ ...body, previous: { answer: origin.answer } }), headers })).statusCode).toBe(400);
    const rollback = await server.inject({ method: "POST", url: "/api/setup/rollback", payload: JSON.stringify({ ...body, previous: (install.json() as { previous: unknown }).previous }), headers });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({ action: "rollback", previous: preflight, current: origin, ledger: { seq: 2 } });
    expect(((application["capabilities"] as Record<string, unknown>)["voice"] as Record<string, unknown>)["webhooks"]).toMatchObject({ answer_url: origin.answer });
    expect(platform.map((p) => p.method)).toEqual(["GET", "PUT", "GET", "GET", "PUT", "GET"]);
    expect(platform.every((p) => p.auth === `Basic ${Buffer.from("4d4ed5c0:s3cr3t-value").toString("base64")}`)).toBe(true);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("computes the rate properties from the stored event webhooks and the paths the calls actually ran", async () => {
    const { server } = app({ POLICY_MODE: "advisory" });
    const at = (s: number) => new Date(NOW + s * 1000).toISOString();
    const event = (uuid: string, status: string, s: number, extra: Record<string, unknown> = {}) => post(server, "/v/event", { uuid, conversation_uuid: `CON-${uuid}`, status, direction: "outbound", from: OUTBOUND.from, to: OUTBOUND.to, timestamp: at(s), ...extra });
    // A: a flow that connects a person; answered, detected human, forty seconds of talk.
    served = FLOWS.connectOnly;
    expect((await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-A" })).headers["x-preflight-decision"]).toBe("pass");
    for (const [status, s, extra] of [["started", 0, {}], ["ringing", 0.5, {}], ["answered", 3, {}], ["human", 3.2, {}], ["completed", 43, { duration: "40" }]] as const) expect((await event("call-A", status, s, extra)).statusCode).toBe(204);
    // B: synthetic speech with an opt-out input and no live leg; a person answered and was never connected: abandoned.
    served = FLOWS.syntheticWithOptOut;
    expect((await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-B" })).headers["x-preflight-decision"]).toBe("pass");
    for (const [status, s, extra] of [["ringing", 0, {}], ["answered", 2, {}], ["completed", 10, { duration: "8" }]] as const) expect((await event("call-B", status, s, extra)).statusCode).toBe(204);
    // C rang twenty seconds before the timeout; D was cut off after five.
    for (const [status, s] of [["ringing", 0], ["timeout", 20]] as const) expect((await event("call-C", status, s)).statusCode).toBe(204);
    for (const [status, s] of [["ringing", 0], ["timeout", 5]] as const) expect((await event("call-D", status, s)).statusCode).toBe(204);

    const res = await server.inject({ method: "GET", url: `/api/campaign?since=${encodeURIComponent(at(-3600))}&until=${encodeURIComponent(at(3600))}` });
    expect(res.statusCode).toBe(200);
    const c = res.json() as { events: number; calls: number; outbound: number; answered: number; answeredByPerson: number; abandoned: number; unanswered: number; medianAnsweredDurationSeconds: number; properties: Array<{ id: string; verdict: string; figure: number | null; n: number; basis: string; citation: string }> };
    expect(c).toMatchObject({ events: 12, calls: 4, outbound: 4, answered: 2, answeredByPerson: 2, abandoned: 1, unanswered: 2, medianAnsweredDurationSeconds: 24 });
    expect(c.properties.map((p) => [p.id, p.verdict, p.n])).toEqual([["P6", "false", 2], ["P7", "false", 2], ["P8", "true", 4]]);
    expect(c.properties[0]!.figure).toBe(0.5);
    expect(c.properties[0]!.basis).toContain("1 of 2 calls answered by a person ran no connect");
    expect(c.properties[1]!.basis).toContain("shortest 5.0 s");
    expect(c.properties[2]!.basis).toContain("2 of 4 outbound calls went unanswered (50.0%)");
    // The default window is the last thirty days; a malformed one is refused.
    expect(((await server.inject({ method: "GET", url: "/api/campaign" })).json() as { calls: number }).calls).toBe(4);
    expect((await server.inject({ method: "GET", url: "/api/campaign?since=yesterday" })).statusCode).toBe(400);
  });

  it("serves the push routes only when the VAPID keys are configured, gates subscriptions with the dashboard token, and proves the pipe with a test push", async () => {
    expect((await app().server.inject({ method: "GET", url: "/api/push/vapid" })).statusCode).toBe(404);
    const token = "dashboard-token-for-tests-4";
    const sent: Array<{ endpoint: string; kind: string }> = [];
    const pushSender = async (sub: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: sub.endpoint, kind: (JSON.parse(payload) as { kind: string }).kind });
      return { statusCode: 201 };
    };
    const config = loadConfig({ VONAGE_API_KEY: API_KEY, VONAGE_SIGNATURE_SECRET: SECRET, ORIGIN_ANSWER_URL: `${originUrl}/answer`, ORIGIN_TIMEOUT_MS: "200", PUBLIC_BASE_URL: "https://preflight.example", LOG_LEVEL: "silent", DASHBOARD_TOKEN: token, VAPID_PUBLIC_KEY: "B".repeat(87), VAPID_PRIVATE_KEY: "k".repeat(43), VAPID_SUBJECT: "mailto:ops@example.com" });
    const server = buildServer({ config, store: new MemoryEventStore(), decisions: new MemoryDecisionStore(), ledger: new MemoryLedgerStore(), graphStore: new MemoryGraphStore(), holds: new MemoryHoldStore(), resolver, declaration: DECLARATION, pushSender, now: () => NOW });
    expect((await server.inject({ method: "GET", url: "/api/push/vapid" })).json()).toEqual({ publicKey: "B".repeat(87) });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const sub = { endpoint: "https://push.example/s1", keys: { p256dh: "p", auth: "a" }, expirationTime: null };
    expect((await server.inject({ method: "POST", url: "/api/push/subscribe", payload: JSON.stringify(sub), headers: { "content-type": "application/json" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/push/subscribe", payload: JSON.stringify({ endpoint: "http://insecure.example/s", keys: { p256dh: "p", auth: "a" } }), headers })).statusCode).toBe(400);
    const created = await server.inject({ method: "POST", url: "/api/push/subscribe", payload: JSON.stringify({ subscription: sub, label: "Stephen's phone" }), headers });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ subscribed: true, endpoint: sub.endpoint, subscriptions: 1 });
    expect((await server.inject({ method: "POST", url: "/api/push/test", headers })).json()).toEqual({ attempted: 1, delivered: 1, retired: 0, failed: 0 });
    expect(sent).toEqual([{ endpoint: sub.endpoint, kind: "test" }]);
    expect((await server.inject({ method: "DELETE", url: "/api/push/subscribe", payload: JSON.stringify({ endpoint: sub.endpoint }), headers })).json()).toEqual({ removed: true });
    expect((await server.inject({ method: "POST", url: "/api/push/test", headers })).json()).toEqual({ attempted: 0, delivered: 0, retired: 0, failed: 0 });
  });

  it("serves Setup behind the dashboard token; a replaced declaration is an evidence-log entry the next decision obeys", async () => {
    served = FLOWS.syntheticWithOptOut;
    const off = app();
    expect((await off.server.inject({ method: "GET", url: "/api/setup" })).statusCode).toBe(404);
    const token = "dashboard-token-for-tests-2";
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    // Advisory, because the opt-out input's callback has never been observed and strict policy would hold that open branch.
    const { server, ledger } = app({ DASHBOARD_TOKEN: token, POLICY_MODE: "advisory" });
    expect((await server.inject({ method: "GET", url: "/api/setup" })).statusCode).toBe(403);
    const before = (await server.inject({ method: "GET", url: "/api/setup", headers: auth })).json() as Record<string, unknown>;
    expect(before).toMatchObject({ urls: { answer: "https://preflight.example/v/answer", event: "https://preflight.example/v/event", fallback: "https://preflight.example/v/fallback" }, policy: "advisory", declaration: DECLARATION, declaration_source: "environment", declared_by: null });
    expect(before["declaration_hash"]).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Under the environment's declaration the flow identifies and offers opt-out: it passes.
    expect((await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-S1" })).headers["x-preflight-decision"]).toBe("pass");

    const bad = await server.inject({ method: "PUT", url: "/api/setup/declaration", headers: auth, payload: JSON.stringify({ declaration: { flow: { answer: "talk" } }, by: "S. Sookra" }) });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { issues: string[] }).issues[0]).toContain("flow.answer");
    expect((await server.inject({ method: "PUT", url: "/api/setup/declaration", headers: auth, payload: JSON.stringify({ declaration: DECLARATION }) })).statusCode).toBe(400);
    expect((await server.inject({ method: "PUT", url: "/api/setup/declaration", payload: JSON.stringify({ declaration: DECLARATION, by: "x" }), headers: { "content-type": "application/json" } })).statusCode).toBe(403);

    // A person declares a different identification phrase and the flow they believe they serve.
    const replaced = { identification: { phrases: ["Preflight Demo Clinic calling"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] }, endpoints: ["/webhooks/optout"], flow: { answer: [["talk", "input"]] } };
    const put = await server.inject({ method: "PUT", url: "/api/setup/declaration", headers: auth, payload: JSON.stringify({ declaration: replaced, by: "S. Sookra" }) });
    expect(put.statusCode).toBe(200);
    const view = put.json() as { declaration: unknown; declaration_source: string; declaration_hash: string; declared_by: string; ledger: { seq: number } };
    expect(view).toMatchObject({ declaration: replaced, declaration_source: "stored", declared_by: "S. Sookra", ledger: { seq: 2 } });
    const entry = (await ledger.entries(1, 1))[0];
    expect(entry).toMatchObject({ seq: 2, kind: "declaration", call_uuid: null, decision: null, detail: { declaration_hash: view.declaration_hash, previous_hash: before["declaration_hash"], by: "S. Sookra", endpoints: ["answer", "/webhooks/optout"], identification_phrases: 1 } });
    expect((await ledger.verify()).ok).toBe(true);

    // The same object now speaks before anything that identifies under the new declaration: blocked, no restart needed.
    const after = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-S2" });
    expect(after.headers["x-preflight-decision"]).toBe("block");
    expect((after.json() as Array<{ text: string }>)[0]?.text).toMatch(/47 CFR 64\.1200\(b\)\(1\)|46-5-27\(g\)\(1\)/);
    expect((await ledger.entries(0, 10)).map((e) => e.kind)).toEqual(["pass", "declaration", "block"]);
    expect(((await server.inject({ method: "GET", url: "/api/flow" })).json() as { declared: { endpoints: string[] } }).declared.endpoints).toEqual(["answer", "/webhooks/optout"]);
  });

  it("streams decisions as server-sent events, with a replay of recent ones on connect", async () => {
    served = FLOWS.connectOnly;
    const { server } = app({ DASHBOARD_TOKEN: "dashboard-token-for-tests-1" });
    await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-S1" });
    // The stream carries phone numbers: no token, no stream.
    expect((await server.inject({ method: "GET", url: "/api/stream" })).statusCode).toBe(403);
    expect((await app().server.inject({ method: "GET", url: "/api/stream?token=x" })).statusCode).toBe(404);
    await server.listen({ port: 0, host: "127.0.0.1" });
    try {
      const addr = server.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/stream?replay=5&token=dashboard-token-for-tests-1`, { signal: ac.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body?.getReader();
      let text = "";
      const decoder = new TextDecoder();
      // First chunk carries the retry hint and the replayed decision.
      while (!text.includes("call-S1")) {
        const { value, done } = (await reader?.read()) ?? { value: undefined, done: true };
        if (done) break;
        text += decoder.decode(value);
      }
      expect(text).toContain("retry: 3000");
      expect(text).toContain("event: decision");
      // A new decision arrives live.
      await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-S2" });
      while (!text.includes("call-S2")) {
        const { value, done } = (await reader?.read()) ?? { value: undefined, done: true };
        if (done) break;
        text += decoder.decode(value);
      }
      expect(text).toContain('"callUuid":"call-S2"');
      ac.abort();
    } finally {
      await server.close();
    }
  });

  it("ignores a forged origin on the hook and refuses a node that names no callback", async () => {
    served = FLOWS.syntheticWithOptOut;
    const { server } = app({ POLICY_MODE: "advisory" });
    const first = await post(server, "/v/answer", { ...OUTBOUND, uuid: "call-F1" });
    const hookUrl = new URL((first.json() as Array<{ eventUrl?: string[] }>)[1]?.eventUrl?.[0] ?? "");
    const raw = JSON.stringify({ uuid: "call-F1", dtmf: { digits: "9" } });
    // A forged u parameter changes nothing: the origin is the node's own callback.
    const forged = await server.inject({ method: "POST", url: `${hookUrl.pathname}${hookUrl.search}&u=${Buffer.from("http://127.0.0.1:1/evil").toString("base64url")}`, payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
    expect(forged.statusCode).not.toBe(400);
    expect([200, 204]).toContain(forged.statusCode);
    const unknown = await server.inject({ method: "POST", url: "/v/hook?n=000000000000000000000000&m=POST", payload: raw, headers: { "content-type": "application/json", authorization: sign(raw) } });
    expect(unknown.statusCode).toBe(404);
  });

  it("fails closed with a safe object when the origin exceeds the timeout", async () => {
    const { server, store } = app({ ORIGIN_ANSWER_URL: `${originUrl}/slow` });
    const res = await post(server, "/v/answer", { uuid: "call-8" });
    expect(res.statusCode).toBe(200);
    const ncco = res.json() as Array<{ action: string; text?: string }>;
    expect(ncco[0]?.action).toBe("talk");
    expect(ncco[0]?.text).toContain("stopped by Preflight");
    expect((await store.recent(1))[0]?.decision).toBe("block");
  });

  it("stores every signed event webhook body and acknowledges with 204", async () => {
    const { server, store } = app();
    const res = await post(server, "/v/event", { uuid: "call-9", status: "ringing", direction: "outbound", timestamp: "2026-09-04T00:00:00.000Z" });
    expect(res.statusCode).toBe(204);
    expect((await store.recent(1))[0]).toMatchObject({ kind: "event", callUuid: "call-9", decision: "stored" });
  });

  it("answers a signed fallback webhook with the safe object", async () => {
    const { server } = app();
    const res = await post(server, "/v/fallback", { uuid: "call-10", reason: "answer url timeout" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ action: string }>)[0]?.action).toBe("talk");
  });
});
