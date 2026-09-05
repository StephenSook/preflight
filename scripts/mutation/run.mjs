#!/usr/bin/env node
/**
 * Mutation-testing harness for the engine, ledger and number-facts packages.
 *
 * Every entry in mutants.json is a hand-written semantic mutation: {id, file, find, replace, why}.
 * For each one the harness rewrites `find` to `replace` in place (the string must occur exactly
 * once), runs the mutated package's vitest suite with output captured to a log file, records
 * killed (the suite went red) or survived (it stayed green), and restores the file byte-for-byte
 * from the bytes it saved before touching anything. The suite is chosen by package directory:
 * an engine mutant runs the engine suite, a ledger mutant the ledger suite, and so on.
 *
 * Guard rails, in order:
 *   1. Refuses to start while `git status --porcelain` shows a modified tracked NON-TEST file under
 *      packages/, so a crash mid-run can never hide behind other work. Modified *.test.ts files are
 *      allowed and listed, because adding tests to kill survivors is this harness's own workflow;
 *      a test file is never a mutation target.
 *   2. Validates every mutant before applying any: file under packages/, not a test, `find`
 *      present exactly once, `find` differs from `replace`, ids unique.
 *   3. Runs each affected suite unmutated first and aborts if it is already red, because a red
 *      baseline would report every mutant as killed.
 *   4. Restores on every path (normal, throw, SIGINT, SIGTERM, SIGHUP); verifies each restore by
 *      re-reading the file and comparing bytes; a restore that does not match prints the file name
 *      loudly and exits 2. A suite that died by signal (an interrupted run) is an abort, never a
 *      kill, so a Ctrl-C can never be recorded as a test failure.
 *   5. At the end runs `git diff --stat -- packages/` and exits 2 if any non-test file under
 *      packages/ differs from HEAD.
 *
 * Exit codes: 0 every mutant killed, 1 at least one survived, 2 a guard rail fired.
 *
 * Usage:  pnpm mutate                                (all mutants)
 *         pnpm mutate --only id1,id2                 (a subset, by id)
 *         pnpm mutate --only id --grep "test name"   (one vitest -t pattern; proves which test kills)
 *         MUTATE_OUT=<dir> pnpm mutate               (log directory; default is a fresh temp dir)
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const mutantsPath = path.join(here, "mutants.json");
const vitestBin = path.join(root, "node_modules/vitest/vitest.mjs");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};
const onlyFlag = flag("--only");
const only = onlyFlag === undefined ? undefined : new Set(onlyFlag.split(",").map((s) => s.trim()).filter(Boolean));
const grep = flag("--grep");

function fail(message) {
  process.stderr.write(`\nMUTATE: ${message}\n`);
  process.exit(2);
}

function git(...cmd) {
  const r = spawnSync("git", cmd, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${cmd.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const isTestFile = (file) => /\.test\.[cm]?[jt]sx?$/.test(file);

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// ---------------------------------------------------------------------------------------------
// Guard 1: a clean working tree under packages/, test files excepted.
// ---------------------------------------------------------------------------------------------
{
  const porcelain = git("status", "--porcelain", "--", "packages/");
  const dirtySource = [];
  const dirtyTests = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    if (status === "??" || status === "!!") continue;
    const rawPath = line.slice(3);
    const file = rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath;
    (isTestFile(file) ? dirtyTests : dirtySource).push(`${status} ${file}`);
  }
  if (dirtySource.length > 0) {
    fail(`refusing to start: modified tracked files under packages/ (commit, stash, or restore them first):\n  ${dirtySource.join("\n  ")}`);
  }
  if (dirtyTests.length > 0) {
    process.stdout.write(`note: modified test files under packages/ (allowed, never mutated):\n  ${dirtyTests.join("\n  ")}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Guard 2: validate every mutant before touching any file.
// ---------------------------------------------------------------------------------------------
if (!existsSync(vitestBin)) fail(`vitest not found at ${vitestBin}; run pnpm install`);
const allMutants = JSON.parse(readFileSync(mutantsPath, "utf8"));
if (!Array.isArray(allMutants) || allMutants.length === 0) fail("mutants.json must be a non-empty array");

const problems = [];
const seenIds = new Set();
const originals = new Map(); // absolute file path -> Buffer
for (const [i, m] of allMutants.entries()) {
  const where = `mutants.json[${i}]${m && typeof m.id === "string" ? ` (${m.id})` : ""}`;
  for (const k of ["id", "file", "find", "replace", "why"]) {
    if (typeof m?.[k] !== "string") problems.push(`${where}: "${k}" must be a string`);
  }
  if (problems.length > 0 && typeof m?.file !== "string") continue;
  if (seenIds.has(m.id)) problems.push(`${where}: duplicate id`);
  seenIds.add(m.id);
  if (!m.file.startsWith("packages/")) problems.push(`${where}: file must live under packages/`);
  if (isTestFile(m.file)) problems.push(`${where}: a test file is never a mutation target`);
  if (m.find.length === 0) problems.push(`${where}: "find" is empty`);
  if (m.find === m.replace) problems.push(`${where}: "find" and "replace" are identical`);
  const abs = path.join(root, m.file);
  if (!existsSync(abs)) {
    problems.push(`${where}: ${m.file} does not exist`);
    continue;
  }
  if (!originals.has(abs)) originals.set(abs, readFileSync(abs));
  const n = countOccurrences(originals.get(abs).toString("utf8"), m.find);
  if (n !== 1) problems.push(`${where}: "find" occurs ${n} times in ${m.file}, must be exactly once`);
}
if (problems.length > 0) fail(`mutants.json is not usable:\n  ${problems.join("\n  ")}`);

const mutants = only ? allMutants.filter((m) => only.has(m.id)) : allMutants;
if (only) {
  const missing = [...only].filter((id) => !allMutants.some((m) => m.id === id));
  if (missing.length > 0) fail(`--only names unknown mutants: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------------------------
// Restore machinery. Idempotent; runs on every exit path.
// ---------------------------------------------------------------------------------------------
const mutatedNow = new Set(); // absolute paths currently holding mutated bytes
let restoreFailed = false;
let currentChild = null;
let interruptedBy = null;

function restoreAll() {
  for (const abs of [...mutatedNow]) {
    const original = originals.get(abs);
    try {
      writeFileSync(abs, original);
      const back = readFileSync(abs);
      if (!back.equals(original)) throw new Error("bytes differ after writing the original back");
      mutatedNow.delete(abs);
    } catch (err) {
      restoreFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n${"!".repeat(88)}\nMUTATE: FAILED TO RESTORE ${path.relative(root, abs)}\n  ${msg}\n  The file may still hold a mutant. Restore it by hand: git checkout -- ${path.relative(root, abs)}\n${"!".repeat(88)}\n`);
    }
  }
}

process.on("exit", () => restoreAll());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    interruptedBy = sig;
    if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) currentChild.kill("SIGKILL");
    restoreAll();
    process.stderr.write(`\nMUTATE: interrupted by ${sig}; originals restored${restoreFailed ? " WITH FAILURES" : ""}, nothing recorded for the interrupted mutant\n`);
    process.exit(2);
  });
}

// ---------------------------------------------------------------------------------------------
// Suites and the runner.
// ---------------------------------------------------------------------------------------------
const outDir = process.env.MUTATE_OUT ? path.resolve(process.env.MUTATE_OUT) : mkdtempSync(path.join(tmpdir(), "preflight-mutate-"));
mkdirSync(outDir, { recursive: true });

/** The vitest path filter for a mutant: the package's src directory, e.g. packages/engine/src. */
function suiteFor(file) {
  const pkg = file.split("/")[1];
  if (!pkg) fail(`cannot pick a suite for ${file}`);
  return `packages/${pkg}/src`;
}

/**
 * Runs one vitest subset with stdout and stderr streamed to a log file. Asynchronous on purpose:
 * while the child runs, the event loop is free, so a signal handler fires at once instead of
 * after the whole loop, which is what a synchronous spawn would force.
 */
function runSuite(suite, logName) {
  const logPath = path.join(outDir, `${logName}.log`);
  const fd = openSync(logPath, "w");
  const started = performance.now();
  const vitestArgs = [vitestBin, "run", suite, ...(grep ? ["-t", grep] : [])];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, vitestArgs, {
      cwd: root,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    currentChild = child;
    child.on("exit", (status, signal) => {
      currentChild = null;
      closeSync(fd);
      const seconds = (performance.now() - started) / 1000;
      const log = readFileSync(logPath, "utf8");
      const firstFailure = (() => {
        const m = /^\s*(?:FAIL|×)\s+(.+?)\s*$/m.exec(log);
        if (m) return m[1].replace(/\s+\d+ms$/, "");
        const e = /^\s*(?:Error|TypeError|RangeError):\s+(.+?)\s*$/m.exec(log);
        return e ? e[1] : "";
      })();
      // vitest exits 0 when a -t filter matches nothing (every test skipped), so a green exit is
      // only a green suite when at least one test actually passed.
      const passed = Number(/^\s*Tests\s+(?:.*?\|\s*)?(\d+) passed/m.exec(log)?.[1] ?? 0);
      resolve({ green: status === 0 && passed > 0, passed, exit: status === null ? `signal ${signal}` : status, signal, seconds, logPath, firstFailure });
    });
  });
}

async function main() {
  // Guard 3: every affected suite is green before any mutation.
  const suites = [...new Set(mutants.map((m) => suiteFor(m.file)))];
  process.stdout.write(`logs: ${outDir}\nmutants: ${mutants.length} of ${allMutants.length}${only ? " (--only)" : ""}${grep ? `\nvitest -t: ${JSON.stringify(grep)}` : ""}\nbaseline:\n`);
  for (const suite of suites) {
    const r = await runSuite(suite, `baseline-${suite.split("/")[1]}`);
    process.stdout.write(`  ${suite.padEnd(28)} ${r.green ? "green" : "RED"}  ${r.seconds.toFixed(1)}s\n`);
    if (r.signal || interruptedBy) fail(`baseline for ${suite} was interrupted (${r.exit})`);
    if (r.exit === 0 && r.passed === 0) fail(`baseline for ${suite} ran no tests${grep ? ` (nothing matches --grep ${JSON.stringify(grep)})` : ""}; refusing to score mutants against an empty suite. Log: ${r.logPath}`);
    if (!r.green) fail(`baseline is red for ${suite} (exit ${r.exit}); a red baseline would report every mutant as killed. Log: ${r.logPath}`);
  }

  // The loop: apply, run, restore, verify.
  const rows = [];
  for (const m of mutants) {
    const abs = path.join(root, m.file);
    const original = originals.get(abs);
    const mutated = original.toString("utf8").replace(m.find, () => m.replace);
    if (mutated === original.toString("utf8")) fail(`${m.id}: applying the mutant changed nothing`);
    mutatedNow.add(abs);
    writeFileSync(abs, mutated, "utf8");
    let r;
    try {
      r = await runSuite(suiteFor(m.file), m.id);
    } finally {
      restoreAll();
    }
    if (restoreFailed) {
      process.stderr.write(`MUTATE: stopping after ${m.id} because a restore failed\n`);
      process.exit(2);
    }
    if (r.signal || interruptedBy) fail(`${m.id}: the suite was interrupted (${r.exit}); an interrupted run is not a kill`);
    rows.push({ id: m.id, file: m.file, killed: !r.green, seconds: r.seconds, note: r.green ? "" : r.firstFailure || `exit ${r.exit}`, logPath: r.logPath });
    process.stdout.write(`  ${(r.green ? "SURVIVED" : "killed  ")} ${m.id.padEnd(44)} ${r.seconds.toFixed(1)}s\n`);
  }

  // Report.
  const idWidth = Math.max(2, ...rows.map((r) => r.id.length));
  const fileWidth = Math.max(4, ...rows.map((r) => r.file.length));
  const line = (a, b, c, d, e) => `${a.padEnd(idWidth)}  ${b.padEnd(fileWidth)}  ${c.padEnd(8)}  ${d.padStart(7)}  ${e}`;
  process.stdout.write(`\n${line("id", "file", "result", "seconds", "first failure (killed) / log (survived)")}\n`);
  process.stdout.write(`${"-".repeat(idWidth)}  ${"-".repeat(fileWidth)}  ${"-".repeat(8)}  ${"-".repeat(7)}  ${"-".repeat(40)}\n`);
  for (const r of rows) {
    process.stdout.write(`${line(r.id, r.file, r.killed ? "killed" : "SURVIVED", r.seconds.toFixed(1), r.killed ? r.note : r.logPath)}\n`);
  }
  const survivors = rows.filter((r) => !r.killed);
  process.stdout.write(`\n${rows.length - survivors.length} killed, ${survivors.length} survived, ${rows.length} total\n`);
  // A full run is recorded for the fact sheet, so the README's kill count is a run, not a file count.
  if (!only && !grep) {
    const record = { commit: git("rev-parse", "--short", "HEAD").trim(), date: new Date().toISOString().slice(0, 10), total: rows.length, killed: rows.length - survivors.length, survived: survivors.length };
    writeFileSync(path.join(root, "scripts/mutation/last-run.json"), JSON.stringify(record, null, 2) + "\n");
    process.stdout.write(`recorded in scripts/mutation/last-run.json\n`);
  }

  // Guard 5: nothing under packages/ differs from HEAD except test files.
  const stat = git("diff", "--stat", "--", "packages/");
  process.stdout.write(`\ngit diff --stat -- packages/\n${stat.trim().length > 0 ? stat : "  (clean)\n"}`);
  const changed = git("diff", "--name-only", "--", "packages/").split("\n").filter((f) => f.length > 0);
  const leaked = changed.filter((f) => !isTestFile(f));
  if (leaked.length > 0) {
    process.stderr.write(`\n${"!".repeat(88)}\nMUTATE: SOURCE FILES DIFFER FROM HEAD AFTER THE RUN:\n  ${leaked.join("\n  ")}\nRestore them with: git checkout -- ${leaked.join(" ")}\n${"!".repeat(88)}\n`);
    process.exit(2);
  }
  if (restoreFailed) process.exit(2);
  process.exit(survivors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  restoreAll();
  fail(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});
