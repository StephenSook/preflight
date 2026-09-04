import type { Decision, PropertyVerdict } from "@preflight/engine";
import type { NumberFacts } from "@preflight/numfacts";
import type { Sql } from "postgres";

export interface DecisionRecord {
  callUuid: string | undefined;
  conversationUuid: string | undefined;
  applicationId: string | undefined;
  direction: "inbound" | "outbound" | "unknown";
  fromNumber: string | undefined;
  toNumber: string | undefined;
  /** The person on the line: the callee on an outbound call, the caller on an inbound one. */
  humanParty: string | undefined;
  facts: NumberFacts;
  policy: "strict" | "advisory";
  terminal: boolean;
  nccoHash: string;
  decision: Decision;
  reason: string | undefined;
  verdicts: PropertyVerdict[];
  decidedAt: string;
  originLatencyMs: number | null;
  verifyLatencyMs: number | null;
}

export interface DecisionStore {
  readonly name: "memory" | "postgres";
  append(record: DecisionRecord): Promise<void>;
  recent(limit: number): Promise<DecisionRecord[]>;
  counts(): Promise<Record<Decision, number>>;
}

export class MemoryDecisionStore implements DecisionStore {
  readonly name = "memory" as const;
  private rows: DecisionRecord[] = [];
  async append(record: DecisionRecord): Promise<void> {
    this.rows.push(record);
  }
  async recent(limit: number): Promise<DecisionRecord[]> {
    return this.rows.slice(-limit).reverse();
  }
  async counts(): Promise<Record<Decision, number>> {
    const c: Record<Decision, number> = { pass: 0, block: 0, hold: 0 };
    for (const r of this.rows) c[r.decision] += 1;
    return c;
  }
}

interface CallRow {
  id: string;
  call_uuid: string | null;
  conversation_uuid: string | null;
  application_id: string | null;
  direction: DecisionRecord["direction"];
  from_number: string | null;
  to_number: string | null;
  human_party: string | null;
  state: string | null;
  rate_center: string | null;
  line_type: NumberFacts["lineType"];
  line_type_source: NumberFacts["lineTypeSource"];
  line_type_confidence: NumberFacts["lineTypeConfidence"];
  zones: string[];
  within_hours: boolean | null;
  hours_basis: string;
  policy: DecisionRecord["policy"];
  terminal: boolean;
  ncco_hash: string;
  decision: Decision;
  reason: string | null;
  decided_at: Date;
  origin_latency_ms: number | null;
  verify_latency_ms: number | null;
}

interface VerdictRow {
  call_id: string;
  property_id: PropertyVerdict["id"];
  verdict: PropertyVerdict["verdict"];
  citation: string;
  witness: PropertyVerdict["witness"] | null;
  at_end: boolean;
  reason: string | null;
}

export class PgDecisionStore implements DecisionStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}

  async append(r: DecisionRecord): Promise<void> {
    await this.sql.begin(async (tx) => {
      const f = r.facts;
      const [row] = await tx<{ id: string }[]>`
        insert into calls (call_uuid, conversation_uuid, application_id, direction, from_number, to_number, human_party, state, rate_center,
          line_type, line_type_source, line_type_confidence, zones, within_hours, hours_basis, policy, terminal, ncco_hash, decision, reason,
          decided_at, origin_latency_ms, verify_latency_ms)
        values (${r.callUuid ?? null}, ${r.conversationUuid ?? null}, ${r.applicationId ?? null}, ${r.direction}, ${r.fromNumber ?? null}, ${r.toNumber ?? null},
          ${r.humanParty ?? null}, ${f.state ?? null}, ${f.rateCenter ?? null}, ${f.lineType}, ${f.lineTypeSource}, ${f.lineTypeConfidence}, ${f.zones},
          ${f.withinHours}, ${f.hoursBasis}, ${r.policy}, ${r.terminal}, ${r.nccoHash}, ${r.decision}, ${r.reason ?? null}, ${r.decidedAt},
          ${r.originLatencyMs}, ${r.verifyLatencyMs})
        returning id::text as id`;
      if (!row) throw new Error("insert into calls returned no id");
      for (const v of r.verdicts) {
        await tx`insert into verdicts (call_id, property_id, verdict, citation, witness, at_end, reason)
          values (${row.id}::bigint, ${v.id}, ${v.verdict}, ${v.citation}, ${v.witness ? tx.json(v.witness as never) : null}, ${v.atEnd ?? false}, ${v.reason ?? null})`;
      }
    });
  }

  async recent(limit: number): Promise<DecisionRecord[]> {
    const calls = await this.sql<CallRow[]>`select id::text as id, call_uuid, conversation_uuid, application_id, direction, from_number, to_number, human_party, state, rate_center,
      line_type, line_type_source, line_type_confidence, zones, within_hours, hours_basis, policy, terminal, ncco_hash, decision, reason, decided_at, origin_latency_ms, verify_latency_ms
      from calls order by decided_at desc, id desc limit ${limit}`;
    if (calls.length === 0) return [];
    const ids = calls.map((c) => c.id);
    const verdicts = await this.sql<VerdictRow[]>`select call_id::text as call_id, property_id, verdict, citation, witness, at_end, reason from verdicts where call_id = any(${ids}::bigint[]) order by id`;
    return calls.map((c) => ({
      callUuid: c.call_uuid ?? undefined,
      conversationUuid: c.conversation_uuid ?? undefined,
      applicationId: c.application_id ?? undefined,
      direction: c.direction,
      fromNumber: c.from_number ?? undefined,
      toNumber: c.to_number ?? undefined,
      humanParty: c.human_party ?? undefined,
      facts: {
        nationalNumber: undefined,
        state: c.state ?? undefined,
        rateCenter: c.rate_center ?? undefined,
        ocn: undefined,
        lineType: c.line_type,
        lineTypeSource: c.line_type_source,
        lineTypeConfidence: c.line_type_confidence,
        zones: c.zones,
        withinHours: c.within_hours,
        hoursBasis: c.hours_basis,
      },
      policy: c.policy,
      terminal: c.terminal,
      nccoHash: c.ncco_hash,
      decision: c.decision,
      reason: c.reason ?? undefined,
      verdicts: verdicts.filter((v) => v.call_id === c.id).map((v) => ({
        id: v.property_id,
        citation: v.citation,
        verdict: v.verdict,
        ...(v.witness ? { witness: v.witness } : {}),
        ...(v.at_end ? { atEnd: true } : {}),
        ...(v.reason ? { reason: v.reason } : {}),
      })),
      decidedAt: c.decided_at.toISOString(),
      originLatencyMs: c.origin_latency_ms,
      verifyLatencyMs: c.verify_latency_ms,
    }));
  }

  async counts(): Promise<Record<Decision, number>> {
    const rows = await this.sql<{ decision: Decision; n: string }[]>`select decision, count(*)::text as n from calls group by decision`;
    const c: Record<Decision, number> = { pass: 0, block: 0, hold: 0 };
    for (const r of rows) c[r.decision] = Number(r.n);
    return c;
  }
}
