import { createHmac } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declarationFrom, loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { MemoryDecisionStore } from "./store/decisionStore.js";
import { MemoryLedgerStore } from "./store/ledgerStore.js";
import { MemoryEventStore } from "./store/eventStore.js";
import { MemoryGraphStore } from "./store/graphStore.js";
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
  beforeAll(async () => {
    origin.route({ method: ["GET", "POST"], url: "/answer", handler: async (_req, reply) => { originHits += 1; return reply.type("application/json").send(served); } });
    origin.route({ method: ["GET", "POST"], url: "/question", handler: async (_req, reply) => (servedQuestion.length === 0 ? reply.code(204).send() : reply.type("application/json").send(servedQuestion)) });
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
      PUBLIC_BASE_URL: "https://preflight.example",
      LOG_LEVEL: "silent",
      ...overrides,
    });
    const store = new MemoryEventStore();
    const decisions = new MemoryDecisionStore();
    const ledger = new MemoryLedgerStore();
    const graphStore = new MemoryGraphStore();
    const declaration = config.FLOW_DECLARATION_JSON ? declarationFrom(config) : DECLARATION;
    return { server: buildServer({ config, store, decisions, ledger, graphStore, resolver, declaration, now: () => NOW }), store, decisions, ledger, graphStore };
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
    expect(Buffer.from(hook.searchParams.get("u") ?? "", "base64url").toString()).toBe("https://origin.example/webhooks/optout");
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
    const server = buildServer({ config, store: new MemoryEventStore(), decisions, ledger: new MemoryLedgerStore(), graphStore: new MemoryGraphStore(), resolver, declaration: DECLARATION, now: () => lateNight });
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
