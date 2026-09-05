import type { Sql } from "postgres";

export type SoftphoneRole = "judge" | "scheduler";
/** A daily allowance: at most `max` tokens of the role recorded since `since`. */
export interface Allowance {
  since: string;
  max: number;
}

/**
 * Tokens issued, so the daily allowance of public judge tokens is counted from durable rows, not process
 * memory. Recording and counting happen as one step under a lock, so two processes sharing the database
 * cannot both issue the last token of the day.
 */
/** A slot taken for one token, or the day spent. */
export type Slot = { ok: true; id: number } | { ok: false };

export interface SoftphoneStore {
  readonly name: "memory" | "postgres";
  /** Takes a slot when the allowance (if any) has room; `ok: false` when the day is spent. Taken BEFORE the platform is asked. */
  tryRecord(role: SoftphoneRole, username: string, issuedAt: string, allowance: Allowance | undefined): Promise<Slot>;
  /** Gives a slot back when the platform refused the user, so a refusal spends nothing. */
  release(id: number): Promise<void>;
}

export class MemorySoftphoneStore implements SoftphoneStore {
  readonly name = "memory" as const;
  private readonly rows: Array<{ id: number; role: string; username: string; issuedAt: string }> = [];
  private nextId = 1;
  // No await between the count and the push: one process, one step.
  async tryRecord(role: SoftphoneRole, username: string, issuedAt: string, allowance: Allowance | undefined): Promise<Slot> {
    if (allowance && this.rows.filter((r) => r.role === role && r.issuedAt >= allowance.since).length >= allowance.max) return { ok: false };
    const id = this.nextId++;
    this.rows.push({ id, role, username, issuedAt });
    return { ok: true, id };
  }
  async release(id: number): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i >= 0) this.rows.splice(i, 1);
  }
}

export class PgSoftphoneStore implements SoftphoneStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}
  async tryRecord(role: SoftphoneRole, username: string, issuedAt: string, allowance: Allowance | undefined): Promise<Slot> {
    // One transaction under an advisory lock: the count and the insert cannot interleave with another process's.
    return this.sql.begin(async (tx): Promise<Slot> => {
      await tx`select pg_advisory_xact_lock(hashtext('softphone_tokens'))`;
      if (allowance) {
        const [r] = await tx<{ n: string }[]>`select count(*)::text as n from softphone_tokens where role = ${role} and issued_at >= ${allowance.since}`;
        if (Number(r?.n ?? 0) >= allowance.max) return { ok: false };
      }
      const [row] = await tx<{ id: string }[]>`insert into softphone_tokens (role, username, issued_at) values (${role}, ${username}, ${issuedAt}) returning id::text as id`;
      return { ok: true, id: Number(row?.id) };
    });
  }
  async release(id: number): Promise<void> {
    await this.sql`delete from softphone_tokens where id = ${id}`;
  }
}
