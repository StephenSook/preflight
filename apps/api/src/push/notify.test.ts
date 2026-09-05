import { describe, expect, it } from "vitest";
import type { Hold } from "../store/holdStore.js";
import { MemoryPushStore } from "../store/pushStore.js";
import { PushNotifier, type PushSender } from "./notify.js";

const vapid = { subject: "mailto:test@example.com", publicKey: "pub", privateKey: "priv" };
const T0 = Date.parse("2026-09-05T16:00:00Z");
const hold: Hold = { holdId: "hold-1", callUuid: undefined, humanParty: "14042010000", reason: "P3: the path continues through input#1, whose continuation has not been observed yet", verdicts: [{ id: "P3", citation: "47 CFR 64.1200(b)(3)", verdict: "inconclusive", reason: "the path continues through input#1, whose continuation has not been observed yet" }], status: "open", createdAt: new Date(T0).toISOString(), decidedBy: undefined, decidedAt: undefined };

describe("held-queue push notifications", () => {
  it("names the hold with a masked number, the first inconclusive property, and the row's link", () => {
    const n = new PushNotifier({ store: new MemoryPushStore(), vapid, dashboardBaseUrl: "https://preflight.example/", now: () => T0 });
    expect(n.holdPayload(hold)).toEqual({ title: "Held: xxxxxxx0000", body: "P3 inconclusive: the path continues through input#1, whose continuation has not been observed yet", url: "https://preflight.example/held/hold-1", tag: "hold-hold-1", kind: "hold" });
    expect(n.publicKey).toBe("pub");
  });

  it("broadcasts to every subscription, retires the ones the push service no longer serves, and records other failures", async () => {
    const store = new MemoryPushStore();
    await store.upsert({ endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } }, "phone", new Date(T0).toISOString());
    await store.upsert({ endpoint: "https://push.example/gone", keys: { p256dh: "p", auth: "a" } }, undefined, new Date(T0).toISOString());
    await store.upsert({ endpoint: "https://push.example/flaky", keys: { p256dh: "p", auth: "a" } }, undefined, new Date(T0).toISOString());
    const sent: Array<{ endpoint: string; payload: unknown }> = [];
    const send: PushSender = async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (sub.endpoint.endsWith("/flaky")) throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
      return { statusCode: 201 };
    };
    const n = new PushNotifier({ store, vapid, dashboardBaseUrl: "https://preflight.example", send, now: () => T0 });
    const report = await n.broadcast(n.holdPayload(hold));
    expect(report).toEqual({ attempted: 3, delivered: 1, retired: 1, failed: 1 });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/a", "https://push.example/gone", "https://push.example/flaky"]);
    expect(sent[0]?.payload).toMatchObject({ title: "Held: xxxxxxx0000", kind: "hold" });
    const rows = await store.list();
    expect(rows.map((r) => r.endpoint)).toEqual(["https://push.example/a", "https://push.example/flaky"]);
    expect(rows.find((r) => r.endpoint.endsWith("/a"))).toMatchObject({ lastSentAt: new Date(T0).toISOString(), lastError: undefined });
    expect(rows.find((r) => r.endpoint.endsWith("/flaky"))?.lastError).toBe("429: Too Many Requests");
  });

  it("holdCreated never throws to its caller, even when the store fails", async () => {
    const store = new MemoryPushStore();
    store.list = async () => { throw new Error("db down"); };
    const n = new PushNotifier({ store, vapid, dashboardBaseUrl: "https://preflight.example", send: async () => ({ statusCode: 201 }), now: () => T0 });
    expect(() => n.holdCreated(hold)).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });
});
