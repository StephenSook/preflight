import { describe, expect, it } from "vitest";
import { lookupIdentityInsights, normalizeInsight } from "./identityInsights.js";
import { NumberFactsResolver } from "./index.js";

/** The shape the platform answered with on 2026-09-04 for +1 943 244 5023 (docs/fact-sheet.md, MEASUREMENTS). */
const LIVE_SHAPE = {
  request_id: "b44c2ea3-d16c-4654-aa59-de69bfa64e4b",
  phone_number: "+19432445023",
  insights: {
    format: { status: "SUCCESS", is_valid: true, international: "+19432445023", time_zones: ["America/New_York"] },
    current_carrier: { status: "NOT_FOUND", status_message: "The phone number may not be assigned to a mobile network." },
    original_carrier: { status: "SUCCESS", name: "Bandwidth.com CLEC LLC", network_type: "LANDLINE", country: "US" },
  },
};

describe("Identity Insights", () => {
  it("reads the time zones, the line type from the current carrier before the original, and the validity flag", () => {
    expect(normalizeInsight(LIVE_SHAPE)).toEqual({ timeZones: ["America/New_York"], lineType: "landline", lineTypeFrom: "original_carrier", carrier: "Bandwidth.com CLEC LLC", valid: true, requestId: "b44c2ea3-d16c-4654-aa59-de69bfa64e4b" });
    const mobile = normalizeInsight({ insights: { format: { location: { time_zones: ["America/Chicago", "America/Chicago"] } }, current_carrier: { carrier: { name: "T-Mobile", network_type: "MOBILE" } }, original_carrier: { network_type: "LANDLINE" } } });
    expect(mobile).toMatchObject({ timeZones: ["America/Chicago", "America/Chicago"], lineType: "wireless", lineTypeFrom: "current_carrier", carrier: "T-Mobile", valid: undefined });
    expect(normalizeInsight({ insights: { format: {} } })).toMatchObject({ timeZones: [], lineType: "unknown", lineTypeFrom: "none", carrier: undefined });
    expect(normalizeInsight("nonsense")).toMatchObject({ timeZones: [], lineType: "unknown" });
    expect(normalizeInsight({ insights: { current_carrier: { network_type: "VIRTUAL" } } }).lineType).toBe("voip");
    // A zone this runtime cannot evaluate is dropped at the door, never cached as a fact.
    expect(normalizeInsight({ insights: { format: { time_zones: ["Not/AZone", "America/Boise", ""] } } }).timeZones).toEqual(["America/Boise"]);
  });

  it("posts one request with the three insights and the application token, and reports failures without throwing", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(LIVE_SHAPE), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await lookupIdentityInsights("19432445023", { host: "https://api-eu.vonage.com/", fetchImpl, token: () => "jwt-1" });
    expect(r).toMatchObject({ ok: true, status: 200, insight: { timeZones: ["America/New_York"], lineType: "landline" } });
    expect(calls[0]?.url).toBe("https://api-eu.vonage.com/identity-insights/v1/requests");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ phone_number: "+19432445023", insights: { format: {}, current_carrier: {}, original_carrier: {} } });
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe("Bearer jwt-1");

    const failing = (async () => new Response(JSON.stringify({ title: "Forbidden", detail: "insights not enabled" }), { status: 403 })) as unknown as typeof fetch;
    expect(await lookupIdentityInsights("19432445023", { host: "https://x", fetchImpl: failing, token: () => "t" })).toMatchObject({ ok: false, status: 403, error: "Forbidden: insights not enabled" });
    const down = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await lookupIdentityInsights("19432445023", { host: "https://x", fetchImpl: down, token: () => "t" })).toMatchObject({ ok: false, status: 0, error: "ECONNRESET" });
  });

  it("overlays a cached insight on the free tables: the platform's zones decide when the prefix cannot, and its carrier outranks the prior", () => {
    const resolver = NumberFactsResolver.load();
    // 208 320: the prefix map lists both America/Boise and America/Los_Angeles; at 14:30Z they disagree (08:30 vs 07:30).
    const at = new Date("2026-09-05T14:30:00Z");
    const bare = resolver.resolve("12083200100", at);
    expect(bare.zones).toEqual(["America/Boise", "America/Los_Angeles"]);
    expect(bare.withinHours).toBeNull();
    expect(bare.hoursBasis).toContain("disagree");
    const insight = { timeZones: ["America/Boise"], lineType: "wireless" as const, lineTypeFrom: "current_carrier" as const, carrier: "Verizon", valid: true, requestId: undefined };
    const overlaid = resolver.resolve("12083200100", at, insight);
    expect(overlaid).toMatchObject({ zones: ["America/Boise"], withinHours: true, hoursBasis: "America/Boise by Identity Insights", lineType: "wireless", lineTypeSource: "identity_insights", lineTypeConfidence: "high" });
    // A single-zone prefix keeps its own zone; the carrier still wins for the line type.
    const atlanta = resolver.resolve("14045550100", at, { ...insight, timeZones: ["America/Chicago"] });
    expect(atlanta.zones).toEqual(["America/New_York"]);
    expect(atlanta.hoursBasis).toContain("by prefix 404");
    expect(atlanta.lineTypeSource).toBe("identity_insights");
    // An insight without a line type leaves the prior in place.
    expect(resolver.resolve("14045550100", at, { ...insight, lineType: "unknown", lineTypeFrom: "none" }).lineTypeSource).toBe("nanpa");
  });

  it("a platform zone can only settle what the prefix left open, and only from the zones the prefix admits", () => {
    const resolver = NumberFactsResolver.load();
    const base = { lineType: "unknown" as const, lineTypeFrom: "none" as const, carrier: undefined, valid: true, requestId: undefined };
    // 12:00Z is 06:00 in Boise and 05:00 in Los Angeles: the split prefix agrees the window is closed. No overlay may open it.
    const closed = new Date("2026-09-05T12:00:00Z");
    for (const zones of [["America/New_York"], ["UTC"], ["America/Boise"]]) {
      const r = resolver.resolve("12083200100", closed, { ...base, timeZones: zones });
      expect(r.withinHours, zones.join()).toBe(false);
      expect(r.hoursBasis).toContain("prefix spans");
    }
    // 14:30Z: the split disagrees. A zone the prefix never assigns does not count; an admissible one decides.
    const open = new Date("2026-09-05T14:30:00Z");
    expect(resolver.resolve("12083200100", open, { ...base, timeZones: ["UTC"] })).toMatchObject({ withinHours: null, zones: ["America/Boise", "America/Los_Angeles"] });
    expect(resolver.resolve("12083200100", open, { ...base, timeZones: ["America/New_York", "America/Los_Angeles"] })).toMatchObject({ withinHours: false, zones: ["America/Los_Angeles"], hoursBasis: "America/Los_Angeles by Identity Insights" });
    expect(resolver.resolve("12083200100", open, { ...base, timeZones: [] }).withinHours).toBeNull();
  });
});
