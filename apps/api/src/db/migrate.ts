import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

/**
 * Forward-only migrations. Every pending .sql file in ./migrations runs, in filename order, inside
 * ONE transaction that holds an advisory lock, so two processes starting at once (or parallel test
 * workers) cannot both apply the same file. Applied files are recorded in schema_migrations. There
 * is deliberately no "down": the ledger is append-only and so is its schema history.
 */
export async function runMigrations(sql: Sql, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const bodies = new Map<string, string>();
  for (const file of files) bodies.set(file, await readFile(path.join(dir, file), "utf8"));
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('preflight-migrations'))`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await tx.unsafe(bodies.get(file) ?? "");
      await tx`insert into schema_migrations (name) values (${file})`;
      ran.push(file);
    }
    return ran;
  });
}
