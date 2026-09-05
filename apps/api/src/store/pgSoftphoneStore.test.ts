import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgSoftphoneStore } from "./softphoneStore.js";

/** Same contract as the other integration suites: under CI a missing DATABASE_URL fails, never skips. */
const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgSoftphoneStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 4, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgSoftphoneStore(sql);
  // A synthetic day of its own, far in the future and unique to this run, so concurrent CI runs and old rows cannot interfere.
  const day = new Date(Date.UTC(2100, 0, 1) + Math.floor(Math.random() * 20000) * 86_400_000);
  const since = day.toISOString();
  const at = (m: number) => new Date(day.getTime() + m * 60_000).toISOString();
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from softphone_tokens where issued_at >= ${since} and issued_at < ${at(24 * 60)}`;
    await sql.end();
  });

  it("records under the allowance, refuses at it, and counts only the role and the day asked about", async () => {
    expect(await store.tryRecord("judge", "judge-aaaa", at(1), { since, max: 2 })).toMatchObject({ ok: true });
    const second = await store.tryRecord("judge", "judge-bbbb", at(2), { since, max: 2 });
    expect(second).toMatchObject({ ok: true });
    expect(await store.tryRecord("judge", "judge-cccc", at(3), { since, max: 2 })).toEqual({ ok: false });
    // A released slot (the platform refused the user) is free again.
    if (second.ok) await store.release(second.id);
    expect(await store.tryRecord("judge", "judge-cccc", at(3), { since, max: 2 })).toMatchObject({ ok: true });
    // The scheduler has no allowance, and a judge row from before the day does not count.
    expect(await store.tryRecord("scheduler", "scheduler", at(4), undefined)).toMatchObject({ ok: true });
    expect(await store.tryRecord("judge", "judge-dddd", at(5), { since: at(4), max: 1 })).toMatchObject({ ok: true });
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from softphone_tokens where issued_at >= ${since} and issued_at < ${at(24 * 60)}`;
    expect(Number(n?.n)).toBe(4);
  });

  it("issues exactly the allowance under concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.tryRecord("judge", `judge-race-${i}`, at(60 + i), { since: at(60), max: 3 })));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });
});
