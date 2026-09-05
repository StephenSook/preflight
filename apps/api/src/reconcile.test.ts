import { describe, expect, it } from "vitest";
import { lineOf, reconcile, type CarrierRecord } from "./reconcile.js";
import type { DecisionRecord } from "./store/decisionStore.js";

const T0 = Date.parse("2026-09-05T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const facts: DecisionRecord["facts"] = { nationalNumber: undefined, state: undefined, rateCenter: undefined, ocn: undefined, lineType: "unknown", lineTypeSource: "none", lineTypeConfidence: "none", zones: [], withinHours: true, hoursBasis: "test" };
const decision = (over: Partial<DecisionRecord>): DecisionRecord => ({ callUuid: undefined, conversationUuid: undefined, applicationId: "app", direction: "outbound", fromNumber: "12016131021", toNumber: "19432445023", humanParty: "19432445023", facts, policy: "strict", terminal: true, nccoHash: "sha256:x", decision: "pass", reason: undefined, verdicts: [], decidedAt: iso(T0), originLatencyMs: 1, verifyLatencyMs: 1, ...over });
const record = (over: Partial<CarrierRecord>): CarrierRecord => ({ call_id: "c", direction: "outbound", from: "12016131021", to: "19432445023", date_start: iso(T0 + 2000), ...over });
const window = { start: iso(T0 - 3600_000), end: iso(T0 + 3600_000) };

describe("carrier-side reconciliation", () => {
  it("normalises a line to its last ten digits", () => {
    expect(lineOf("12016131021")).toBe("2016131021");
    expect(lineOf("+1 (201) 613-1021")).toBe("2016131021");
    expect(lineOf("2016131021")).toBe("2016131021");
    expect(lineOf(undefined)).toBe("");
  });

  it("matches carrier records to decided calls by uuid, and reports the rest as placed around the interlock", () => {
    const decisions = [decision({ callUuid: "known-1", decision: "pass" }), decision({ callUuid: "known-2", decision: "block", direction: "inbound" })];
    const report = reconcile(window, [record({ call_id: "known-1" }), record({ call_id: "known-2", direction: "inbound" }), record({ call_id: "stranger", from: "14045550100", to: "14045550199" })], decisions);
    expect(report).toMatchObject({ carrier_records: 3, matched: 2, unmatched: 1, leaks: 0, refused_in_window: 0, decided_not_in_records: 0, unmatched_ids: ["stranger"], leaked_ids: [], missing_ids: [] });
    expect(report.records_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("counts a decided call with a platform uuid that the pull never returned, so an empty or mis-filtered pull is not a clean night", () => {
    const decisions = [decision({ callUuid: "known-1", decision: "pass" }), decision({ callUuid: "known-9", decision: "pass" }), decision({ callUuid: "old-1", decision: "pass", decidedAt: iso(T0 - 7200_000) }), decision({ callUuid: "preflight-dryrun-aa", decision: "block" })];
    const empty = reconcile(window, [], decisions);
    expect(empty).toMatchObject({ carrier_records: 0, decided_not_in_records: 2, missing_ids: ["known-1", "known-9"] });
    // A record outside the window still proves the platform knows the call.
    const some = reconcile(window, [record({ call_id: "known-1" }), record({ call_id: "known-9", date_start: iso(T0 - 3700_000) })], decisions);
    expect(some).toMatchObject({ carrier_records: 1, outside_window: 1, decided_not_in_records: 0, missing_ids: [] });
  });

  it("names a leak: a carrier record with no uuid Preflight knows, on the same two lines, moments after the gateway refused that request", () => {
    const refusedAt = T0;
    const decisions = [decision({ decision: "block", decidedAt: iso(refusedAt) })];
    const inside = reconcile(window, [record({ call_id: "leak-1", date_start: iso(refusedAt + 30_000) })], decisions);
    expect(inside).toMatchObject({ unmatched: 1, leaks: 1, leaked_ids: ["leak-1"], refused_in_window: 1 });
    // Two minutes after the refusal, no longer attributable to it; four seconds before, still the same attempt (clock skew).
    expect(reconcile(window, [record({ call_id: "late", date_start: iso(refusedAt + 121_000) })], decisions).leaks).toBe(0);
    expect(reconcile(window, [record({ call_id: "skew", date_start: iso(refusedAt - 4_000) })], decisions).leaks).toBe(1);
    // Different lines, same moment: unmatched but not a leak of that refusal.
    expect(reconcile(window, [record({ call_id: "other", to: "14045550199", date_start: iso(refusedAt + 1_000) })], decisions)).toMatchObject({ unmatched: 1, leaks: 0 });
    // A refusal that already carries a uuid was decided on the webhook path; the carrier record for it is matched, not a leak.
    expect(reconcile(window, [record({ call_id: "wh-1" })], [decision({ callUuid: "wh-1", decision: "block" })])).toMatchObject({ matched: 1, leaks: 0, refused_in_window: 0 });
  });

  it("hashes the records in canonical form so the same pull hashes the same regardless of field order or number formatting", () => {
    const a = reconcile(window, [record({ call_id: "x", from: "+1 201 613 1021" })], []);
    const b = reconcile(window, [{ to: "19432445023", from: "12016131021", date_start: iso(T0 + 2000), direction: "outbound", call_id: "x", status: "ANSWERED" }], []);
    expect(a.records_hash).toBe(b.records_hash);
  });

  it("classifies only records that started inside the window and reports the rest as outside it", () => {
    const decisions = [decision({ decision: "hold", decidedAt: iso(T0 - 7200_000) })];
    const report = reconcile(window, [record({ call_id: "old", date_start: iso(T0 - 7200_000 + 10_000) }), record({ call_id: "in", date_start: iso(T0) })], decisions);
    expect(report).toMatchObject({ carrier_records: 1, outside_window: 1, refused_in_window: 0, unmatched: 1, leaks: 0, unmatched_ids: ["in"] });
  });

  it("treats the gateway's dry-run ids as no uuid: a refusal carrying one is a refusal, and no carrier record matches it", () => {
    const decisions = [decision({ callUuid: "preflight-dryrun-a1b2c3d4e5f6", decision: "block", decidedAt: iso(T0) })];
    expect(reconcile(window, [record({ call_id: "real-platform-uuid", date_start: iso(T0 + 2000) })], decisions)).toMatchObject({ refused_in_window: 1, unmatched: 1, leaks: 1, leaked_ids: ["real-platform-uuid"] });
    expect(reconcile(window, [record({ call_id: "preflight-dryrun-a1b2c3d4e5f6", date_start: iso(T0 + 2000) })], decisions)).toMatchObject({ matched: 0, unmatched: 1 });
    expect(reconcile(window, [], decisions).refused_in_window).toBe(1);
  });

  it("a refusal placed with a random caller id is attributed by the destination alone", () => {
    const decisions = [decision({ decision: "block", fromNumber: "random_from_number", decidedAt: iso(T0) })];
    expect(reconcile(window, [record({ call_id: "x", from: "12125550100", date_start: iso(T0 + 1000) })], decisions).leaks).toBe(1);
    expect(reconcile(window, [record({ call_id: "y", from: "12125550100", to: "14045550199", date_start: iso(T0 + 1000) })], decisions).leaks).toBe(0);
  });
});
