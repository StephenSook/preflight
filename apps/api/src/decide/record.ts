import type { LedgerDraft } from "../store/ledgerStore.js";
import type { AnswerOutcome } from "./answer.js";

/** The evidence-log entry for one decision, the same shape on the webhook path and the gateway path. */
export function ledgerDraftFor(outcome: AnswerOutcome): LedgerDraft {
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
    detail: outcome.reason ? { reason: outcome.reason } : null,
  };
}
