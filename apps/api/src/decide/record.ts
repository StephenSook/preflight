import type { Decision, Evaluation } from "@preflight/engine";
import type { DecisionRecord } from "../store/decisionStore.js";
import type { LedgerDraft } from "../store/ledgerStore.js";

export interface DecidedOutcome {
  decision: Decision;
  reason: string | undefined;
  evaluation: Evaluation;
  record: DecisionRecord;
}

/** The evidence-log entry for one decision, the same shape on the webhook path, the hook path and the gateway path. */
/** The entry for a decision. A pass is Preflight's verdict; whether the platform then created the call is the platform's answer, and the entry carries both. */
export function ledgerDraftFor(outcome: DecidedOutcome, placed?: { status: number }): LedgerDraft {
  const failed = outcome.evaluation.verdicts.find((v) => v.verdict === "false");
  const undecided = outcome.evaluation.verdicts.find((v) => v.verdict === "inconclusive");
  const named = outcome.decision === "block" ? failed : outcome.decision === "hold" ? undecided : undefined;
  const r = outcome.record;
  return {
    ts: r.decidedAt,
    kind: outcome.decision === "pass" ? "pass" : outcome.decision,
    call_uuid: r.callUuid ?? null,
    decision: outcome.decision,
    property: named?.id ?? null,
    citation: named?.citation ?? null,
    witness: named?.witness?.map((w) => w.label) ?? [],
    ncco_hash: r.nccoHash,
    line_type: { value: r.facts.lineType, source: r.facts.lineTypeSource, conf: r.facts.lineTypeConfidence },
    detail: detailFor(outcome.reason, placed),
  };
}

function detailFor(reason: string | undefined, placed: { status: number } | undefined): LedgerDraft["detail"] {
  const d: Record<string, string | number | boolean> = {};
  if (reason) d["reason"] = reason;
  if (placed) {
    d["placed"] = placed.status === 201;
    d["platform_status"] = placed.status;
  }
  return Object.keys(d).length > 0 ? d : null;
}
