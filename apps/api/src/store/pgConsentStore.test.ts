import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgConsentStore } from "./consentStore.js";

/** Same contract as the other integration suites: under CI a missing DATABASE_URL fails, never skips. */
const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgConsentStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgConsentStore(sql);
  const marker = `consent-int-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const number = `1404555${String(Date.now() % 10000).padStart(4, "0")}`;
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from consents where request_id like ${marker + "%"}`;
    await sql.end({ timeout: 5 });
  });

  it("creates, grants once, uses once, releases, refuses after expiry, and counts", async () => {
    const t0 = Date.parse("2026-09-04T16:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const id = `${marker}-1`;
    await store.create({ requestId: id, number, requestedAt: iso(t0), grantedAt: undefined, expiresAt: undefined, usedAt: undefined });
    expect((await store.get(id))?.grantedAt).toBeUndefined();
    expect((await store.latestForNumber(number))?.requestId).toBe(id);
    expect(await store.use(id, iso(t0 + 1000))).toBeUndefined();
    expect((await store.grant(id, iso(t0 + 2000), iso(t0 + 900000)))?.grantedAt).toBe(iso(t0 + 2000));
    expect(await store.grant(id, iso(t0 + 3000), iso(t0 + 900000))).toBeUndefined();
    const used = await store.use(id, iso(t0 + 4000));
    expect(used?.usedAt).toBe(iso(t0 + 4000));
    expect(await store.use(id, iso(t0 + 5000))).toBeUndefined();
    await store.release(id, iso(t0 + 4000));
    expect((await store.use(id, iso(t0 + 6000)))?.usedAt).toBe(iso(t0 + 6000));
    await store.release(id, iso(t0 + 6000));
    expect(await store.use(id, iso(t0 + 900001))).toBeUndefined();
    expect(await store.countRequestedSince(iso(t0 - 1))).toBeGreaterThanOrEqual(1);
    expect((await store.use(id, iso(t0 + 7000)))?.usedAt).toBe(iso(t0 + 7000));
    expect(await store.countUsedSince(iso(t0 - 1))).toBeGreaterThanOrEqual(1);
  }, 30000);
});
