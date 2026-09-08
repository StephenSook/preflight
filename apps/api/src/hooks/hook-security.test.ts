import { createHmac } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { MemoryDecisionStore } from "../store/decisionStore.js";
import { MemoryEventStore } from "../store/eventStore.js";
import { callContextFor, callPathFor, MemoryGraphStore, rememberCallPath } from "../store/graphStore.js";
import { MemoryHoldStore } from "../store/holdStore.js";
import { MemoryLedgerStore } from "../store/ledgerStore.js";
import { sha256Hex } from "../vonage/verifyWebhook.js";

const NOW = Date.parse("2026-09-04T16:00:00Z");
const SECRET = "hook-test-signature";
const resolver = NumberFactsResolver.load();
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

function sign(raw: string, jti = "hook-test"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({ iat: NOW / 1000, jti, iss: "Vonage", api_key: "hook-key", payload_hash: sha256Hex(raw) });
  return `Bearer ${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

function fixture() {
  const graphStore = new MemoryGraphStore();
  const decisions = new MemoryDecisionStore();
  const hits: string[] = [];
  let response = "";
  const branch = (name: string) => JSON.stringify([{ action: "input", type: ["dtmf"], eventUrl: [`https://origin.example/${name}`] }]);
  const server = buildServer({
    config: loadConfig({ VONAGE_API_KEY: "hook-key", VONAGE_SIGNATURE_SECRET: SECRET, ORIGIN_ANSWER_URL: "https://origin.example/answer", PUBLIC_BASE_URL: "https://preflight.example", POLICY_MODE: "advisory", LOG_LEVEL: "silent" }),
    graphStore, decisions, store: new MemoryEventStore(), ledger: new MemoryLedgerStore(), holds: new MemoryHoldStore(), resolver, declaration: {}, now: () => NOW,
    fetchImpl: async (input) => {
      hits.push(String(input));
      return new Response(response || null, { status: response ? 200 : 204, headers: { "content-type": "application/json" } });
    },
  });
  servers.push(server);
  const post = (url: string, payload: Record<string, unknown>, jti?: string) => {
    const raw = JSON.stringify(payload);
    return server.inject({ method: "POST", url, payload: raw, headers: { "content-type": "application/json", authorization: sign(raw, jti) } });
  };
  const hookOf = (body: string) => {
    const hook = new URL((JSON.parse(body) as Array<{ eventUrl: string[] }>)[0]!.eventUrl[0]!);
    return hook.pathname + hook.search;
  };
  const answer = async (uuid: string, conversation: string, name = uuid) => {
    response = branch(name);
    const result = await post("/v/answer", { uuid, conversation_uuid: conversation, from_user: "test-user", endpoint_type: "app", to: "14045550100" });
    expect(result.headers["x-preflight-decision"]).toBe("pass");
    response = "";
    return hookOf(result.body);
  };
  return { server, graphStore, decisions, hits, post, answer, hookOf, next: (name: string) => { response = branch(name); } };
}

describe("branch callback authorization before origin forwarding", () => {
  it.each([undefined, null, "", 123])("refuses an answer without a usable signed call UUID (%j)", async (uuid) => {
    const test = fixture();
    expect((await test.post("/v/answer", { uuid, conversation_uuid: "conversation-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("allows only one simultaneous answer per call, even with different JWT ids", async () => {
    const test = fixture();
    test.next("call-A");
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => test.post("/v/answer", { uuid: "call-A", from_user: "test-user", endpoint_type: "app", to: "14045550100" }, `answer-${index}`)));
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1);
    expect(results.filter((result) => result.statusCode === 403)).toHaveLength(7);
    expect(test.hits).toEqual(["https://origin.example/answer"]);
  });

  it("refuses UUID-null timeout replay on a returning menu and preserves the next distinct event", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.next("call-A");
    const timeout = { uuid: null, conversation_uuid: "conversation-A", dtmf: { digits: "", timed_out: true }, speech: { results: [] }, timestamp: "2026-09-04T16:00:00Z" };
    const first = await test.post(hook, timeout);
    expect(first.statusCode).toBe(200);
    test.hits.length = 0;
    expect((await test.post(test.hookOf(first.body), timeout, "timeout-retry")).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
    expect((await test.post(test.hookOf(first.body), { ...timeout, timestamp: "2026-09-04T16:00:10Z" })).statusCode).toBe(200);
  });

  it("refuses a replayed answer before it can rearm a consumed branch", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    expect((await test.post(hook, { uuid: "call-A" })).statusCode).toBe(204);
    expect((await test.post(hook, { uuid: "call-A" })).statusCode).toBe(403);
    test.next("call-A");
    test.hits.length = 0;
    expect((await test.post("/v/answer", { uuid: "call-A", conversation_uuid: "conversation-A", from_user: "test-user", endpoint_type: "app", to: "14045550100" }, "resigned-answer")).statusCode).toBe(403);
    expect((await test.post(hook, { uuid: "call-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("refuses a repeated signed event even when the callback returns the same menu", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.next("call-A");
    const payload = { uuid: "call-A", dtmf: { digits: "1", timed_out: false } };
    const first = await test.post(hook, payload);
    expect(first.statusCode).toBe(200);
    const repeatedMenu = test.hookOf(first.body);
    const second = await test.post(repeatedMenu, { uuid: "call-A", dtmf: { digits: "2", timed_out: false } });
    expect(second.statusCode).toBe(200);
    expect(test.hookOf(second.body)).toBe(repeatedMenu);
    test.hits.length = 0;
    expect((await test.post(repeatedMenu, { dtmf: { timed_out: false, digits: "2" }, uuid: "call-A" }, "resigned-event")).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
    expect((await test.post(repeatedMenu, { uuid: "call-A", dtmf: { digits: "3", timed_out: false } })).statusCode).toBe(200);
  });

  it("rechecks timeout conversation uniqueness when claiming after path lookup", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "shared");
    const callPath = test.graphStore.callPath.bind(test.graphStore);
    vi.spyOn(test.graphStore, "callPath").mockImplementationOnce(async (uuid) => {
      await rememberCallPath(test.graphStore, { callUuid: "call-B", conversationUuid: "shared" }, ["other"]);
      return callPath(uuid);
    });
    test.hits.length = 0;
    expect((await test.post(hook, { uuid: null, conversation_uuid: "shared" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("refuses a signed different leg at a captured, valid node-stamped URL", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    await test.answer("call-B", "conversation-B");
    test.hits.length = 0;
    expect((await test.post(hook, { uuid: "call-B", conversation_uuid: "conversation-B" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("refuses an explicit unknown UUID even with a known conversation", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.hits.length = 0;
    expect((await test.post(hook, { uuid: "unknown", conversation_uuid: "conversation-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("refuses a forged node stamp before forwarding", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.hits.length = 0;
    expect((await test.post(hook.replace(/s=[^&]+/, "s=forged"), { uuid: "call-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("supports the measured UUID-null timeout with no numbers, preserving answer context", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.hits.length = 0;
    const result = await test.post(hook, { uuid: null, conversation_uuid: "conversation-A", dtmf: { digits: "", timed_out: true }, speech: { results: [] }, timestamp: "2026-09-04T16:00:00Z" });
    expect(result.statusCode).toBe(204);
    expect(test.hits).toEqual(["https://origin.example/call-A"]);
    expect((await test.decisions.recent(1))[0]).toMatchObject({ source: "webhook", callUuid: "call-A", conversationUuid: "conversation-A", direction: "inbound", humanParty: "test-user", toNumber: "14045550100" });
  });

  it("refuses UUID-null ambiguity even when both legs have the identical branch", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "shared", "same");
    await test.answer("call-B", "shared", "same");
    test.hits.length = 0;
    expect((await test.post(hook, { uuid: null, conversation_uuid: "shared" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
    expect((await test.post(hook, { uuid: "call-A", conversation_uuid: "shared" })).statusCode).toBe(204);
  });

  it("requires the current pending branch, not an earlier branch in the path", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.next("next");
    const continuation = await test.post(hook, { uuid: "call-A", conversation_uuid: "conversation-A" });
    expect(continuation.statusCode).toBe(200);
    test.hits.length = 0;
    expect((await test.post(hook, { uuid: "call-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
    expect((await test.post(test.hookOf(continuation.body), { uuid: "call-A" })).statusCode).toBe(200);
  });

  it("does not authorize the completed branch again after an empty terminal callback", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    expect((await test.post(hook, { uuid: null, conversation_uuid: "conversation-A" })).statusCode).toBe(204);
    test.hits.length = 0;
    expect((await test.post(hook, { uuid: "call-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it.each(["", 123, false, {}])("refuses malformed explicit UUID %j rather than falling back", async (uuid) => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.hits.length = 0;
    expect((await test.post(hook, { uuid, conversation_uuid: "conversation-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("refuses a callback without a known call or conversation", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.hits.length = 0;
    expect((await test.post(hook, {})).statusCode).toBe(403);
    expect((await test.post(hook, { uuid: null, conversation_uuid: "unknown" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("refuses a multibyte forged stamp without throwing", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.hits.length = 0;
    expect((await test.post(hook.replace(/s=[^&]+/, `s=${encodeURIComponent("é".repeat(32))}`), { uuid: "call-A" })).statusCode).toBe(403);
    expect(test.hits).toEqual([]);
  });

  it("forwards at most one of simultaneous callbacks for the same pending branch", async () => {
    const test = fixture();
    const hook = await test.answer("call-A", "conversation-A");
    test.hits.length = 0;
    const results = await Promise.all(Array.from({ length: 8 }, () => test.post(hook, { uuid: "call-A" })));
    expect(results.filter((result) => result.statusCode === 204)).toHaveLength(1);
    expect(results.filter((result) => result.statusCode === 403)).toHaveLength(7);
    expect(test.hits).toEqual(["https://origin.example/call-A"]);
  });
});

describe("call path and context resolution", () => {
  it("keeps answer claims across path writes and scopes event replay claims to the call", async () => {
    const store = new MemoryGraphStore();
    expect(await store.claimAnswer("A")).toBe(true);
    await store.setCallPath("A", ["branch"]);
    expect(await store.claimAnswer("A")).toBe(false);
    expect(await store.claimBranch("A", "wrong", undefined, "event")).toBe(false);
    expect(await store.claimBranch("A", "branch", undefined, "event")).toBe(true);
    await store.setCallPath("A", ["branch", "branch"]);
    expect(await store.claimBranch("A", "branch", undefined, "event")).toBe(false);
    expect(await store.claimBranch("A", "branch", undefined, "next-event")).toBe(true);
    await store.setCallPath("B", ["branch"]);
    expect(await store.claimBranch("B", "branch", undefined, "event")).toBe(true);
  });

  it.each(["hold", "block"] as const)("does not arm a %s path that was not served to the call", async (decision) => {
    const store = new MemoryGraphStore();
    const record = { callUuid: "refused", decision };
    await rememberCallPath(store, record, ["branch"]);
    expect(await store.claimBranch("refused", "branch")).toBe(false);
  });

  it("never falls back after an explicit UUID miss, including a context-only miss", async () => {
    const store = new MemoryGraphStore();
    await rememberCallPath(store, { callUuid: "known", conversationUuid: "conversation" }, ["branch"], { from_user: "known-user" });
    await store.setCallPath("no-context", ["other"]);
    expect(await callPathFor(store, { callUuid: "unknown", conversationUuid: "conversation" })).toBeUndefined();
    expect(await callContextFor(store, { callUuid: "unknown", conversationUuid: "conversation" })).toBeUndefined();
    expect(await callContextFor(store, { callUuid: "no-context", conversationUuid: "conversation" })).toBeUndefined();
  });

  it("keeps ambiguous conversations refused after later writes by either leg", async () => {
    const store = new MemoryGraphStore();
    await Promise.all(["A", "B"].map((callUuid) => rememberCallPath(store, { callUuid, conversationUuid: "shared" }, [callUuid], { from_user: callUuid })));
    await rememberCallPath(store, { callUuid: "A", conversationUuid: "shared" }, ["new-A"]);
    expect(await callPathFor(store, { conversationUuid: "shared" })).toBeUndefined();
    expect(await callContextFor(store, { conversationUuid: "shared" })).toBeUndefined();
    expect(await callPathFor(store, { callUuid: "B" })).toEqual(["B"]);
  });

  it("does not trust legacy conversation aliases without leg membership", async () => {
    const store = new MemoryGraphStore();
    await store.setCallPath("legacy-conversation", ["branch"], { from_user: "legacy" });
    expect(await callPathFor(store, { conversationUuid: "legacy-conversation" })).toBeUndefined();
    expect(await callContextFor(store, { conversationUuid: "legacy-conversation" })).toBeUndefined();
  });
});
