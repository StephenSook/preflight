import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgPushStore } from "./pushStore.js";

const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgPushStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgPushStore(sql);
  const endpoint = `https://push.example/int-${Date.now()}`;
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from push_subscriptions where endpoint = ${endpoint}`;
    await sql.end({ timeout: 5 });
  });

  it("upserts by endpoint, records sends and errors, and removes", async () => {
    const sub = { endpoint, keys: { p256dh: "p", auth: "a" } };
    await store.upsert(sub, "phone", new Date().toISOString());
    await store.upsert({ ...sub, keys: { p256dh: "p2", auth: "a2" } }, "phone 2", new Date().toISOString());
    const rows = (await store.list()).filter((r) => r.endpoint === endpoint);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "phone 2", subscription: { keys: { p256dh: "p2" } }, lastError: undefined });
    await store.markSent(endpoint, new Date().toISOString(), "410 Gone");
    expect((await store.list()).find((r) => r.endpoint === endpoint)?.lastError).toBe("410 Gone");
    expect(await store.remove(endpoint)).toBe(true);
    expect(await store.remove(endpoint)).toBe(false);
  }, 30000);
});
