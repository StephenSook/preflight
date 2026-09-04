import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

/**
 * Forward-only migrations. Each .sql file in ./migrations runs once, in filename order, inside a
 * transaction, and is recorded in schema_migrations. There is deliberately no "down": the ledger is
 * append-only and so is its schema history.
 */
export async function runMigrations(sql: Sql, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    ran.push(file);
  }
  return ran;
}
