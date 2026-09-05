import { describe, expect, it } from "vitest";
import { MemoryInsightStore } from "../store/insightStore.js";
import { InsightLookups } from "./lookups.js";

const T0 = Date.parse("2026-09-05T15:00:00Z");
const answer = (zones: string[], networkType?: string) => new Response(JSON.stringify({ request_id: "r", insights: { format: { time_zones: zones }, current_carrier: networkType ? { network_type: networkType } : {} } }), { status: 200 });

describe("the Identity Insights lookup queue", () => {
  it("reserves the line and the day's allowance before any await, so overlapping holds cannot double-spend", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return answer(["America/Boise"], "MOBILE");
    }) as unknown as typeof fetch;
    const store = new MemoryInsightStore();
    const q = new InsightLookups({ store, host: "https://x", fetchImpl, token: () => "t", perDay: 1, now: () => T0 });
    const results = await Promise.all([q.enqueue("12083200100"), q.enqueue("+1 208 320 0100"), q.enqueue("12083250100")]);
    expect(results.filter((r) => r === "scheduled")).toHaveLength(1);
    expect(results[1]).toBe("inflight");
    expect(results).toContain("allowance");
    await q.settled();
    expect(calls).toBe(1);
    const looked = (await store.get("2083200100")) ?? (await store.get("2083250100"));
    expect(looked).toMatchObject({ status: "ok", insight: { timeZones: ["America/Boise"], lineType: "wireless" } });
    // The allowance is spent for the day; the cached line answers from the cache.
    const cachedLine = looked?.line === "2083200100" ? "12083200100" : "12083250100";
    expect(await q.enqueue(cachedLine)).toBe("cached");
    expect(await q.enqueue("12082345678")).toBe("allowance");
    expect(await q.enqueue("not a number")).toBe("unsupported");
  });

  it("a 200 without a usable zone or line type is recorded as an error with a cool-down, never as an empty fact", async () => {
    const fetchImpl = (async () => answer(["Not/AZone"])) as unknown as typeof fetch;
    const store = new MemoryInsightStore();
    let now = T0;
    const q = new InsightLookups({ store, host: "https://x", fetchImpl, token: () => "t", perDay: 5, now: () => now });
    expect(await q.enqueue("12083200100")).toBe("scheduled");
    await q.settled();
    expect(await store.get("2083200100")).toMatchObject({ status: "error", httpStatus: 200, error: expect.stringContaining("usable") });
    expect(await q.cached("12083200100")).toBeUndefined();
    expect(await q.enqueue("12083200100")).toBe("cooling");
    expect((await q.status("12083200100")).state).toBe("error");
    now = T0 + 7 * 3600_000;
    expect(await q.enqueue("12083200100")).toBe("scheduled");
    await q.settled();
  });

  it("a platform failure is recorded with its status and the queue is empty afterwards", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ title: "Forbidden", detail: "not enabled" }), { status: 403 })) as unknown as typeof fetch;
    const store = new MemoryInsightStore();
    const q = new InsightLookups({ store, host: "https://x", fetchImpl, token: () => "t", perDay: 5, now: () => T0 });
    expect(await q.enqueue("12083200100")).toBe("scheduled");
    expect((await q.status("12083200100")).state).toBe("pending");
    await q.settled();
    expect(await store.get("2083200100")).toMatchObject({ status: "error", httpStatus: 403, error: "Forbidden: not enabled" });
    expect((await q.status("12083200100")).state).toBe("error");
  });
});
