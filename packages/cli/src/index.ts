import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { decide, evaluateNcco, parseNcco, PROPERTIES, type CallFacts, type Decision, type Evaluation, type FlowDeclaration, type PropertyVerdict, type Verdict } from "@preflight/engine";
import { GENESIS_HASH, hashBody, verifyChain, type LedgerEntry, type VerifyResult } from "@preflight/ledger";

/**
 * The library behind `npx preflight`: check one object, replay the labelled corpus, verify a
 * ledger. Every function is pure over its inputs so the tests and the binary share one path.
 * Number facts are given, not looked up: the CLI is for a stranger reproducing verdicts, and it
 * carries no data tables.
 */

export interface CheckOptions {
  declaration?: FlowDeclaration | undefined;
  facts: CallFacts;
  policy?: "strict" | "advisory";
  /** The object is one path that may continue through a branch; default is a terminal object. */
  open?: boolean;
}

export interface CheckResult {
  decision: Decision;
  verdicts: PropertyVerdict[];
  issues: { path: string; message: string; severity: "error" | "warning" }[];
  evaluation: Evaluation;
}

/**
 * Evaluates one object exactly as the engine does. An object that is not an NCCO is undecidable
 * and holds here; the live service blocks it, because the platform would disconnect on it anyway.
 */
export function checkObject(object: unknown, opts: CheckOptions): CheckResult {
  const parsed = parseNcco(object);
  const evaluation = evaluateNcco(parsed, { declaration: opts.declaration, facts: opts.facts, terminal: !opts.open });
  const decision: Decision = parsed.ok ? decide(evaluation.verdicts, opts.policy ?? "strict") : evaluation.decision;
  return { decision, verdicts: evaluation.verdicts, issues: parsed.issues, evaluation };
}

/** A corpus file wraps its object; a bare file is the object. Returns the object and any declaration it carries. */
export function unwrapObjectFile(parsed: unknown): { object: unknown; declaration?: FlowDeclaration | undefined } {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as { ncco?: unknown }).ncco)) {
    const c = parsed as { ncco: unknown; declaration?: FlowDeclaration };
    return { object: c.ncco, declaration: c.declaration };
  }
  return { object: parsed };
}

export function renderVerdicts(result: CheckResult): string {
  const lines: string[] = [];
  const width = Math.max(...PROPERTIES.map((p) => p.title.length));
  for (const v of result.verdicts) {
    const spec = PROPERTIES.find((p) => p.id === v.id);
    const mark = v.verdict === "true" ? "pass" : v.verdict === "false" ? "FAIL" : "hold";
    lines.push(`${v.id}  ${(spec?.title ?? v.id).padEnd(width)}  ${mark.padEnd(4)}  ${v.citation}`);
    if (v.witness) lines.push(`      witness: ${v.witness.map((w) => w.label).join(" > ")}${v.atEnd ? " > end of flow" : ""}`);
    if (v.reason) lines.push(`      ${v.reason}`);
  }
  for (const i of result.issues) lines.push(`${i.severity === "error" ? "error" : "warn "} ${i.path || "(object)"}: ${i.message}`);
  lines.push(`decision: ${result.decision.toUpperCase()}`);
  return lines.join("\n");
}

export interface CorpusLabel {
  name: string;
  declaration?: FlowDeclaration;
  ncco: unknown;
  expect: { terminal: { facts: CallFacts; verdicts: Record<string, Verdict>; decision: Decision; witness?: Record<string, { path: string[]; atEnd: boolean }> } };
}

export interface ReplayRow {
  file: string;
  name: string;
  expected: Decision;
  got: Decision;
  mismatches: string[];
}

export function replayCorpus(dir: string): { rows: ReplayRow[]; ok: boolean } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const rows = files.map((file): ReplayRow => {
    const c = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as CorpusLabel;
    const label = c.expect.terminal;
    const result = checkObject(c.ncco, { declaration: c.declaration, facts: label.facts });
    const mismatches: string[] = [];
    for (const v of result.verdicts) {
      const want = label.verdicts[v.id];
      if (want !== v.verdict) mismatches.push(`${v.id}: expected ${want ?? "(unlabelled)"}, got ${v.verdict}`);
      const w = label.witness?.[v.id];
      if (w) {
        const got = v.witness?.map((x) => x.label) ?? [];
        if (got.join(">") !== w.path.join(">") || (v.atEnd ?? false) !== w.atEnd) mismatches.push(`${v.id} witness: expected ${w.path.join(" > ")}${w.atEnd ? " > end" : ""}, got ${got.join(" > ")}${v.atEnd ? " > end" : ""}`);
      }
    }
    if (result.decision !== label.decision) mismatches.push(`decision: expected ${label.decision}, got ${result.decision}`);
    return { file, name: c.name, expected: label.decision, got: result.decision, mismatches };
  });
  return { rows, ok: rows.every((r) => r.mismatches.length === 0) };
}

export function renderReplay(rows: ReplayRow[]): string {
  const w = Math.max(...rows.map((r) => r.file.length));
  const lines = rows.map((r) => `${r.mismatches.length === 0 ? "ok  " : "FAIL"} ${r.file.padEnd(w)}  ${r.got.padEnd(5)}  ${r.name}${r.mismatches.map((m) => `\n       ${m}`).join("")}`);
  const failed = rows.filter((r) => r.mismatches.length > 0).length;
  lines.push(`${rows.length} objects, ${rows.length - failed} match their labels${failed ? `, ${failed} do not` : ""}`);
  return lines.join("\n");
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const nullableString = (field: unknown) => field === null || typeof field === "string";
  const line = entry.line_type;
  return Number.isSafeInteger(entry.seq) && typeof entry.ts === "string"
    && typeof entry.kind === "string" && ["pass", "block", "hold", "override", "consent", "seal", "declaration", "reconciliation", "setup"].includes(entry.kind)
    && (entry.decision === null || (typeof entry.decision === "string" && ["pass", "block", "hold"].includes(entry.decision)))
    && [entry.call_uuid, entry.property, entry.citation, entry.ncco_hash].every(nullableString)
    && Array.isArray(entry.witness) && entry.witness.every((item) => typeof item === "string")
    && (line === null || (typeof line === "object" && !Array.isArray(line) && line !== null
      && "value" in line && typeof line.value === "string" && "source" in line && typeof line.source === "string"
      && "conf" in line && typeof line.conf === "string"))
    && (entry.detail === null || (typeof entry.detail === "object" && !Array.isArray(entry.detail) && entry.detail !== null))
    && typeof entry.prev_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(entry.prev_hash)
    && typeof entry.entry_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(entry.entry_hash);
}

/** Reads every entry from a Preflight host (paged) or from a JSON file (an array, or {entries: [...]}). */
export async function loadLedger(source: string, fetchImpl: typeof fetch = fetch): Promise<LedgerEntry[]> {
  if (/^https?:\/\//.test(source)) {
    const base = source.replace(/\/+$/, "");
    const getJson = async (route: string): Promise<unknown> => {
      const res = await fetchImpl(`${base}${route}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${base}: HTTP ${res.status}`);
      return res.json();
    };
    const snapshot = await getJson("/api/ledger/head");
    if (!snapshot || typeof snapshot !== "object" || !("seq" in snapshot) || !("entry_hash" in snapshot)
      || typeof snapshot.seq !== "number" || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0
      || typeof snapshot.entry_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(snapshot.entry_hash)
      || (snapshot.seq === 0 && snapshot.entry_hash !== GENESIS_HASH)) throw new Error(`${base}: invalid ledger head`);
    const all: LedgerEntry[] = [];
    let previousHash = GENESIS_HASH;
    let after = 0;
    while (after < snapshot.seq) {
      const limit = Math.min(1000, snapshot.seq - after);
      const page = await getJson(`/api/ledger/entries?after=${after}&limit=${limit}`);
      if (!page || typeof page !== "object" || !("entries" in page) || !Array.isArray(page.entries)) throw new Error(`${base}: invalid ledger page: entries must be an array`);
      if (page.entries.length !== limit) throw new Error(`${base}: invalid ledger page: expected ${limit} entries before snapshot head`);
      if ("after" in page && page.after !== after) throw new Error(`${base}: invalid ledger page: cursor mismatch`);
      for (const entry of page.entries) {
        if (!isLedgerEntry(entry)) throw new Error(`${base}: invalid ledger page: malformed entry`);
        if (entry.seq !== after + 1) throw new Error(`${base}: invalid ledger page: sequence must advance consecutively`);
        const { entry_hash, ...body } = entry;
        if (entry.prev_hash !== previousHash || hashBody(body) !== entry_hash) throw new Error(`${base}: invalid ledger page: inconsistent hash or link at seq ${entry.seq}`);
        all.push(entry);
        previousHash = entry_hash;
        after = entry.seq;
      }
    }
    if (previousHash !== snapshot.entry_hash) throw new Error(`${base}: ledger does not match snapshot head`);
    return all;
  }
  const parsed = JSON.parse(readFileSync(source, "utf8")) as LedgerEntry[] | { entries: LedgerEntry[] };
  return Array.isArray(parsed) ? parsed : parsed.entries;
}

export async function verifyLedgerSource(source: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  return verifyChain(await loadLedger(source, fetchImpl));
}

export function renderVerify(r: VerifyResult): string {
  if (r.ok) return `ok: ${r.entries} entries, every hash and link recomputed from genesis\nhead: ${r.head}`;
  return `BROKEN at seq ${r.brokenAt?.seq}: ${r.brokenAt?.problem}\nentries read: ${r.entries}`;
}
