import type { Sql } from "postgres";

/** The browser's PushSubscription as `JSON.stringify` renders it. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export interface StoredSubscription {
  endpoint: string;
  subscription: PushSubscriptionRecord;
  label: string | undefined;
  createdAt: string;
  lastSentAt: string | undefined;
  lastError: string | undefined;
}

export interface PushStore {
  readonly name: "memory" | "postgres";
  upsert(subscription: PushSubscriptionRecord, label: string | undefined, at: string): Promise<void>;
  remove(endpoint: string): Promise<boolean>;
  list(): Promise<StoredSubscription[]>;
  markSent(endpoint: string, at: string, error: string | undefined): Promise<void>;
}

export class MemoryPushStore implements PushStore {
  readonly name = "memory" as const;
  private readonly rows = new Map<string, StoredSubscription>();
  async upsert(subscription: PushSubscriptionRecord, label: string | undefined, at: string): Promise<void> {
    const existing = this.rows.get(subscription.endpoint);
    this.rows.set(subscription.endpoint, { endpoint: subscription.endpoint, subscription: structuredClone(subscription), label, createdAt: existing?.createdAt ?? at, lastSentAt: existing?.lastSentAt, lastError: undefined });
  }
  async remove(endpoint: string): Promise<boolean> {
    return this.rows.delete(endpoint);
  }
  async list(): Promise<StoredSubscription[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async markSent(endpoint: string, at: string, error: string | undefined): Promise<void> {
    const r = this.rows.get(endpoint);
    if (r) Object.assign(r, { lastSentAt: at, lastError: error });
  }
}

interface Row { endpoint: string; subscription: PushSubscriptionRecord; label: string | null; created_at: Date; last_sent_at: Date | null; last_error: string | null }
const toStored = (r: Row): StoredSubscription => ({ endpoint: r.endpoint, subscription: r.subscription, label: r.label ?? undefined, createdAt: r.created_at.toISOString(), lastSentAt: r.last_sent_at?.toISOString(), lastError: r.last_error ?? undefined });

export class PgPushStore implements PushStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}
  async upsert(subscription: PushSubscriptionRecord, label: string | undefined, at: string): Promise<void> {
    await this.sql`insert into push_subscriptions (endpoint, subscription, label, created_at) values (${subscription.endpoint}, ${this.sql.json(subscription as never)}, ${label ?? null}, ${at})
      on conflict (endpoint) do update set subscription = excluded.subscription, label = excluded.label, last_error = null`;
  }
  async remove(endpoint: string): Promise<boolean> {
    const rows = await this.sql`delete from push_subscriptions where endpoint = ${endpoint} returning endpoint`;
    return rows.length > 0;
  }
  async list(): Promise<StoredSubscription[]> {
    const rows = await this.sql<Row[]>`select * from push_subscriptions order by created_at asc`;
    return rows.map(toStored);
  }
  async markSent(endpoint: string, at: string, error: string | undefined): Promise<void> {
    await this.sql`update push_subscriptions set last_sent_at = ${at}, last_error = ${error ?? null} where endpoint = ${endpoint}`;
  }
}
