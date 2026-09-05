import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgInsightStore } from "./insightStore.js";

const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgInsightStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgInsightStore(sql);
  const line = `9${String(Date.now()).slice(-9)}`;
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from number_insights where line = ${line}`;
    await sql.end({ timeout: 5 });
  });

  it("stores one row per line, the newest lookup replacing the older, and counts lookups since a time", async () => {
    expect(await store.get(line)).toBeUndefined();
    const at = new Date().toISOString();
    await store.put({ line, status: "error", insight: undefined, error: "HTTP 403", httpStatus: 403, latencyMs: 120, lookedUpAt: at });
    expect(await store.get(line)).toMatchObject({ line, status: "error", error: "HTTP 403", httpStatus: 403 });
    const insight = { timeZones: ["America/Boise"], lineType: "wireless" as const, lineTypeFrom: "current_carrier" as const, carrier: "Verizon", valid: true, requestId: "r1" };
    await store.put({ line, status: "ok", insight, error: undefined, httpStatus: 200, latencyMs: 600, lookedUpAt: new Date().toISOString() });
    expect(await store.get(line)).toMatchObject({ status: "ok", insight, error: undefined });
    expect(await store.countSince(at)).toBeGreaterThanOrEqual(1);
    expect(await store.countSince(new Date(Date.now() + 60_000).toISOString())).toBe(0);
  }, 30000);
});
