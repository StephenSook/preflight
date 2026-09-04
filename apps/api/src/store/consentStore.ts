import type { Sql } from "postgres";

/**
 * Consent to one demonstration call, granted by a Verify v2 code spoken to the phone in question.
 * A consent is single use: `use` succeeds once, only while granted and unexpired, and never twice.
 */
export interface Consent {
  requestId: string;
  /** Digits only, E.164 without the plus. Never returned unmasked by the API. */
  number: string;
  requestedAt: string;
  grantedAt: string | undefined;
  expiresAt: string | undefined;
  usedAt: string | undefined;
}

export interface ConsentStore {
  readonly name: "memory" | "postgres";
  create(consent: Consent): Promise<void>;
  get(requestId: string): Promise<Consent | undefined>;
  latestForNumber(number: string): Promise<Consent | undefined>;
  grant(requestId: string, grantedAt: string, expiresAt: string): Promise<Consent | undefined>;
  /** Marks the consent used at `usedAt`; undefined when it is not granted, already used, or expired at that instant. */
  use(requestId: string, usedAt: string): Promise<Consent | undefined>;
  /** Undoes a `use` whose call was never placed, so the consent still covers a retry within its window. */
  release(requestId: string, usedAt: string): Promise<void>;
  countRequestedSince(iso: string): Promise<number>;
  countUsedSince(iso: string): Promise<number>;
}

export class MemoryConsentStore implements ConsentStore {
  readonly name = "memory" as const;
  private readonly rows = new Map<string, Consent>();
  async create(c: Consent): Promise<void> {
    this.rows.set(c.requestId, { ...c });
  }
  async get(requestId: string): Promise<Consent | undefined> {
    const c = this.rows.get(requestId);
    return c ? { ...c } : undefined;
  }
  async latestForNumber(number: string): Promise<Consent | undefined> {
    const c = [...this.rows.values()].filter((x) => x.number === number).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
    return c ? { ...c } : undefined;
  }
  async grant(requestId: string, grantedAt: string, expiresAt: string): Promise<Consent | undefined> {
    const c = this.rows.get(requestId);
    if (!c || c.grantedAt) return undefined;
    c.grantedAt = grantedAt;
    c.expiresAt = expiresAt;
    return { ...c };
  }
  async use(requestId: string, usedAt: string): Promise<Consent | undefined> {
    const c = this.rows.get(requestId);
    if (!c || !c.grantedAt || c.usedAt || !c.expiresAt || c.expiresAt <= usedAt) return undefined;
    c.usedAt = usedAt;
    return { ...c };
  }
  async release(requestId: string, usedAt: string): Promise<void> {
    const c = this.rows.get(requestId);
    if (c && c.usedAt === usedAt) c.usedAt = undefined;
  }
  async countRequestedSince(iso: string): Promise<number> {
    return [...this.rows.values()].filter((c) => c.requestedAt >= iso).length;
  }
  async countUsedSince(iso: string): Promise<number> {
    return [...this.rows.values()].filter((c) => c.usedAt !== undefined && c.usedAt >= iso).length;
  }
}

interface Row { request_id: string; number: string; requested_at: Date; granted_at: Date | null; expires_at: Date | null; used_at: Date | null }
const toConsent = (r: Row): Consent => ({ requestId: r.request_id, number: r.number, requestedAt: r.requested_at.toISOString(), grantedAt: r.granted_at?.toISOString(), expiresAt: r.expires_at?.toISOString(), usedAt: r.used_at?.toISOString() });

export class PgConsentStore implements ConsentStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}
  async create(c: Consent): Promise<void> {
    await this.sql`insert into consents (request_id, number, requested_at) values (${c.requestId}, ${c.number}, ${c.requestedAt})`;
  }
  async get(requestId: string): Promise<Consent | undefined> {
    const [r] = await this.sql<Row[]>`select * from consents where request_id = ${requestId}`;
    return r ? toConsent(r) : undefined;
  }
  async latestForNumber(number: string): Promise<Consent | undefined> {
    const [r] = await this.sql<Row[]>`select * from consents where number = ${number} order by requested_at desc limit 1`;
    return r ? toConsent(r) : undefined;
  }
  async grant(requestId: string, grantedAt: string, expiresAt: string): Promise<Consent | undefined> {
    const [r] = await this.sql<Row[]>`update consents set granted_at = ${grantedAt}, expires_at = ${expiresAt} where request_id = ${requestId} and granted_at is null returning *`;
    return r ? toConsent(r) : undefined;
  }
  async use(requestId: string, usedAt: string): Promise<Consent | undefined> {
    const [r] = await this.sql<Row[]>`update consents set used_at = ${usedAt} where request_id = ${requestId} and granted_at is not null and used_at is null and expires_at > ${usedAt} returning *`;
    return r ? toConsent(r) : undefined;
  }
  async release(requestId: string, usedAt: string): Promise<void> {
    await this.sql`update consents set used_at = null where request_id = ${requestId} and used_at = ${usedAt}`;
  }
  async countRequestedSince(iso: string): Promise<number> {
    const [r] = await this.sql<{ n: string }[]>`select count(*)::text as n from consents where requested_at >= ${iso}`;
    return Number(r?.n ?? 0);
  }
  async countUsedSince(iso: string): Promise<number> {
    const [r] = await this.sql<{ n: string }[]>`select count(*)::text as n from consents where used_at is not null and used_at >= ${iso}`;
    return Number(r?.n ?? 0);
  }
}
