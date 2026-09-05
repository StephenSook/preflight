import { describe, expect, it } from "vitest";
import { campaignRates, telemetryFromEvents, type CallTelemetry, type EventLike } from "./rates.js";

const T0 = Date.parse("2026-09-05T15:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const call = (over: Partial<CallTelemetry>): CallTelemetry => ({ uuid: "c", direction: "outbound", outcome: "completed", connectedHuman: false, ...over });

describe("rate properties over event telemetry", () => {
  it("P6 divides by calls answered by a person, never by dials or by machines", () => {
    const calls = [
      call({ uuid: "a", answeredAt: iso(5), endedAt: iso(40), durationSeconds: 35, detected: "human", connectedHuman: true }),
      call({ uuid: "b", answeredAt: iso(5), endedAt: iso(40), durationSeconds: 35, detected: "human", connectedHuman: true }),
      call({ uuid: "c", answeredAt: iso(5), endedAt: iso(20), durationSeconds: 15, detected: "machine", connectedHuman: false }), // machine: out of the denominator, not abandoned
      call({ uuid: "d", answeredAt: iso(5), endedAt: iso(9), durationSeconds: 4, connectedHuman: false }), // no detection: counts as a person, and it is abandoned
      call({ uuid: "e", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" }), // unanswered: not in the denominator
      call({ uuid: "f", direction: "inbound", answeredAt: iso(1), connectedHuman: false }), // inbound: not a dial
    ];
    const r = campaignRates(calls);
    expect(r).toMatchObject({ calls: 6, outbound: 5, answered: 4, answeredByPerson: 3, machineAnswered: 1, abandoned: 1, unanswered: 1 });
    const p6 = r.properties[0]!;
    expect(p6).toMatchObject({ id: "P6", verdict: "false", n: 3 });
    expect(p6.figure).toBeCloseTo(1 / 3, 6);
    expect(p6.basis).toContain("1 of 3 calls answered by a person");
    expect(p6.basis).toContain("1 machine-answered");
    expect(p6.basis).toContain("1 answered call(s) had no machine detection");
    // Under the safe harbour: 1 abandoned in 40 person-answered calls is 2.5%.
    const many = [...Array.from({ length: 39 }, (_, i) => call({ uuid: `p${i}`, answeredAt: iso(5), detected: "human", connectedHuman: true })), call({ uuid: "x", answeredAt: iso(5), detected: "human", connectedHuman: false })];
    expect(campaignRates(many).properties[0]).toMatchObject({ verdict: "true", n: 40 });
    expect(campaignRates(many).properties[0]!.figure).toBeCloseTo(0.025, 6);
  });

  it("P6 and P7 are inconclusive without their denominators, never guessed", () => {
    const r = campaignRates([call({ uuid: "e", ringingAt: iso(0), outcome: "timeout" })]);
    expect(r.properties[0]).toMatchObject({ id: "P6", verdict: "inconclusive", figure: null, n: 0 });
    expect(r.properties[1]).toMatchObject({ id: "P7", verdict: "inconclusive", n: 0 }); // no end time, so no ring time
    expect(campaignRates([]).properties.map((p) => p.verdict)).toEqual(["inconclusive", "inconclusive", "inconclusive"]);
  });

  it("P7 fails when any unanswered call was disconnected before fifteen seconds of ringing", () => {
    const ok = campaignRates([call({ uuid: "a", ringingAt: iso(0), endedAt: iso(16), outcome: "timeout" }), call({ uuid: "b", ringingAt: iso(0), endedAt: iso(30), outcome: "unanswered" })]);
    expect(ok.properties[1]).toMatchObject({ id: "P7", verdict: "true", n: 2, figure: 0 });
    const short = campaignRates([call({ uuid: "a", ringingAt: iso(0), endedAt: iso(14.9), outcome: "timeout" }), call({ uuid: "b", ringingAt: iso(0), endedAt: iso(30), outcome: "unanswered" })]);
    expect(short.properties[1]).toMatchObject({ id: "P7", verdict: "false", n: 2, figure: 0.5 });
    expect(short.properties[1]!.basis).toContain("shortest 14.9 s");
    // A busy or cancelled call that never rang is not a ring-duration case.
    expect(campaignRates([call({ uuid: "c", outcome: "busy", endedAt: iso(1) })]).properties[1]!.verdict).toBe("inconclusive");
  });

  it("P8 judges the twelve-second line and only reports the unanswered share", () => {
    const shortTalk = campaignRates([
      call({ uuid: "a", answeredAt: iso(2), endedAt: iso(8), durationSeconds: 6 }),
      call({ uuid: "b", answeredAt: iso(2), endedAt: iso(12), durationSeconds: 10 }),
      call({ uuid: "c", answeredAt: iso(2), endedAt: iso(30), durationSeconds: 28 }),
      call({ uuid: "d", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" }),
    ]);
    expect(shortTalk.medianAnsweredDurationSeconds).toBe(10);
    expect(shortTalk.properties[2]).toMatchObject({ id: "P8", verdict: "false", n: 4, figure: 0.25 });
    expect(shortTalk.properties[2]!.basis).toContain("1 of 4 outbound calls went unanswered (25.0%)");
    expect(shortTalk.properties[2]!.basis).toContain("median talk time 10.0 s");
    const longTalk = campaignRates([call({ uuid: "a", answeredAt: iso(2), durationSeconds: 40 }), call({ uuid: "b", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" }), call({ uuid: "c", ringingAt: iso(0), endedAt: iso(60), outcome: "timeout" })]);
    expect(longTalk.properties[2]).toMatchObject({ verdict: "true", figure: 2 / 3 });
    expect(longTalk.properties[2]!.basis).toContain("not judged");
  });

  it("folds the platform's event webhooks into per-call telemetry, first ringing and first answer winning, the platform's timestamp over the receipt time", () => {
    const ev = (uuid: string, status: string, at: string, extra: Record<string, unknown> = {}): EventLike => ({ callUuid: uuid, receivedAt: iso(999), payload: { uuid, status, timestamp: at, direction: "outbound", ...extra } });
    const events = [
      ev("a", "started", iso(0)),
      ev("a", "ringing", iso(0.5)),
      ev("a", "ringing", iso(0.9)),
      ev("a", "answered", iso(3)),
      ev("a", "human", iso(3.2)),
      ev("a", "completed", iso(40), { duration: "37", end_time: iso(40.1) }),
      ev("b", "ringing", iso(0)),
      ev("b", "timeout", iso(61)),
      { callUuid: undefined, receivedAt: iso(1), payload: { status: "ringing" } }, // no uuid anywhere: dropped
    ];
    const t = telemetryFromEvents(events, (uuid) => uuid === "a");
    expect(t).toEqual([
      { uuid: "a", direction: "outbound", ringingAt: iso(0.5), answeredAt: iso(3), detected: "human", endedAt: iso(40.1), outcome: "completed", durationSeconds: 37, connectedHuman: true },
      { uuid: "b", direction: "outbound", ringingAt: iso(0), endedAt: iso(61), outcome: "timeout", connectedHuman: false },
    ]);
    const r = campaignRates(t);
    expect(r.properties.map((p) => [p.id, p.verdict])).toEqual([["P6", "true"], ["P7", "true"], ["P8", "true"]]);
    expect(r.properties[1]!.basis).toContain("0 of 1 unanswered calls");
  });
});
