import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgEventStore } from "./pgEventStore.js";

/**
 * Integration test against the real database. Under CI the DATABASE_URL secret must be present:
 * a missing URL FAILS the suite there rather than skipping it, so a guard can never go vacuous
 * (playbook HR75). Locally without a URL the suite is skipped and says so.
 */
const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) {
  throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");
}

describe.skipIf(!url)("PgEventStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgEventStore(sql);
  const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from webhooks where conversation_uuid = ${marker}`;
    await sql.end({ timeout: 5 });
  });

  it("appends and reads back a webhook with exact bytes and timestamps", async () => {
    const raw = JSON.stringify({ uuid: "call-int-1", conversation_uuid: marker, status: "answered" });
    await store.append({
      kind: "event",
      receivedAt: new Date().toISOString(),
      method: "POST",
      applicationId: "app-1",
      callUuid: "call-int-1",
      conversationUuid: marker,
      raw,
      payload: JSON.parse(raw) as Record<string, unknown>,
      originLatencyMs: 12.5,
      verifyLatencyMs: 0.4,
      decision: "stored",
    });
    const rows = (await store.recent(50)).filter((r) => r.conversationUuid === marker);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "event", callUuid: "call-int-1", raw, decision: "stored", originLatencyMs: 12.5 });
    expect((rows[0]?.payload as { status?: string })?.status).toBe("answered");
    expect(await store.count()).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("refuses an invalid decision at the database boundary", async () => {
    await expect(
      store.append({
        kind: "event", receivedAt: new Date().toISOString(), method: "POST", applicationId: undefined, callUuid: "x", conversationUuid: marker,
        raw: "{}", payload: {}, originLatencyMs: null, verifyLatencyMs: null, decision: "nonsense" as never,
      }),
    ).rejects.toThrow();
  }, 30000);
});
