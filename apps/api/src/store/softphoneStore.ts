import type { Sql } from "postgres";

/** Tokens issued, so the daily allowance of public judge tokens is counted from durable rows, not process memory. */
export interface SoftphoneStore {
  readonly name: "memory" | "postgres";
  record(role: "judge" | "scheduler", username: string, issuedAt: string): Promise<void>;
  countSince(role: "judge" | "scheduler", sinceIso: string): Promise<number>;
}

export class MemorySoftphoneStore implements SoftphoneStore {
  readonly name = "memory" as const;
  private readonly rows: Array<{ role: string; username: string; issuedAt: string }> = [];
  async record(role: "judge" | "scheduler", username: string, issuedAt: string): Promise<void> {
    this.rows.push({ role, username, issuedAt });
  }
  async countSince(role: "judge" | "scheduler", sinceIso: string): Promise<number> {
    return this.rows.filter((r) => r.role === role && r.issuedAt >= sinceIso).length;
  }
}

export class PgSoftphoneStore implements SoftphoneStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}
  async record(role: "judge" | "scheduler", username: string, issuedAt: string): Promise<void> {
    await this.sql`insert into softphone_tokens (role, username, issued_at) values (${role}, ${username}, ${issuedAt})`;
  }
  async countSince(role: "judge" | "scheduler", sinceIso: string): Promise<number> {
    const [r] = await this.sql<{ n: string }[]>`select count(*)::text as n from softphone_tokens where role = ${role} and issued_at >= ${sinceIso}`;
    return Number(r?.n ?? 0);
  }
}
