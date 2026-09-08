import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgDecisionStore, type DecisionRecord } from "./decisionStore.js";

/** Same contract as pgEventStore.test.ts: under CI a missing DATABASE_URL fails, never skips. */
const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgDecisionStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgDecisionStore(sql);
  const marker = "test-decision-provenance";

  beforeAll(async () => {
    await runMigrations(sql);
    await sql`delete from calls where conversation_uuid = ${marker}`;
  }, 60000);
  afterAll(async () => {
    await sql`delete from calls where conversation_uuid = ${marker}`;
    await sql.end({ timeout: 5 });
  });

  it("round-trips a decision with its verdicts, witness path and number facts", async () => {
    const record: DecisionRecord = {
      callUuid: "call-int-2",
      conversationUuid: marker,
      applicationId: "app-1",
      direction: "outbound",
      fromNumber: "14045550100",
      toNumber: "14042010000",
      humanParty: "14042010000",
      facts: { nationalNumber: "4042010000", state: "GA", rateCenter: "ATLANTA", ocn: "6214", lineType: "wireless", lineTypeSource: "nanpa", lineTypeConfidence: "low", zones: ["America/New_York"], withinHours: true, hoursBasis: "America/New_York by prefix 404" },
      policy: "strict",
      terminal: true,
      nccoHash: "sha256:" + "ab".repeat(32),
      decision: "block",
      reason: "P3 Interactive opt-out present, 47 CFR 64.1200(b)(3)",
      verdicts: [
        { id: "P1", citation: "47 CFR 64.1200(c)(1)", verdict: "true" },
        { id: "P3", citation: "47 CFR 64.1200(b)(3)", verdict: "false", atEnd: true, witness: [{ index: 0, label: "talk#0", atoms: { speaks: true, synthetic: true, identifies: true, offers_optout: false, connects_human: false } }] },
        { id: "P4", citation: "O.C.G.A. 46-5-27(g)(2); Ga. Comp. R. & Regs. 515-14-1-.03(c)", verdict: "inconclusive", reason: "caller id unresolved" },
      ],
      decidedAt: "2026-09-05T10:00:00.000Z",
      originLatencyMs: 41.2,
      verifyLatencyMs: 3.7,
    };
    await store.append(record);
    const back = (await store.recent(50)).find((r) => r.conversationUuid === marker);
    expect(back).toBeDefined();
    expect(back).toMatchObject({ callUuid: "call-int-2", decision: "block", terminal: true, policy: "strict", nccoHash: record.nccoHash, facts: { state: "GA", rateCenter: "ATLANTA", lineType: "wireless", zones: ["America/New_York"], withinHours: true } });
    expect(back?.verdicts).toEqual(record.verdicts);
    expect(back?.source).toBe("unknown");
    expect(back?.platformStatus).toBeUndefined();
    for (const [index, evidence] of ([
      { source: "gateway", platformStatus: 201 },
      { source: "gateway", platformStatus: 403 },
      { source: "webhook" },
      { source: "unknown" },
    ] as const).entries()) {
      const stamped: DecisionRecord = { ...record, ...evidence, callUuid: `provenance-${index}` };
      await store.append(stamped);
      const recent = (await store.recent(50)).find((row) => row.callUuid === stamped.callUuid && row.conversationUuid === marker);
      const between = (await store.between(record.decidedAt, record.decidedAt, 50)).find((row) => row.callUuid === stamped.callUuid && row.conversationUuid === marker);
      for (const restored of [recent, between]) {
        expect(restored).toMatchObject({ source: stamped.source, callUuid: stamped.callUuid });
        expect(restored?.platformStatus).toBe(stamped.platformStatus);
      }
    }
    const counts = await store.counts();
    expect(counts.block).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("defaults legacy inserts to unknown without inferring provenance from a UUID", async () => {
    const [row] = await sql`insert into calls (call_uuid, direction, line_type, line_type_source, line_type_confidence, hours_basis, policy, terminal, ncco_hash, decision, conversation_uuid, decided_at)
      values ('legacy-observed', 'outbound', 'unknown', 'none', 'none', 'x', 'strict', true, 'sha256:0', 'pass', ${marker}, '2026-09-05T10:00:00.000Z') returning source, platform_status`;
    expect(row).toMatchObject({ source: "unknown", platform_status: null });
  });

  it("refuses a decision value outside the three the product has", async () => {
    await expect(sql`insert into calls (direction, line_type, line_type_source, line_type_confidence, hours_basis, policy, terminal, ncco_hash, decision, conversation_uuid)
      values ('outbound', 'unknown', 'none', 'none', 'x', 'strict', true, 'sha256:0', 'maybe', ${marker})`).rejects.toThrow();
  }, 30000);
});
