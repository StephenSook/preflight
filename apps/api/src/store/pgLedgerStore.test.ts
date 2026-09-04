import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgLedgerStore, type LedgerDraft } from "./ledgerStore.js";

/** Same contract as the other integration suites: under CI a missing DATABASE_URL fails, never skips. */
const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

const draft = (n: number): LedgerDraft => ({
  ts: new Date().toISOString(),
  kind: "block",
  call_uuid: `ledger-int-${n}`,
  decision: "block",
  property: "P3",
  citation: "47 CFR 64.1200(b)(3)",
  witness: ["talk#0", "talk#1"],
  ncco_hash: "sha256:" + "1f".repeat(32),
  line_type: { value: "wireless", source: "nanpa", conf: "low" },
  detail: null,
});

describe.skipIf(!url)("PgLedgerStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 3, idle_timeout: 5, connect_timeout: 15 });
  const store = new PgLedgerStore(sql);
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("appends linked entries and the whole chain verifies from genesis", async () => {
    const before = await store.head();
    const a = await store.append(draft(1));
    const b = await store.append(draft(2));
    expect(a.seq).toBe(before.seq + 1);
    expect(a.prev_hash).toBe(before.entry_hash);
    expect(b.prev_hash).toBe(a.entry_hash);
    expect(await store.head()).toEqual({ seq: b.seq, entry_hash: b.entry_hash });
    const r = await store.verify();
    expect(r.ok).toBe(true);
    expect(r.head).toBe(b.entry_hash);
  }, 60000);

  it("serialises concurrent appends so no two entries share a predecessor", async () => {
    const results = await Promise.all([3, 4, 5, 6].map((n) => store.append(draft(n))));
    const seqs = results.map((e) => e.seq).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(4);
    expect(new Set(results.map((e) => e.prev_hash)).size).toBe(4);
    expect((await store.verify()).ok).toBe(true);
  }, 60000);

  it("refuses UPDATE and DELETE on the ledger for the application role and for anyone via the trigger", async () => {
    const { seq } = await store.head();
    await expect(sql`update ledger set prev_hash = 'x' where seq = ${seq}`).rejects.toThrow(/append-only|permission denied/);
    await expect(sql`delete from ledger where seq = ${seq}`).rejects.toThrow(/append-only|permission denied/);
    await expect(sql`truncate ledger`).rejects.toThrow(/permission denied|append-only/);
    expect((await store.verify()).ok).toBe(true);
  }, 30000);
});
