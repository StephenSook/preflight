import { createHash } from "node:crypto";
import { canonicalize, type Canonical } from "@preflight/ledger";
import type { DecisionRecord } from "./store/decisionStore.js";

/**
 * Carrier-side reconciliation (plan addition A6). The platform's Reports API is the sponsor's own
 * record of every call the account placed or received. Every record must be a call Preflight
 * decided (matched by uuid). One that is not was placed around the interlock (unmatched); one that
 * is not AND lines up with a request the gateway refused, same numbers, moments later, is a leak:
 * the negative the film claims, checked against the carrier rather than against ourselves.
 */

export interface CarrierRecord {
  call_id: string;
  direction: "inbound" | "outbound" | string;
  from: string;
  to: string;
  /** ISO time the carrier started the call. */
  date_start: string;
  status?: string;
  duration?: string | number;
}

export interface ReconciliationReport {
  window: { start: string; end: string };
  /** Carrier records whose start time lies inside the window; only these are classified. */
  carrier_records: number;
  /** Records the workflow sent that started outside the window: not this window's to classify. */
  outside_window: number;
  matched: number;
  unmatched: number;
  leaks: number;
  /** Refusals (block or hold) the gateway issued inside the window, none of which reached the carrier unless listed as a leak. */
  refused_in_window: number;
  /** Calls the interlock decided with a platform uuid that came back in no pulled record at all. */
  decided_not_in_records: number;
  unmatched_ids: string[];
  missing_ids: string[];
  leaked_ids: string[];
  /** sha256 over the canonical records, so the entry can be checked against a re-pull of the same window. */
  records_hash: string;
}

/** The last ten digits, so 12016131021 and 2016131021 are the same line. */
export const lineOf = (s: string | undefined): string => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
};

const LEAK_BEFORE_MS = 120_000;
const LEAK_AFTER_MS = 5_000;
const DRY_RUN_PREFIX = "preflight-dryrun-";

/**
 * A uuid the platform issued. The gateway stamps its dry-run pre-fetch with a `preflight-dryrun-`
 * id and only a placed call replaces it with the platform's, so a refusal still carries the dry-run
 * id: for reconciliation that is no uuid at all, or every refusal would look like a known call.
 */
export const isPlatformUuid = (u: string | undefined): u is string => typeof u === "string" && u.length > 0 && !u.startsWith(DRY_RUN_PREFIX);

export function reconcile(window: { start: string; end: string }, records: readonly CarrierRecord[], decisions: readonly DecisionRecord[]): ReconciliationReport {
  const known = new Set(decisions.map((d) => d.callUuid).filter(isPlatformUuid));
  const refused = decisions.filter((d) => (d.decision === "block" || d.decision === "hold") && !isPlatformUuid(d.callUuid));
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const refusedInWindow = refused.filter((d) => {
    const t = Date.parse(d.decidedAt);
    return t >= startMs && t <= endMs;
  }).length;

  // Only records that started inside the window are this window's to classify; a record from before
  // it is not attributed to a refusal here, and the count of what was left out is reported.
  const inside = records.filter((r) => {
    const t = Date.parse(r.date_start);
    return t >= startMs && t <= endMs;
  });

  const unmatched: string[] = [];
  const leaked: string[] = [];
  for (const r of inside) {
    if (known.has(r.call_id)) continue;
    unmatched.push(r.call_id);
    const started = Date.parse(r.date_start);
    const from = lineOf(r.from);
    const to = lineOf(r.to);
    const leak = refused.some((d) => {
      const decided = Date.parse(d.decidedAt);
      // A refusal placed with a random caller id has no line to compare; the destination alone attributes it.
      const refusedFrom = lineOf(d.fromNumber);
      return (refusedFrom === "" || refusedFrom === from) && lineOf(d.toNumber) === to && started >= decided - LEAK_AFTER_MS && started <= decided + LEAK_BEFORE_MS;
    });
    if (leak) leaked.push(r.call_id);
  }

  // A decided call with a platform uuid that the pull did not return at all: an empty or mis-filtered
  // pull must not read as a clean night.
  const pulled = new Set(records.map((r) => r.call_id));
  const missing = [...new Set(decisions.filter((d) => isPlatformUuid(d.callUuid) && Date.parse(d.decidedAt) >= startMs && Date.parse(d.decidedAt) <= endMs).map((d) => d.callUuid as string).filter((u) => !pulled.has(u)))];

  const canonicalRecords = inside.map((r) => ({ call_id: r.call_id, direction: r.direction, from: lineOf(r.from), to: lineOf(r.to), date_start: r.date_start }));
  return {
    window,
    carrier_records: inside.length,
    outside_window: records.length - inside.length,
    matched: inside.length - unmatched.length,
    unmatched: unmatched.length,
    leaks: leaked.length,
    refused_in_window: refusedInWindow,
    decided_not_in_records: missing.length,
    unmatched_ids: unmatched.slice(0, 50),
    missing_ids: missing.slice(0, 50),
    leaked_ids: leaked.slice(0, 50),
    records_hash: "sha256:" + createHash("sha256").update(canonicalize(canonicalRecords as unknown as Canonical)).digest("hex"),
  };
}
