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
  carrier_records: number;
  matched: number;
  unmatched: number;
  leaks: number;
  /** Refusals (block or hold) the gateway issued inside the window, none of which reached the carrier unless listed as a leak. */
  refused_in_window: number;
  unmatched_ids: string[];
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

export function reconcile(window: { start: string; end: string }, records: readonly CarrierRecord[], decisions: readonly DecisionRecord[]): ReconciliationReport {
  const known = new Set(decisions.map((d) => d.callUuid).filter((u): u is string => typeof u === "string" && u.length > 0));
  const refused = decisions.filter((d) => (d.decision === "block" || d.decision === "hold") && !d.callUuid);
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const refusedInWindow = refused.filter((d) => {
    const t = Date.parse(d.decidedAt);
    return t >= startMs && t <= endMs;
  }).length;

  const unmatched: string[] = [];
  const leaked: string[] = [];
  for (const r of records) {
    if (known.has(r.call_id)) continue;
    unmatched.push(r.call_id);
    const started = Date.parse(r.date_start);
    const from = lineOf(r.from);
    const to = lineOf(r.to);
    const leak = refused.some((d) => {
      const decided = Date.parse(d.decidedAt);
      return lineOf(d.fromNumber) === from && lineOf(d.toNumber) === to && started >= decided - LEAK_AFTER_MS && started <= decided + LEAK_BEFORE_MS;
    });
    if (leak) leaked.push(r.call_id);
  }

  const canonicalRecords = records.map((r) => ({ call_id: r.call_id, direction: r.direction, from: lineOf(r.from), to: lineOf(r.to), date_start: r.date_start }));
  return {
    window,
    carrier_records: records.length,
    matched: records.length - unmatched.length,
    unmatched: unmatched.length,
    leaks: leaked.length,
    refused_in_window: refusedInWindow,
    unmatched_ids: unmatched.slice(0, 50),
    leaked_ids: leaked.slice(0, 50),
    records_hash: "sha256:" + createHash("sha256").update(canonicalize(canonicalRecords as unknown as Canonical)).digest("hex"),
  };
}
