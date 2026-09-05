import { createVerify, generateKeyPairSync } from "node:crypto";
import { NumberFactsResolver } from "@preflight/numfacts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { MemoryDecisionStore } from "../store/decisionStore.js";
import { MemoryEventStore } from "../store/eventStore.js";
import { MemoryGraphStore } from "../store/graphStore.js";
import { MemoryHoldStore } from "../store/holdStore.js";
import { MemoryLedgerStore } from "../store/ledgerStore.js";

const resolver = NumberFactsResolver.load();
const NOW = Date.parse("2026-09-05T16:00:00Z");
const APP_ID = "0634d503-32c0-4160-be3e-8c31f50e5bd6";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
const VONAGE = "https://vonage.test";

function decode(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; valid: boolean } {
  const [h, p, s] = token.split(".") as [string, string, string];
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(p, "base64url").toString()), valid: verifier.verify(PUBLIC_PEM, Buffer.from(s, "base64url")) };
}

describe("the browser softphone's user tokens", () => {
  const users: Array<{ name: string; auth: string | undefined }> = [];
  /** When set, the platform cannot be reached: fetch rejects the way undici does. */
  let platformDown = false;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === `${VONAGE}/v1/users`) {
      if (platformDown) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init?.body)) as { name: string };
      users.push({ name: body.name, auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] });
      const seen = users.filter((u) => u.name === body.name).length;
      return new Response(JSON.stringify(seen > 1 ? { title: "Conflict" } : { id: "USR-1", name: body.name }), { status: seen > 1 ? 409 : 201 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
  /** `privateKey: null` builds a deployment without the application key. */
  const build = (over: Record<string, string> = {}, privateKey: string | null = PRIVATE_PEM) => {
    const config = loadConfig({ VONAGE_API_KEY: "k", VONAGE_SIGNATURE_SECRET: "s", VONAGE_APPLICATION_ID: APP_ID, VONAGE_API_HOST: VONAGE, PUBLIC_BASE_URL: "https://preflight.example", ORIGIN_ANSWER_URL: "https://origin.example/answer", LOG_LEVEL: "silent", SOFTPHONE_TOKENS_PER_DAY: "2", ...over });
    return buildServer({ config, store: new MemoryEventStore(), decisions: new MemoryDecisionStore(), ledger: new MemoryLedgerStore(), graphStore: new MemoryGraphStore(), holds: new MemoryHoldStore(), resolver, declaration: {}, fetchImpl, now: () => NOW, applicationPrivateKeyPem: privateKey ?? undefined });
  };

  it("mints a judge token signed by the application key with a subject and the Client SDK ACL, after creating the user once", async () => {
    const server = build();
    const res = await server.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "judge" }), headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { role: string; user: string; token: string; expires_at: string; created: boolean };
    expect(body).toMatchObject({ role: "judge", created: true, expires_at: new Date(NOW + 30 * 60 * 1000).toISOString() });
    expect(body.user).toMatch(/^judge-[0-9a-f]{8}$/);
    const t = decode(body.token);
    expect(t.valid).toBe(true);
    expect(t.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(t.claims).toMatchObject({ application_id: APP_ID, sub: body.user, iat: NOW / 1000, exp: NOW / 1000 + 1800, acl: { paths: expect.objectContaining({ "/*/sessions/**": {}, "/*/legs/**": {} }) } });
    // The user was created with an application token, not the user's own.
    expect(users).toHaveLength(1);
    expect(decode(String(users[0]?.auth).replace(/^Bearer /, "")).claims["sub"]).toBeUndefined();
    // An empty body means a judge.
    expect((await server.inject({ method: "POST", url: "/api/softphone/token", headers: { "content-type": "application/json" }, payload: "" })).statusCode).toBe(201);
    // The daily cap (two here) holds; a stranger cannot mint the scheduler's token.
    expect((await server.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "judge" }), headers: { "content-type": "application/json" } })).statusCode).toBe(429);
    // Overlapping requests against a fresh cap of two mint exactly two, however many are in flight at once.
    const fresh = build();
    const usersBefore = users.length;
    const burst = await Promise.all(Array.from({ length: 8 }, () => fresh.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "judge" }), headers: { "content-type": "application/json" } })));
    expect(burst.map((r) => r.statusCode).sort()).toEqual([201, 201, 429, 429, 429, 429, 429, 429]);
    // A spent day never reaches the platform: exactly two users were created for the two tokens.
    expect(users.length - usersBefore).toBe(2);
    // An unreachable platform is a 502, not a crash, and gives the slot back: the day still issues its two.
    const again = build();
    platformDown = true;
    try {
      const down = await again.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "judge" }), headers: { "content-type": "application/json" } });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toMatchObject({ platform_status: 0, error: expect.stringContaining("fetch failed") });
    } finally {
      platformDown = false;
    }
    const after = await Promise.all(Array.from({ length: 3 }, () => again.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "judge" }), headers: { "content-type": "application/json" } })));
    expect(after.map((r) => r.statusCode).sort()).toEqual([201, 201, 429]);
    expect((await server.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "scheduler" }), headers: { "content-type": "application/json" } })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "pilot" }), headers: { "content-type": "application/json" } })).statusCode).toBe(400);
  });

  it("mints the scheduler's token only with the dashboard token, treating an existing user as present", async () => {
    const server = build({ DASHBOARD_TOKEN: "dashboard-token-for-tests-5", REFERENCE_AGENT: "scheduler" });
    const headers = { "content-type": "application/json", authorization: "Bearer dashboard-token-for-tests-5" };
    expect((await server.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "scheduler" }), headers: { "content-type": "application/json", authorization: "Bearer wrong" } })).statusCode).toBe(403);
    const first = await server.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "scheduler" }), headers });
    expect(first.json()).toMatchObject({ role: "scheduler", user: "scheduler", created: true });
    const second = await server.inject({ method: "POST", url: "/api/softphone/token", payload: JSON.stringify({ role: "scheduler" }), headers });
    expect(second.json()).toMatchObject({ role: "scheduler", user: "scheduler", created: false });
    expect(decode((second.json() as { token: string }).token).claims["sub"]).toBe("scheduler");
  });

  it("answers 404 without the application private key, and swallows RTC events without storing them", async () => {
    const server = build({}, null);
    expect((await server.inject({ method: "POST", url: "/api/softphone/token", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: "/v/rtc", payload: JSON.stringify({ type: "rtc:hangup" }), headers: { "content-type": "application/json" } })).statusCode).toBe(204);
    expect((await server.inject({ method: "GET", url: "/v/rtc" })).statusCode).toBe(204);
  });
});
