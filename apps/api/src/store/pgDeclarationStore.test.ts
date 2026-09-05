import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { declarationHash, PgDeclarationStore } from "./declarationStore.js";

const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgDeclarationStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const appId = `decl-int-${Date.now()}`;
  const store = new PgDeclarationStore(sql, appId);
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from flow_declarations where application_id = ${appId}`;
    await sql.end({ timeout: 5 });
  });

  it("starts empty for an application, then returns the newest declaration with its hash, author and time", async () => {
    expect(await store.current()).toBeUndefined();
    const first = { identification: { phrases: ["This is a message from Preflight Demo Clinic"] }, endpoints: ["/menu"] };
    const a = await store.set(first, "S. Sookra", "2026-09-05T12:00:00.000Z");
    expect(a).toEqual({ declaration: first, hash: declarationHash(first), declaredBy: "S. Sookra", declaredAt: "2026-09-05T12:00:00.000Z" });
    const second = { ...first, flow: { answer: [["talk", "input"]] } };
    await store.set(second, "S. Sookra", "2026-09-05T12:05:00.000Z");
    const cur = await store.current();
    expect(cur?.declaration).toEqual(second);
    expect(cur?.hash).toBe(declarationHash(second));
    expect(cur?.hash).not.toBe(a.hash);
    // Another application's declaration is invisible here.
    const other = new PgDeclarationStore(sql, `${appId}-other`);
    expect(await other.current()).toBeUndefined();
  }, 30000);
});
