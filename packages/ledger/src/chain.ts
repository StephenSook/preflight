import { createHash } from "node:crypto";
import { canonicalize, type Canonical } from "./canonical.js";

/**
 * The evidence log entry (spec section 10). Every entry hashes its own canonical form together with
 * the previous entry's hash, so altering any historical entry invalidates every entry after it.
 * The chain head is what gets sealed to the public transparency log.
 */
export type LedgerKind = "pass" | "block" | "hold" | "override" | "consent" | "seal" | "declaration";

export interface LedgerBody {
  seq: number;
  ts: string;
  kind: LedgerKind;
  call_uuid: string | null;
  decision: "pass" | "block" | "hold" | null;
  property: string | null;
  citation: string | null;
  witness: string[];
  ncco_hash: string | null;
  line_type: { value: string; source: string; conf: string } | null;
  /** Free-form, canonical-JSON-safe detail (who overrode, what was consented to, the seal uuid). */
  detail: { [key: string]: Canonical | undefined } | null;
  prev_hash: string;
}

export interface LedgerEntry extends LedgerBody {
  entry_hash: string;
}

export const GENESIS_HASH = "sha256:" + "0".repeat(64);

export function hashBody(body: LedgerBody): string {
  return "sha256:" + createHash("sha256").update(canonicalize(body as unknown as Canonical)).digest("hex");
}

export function makeEntry(body: LedgerBody): LedgerEntry {
  return { ...body, entry_hash: hashBody(body) };
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  head: string;
  /** The first entry whose hash or link is wrong, when the chain is broken. */
  brokenAt?: { seq: number; problem: string };
}

/** Walks the chain from genesis, recomputing every hash and link. Stops at the first break. */
export function verifyChain(entries: readonly LedgerEntry[]): VerifyResult {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { ok: false, entries: entries.length, head: prev, brokenAt: { seq: e.seq, problem: `sequence gap: expected ${expectedSeq}` } };
    if (e.prev_hash !== prev) return { ok: false, entries: entries.length, head: prev, brokenAt: { seq: e.seq, problem: "prev_hash does not match the previous entry" } };
    const { entry_hash, ...body } = e;
    const recomputed = hashBody(body);
    if (recomputed !== entry_hash) return { ok: false, entries: entries.length, head: prev, brokenAt: { seq: e.seq, problem: "entry_hash does not match the entry's canonical form" } };
    prev = entry_hash;
    expectedSeq += 1;
  }
  return { ok: true, entries: entries.length, head: prev };
}
