import { GENESIS_HASH, hashBody, verifyChain, type LedgerBody, type LedgerEntry, type VerifyResult } from "@preflight/ledger";
import type { Sql } from "postgres";

/** Everything an entry carries except what the chain assigns (seq, prev_hash) and computes (entry_hash). */
export type LedgerDraft = Omit<LedgerBody, "seq" | "prev_hash">;

export interface LedgerStore {
  readonly name: "memory" | "postgres";
  append(draft: LedgerDraft): Promise<LedgerEntry>;
  head(): Promise<{ seq: number; entry_hash: string }>;
  /** Entries with seq greater than `after`, ascending, at most `limit`. */
  entries(after: number, limit: number): Promise<LedgerEntry[]>;
  /** Walks the whole chain from genesis. */
  verify(): Promise<VerifyResult>;
}

function build(draft: LedgerDraft, seq: number, prev_hash: string): LedgerEntry {
  const body: LedgerBody = { ...draft, seq, prev_hash };
  return { ...body, entry_hash: hashBody(body) };
}

export class MemoryLedgerStore implements LedgerStore {
  readonly name = "memory" as const;
  private rows: LedgerEntry[] = [];
  async append(draft: LedgerDraft): Promise<LedgerEntry> {
    const last = this.rows[this.rows.length - 1];
    const e = build(draft, (last?.seq ?? 0) + 1, last?.entry_hash ?? GENESIS_HASH);
    this.rows.push(e);
    return e;
  }
  async head(): Promise<{ seq: number; entry_hash: string }> {
    const last = this.rows[this.rows.length - 1];
    return { seq: last?.seq ?? 0, entry_hash: last?.entry_hash ?? GENESIS_HASH };
  }
  async entries(after: number, limit: number): Promise<LedgerEntry[]> {
    return this.rows.filter((e) => e.seq > after).slice(0, limit);
  }
  async verify(): Promise<VerifyResult> {
    return verifyChain(this.rows);
  }
}

export class PgLedgerStore implements LedgerStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}

  async append(draft: LedgerDraft): Promise<LedgerEntry> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('preflight-ledger'))`;
      // No alias on seq: an aliased text column would make ORDER BY sort lexically and pick "9" over "10".
      const [last] = await tx<{ seq: string; entry_hash: string }[]>`select seq, entry_hash from ledger order by seq desc limit 1`;
      const e = build(draft, Number(last?.seq ?? 0) + 1, last?.entry_hash ?? GENESIS_HASH);
      await tx`insert into ledger (seq, entry, entry_hash, prev_hash) values (${e.seq}, ${tx.json(e as never)}, ${e.entry_hash}, ${e.prev_hash})`;
      return e;
    });
  }

  async head(): Promise<{ seq: number; entry_hash: string }> {
    const [last] = await this.sql<{ seq: string; entry_hash: string }[]>`select seq, entry_hash from ledger order by seq desc limit 1`;
    return { seq: Number(last?.seq ?? 0), entry_hash: last?.entry_hash ?? GENESIS_HASH };
  }

  async entries(after: number, limit: number): Promise<LedgerEntry[]> {
    const rows = await this.sql<{ entry: LedgerEntry }[]>`select entry from ledger where seq > ${after} order by seq asc limit ${limit}`;
    return rows.map((r) => r.entry);
  }

  async verify(): Promise<VerifyResult> {
    const all: LedgerEntry[] = [];
    let after = 0;
    for (;;) {
      const page = await this.entries(after, 5000);
      if (page.length === 0) break;
      all.push(...page);
      after = page[page.length - 1]?.seq ?? after;
    }
    return verifyChain(all);
  }
}
