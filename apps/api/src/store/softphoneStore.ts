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
export interface SoftphoneStore {
  readonly name: "memory" | "postgres";
  /** Records the token when the allowance (if any) has room; false when the day is spent. */
  tryRecord(role: SoftphoneRole, username: string, issuedAt: string, allowance: Allowance | undefined): Promise<boolean>;
}

export class MemorySoftphoneStore implements SoftphoneStore {
  readonly name = "memory" as const;
  private readonly rows: Array<{ role: string; username: string; issuedAt: string }> = [];
  // No await between the count and the push: one process, one step.
  async tryRecord(role: SoftphoneRole, username: string, issuedAt: string, allowance: Allowance | undefined): Promise<boolean> {
    if (allowance && this.rows.filter((r) => r.role === role && r.issuedAt >= allowance.since).length >= allowance.max) return false;
    this.rows.push({ role, username, issuedAt });
    return true;
  }
}

export class PgSoftphoneStore implements SoftphoneStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}
  async tryRecord(role: SoftphoneRole, username: string, issuedAt: string, allowance: Allowance | undefined): Promise<boolean> {
    // One transaction under an advisory lock: the count and the insert cannot interleave with another process's.
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('softphone_tokens'))`;
      if (allowance) {
        const [r] = await tx<{ n: string }[]>`select count(*)::text as n from softphone_tokens where role = ${role} and issued_at >= ${allowance.since}`;
        if (Number(r?.n ?? 0) >= allowance.max) return false;
      }
      await tx`insert into softphone_tokens (role, username, issued_at) values (${role}, ${username}, ${issuedAt})`;
      return true;
    });
  }
}
