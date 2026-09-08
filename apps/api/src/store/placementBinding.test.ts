import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { MemoryHoldStore, PgHoldStore, type HoldStore } from "./holdStore.js";

const now = "2026-09-08T16:00:00.000Z";
const expiresAt = "2026-09-08T16:10:00.000Z";
const destination = "14042010000";
const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI");

function bindingTests(makeStore: () => HoldStore) {
  let sequence = 0;
  const prefix = `binding-${Date.now()}-${Math.random()}`;
  async function reserved() {
    const store = makeStore();
    const id = `${prefix}-${sequence++}`;
    await store.create({ holdId: id, callUuid: undefined, humanParty: `+${destination}`, reason: "fixture", verdicts: [], status: "open", createdAt: now, decidedAt: undefined, decidedBy: undefined });
    await store.decide(id, "placed", "fixture", now);
    expect(await store.reservePlacement(id, { hash: id, expiresAt })).toBe(true);
    return { store, id };
  }

  it("binds before201 once, preserving the first binding when the response arrives", async () => {
    const { store, id } = await reserved();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => store.bindPlacement(id, `call-${index}`, "conversation", destination, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = `call-${results.indexOf(true)}`;
    await store.placed(id, "conflicting-response", "other-conversation");
    expect(await store.get(id)).toMatchObject({ placedCallUuid: winner, placedConversationUuid: "conversation", placementReserved: true });
    expect(await store.bindPlacement(id, winner, "conversation", destination, now)).toBe(false);
    expect(await store.reservePlacement(id, { hash: "new", expiresAt })).toBe(false);
  });

  it("allows the same binding when201 precedes the first answer, but rejects a different UUID", async () => {
    const { store, id } = await reserved();
    await store.placed(id, "placed-call", "conversation");
    expect(await store.bindPlacement(id, "other-call", "conversation", destination, now)).toBe(false);
    expect(await store.bindPlacement(id, "placed-call", "other-conversation", destination, now)).toBe(false);
    expect(await store.bindPlacement(id, "placed-call", "conversation", destination, now)).toBe(true);
  });

  it("rejects unknown, expired, wrong-destination and empty-UUID claims without consuming a valid reservation", async () => {
    const { store, id } = await reserved();
    expect(await store.bindPlacement("unknown", "call", undefined, destination, now)).toBe(false);
    expect(await store.bindPlacement(id, "call", undefined, "14045550999", now)).toBe(false);
    expect(await store.bindPlacement(id, "", undefined, destination, now)).toBe(false);
    expect(await store.bindPlacement(id, "call", undefined, destination, expiresAt)).toBe(false);
    expect(await store.bindPlacement(id, "call", undefined, destination, now)).toBe(true);
    expect(JSON.stringify(await store.get(id))).not.toContain('"hash"');
  });
  return prefix;
}

describe("memory placement binding", () => { bindingTests(() => new MemoryHoldStore()); });

describe.skipIf(!url)("Postgres placement binding", () => {
  const sql = postgres(url ?? "", { max: 8, idle_timeout: 5 });
  beforeAll(async () => { await runMigrations(sql); }, 60000);
  const prefix = bindingTests(() => new PgHoldStore(sql));
  afterAll(async () => {
    await sql`delete from holds where hold_id like ${`${prefix}-%`}`;
    await sql.end({ timeout: 5 });
  });
});
