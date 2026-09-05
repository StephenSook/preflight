import type { Insight } from "@preflight/numfacts";
import type { Sql } from "postgres";

export interface InsightRecord {
  /** The last ten digits of the number. */
  line: string;
  status: "ok" | "error";
  insight: Insight | undefined;
  error: string | undefined;
  httpStatus: number | undefined;
  latencyMs: number | undefined;
  lookedUpAt: string;
}

/** Cached Identity Insights answers, keyed by line; one row per line, the newest lookup wins. */
export interface InsightStore {
  readonly name: "memory" | "postgres";
  get(line: string): Promise<InsightRecord | undefined>;
  put(record: InsightRecord): Promise<void>;
  /** Lookups recorded at or after `sinceIso`, successes and failures alike: the daily spend counter. */
  countSince(sinceIso: string): Promise<number>;
}

export class MemoryInsightStore implements InsightStore {
  readonly name = "memory" as const;
  private readonly rows = new Map<string, InsightRecord>();
  async get(line: string): Promise<InsightRecord | undefined> {
    return this.rows.get(line);
  }
  async put(record: InsightRecord): Promise<void> {
    this.rows.set(record.line, { ...record });
  }
  async countSince(sinceIso: string): Promise<number> {
    return [...this.rows.values()].filter((r) => r.lookedUpAt >= sinceIso).length;
  }
}

interface Row { line: string; status: "ok" | "error"; insight: Insight | null; error: string | null; http_status: number | null; latency_ms: number | null; looked_up_at: Date }
const toRecord = (r: Row): InsightRecord => ({ line: r.line, status: r.status, insight: r.insight ?? undefined, error: r.error ?? undefined, httpStatus: r.http_status ?? undefined, latencyMs: r.latency_ms ?? undefined, lookedUpAt: r.looked_up_at.toISOString() });

export class PgInsightStore implements InsightStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}
  async get(line: string): Promise<InsightRecord | undefined> {
    const [r] = await this.sql<Row[]>`select * from number_insights where line = ${line}`;
    return r ? toRecord(r) : undefined;
  }
  async put(rec: InsightRecord): Promise<void> {
    await this.sql`insert into number_insights (line, status, insight, error, http_status, latency_ms, looked_up_at)
      values (${rec.line}, ${rec.status}, ${rec.insight ? this.sql.json(rec.insight as never) : null}, ${rec.error ?? null}, ${rec.httpStatus ?? null}, ${rec.latencyMs ?? null}, ${rec.lookedUpAt})
      on conflict (line) do update set status = excluded.status, insight = excluded.insight, error = excluded.error, http_status = excluded.http_status, latency_ms = excluded.latency_ms, looked_up_at = excluded.looked_up_at`;
  }
  async countSince(sinceIso: string): Promise<number> {
    const [r] = await this.sql<{ n: string }[]>`select count(*)::text as n from number_insights where looked_up_at >= ${sinceIso}`;
    return Number(r?.n ?? 0);
  }
}
