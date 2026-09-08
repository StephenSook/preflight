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
  placementReserved?: boolean;
}

export interface PlacementCorrelation {
  hash: string;
  expiresAt: string;
}

export interface HoldStore {
  readonly name: "memory" | "postgres";
  create(hold: Hold): Promise<void>;
  get(holdId: string): Promise<Hold | undefined>;
  list(status: Hold["status"] | "all", limit: number): Promise<Hold[]>;
  decide(holdId: string, status: "placed" | "cancelled", by: string, at: string): Promise<Hold | undefined>;
  reservePlacement(holdId: string, correlation?: PlacementCorrelation): Promise<boolean>;
  bindPlacement(hash: string, callUuid: string, conversationUuid: string | undefined, toNumber: string, now: string): Promise<boolean>;
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
  private readonly correlations = new Map<string, PlacementCorrelation>();
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
  async reservePlacement(holdId: string, correlation?: PlacementCorrelation): Promise<boolean> {
    const hold = this.rows.get(holdId);
    if (!hold || hold.status !== "placed" || hold.placementReserved || hold.placedCallUuid || hold.placedConversationUuid) return false;
    hold.placementReserved = true;
    if (correlation) this.correlations.set(holdId, { ...correlation });
    return true;
  }
  async bindPlacement(hash: string, callUuid: string, conversationUuid: string | undefined, toNumber: string, now: string): Promise<boolean> {
    if (!callUuid || !toNumber) return false;
    for (const [holdId, correlation] of this.correlations) {
      if (correlation.hash !== hash || !(Date.parse(correlation.expiresAt) > Date.parse(now))) continue;
      const hold = this.rows.get(holdId);
      if (!hold || hold.status !== "placed" || !hold.placementReserved || hold.humanParty?.replace(/^\+/, "") !== toNumber.replace(/^\+/, "")) return false;
      if ((hold.placedCallUuid && hold.placedCallUuid !== callUuid) || (hold.placedConversationUuid && hold.placedConversationUuid !== conversationUuid)) return false;
      hold.placedCallUuid = callUuid;
      hold.placedConversationUuid = conversationUuid;
      this.correlations.delete(holdId);
      return true;
    }
    return false;
  }
  async placed(holdId: string, callUuid: string | undefined, conversationUuid: string | undefined): Promise<void> {
    const h = this.rows.get(holdId);
    // A release places one call: the first binding stands.
    if (h && !h.placedCallUuid && !h.placedConversationUuid) Object.assign(h, { placedCallUuid: callUuid, placedConversationUuid: conversationUuid });
  }
  async forCall(callUuid: string | undefined, conversationUuid: string | undefined): Promise<Hold | undefined> {
    const rows = [...this.rows.values()].filter((h) => h.status === "placed");
    // The call's own uuid decides; the conversation is the fallback for an event that names no call.
    if (callUuid) return rows.find((h) => h.placedCallUuid === callUuid);
    if (!conversationUuid) return undefined;
    return rows.filter((h) => h.placedConversationUuid === conversationUuid).sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
  }
}

interface Row { hold_id: string; call_uuid: string | null; human_party: string | null; reason: string; verdicts: PropertyVerdict[]; status: Hold["status"]; created_at: Date; decided_by: string | null; decided_at: Date | null; placed_call_uuid: string | null; placed_conversation_uuid: string | null; placement_reserved: boolean }
const toHold = (r: Row): Hold => ({ holdId: r.hold_id, callUuid: r.call_uuid ?? undefined, humanParty: r.human_party ?? undefined, reason: r.reason, verdicts: r.verdicts, status: r.status, createdAt: r.created_at.toISOString(), decidedBy: r.decided_by ?? undefined, decidedAt: r.decided_at?.toISOString(), placedCallUuid: r.placed_call_uuid ?? undefined, placedConversationUuid: r.placed_conversation_uuid ?? undefined, placementReserved: r.placement_reserved });

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
    // A release places one call: the first binding stands.
    await this.sql`update holds set placed_call_uuid = ${callUuid ?? null}, placed_conversation_uuid = ${conversationUuid ?? null} where hold_id = ${holdId} and placed_call_uuid is null and placed_conversation_uuid is null`;
  }
  async reservePlacement(holdId: string, correlation?: PlacementCorrelation): Promise<boolean> {
    const rows = await this.sql`update holds set placement_reserved = true, placement_hash = ${correlation?.hash ?? null}, placement_expires_at = ${correlation?.expiresAt ?? null} where hold_id = ${holdId} and status = 'placed' and not placement_reserved and placed_call_uuid is null and placed_conversation_uuid is null returning hold_id`;
    return rows.length === 1;
  }
  async bindPlacement(hash: string, callUuid: string, conversationUuid: string | undefined, toNumber: string, now: string): Promise<boolean> {
    if (!callUuid || !toNumber || !Number.isFinite(Date.parse(now))) return false;
    const rows = await this.sql`update holds set placed_call_uuid = ${callUuid}, placed_conversation_uuid = ${conversationUuid ?? null}, placement_hash = null, placement_expires_at = null
      where placement_hash = ${hash} and placement_reserved and status = 'placed' and placement_expires_at > ${now}
      and regexp_replace(human_party, '^\\+', '') = ${toNumber.replace(/^\+/, "")}
      and (placed_call_uuid is null or placed_call_uuid = ${callUuid})
      and (placed_conversation_uuid is null or placed_conversation_uuid = ${conversationUuid ?? null}) returning hold_id`;
    return rows.length === 1;
  }
  async forCall(callUuid: string | undefined, conversationUuid: string | undefined): Promise<Hold | undefined> {
    // The call's own uuid decides; the conversation is the fallback for an event that names no call.
    if (callUuid) {
      const [byCall] = await this.sql<Row[]>`select * from holds where status = 'placed' and placed_call_uuid = ${callUuid} limit 1`;
      return byCall ? toHold(byCall) : undefined;
    }
    if (!conversationUuid) return undefined;
    const [r] = await this.sql<Row[]>`select * from holds where status = 'placed' and placed_conversation_uuid = ${conversationUuid} order by decided_at desc nulls last limit 1`;
    return r ? toHold(r) : undefined;
  }
}
