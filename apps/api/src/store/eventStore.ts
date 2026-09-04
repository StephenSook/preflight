/**
 * Every webhook Preflight admits is stored with a received-at timestamp. This is the raw material for
 * the rate properties (P6 abandonment with the human-answered denominator, P7 ring duration, P8 the
 * platform's own acceptable-use limit) and for the replay corpus. The Postgres implementation lands
 * once the database exists; the memory implementation keeps the server honest until then and serves
 * the unit tests.
 */

export type WebhookKind = "answer" | "event" | "fallback";

export interface StoredWebhook {
  kind: WebhookKind;
  receivedAt: string;
  method: "GET" | "POST";
  applicationId: string | undefined;
  callUuid: string | undefined;
  conversationUuid: string | undefined;
  /** Exact bytes received (body for POST, query string for GET). */
  raw: string;
  /** Parsed form of the payload, when it parsed. */
  payload: Record<string, unknown> | undefined;
  originLatencyMs: number | null;
  verifyLatencyMs: number | null;
  decision: "pass" | "block" | "hold" | "forwarded" | "stored" | null;
}

export interface EventStore {
  append(row: StoredWebhook): Promise<void>;
  /** Most recent rows first. */
  recent(limit: number): Promise<StoredWebhook[]>;
  count(): Promise<number>;
}

export class MemoryEventStore implements EventStore {
  private rows: StoredWebhook[] = [];
  async append(row: StoredWebhook): Promise<void> {
    this.rows.push(row);
  }
  async recent(limit: number): Promise<StoredWebhook[]> {
    return this.rows.slice(-limit).reverse();
  }
  async count(): Promise<number> {
    return this.rows.length;
  }
}
