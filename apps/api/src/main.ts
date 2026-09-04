import { existsSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { NumberFactsResolver } from "@preflight/numfacts";
import { declarationFrom, loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { buildServer } from "./server.js";
import { MemoryDecisionStore, PgDecisionStore, type DecisionStore } from "./store/decisionStore.js";
import { MemoryEventStore, type EventStore } from "./store/eventStore.js";
import { MemoryGraphStore, PgGraphStore, type GraphStore } from "./store/graphStore.js";
import { MemoryLedgerStore, PgLedgerStore, type LedgerStore } from "./store/ledgerStore.js";
import { PgEventStore } from "./store/pgEventStore.js";

// Local development reads .env; a hosted process gets its variables from the platform and has no
// file. Variables already present in the environment always win.
if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const declaration = declarationFrom(config);

async function main(): Promise<void> {
  const resolver = NumberFactsResolver.load();
  let store: EventStore = new MemoryEventStore();
  let decisions: DecisionStore = new MemoryDecisionStore();
  let ledger: LedgerStore = new MemoryLedgerStore();
  let graphStore: GraphStore = new MemoryGraphStore();
  let sql: Sql | undefined;
  if (config.DATABASE_URL) {
    sql = postgres(config.DATABASE_URL, { max: 5, idle_timeout: 20, connect_timeout: 10 });
    const ran = await runMigrations(sql);
    store = new PgEventStore(sql);
    decisions = new PgDecisionStore(sql);
    ledger = new PgLedgerStore(sql);
    graphStore = new PgGraphStore(sql, config.VONAGE_APPLICATION_ID);
    process.stdout.write(`migrations applied: ${ran.length === 0 ? "none pending" : ran.join(", ")}\n`);
  }

  const app = buildServer({ config, store, decisions, ledger, graphStore, resolver, declaration });
  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info({ address, origin: config.ORIGIN_ANSWER_URL, policy: config.POLICY_MODE, store: store.name, nanpaFileUpdated: resolver.sources.nanpa.fileUpdated, declared: Object.keys(declaration), reference: config.REFERENCE_APP === "on" ? config.REFERENCE_MODE : "off" }, "preflight api listening");

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "preflight api shutting down");
    await app.close();
    await sql?.end({ timeout: 5 });
    process.exit(0);
  };
  process.once("SIGTERM", (s) => void shutdown(s));
  process.once("SIGINT", (s) => void shutdown(s));
}

main().catch((err: unknown) => {
  process.stderr.write(`preflight api failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
