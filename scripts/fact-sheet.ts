/**
 * Regenerates the GENERATED section of docs/fact-sheet.md, the single source for every number the
 * README, the film narration and the Devpost write-up may print (CONSTITUTION, ALWAYS).
 *
 *   pnpm fact-sheet                 regenerate both blocks (runs the test suite for the count, reads the live host)
 *   pnpm fact-sheet --no-tests      keep the recorded test count
 *   pnpm fact-sheet --offline       skip the live block
 *   pnpm fact-sheet --check         exit 1 when the STATIC block or the README counts are stale (CI gate);
 *                                   the live block changes every day and is never checked
 *
 * STATIC is derived from the repository (tests, mutants, corpus, properties, migrations, routes,
 * workflows, CLI version). LIVE is read from the deployed host and stamped with the time.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROPERTIES } from "../packages/engine/src/properties.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const noTests = args.has("--no-tests") || check;
const offline = args.has("--offline") || check;
const api = (process.env["PREFLIGHT_API_URL"] ?? "https://preflight-api-rc34.onrender.com").replace(/\/$/, "");
const factSheetPath = path.join(root, "docs/fact-sheet.md");
const readmePath = path.join(root, "README.md");

const STATIC_OPEN = "<!-- generated:static -->";
const STATIC_CLOSE = "<!-- /generated:static -->";
const LIVE_OPEN = "<!-- generated:live -->";
const LIVE_CLOSE = "<!-- /generated:live -->";

function between(text: string, open: string, close: string): string | undefined {
  const a = text.indexOf(open);
  const b = text.indexOf(close);
  return a === -1 || b === -1 || b < a ? undefined : text.slice(a + open.length, b);
}

function testCount(previous: { tests: number; files: number } | undefined): { tests: number; files: number } {
  if (noTests) {
    if (!previous) throw new Error("no recorded test count to keep; run without --no-tests once");
    return previous;
  }
  const out = path.join(root, "node_modules/.cache/fact-sheet-vitest.json");
  execFileSync("pnpm", ["exec", "vitest", "run", "--reporter=json", `--outputFile=${out}`], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const j = JSON.parse(readFileSync(out, "utf8")) as { numTotalTests: number; numPassedTests: number; numTotalTestSuites: number; success: boolean };
  if (!j.success || j.numPassedTests !== j.numTotalTests) throw new Error(`the suite is not green (${j.numPassedTests} of ${j.numTotalTests}); a fact sheet is not written from a red suite`);
  return { tests: j.numTotalTests, files: j.numTotalTestSuites };
}

function previousCounts(section: string | undefined): { tests: number; files: number } | undefined {
  const m = section?.match(/^- Tests: (\d+) across (\d+) (?:suites|files)/m);
  return m ? { tests: Number(m[1]), files: Number(m[2]) } : undefined;
}

function routes(): string[] {
  const files = ["apps/api/src/server.ts", "apps/api/src/consent/routes.ts", "apps/api/src/gateway/calls.ts", "apps/api/src/hooks/branch.ts", "apps/api/src/stream.ts"];
  const found = new Set<string>();
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(/app\.(get|post|put|delete|route)(?:<[^>]*>)?\(\s*(?:\{\s*method:\s*\[[^\]]*\],\s*url:\s*)?["'`]([^"'`]+)["'`]/g)) found.add(`${m[1] === "route" ? "GET/POST" : m[1].toUpperCase()} ${m[2]}`);
  }
  return [...found].sort((a, b) => a.split(" ")[1]!.localeCompare(b.split(" ")[1]!) || a.localeCompare(b));
}

function workflows(): string[] {
  const dir = path.join(root, ".github/workflows");
  return readdirSync(dir).filter((f) => f.endsWith(".yml")).sort().map((f) => {
    const y = readFileSync(path.join(dir, f), "utf8");
    const cron = y.match(/cron:\s*"([^"]+)"/)?.[1];
    return `${f}${cron ? ` (cron \`${cron}\` UTC)` : " (on push and pull request)"}`;
  });
}

function staticBlock(counts: { tests: number; files: number }): string {
  const mutants = (JSON.parse(readFileSync(path.join(root, "scripts/mutation/mutants.json"), "utf8")) as unknown[]).length;
  const corpus = readdirSync(path.join(root, "corpus/ncco")).filter((f) => f.endsWith(".json")).length;
  const migrations = readdirSync(path.join(root, "apps/api/src/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const cli = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8")) as { name: string; version: string };
  const nanpaRows = readFileSync(path.join(root, "packages/numfacts/data/co-codes.tsv"), "utf8").split("\n").filter((l) => l.length > 0 && !l.startsWith("#")).length - 1;
  const lines = [
    `- Tests: ${counts.tests} across ${counts.files} suites (vitest, \`pnpm test\`)`,
    `- Mutants: ${mutants} hand-written (\`scripts/mutation/mutants.json\`, \`pnpm mutate\` requires every one killed)`,
    `- Labelled corpus: ${corpus} call-control objects (\`corpus/ncco\`, \`pnpm replay corpus/ncco\`)`,
    `- Number-facts table: ${nanpaRows} NPA-NXX rows (\`packages/numfacts/data/co-codes.tsv\`)`,
    `- Properties (Tier 1, armed by default):`,
    ...PROPERTIES.map((p) => `  - ${p.id} ${p.title}: \`${p.formula}\` (${p.citation})`),
    `- Migrations: ${migrations.join(", ")}`,
    `- HTTP routes: ${routes().map((r) => `\`${r}\``).join(", ")}`,
    `- Scheduled and CI workflows: ${workflows().join("; ")}`,
    `- CLI: \`${cli.name}@${cli.version}\` (\`npx ${cli.name}\`)`,
  ];
  return `\n${lines.join("\n")}\n`;
}

async function liveBlock(): Promise<string> {
  const get = async (p: string): Promise<Record<string, unknown>> => {
    const r = await fetch(`${api}${p}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  };
  const at = new Date().toISOString();
  const health = await get("/health");
  const summary = await get("/api/summary");
  const verify = await get("/api/ledger/verify");
  const flow = await get("/api/flow");
  const ledger = health["ledger"] as { seq: number; entry_hash: string };
  const decisions = health["decisions"] as Record<string, number>;
  const coverage = summary["coverage"] as { observed: string[]; declared: string[]; states: number; edges: number; openBranches: string[] };
  const latency = summary["latency"] as Record<string, number | null>;
  const rec = summary["reconciliation"] as Record<string, unknown> | null;
  const counts = flow["counts"] as Record<string, number>;
  const lines = [
    `- Read at ${at} from ${api} (deployed version ${String(health["version"])}, policy ${String(health["policy"])}, store ${String(health["store"])})`,
    `- Decisions: ${decisions["pass"]} passed, ${decisions["block"]} blocked, ${decisions["hold"]} held; ${String(health["events"])} signed event webhooks stored`,
    `- Evidence log: ${ledger.seq} entries, head \`${ledger.entry_hash}\`, verify ${verify["ok"] ? "ok" : "BROKEN"} (${String(verify["entries"])} entries recomputed from genesis)`,
    `- Coverage: ${coverage.observed.length} of ${coverage.declared.length} declared endpoints observed, ${coverage.states} states, ${coverage.edges} edges, ${coverage.openBranches.length} open branch(es)`,
    `- Declared versus actual: ${counts["declared"]} declared states, ${counts["undeclared"]} undeclared (${counts["undeclaredSpeaking"]} speaking synthetically), ${counts["neverObserved"]} declared and never observed`,
    `- Latency over the last ${latency["sample"]} decisions: verify p50 ${latency["verifyP50Ms"]} ms, p95 ${latency["verifyP95Ms"]} ms; origin p50 ${latency["originP50Ms"]} ms, p95 ${latency["originP95Ms"]} ms`,
    rec ? `- Last carrier reconciliation (${String(rec["ts"])}): ${String(rec["carrier_records"])} carrier records, ${String(rec["matched"])} matched, ${String(rec["unmatched"])} placed around the interlock, ${String(rec["leaks"])} leaked past a refusal` : "- Carrier reconciliation: none recorded yet",
  ];
  return `\n${lines.join("\n")}\n`;
}

function readmeCounts(readme: string): { badge: number | undefined; comment: number | undefined; mutantsApplied: number | undefined; mutantsKilled: number | undefined } {
  return {
    badge: Number(readme.match(/tests-(\d+)%20passing/)?.[1]) || undefined,
    comment: Number(readme.match(/# every suite, (\d+) tests/)?.[1]) || undefined,
    mutantsApplied: Number(readme.match(/applies (\d+) hand-written mutations/)?.[1]) || undefined,
    mutantsKilled: Number(readme.match(/the last run killed (\d+) of \d+/)?.[1]) || undefined,
  };
}

function mutantCount(): number {
  return (JSON.parse(readFileSync(path.join(root, "scripts/mutation/mutants.json"), "utf8")) as unknown[]).length;
}

async function main(): Promise<void> {
  const sheet = readFileSync(factSheetPath, "utf8");
  if (!sheet.includes(STATIC_OPEN) || !sheet.includes(LIVE_OPEN)) throw new Error("docs/fact-sheet.md lacks the generated markers");
  const previous = previousCounts(between(sheet, STATIC_OPEN, STATIC_CLOSE));
  const counts = testCount(previous);
  const nextStatic = staticBlock(counts);
  const readme = readFileSync(readmePath, "utf8");

  if (check) {
    const current = between(sheet, STATIC_OPEN, STATIC_CLOSE);
    const rc = readmeCounts(readme);
    const problems: string[] = [];
    if (current !== nextStatic) problems.push("the STATIC block of docs/fact-sheet.md is stale: run `pnpm fact-sheet --no-tests`");
    if (rc.badge !== counts.tests) problems.push(`README test badge says ${rc.badge}, the fact sheet says ${counts.tests}`);
    if (rc.comment !== counts.tests) problems.push(`README "every suite" line says ${rc.comment}, the fact sheet says ${counts.tests}`);
    const mutants = mutantCount();
    if (rc.mutantsApplied !== mutants || rc.mutantsKilled !== mutants) problems.push(`README says ${rc.mutantsApplied} mutants applied and ${rc.mutantsKilled} killed, mutants.json holds ${mutants}`);
    if (problems.length > 0) {
      for (const p of problems) process.stderr.write(`fact-sheet check: ${p}\n`);
      process.exit(1);
    }
    process.stdout.write(`fact-sheet check: static block and README counts agree (${counts.tests} tests)\n`);
    return;
  }

  let next = sheet.replace(new RegExp(`${STATIC_OPEN}[\\s\\S]*?${STATIC_CLOSE}`), `${STATIC_OPEN}${nextStatic}${STATIC_CLOSE}`);
  if (!offline) next = next.replace(new RegExp(`${LIVE_OPEN}[\\s\\S]*?${LIVE_CLOSE}`), `${LIVE_OPEN}${await liveBlock()}${LIVE_CLOSE}`);
  writeFileSync(factSheetPath, next);
  const mutants = mutantCount();
  const nextReadme = readme
    .replace(/tests-\d+%20passing/, `tests-${counts.tests}%20passing`)
    .replace(/# every suite, \d+ tests/, `# every suite, ${counts.tests} tests`)
    .replace(/applies \d+ hand-written mutations/, `applies ${mutants} hand-written mutations`)
    .replace(/the last run killed \d+ of \d+/, `the last run killed ${mutants} of ${mutants}`);
  if (nextReadme !== readme) writeFileSync(readmePath, nextReadme);
  process.stdout.write(`fact sheet regenerated: ${counts.tests} tests, ${offline ? "live block kept" : "live block read from " + api}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`fact-sheet: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
