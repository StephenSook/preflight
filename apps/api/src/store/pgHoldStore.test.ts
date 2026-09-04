import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgHoldStore } from "./holdStore.js";

const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgHoldStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgHoldStore(sql);
  const id = `hold-int-${Date.now()}`;
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from holds where hold_id = ${id}`;
    await sql.end({ timeout: 5 });
  });

  it("creates, lists, decides once, and refuses a second decision", async () => {
    await store.create({ holdId: id, callUuid: "c1", humanParty: "14042010000", reason: "P3: open branch", verdicts: [{ id: "P3", citation: "47 CFR 64.1200(b)(3)", verdict: "inconclusive", reason: "open" }], status: "open", createdAt: new Date().toISOString(), decidedBy: undefined, decidedAt: undefined });
    expect((await store.list("open", 100)).some((h) => h.holdId === id)).toBe(true);
    const decided = await store.decide(id, "placed", "S. Sookra", new Date().toISOString());
    expect(decided).toMatchObject({ holdId: id, status: "placed", decidedBy: "S. Sookra" });
    expect(await store.decide(id, "cancelled", "x", new Date().toISOString())).toBeUndefined();
    expect((await store.get(id))?.verdicts[0]).toMatchObject({ id: "P3", verdict: "inconclusive" });
  }, 30000);
});
