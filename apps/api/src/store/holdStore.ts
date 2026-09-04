import type { PropertyVerdict } from "@preflight/engine";
import type { Sql } from "postgres";

export interface Hold {
  holdId: string;
  callUuid: string | undefined;
  humanParty: string | undefined;
  reason: string;
  verdicts: PropertyVerdict[];
  status: "open" | "placed" | "cancelled";
  createdAt: string;
  decidedBy: string | undefined;
  decidedAt: string | undefined;
}

export interface HoldStore {
  readonly name: "memory" | "postgres";
  create(hold: Hold): Promise<void>;
  get(holdId: string): Promise<Hold | undefined>;
  list(status: Hold["status"] | "all", limit: number): Promise<Hold[]>;
  decide(holdId: string, status: "placed" | "cancelled", by: string, at: string): Promise<Hold | undefined>;
}

export class MemoryHoldStore implements HoldStore {
  readonly name = "memory" as const;
  private readonly rows = new Map<string, Hold>();
  async create(hold: Hold): Promise<void> {
    this.rows.set(hold.holdId, { ...hold });
  }
  async get(holdId: string): Promise<Hold | undefined> {
    return this.rows.get(holdId);
  }
  async list(status: Hold["status"] | "all", limit: number): Promise<Hold[]> {
    return [...this.rows.values()].filter((h) => status === "all" || h.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async decide(holdId: string, status: "placed" | "cancelled", by: string, at: string): Promise<Hold | undefined> {
    const h = this.rows.get(holdId);
    if (!h || h.status !== "open") return undefined;
    Object.assign(h, { status, decidedBy: by, decidedAt: at });
    return h;
  }
}

interface Row { hold_id: string; call_uuid: string | null; human_party: string | null; reason: string; verdicts: PropertyVerdict[]; status: Hold["status"]; created_at: Date; decided_by: string | null; decided_at: Date | null }
const toHold = (r: Row): Hold => ({ holdId: r.hold_id, callUuid: r.call_uuid ?? undefined, humanParty: r.human_party ?? undefined, reason: r.reason, verdicts: r.verdicts, status: r.status, createdAt: r.created_at.toISOString(), decidedBy: r.decided_by ?? undefined, decidedAt: r.decided_at?.toISOString() });

export class PgHoldStore implements HoldStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}
  async create(h: Hold): Promise<void> {
    await this.sql`insert into holds (hold_id, call_uuid, human_party, reason, verdicts, status, created_at) values (${h.holdId}, ${h.callUuid ?? null}, ${h.humanParty ?? null}, ${h.reason}, ${this.sql.json(h.verdicts as never)}, ${h.status}, ${h.createdAt})`;
  }
  async get(holdId: string): Promise<Hold | undefined> {
    const [r] = await this.sql<Row[]>`select * from holds where hold_id = ${holdId}`;
    return r ? toHold(r) : undefined;
  }
  async list(status: Hold["status"] | "all", limit: number): Promise<Hold[]> {
    const rows = status === "all"
      ? await this.sql<Row[]>`select * from holds order by created_at desc limit ${limit}`
      : await this.sql<Row[]>`select * from holds where status = ${status} order by created_at desc limit ${limit}`;
    return rows.map(toHold);
  }
  async decide(holdId: string, status: "placed" | "cancelled", by: string, at: string): Promise<Hold | undefined> {
    const [r] = await this.sql<Row[]>`update holds set status = ${status}, decided_by = ${by}, decided_at = ${at} where hold_id = ${holdId} and status = 'open' returning *`;
    return r ? toHold(r) : undefined;
  }
}
