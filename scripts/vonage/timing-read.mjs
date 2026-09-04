// Reads the webhooks the running Preflight stored for one call and prints them in arrival order, so the
// answer webhook's position relative to `ringing`, `answered` and `completed` is a measured fact.
import postgres from "../../apps/api/node_modules/postgres/src/index.js";
import { loadEnv } from "./jwt.mjs";

const uuid = process.argv[2];
if (!uuid) {
  console.error("usage: node scripts/vonage/timing-read.mjs <call uuid>");
  process.exit(1);
}
const { env } = loadEnv();
const sql = postgres(env.DATABASE_URL, { max: 1 });
const rows = await sql`select kind, received_at, method, payload->>'status' as status, payload->>'direction' as direction, payload->>'timestamp' as vonage_ts from webhooks where call_uuid = ${uuid} or conversation_uuid = ${uuid} order by received_at asc, id asc`;
await sql.end();
const t0 = rows[0] ? new Date(rows[0].received_at).getTime() : 0;
for (const r of rows) console.log(`${String(new Date(r.received_at).getTime() - t0).padStart(6)} ms  ${r.kind.padEnd(8)} ${(r.status ?? "").padEnd(10)} vonage_ts=${r.vonage_ts ?? "-"}`);
const answerIdx = rows.findIndex((r) => r.kind === "answer");
const ringingIdx = rows.findIndex((r) => r.kind === "event" && r.status === "ringing");
if (answerIdx === -1 || ringingIdx === -1) console.log("\nverdict: incomplete (answer or ringing webhook missing)");
else console.log(`\nverdict: answer webhook arrived ${answerIdx > ringingIdx ? "AFTER" : "BEFORE"} the ringing event (prediction ${answerIdx > ringingIdx ? "A: gateway is load-bearing" : "B: webhook path suffices"})`);
