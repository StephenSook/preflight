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
  /** What the platform placed on this hold's override, so the call's own webhooks can find it. */
  placedCallUuid?: string | undefined;
  placedConversationUuid?: string | undefined;
}

export interface HoldStore {
  readonly name: "memory" | "postgres";
  create(hold: Hold): Promise<void>;
  get(holdId: string): Promise<Hold | undefined>;
  list(status: Hold["status"] | "all", limit: number): Promise<Hold[]>;
  decide(holdId: string, status: "placed" | "cancelled", by: string, at: string): Promise<Hold | undefined>;
  /** Records the call the platform placed on a released hold. */
  placed(holdId: string, callUuid: string | undefined, conversationUuid: string | undefined): Promise<void>;
  /** The released hold a live call is running on, by its call or conversation uuid; undefined when it runs on none. */
  forCall(callUuid: string | undefined, conversationUuid: string | undefined): Promise<Hold | undefined>;
}

/** The override a webhook's call is running on, read from its uuid or conversation uuid. */
export async function overrideFor(store: HoldStore, payload: Record<string, unknown> | undefined): Promise<{ holdId: string; by: string } | undefined> {
  const s = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const callUuid = s(payload?.["uuid"]);
  const conversationUuid = s(payload?.["conversation_uuid"]);
  if (!callUuid && !conversationUuid) return undefined;
  const hold = await store.forCall(callUuid, conversationUuid);
  return hold ? { holdId: hold.holdId, by: hold.decidedBy ?? "unknown" } : undefined;
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
  async placed(holdId: string, callUuid: string | undefined, conversationUuid: string | undefined): Promise<void> {
    const h = this.rows.get(holdId);
    if (h) Object.assign(h, { placedCallUuid: callUuid, placedConversationUuid: conversationUuid });
  }
  async forCall(callUuid: string | undefined, conversationUuid: string | undefined): Promise<Hold | undefined> {
    if (!callUuid && !conversationUuid) return undefined;
    return [...this.rows.values()].filter((h) => h.status === "placed" && ((callUuid !== undefined && h.placedCallUuid === callUuid) || (conversationUuid !== undefined && h.placedConversationUuid === conversationUuid))).sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
  }
}

interface Row { hold_id: string; call_uuid: string | null; human_party: string | null; reason: string; verdicts: PropertyVerdict[]; status: Hold["status"]; created_at: Date; decided_by: string | null; decided_at: Date | null; placed_call_uuid: string | null; placed_conversation_uuid: string | null }
const toHold = (r: Row): Hold => ({ holdId: r.hold_id, callUuid: r.call_uuid ?? undefined, humanParty: r.human_party ?? undefined, reason: r.reason, verdicts: r.verdicts, status: r.status, createdAt: r.created_at.toISOString(), decidedBy: r.decided_by ?? undefined, decidedAt: r.decided_at?.toISOString(), placedCallUuid: r.placed_call_uuid ?? undefined, placedConversationUuid: r.placed_conversation_uuid ?? undefined });

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
  async placed(holdId: string, callUuid: string | undefined, conversationUuid: string | undefined): Promise<void> {
    await this.sql`update holds set placed_call_uuid = ${callUuid ?? null}, placed_conversation_uuid = ${conversationUuid ?? null} where hold_id = ${holdId}`;
  }
  async forCall(callUuid: string | undefined, conversationUuid: string | undefined): Promise<Hold | undefined> {
    if (!callUuid && !conversationUuid) return undefined;
    // A comparison with null is never true, so an absent uuid matches nothing.
    const [r] = await this.sql<Row[]>`select * from holds where status = 'placed' and (placed_call_uuid = ${callUuid ?? null} or placed_conversation_uuid = ${conversationUuid ?? null}) order by decided_at desc nulls last limit 1`;
    return r ? toHold(r) : undefined;
  }
}
