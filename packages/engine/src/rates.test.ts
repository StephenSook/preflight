import { describe, expect, it } from "vitest";
import { campaignRates, telemetryFromEvents, type CallTelemetry, type EventLike } from "./rates.js";

const T0 = Date.parse("2026-09-05T15:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const call = (over: Partial<CallTelemetry>): CallTelemetry => ({ uuid: "c", conversationUuid: undefined, direction: "outbound", outcome: "completed", pathHasConnect: false, otherLegAnswered: false, connectLeg: false, ...over });
/** An answered call whose connect really produced an answered leg. */
const connected = (over: Partial<CallTelemetry>): CallTelemetry => call({ answeredAt: iso(5), endedAt: iso(40), durationSeconds: 35, detected: "human", pathHasConnect: true, otherLegAnswered: true, ...over });

describe("rate properties over event telemetry", () => {
  it("P6 divides by ended calls answered by a person, never by dials or by machines, and a connect counts only with an answered leg", () => {
    const calls = [
      connected({ uuid: "a" }),
      connected({ uuid: "b" }),
      call({ uuid: "c", answeredAt: iso(5), endedAt: iso(20), durationSeconds: 15, detected: "machine" }), // machine: out of the denominator, not abandoned
      call({ uuid: "d", answeredAt: iso(5), endedAt: iso(9), durationSeconds: 4 }), // no detection: counts as a person, and it is abandoned
      call({ uuid: "p", answeredAt: iso(5), endedAt: iso(30), durationSeconds: 25, detected: "human", pathHasConnect: true, otherLegAnswered: false }), // a connect on the path that never answered: abandoned
      call({ uuid: "e", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" }), // unanswered: not in the denominator
      call({ uuid: "f", direction: "inbound", answeredAt: iso(1) }), // inbound: not a dial
      call({ uuid: "g", answeredAt: iso(2), outcome: undefined }), // still in progress: not counted yet
    ];
    const r = campaignRates(calls);
    expect(r).toMatchObject({ calls: 8, outbound: 6, inProgress: 1, answered: 5, answeredByPerson: 4, machineAnswered: 1, abandoned: 2, unanswered: 1 });
    const p6 = r.properties[0]!;
    expect(p6).toMatchObject({ id: "P6", verdict: "false", n: 4, unit: "fraction", figure: 0.5 });
    expect(p6.basis).toContain("2 of 4 ended calls answered by a person");
    expect(p6.basis).toContain("1 had a connect on the path and no answered leg");
    expect(p6.basis).toContain("1 machine-answered");
    expect(p6.basis).toContain("1 answered call(s) had no machine detection");
    // Under the safe harbour: 1 abandoned in 40 person-answered calls is 2.5%.
    const many = [...Array.from({ length: 39 }, (_, i) => connected({ uuid: `p${i}` })), call({ uuid: "x", answeredAt: iso(5), detected: "human" })];
    expect(campaignRates(many).properties[0]).toMatchObject({ verdict: "true", n: 40 });
    expect(campaignRates(many).properties[0]!.figure).toBeCloseTo(0.025, 6);
  });

  it("P6, P7 and P8 are inconclusive without their denominators, never guessed", () => {
    const r = campaignRates([call({ uuid: "e", ringingAt: iso(0), outcome: "timeout" })]);
    expect(r.properties[0]).toMatchObject({ id: "P6", verdict: "inconclusive", figure: null, n: 0 });
    expect(r.properties[1]).toMatchObject({ id: "P7", verdict: "inconclusive", n: 0 }); // no end time, so no ring time
    expect(r.properties[2]).toMatchObject({ id: "P8", verdict: "inconclusive", figure: null }); // no talk time: the twelve-second line cannot be judged
    expect(r.properties[2]!.basis).toContain("1 of 1 ended outbound calls went unanswered (100.0%)");
    expect(campaignRates([]).properties.map((p) => p.verdict)).toEqual(["inconclusive", "inconclusive", "inconclusive"]);
    // Ten timeouts and nothing answered is not a pass on the twelve-second line.
    expect(campaignRates(Array.from({ length: 10 }, (_, i) => call({ uuid: `t${i}`, ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" }))).properties[2]!.verdict).toBe("inconclusive");
  });

  it("P7 fails when any rung-out call was disconnected before fifteen seconds of ringing, and ignores busy, rejected and failed legs", () => {
    const ok = campaignRates([call({ uuid: "a", ringingAt: iso(0), endedAt: iso(16), outcome: "timeout" }), call({ uuid: "b", ringingAt: iso(0), endedAt: iso(30), outcome: "unanswered" })]);
    expect(ok.properties[1]).toMatchObject({ id: "P7", verdict: "true", n: 2, figure: 0 });
    const short = campaignRates([call({ uuid: "a", ringingAt: iso(0), endedAt: iso(14.9), outcome: "timeout" }), call({ uuid: "b", ringingAt: iso(0), endedAt: iso(30), outcome: "cancelled" })]);
    expect(short.properties[1]).toMatchObject({ id: "P7", verdict: "false", n: 2, figure: 0.5 });
    expect(short.properties[1]!.basis).toContain("shortest 14.9 s");
    // A busy line, a rejected or a failed leg ended by the network is not a ring the dialer cut short.
    expect(campaignRates([call({ uuid: "c", ringingAt: iso(0), endedAt: iso(1.1), outcome: "busy" }), call({ uuid: "d", ringingAt: iso(0), endedAt: iso(2), outcome: "failed" }), call({ uuid: "e", ringingAt: iso(0), endedAt: iso(2), outcome: "rejected" })]).properties[1]!.verdict).toBe("inconclusive");
    // A ring time that is not positive (an end recorded before the ringing) is excluded, never a violation.
    expect(campaignRates([call({ uuid: "f", ringingAt: iso(10), endedAt: iso(5), outcome: "timeout" })]).properties[1]!.verdict).toBe("inconclusive");
  });

  it("P8 judges the median talk time in seconds and only reports the unanswered share", () => {
    const shortTalk = campaignRates([
      call({ uuid: "a", answeredAt: iso(2), endedAt: iso(8), durationSeconds: 6 }),
      call({ uuid: "b", answeredAt: iso(2), endedAt: iso(12), durationSeconds: 10 }),
      call({ uuid: "c", answeredAt: iso(2), endedAt: iso(30), durationSeconds: 28 }),
      call({ uuid: "d", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" }),
    ]);
    expect(shortTalk.medianAnsweredDurationSeconds).toBe(10);
    expect(shortTalk.properties[2]).toMatchObject({ id: "P8", verdict: "false", n: 3, figure: 10, unit: "seconds" });
    expect(shortTalk.properties[2]!.basis).toContain("median talk time 10.0 s over 3 answered call(s)");
    expect(shortTalk.properties[2]!.basis).toContain("1 of 4 ended outbound calls went unanswered (25.0%)");
    const longTalk = campaignRates([call({ uuid: "a", answeredAt: iso(2), durationSeconds: 40 }), call({ uuid: "b", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" }), call({ uuid: "c", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" })]);
    expect(longTalk.properties[2]).toMatchObject({ verdict: "true", figure: 40 });
    expect(longTalk.properties[2]!.basis).toContain("not judged");
  });

  it("folds the platform's event webhooks into per-call telemetry whatever their order of receipt, and proves a connect by an answered leg in the same conversation", () => {
    const ev = (uuid: string, status: string, at: string | undefined, extra: Record<string, unknown> = {}): EventLike => ({ callUuid: uuid, conversationUuid: (extra["conversation_uuid"] as string | undefined) ?? "CON-1", receivedAt: iso(999), payload: { uuid, status, direction: "outbound", ...(at ? { timestamp: at } : {}), ...extra } });
    const events = [
      ev("a", "completed", iso(40), { duration: "37", end_time: iso(40.1) }), // received first, happened last
      ev("a", "answered", iso(3)),
      ev("a", "ringing", iso(0.9)),
      ev("a", "ringing", iso(0.5)), // the earliest ringing wins whatever arrives first
      ev("a", "human", iso(3.2)),
      ev("a", "started", iso(0)),
      ev("leg-agent", "answered", iso(6), { direction: "outbound" }), // the connect's second leg, same conversation
      ev("leg-agent", "completed", iso(40)),
      ev("b", "timeout", iso(61), { conversation_uuid: "CON-2" }),
      ev("b", "ringing", undefined, { conversation_uuid: "CON-2" }), // no platform timestamp: the receipt time stands in
      { callUuid: undefined, receivedAt: iso(1), payload: { status: "ringing" } }, // no uuid anywhere: dropped
    ];
    const t = telemetryFromEvents(events, (uuid) => uuid === "a");
    const a = t.find((x) => x.uuid === "a");
    expect(a).toEqual({ uuid: "a", conversationUuid: "CON-1", direction: "outbound", ringingAt: iso(0.5), answeredAt: iso(3), detected: "human", endedAt: iso(40.1), outcome: "completed", durationSeconds: 37, pathHasConnect: true, otherLegAnswered: true, connectLeg: false });
    expect(t.find((x) => x.uuid === "leg-agent")).toMatchObject({ pathHasConnect: false, otherLegAnswered: true, connectLeg: true });
    expect(t.find((x) => x.uuid === "b")).toMatchObject({ ringingAt: iso(999), endedAt: iso(61), outcome: "timeout", otherLegAnswered: false, connectLeg: false });
    const r = campaignRates(t);
    // "a" was connected (its representative's leg answered); that leg is not a dial and is not in the denominator.
    expect(r).toMatchObject({ calls: 3, outbound: 2, answeredByPerson: 1, abandoned: 0 });
    expect(r.properties[0]).toMatchObject({ id: "P6", verdict: "true", n: 1, figure: 0 });
    expect(r.properties[1]).toMatchObject({ id: "P7", verdict: "inconclusive" }); // b's ring time is negative by receipt time, excluded
    // A call's own answer proves nothing about its connect: alone in its conversation, with a connect on the path, it was never connected.
    const solo = telemetryFromEvents([ev("s", "answered", iso(3), { conversation_uuid: "CON-3" }), ev("s", "completed", iso(20), { conversation_uuid: "CON-3", duration: "17" })], () => true);
    expect(solo).toHaveLength(1);
    expect(solo[0]).toMatchObject({ uuid: "s", pathHasConnect: true, otherLegAnswered: false, connectLeg: false });
    expect(campaignRates(solo).properties[0]).toMatchObject({ id: "P6", verdict: "false", n: 1, figure: 1 });
  });
});
