import type { JSONValue, Sql } from "postgres";
import type { EventStore, StoredWebhook, WebhookKind } from "./eventStore.js";

interface Row {
  kind: WebhookKind;
  received_at: Date;
  method: "GET" | "POST";
  application_id: string | null;
  call_uuid: string | null;
  conversation_uuid: string | null;
  raw: string;
  payload: Record<string, unknown> | null;
  origin_latency_ms: number | null;
  verify_latency_ms: number | null;
  decision: StoredWebhook["decision"];
}

function toStored(r: Row): StoredWebhook {
  return {
    kind: r.kind,
    receivedAt: r.received_at.toISOString(),
    method: r.method,
    applicationId: r.application_id ?? undefined,
    callUuid: r.call_uuid ?? undefined,
    conversationUuid: r.conversation_uuid ?? undefined,
    raw: r.raw,
    payload: r.payload ?? undefined,
    originLatencyMs: r.origin_latency_ms,
    verifyLatencyMs: r.verify_latency_ms,
    decision: r.decision,
  };
}

export class PgEventStore implements EventStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql) {}

  async append(row: StoredWebhook): Promise<void> {
    await this.sql`
      insert into webhooks (kind, received_at, method, application_id, call_uuid, conversation_uuid, raw, payload, origin_latency_ms, verify_latency_ms, decision)
      values (${row.kind}, ${row.receivedAt}, ${row.method}, ${row.applicationId ?? null}, ${row.callUuid ?? null}, ${row.conversationUuid ?? null}, ${row.raw}, ${row.payload ? this.sql.json(row.payload as JSONValue) : null}, ${row.originLatencyMs}, ${row.verifyLatencyMs}, ${row.decision})
    `;
  }

  async recent(limit: number): Promise<StoredWebhook[]> {
    const rows = await this.sql<Row[]>`select kind, received_at, method, application_id, call_uuid, conversation_uuid, raw, payload, origin_latency_ms, verify_latency_ms, decision from webhooks order by received_at desc, id desc limit ${limit}`;
    return rows.map(toStored);
  }

  async count(): Promise<number> {
    const [r] = await this.sql<{ n: string }[]>`select count(*)::text as n from webhooks`;
    return Number(r?.n ?? 0);
  }
}
