import { describe, expect, it } from "vitest";
import { preflightWebhooks, readApplication, sameHooks, viewOf, writeWebhooks, type VoiceWebhooks } from "./application.js";

const ORIGIN: VoiceWebhooks = { answer: { address: "https://app.example/answer", http_method: "POST" }, event: { address: "https://app.example/event", http_method: "POST" }, fallback: { address: "https://app.example/fallback", http_method: "POST" } };
const creds = { applicationId: "0634d503-32c0-4160-be3e-8c31f50e5bd6", apiKey: "4d4ed5c0", apiSecret: "s3cr3t-value" };

/** A stand-in for the Application API: one application whose PUT is stored and read back, with an optional saboteur. */
function fakeApi(opts: { sabotage?: "drop-answer" | "drop-event-method" | "unsigned" | "put-fails" | "get-fails" } = {}) {
  let app: Record<string, unknown> = {
    id: creds.applicationId,
    name: "gate1-spike",
    capabilities: { voice: { signed_callbacks: true, webhooks: { answer_url: { address: ORIGIN.answer.address, http_method: "POST" }, event_url: { address: ORIGIN.event.address, http_method: "POST" }, fallback_answer_url: { address: ORIGIN.fallback.address, http_method: "POST" } } }, rtc: { webhooks: {} } },
    keys: { public_key: "-----BEGIN PUBLIC KEY-----..." },
  };
  const requests: Array<{ method: string; url: string; auth: string | undefined; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method, url: String(url), auth: headers["authorization"], body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") {
      if (opts.sabotage === "get-fails") return new Response(JSON.stringify({ title: "Unauthorized", detail: "bad credentials" }), { status: 401 });
      return new Response(JSON.stringify(app), { status: 200 });
    }
    if (opts.sabotage === "put-fails") return new Response(JSON.stringify({ title: "Bad Request", detail: "answer_url must be https" }), { status: 400 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const caps = structuredClone(body["capabilities"] as Record<string, unknown>);
    const voice = caps["voice"] as Record<string, unknown>;
    if (opts.sabotage === "drop-answer") delete (voice["webhooks"] as Record<string, unknown>)["answer_url"];
    if (opts.sabotage === "drop-event-method") delete ((voice["webhooks"] as Record<string, Record<string, unknown>>)["event_url"] as Record<string, unknown>)["http_method"];
    if (opts.sabotage === "unsigned") voice["signed_callbacks"] = false;
    app = { ...app, name: body["name"], capabilities: caps };
    return new Response(JSON.stringify(app), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests, current: () => app };
}

describe("the Application API install and rollback", () => {
  it("reads the three voice webhooks and the signed-callbacks flag off an application", () => {
    const v = viewOf({ id: "a", name: "n", capabilities: { voice: { signed_callbacks: false, webhooks: { answer_url: { address: "https://x/a", http_method: "GET" }, event_url: { address: "https://x/e", http_method: "POST" }, fallback_answer_url: { address: "https://x/f", http_method: "POST" } } } } });
    expect(v).toEqual({ id: "a", name: "n", signedCallbacks: false, webhooks: { answer: { address: "https://x/a", http_method: "GET" }, event: { address: "https://x/e", http_method: "POST" }, fallback: { address: "https://x/f", http_method: "POST" } } });
    // A hook with no method, or a foreign one, is not a hook: the read-back must carry exactly what was written.
    expect(viewOf({ id: "a", name: "n", capabilities: { voice: { webhooks: { answer_url: { address: "https://x/a", http_method: "GET" }, event_url: { address: "https://x/e" }, fallback_answer_url: { address: "https://x/f", http_method: "GET" } } } } }).webhooks).toBeUndefined();
    expect(viewOf({ id: "a", name: "n", capabilities: { voice: { webhooks: { answer_url: { address: "https://x/a", http_method: "GET" }, event_url: { address: "https://x/e", http_method: "PUT" }, fallback_answer_url: { address: "https://x/f", http_method: "GET" } } } } }).webhooks).toBeUndefined();
    expect(viewOf({ id: "a", name: "n", capabilities: { voice: { webhooks: { answer_url: { address: "https://x/a" } } } } }).webhooks).toBeUndefined();
    expect(preflightWebhooks("https://preflight.example/")).toEqual({ answer: { address: "https://preflight.example/v/answer", http_method: "GET" }, event: { address: "https://preflight.example/v/event", http_method: "POST" }, fallback: { address: "https://preflight.example/v/fallback", http_method: "GET" } });
    expect(sameHooks(ORIGIN, { ...ORIGIN, answer: { ...ORIGIN.answer, http_method: "GET" } })).toBe(false);
    expect(sameHooks(undefined, ORIGIN)).toBe(false);
  });

  it("installs: records the previous hooks, writes Preflight's with signed callbacks on, keeps the other capabilities, and verifies the read-back", async () => {
    const api = fakeApi();
    const before = await readApplication(creds, { fetchImpl: api.fetchImpl });
    expect(before).toMatchObject({ ok: true, view: { name: "gate1-spike", webhooks: ORIGIN, signedCallbacks: true } });
    if (!before.ok) throw new Error("unreachable");
    const target = preflightWebhooks("https://preflight.example");
    const after = await writeWebhooks(creds, before.raw, target, { fetchImpl: api.fetchImpl });
    expect(after).toMatchObject({ ok: true, view: { webhooks: target, signedCallbacks: true } });
    const put = api.requests.find((r) => r.method === "PUT");
    expect(put?.url).toBe(`https://api.nexmo.com/v2/applications/${creds.applicationId}`);
    expect(put?.auth).toBe(`Basic ${Buffer.from("4d4ed5c0:s3cr3t-value").toString("base64")}`);
    const putBody = put?.body as { name: string; capabilities: Record<string, unknown> };
    expect(putBody.name).toBe("gate1-spike");
    expect(putBody.capabilities["rtc"]).toEqual({ webhooks: {} });
    expect((putBody.capabilities["voice"] as Record<string, unknown>)["signed_callbacks"]).toBe(true);
    expect(api.requests.map((r) => r.method)).toEqual(["GET", "PUT", "GET"]);
    // Rollback writes the recorded hooks back and verifies the same way.
    if (!after.ok) throw new Error("unreachable");
    const restored = await writeWebhooks(creds, after.raw, ORIGIN, { fetchImpl: api.fetchImpl });
    expect(restored).toMatchObject({ ok: true, view: { webhooks: ORIGIN } });
  });

  it("reports a platform refusal, a dropped hook on read-back, and signed callbacks that did not stick, instead of claiming success", async () => {
    const target = preflightWebhooks("https://preflight.example");
    const getFails = fakeApi({ sabotage: "get-fails" });
    expect(await readApplication(creds, { fetchImpl: getFails.fetchImpl })).toEqual({ ok: false, status: 401, error: "Unauthorized: bad credentials" });
    for (const [sabotage, status, fragment] of [["put-fails", 400, "answer_url must be https"], ["drop-answer", 502, "does not carry the webhooks"], ["drop-event-method", 502, "does not carry the webhooks"], ["unsigned", 502, "signed callbacks"]] as const) {
      const api = fakeApi({ sabotage });
      const before = await readApplication(creds, { fetchImpl: api.fetchImpl });
      if (!before.ok) throw new Error("unreachable");
      const r = await writeWebhooks(creds, before.raw, target, { fetchImpl: api.fetchImpl });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(status);
        expect(r.error).toContain(fragment);
      }
    }
    const down = (async () => { throw new Error("ENOTFOUND api.nexmo.com"); }) as unknown as typeof fetch;
    expect(await readApplication(creds, { fetchImpl: down })).toMatchObject({ ok: false, status: 0, error: "request failed: ENOTFOUND api.nexmo.com" });
  });
});
