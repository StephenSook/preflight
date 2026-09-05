import { existsSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { NumberFactsResolver } from "@preflight/numfacts";
import { applicationPrivateKeyPem, applicationPublicKeyPem, declarationFrom, loadConfig, selfPingTarget } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { buildServer } from "./server.js";
import { MemoryConsentStore, PgConsentStore, type ConsentStore } from "./store/consentStore.js";
import { MemoryDecisionStore, PgDecisionStore, type DecisionStore } from "./store/decisionStore.js";
import { MemoryDeclarationStore, PgDeclarationStore, type DeclarationStore } from "./store/declarationStore.js";
import { MemoryInsightStore, PgInsightStore, type InsightStore } from "./store/insightStore.js";
import { MemoryEventStore, type EventStore } from "./store/eventStore.js";
import { MemoryGraphStore, PgGraphStore, type GraphStore } from "./store/graphStore.js";
import { MemoryHoldStore, PgHoldStore, type HoldStore } from "./store/holdStore.js";
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
  let holds: HoldStore = new MemoryHoldStore();
  let consents: ConsentStore = new MemoryConsentStore();
  let declarations: DeclarationStore = new MemoryDeclarationStore();
  let insights: InsightStore = new MemoryInsightStore();
  let sql: Sql | undefined;
  if (config.DATABASE_URL) {
    // Notices ("relation already exists, skipping" from every idempotent create) are not worth a log line per boot.
    sql = postgres(config.DATABASE_URL, { max: 5, idle_timeout: 20, connect_timeout: 10, onnotice: () => undefined });
    const ran = await runMigrations(sql);
    store = new PgEventStore(sql);
    decisions = new PgDecisionStore(sql);
    ledger = new PgLedgerStore(sql);
    graphStore = new PgGraphStore(sql, config.VONAGE_APPLICATION_ID);
    holds = new PgHoldStore(sql);
    consents = new PgConsentStore(sql);
    declarations = new PgDeclarationStore(sql, config.VONAGE_APPLICATION_ID);
    insights = new PgInsightStore(sql);
    process.stdout.write(`migrations applied: ${ran.length === 0 ? "none pending" : ran.join(", ")}\n`);
  }

  const publicKeyPem = applicationPublicKeyPem(config);
  if (!publicKeyPem) process.stderr.write("no application public key (VONAGE_APPLICATION_PUBLIC_KEY_PEM or _PATH): the create-call gateway will refuse every caller\n");
  const privateKeyPem = applicationPrivateKeyPem(config);
  if (!privateKeyPem) process.stderr.write("no application private key (VONAGE_PRIVATE_KEY_PEM or _PATH): the consent gate and the demonstration call are off\n");
  const app = buildServer({ config, store, decisions, ledger, graphStore, holds, consents, declarations, insights, resolver, declaration, applicationPublicKeyPem: publicKeyPem, applicationPrivateKeyPem: privateKeyPem });
  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info({ address, origin: config.ORIGIN_ANSWER_URL, policy: config.POLICY_MODE, store: store.name, nanpaFileUpdated: resolver.sources.nanpa.fileUpdated, declared: Object.keys(declaration), reference: config.REFERENCE_APP === "on" ? config.REFERENCE_MODE : "off" }, "preflight api listening");

  const pingTarget = selfPingTarget(config);
  if (pingTarget) {
    const everyMs = 4 * 60 * 1000;
    const timer = setInterval(() => {
      fetch(pingTarget).catch((err: unknown) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "self-ping failed"));
    }, everyMs);
    timer.unref();
    app.log.info({ target: pingTarget, everySeconds: everyMs / 1000 }, "self-ping on: the free host sleeps without traffic");
  }

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
