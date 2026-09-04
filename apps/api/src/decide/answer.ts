import { createHash } from "node:crypto";
import { decide, evaluateNcco, parseNcco, propertySpec, type Decision, type Evaluation, type FlowDeclaration } from "@preflight/engine";
import type { NumberFactsResolver } from "@preflight/numfacts";
import type { DecisionRecord } from "../store/decisionStore.js";

export interface AnswerInput {
  payload: Record<string, unknown> | undefined;
  nccoBytes: string;
  declaration: FlowDeclaration;
  resolver: NumberFactsResolver;
  policy: "strict" | "advisory";
  applicationId: string | undefined;
  now: Date;
  originLatencyMs: number | null;
  verifyLatencyMs: number | null;
}

export interface AnswerOutcome {
  decision: Decision;
  reason: string | undefined;
  evaluation: Evaluation;
  record: DecisionRecord;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * The decision for one answer webhook. The person on the line is the callee of an outbound call or
 * the caller of an inbound one, and their number is what the calling-hours check resolves. The
 * object is evaluated as one path; it is terminal when nothing in it can return a replacement
 * object (no input, no notify), otherwise the path is open and an undecided property holds under
 * strict policy until the branch has been observed. An object that does not parse at all is
 * blocked under either policy, because the platform would disconnect on it anyway.
 */
export function decideAnswer(input: AnswerInput): AnswerOutcome {
  const p = input.payload ?? {};
  const rawDirection = str(p["direction"]);
  const direction: DecisionRecord["direction"] = rawDirection === "inbound" || rawDirection === "outbound" ? rawDirection : "unknown";
  const fromNumber = str(p["from"]);
  const toNumber = str(p["to"]);
  const humanParty = direction === "inbound" ? fromNumber : toNumber;
  const callerId = direction === "inbound" ? toNumber : fromNumber;
  const facts = input.resolver.resolve(humanParty ?? "", input.now);

  const parsed = parseNcco(input.nccoBytes);
  const terminal = !parsed.actions.some((a) => a.action === "input" || a.action === "notify");
  const evaluation = evaluateNcco(parsed, {
    declaration: input.declaration,
    facts: { from: callerId, lineType: facts.lineType, withinHours: facts.withinHours },
    terminal,
  });

  let decision: Decision = decide(evaluation.verdicts, input.policy);
  let reason: string | undefined;
  if (!parsed.ok && parsed.actions.length === 0) {
    decision = "block";
    reason = `the application's server returned something that is not a call-control object: ${parsed.issues[0]?.message ?? "unknown defect"}`;
  } else if (decision === "block") {
    const failed = evaluation.verdicts.filter((v) => v.verdict === "false");
    reason = failed.map((v) => `${v.id} ${propertySpec(v.id).title}, ${v.citation}${v.atEnd ? " (no opt-out before the flow ends)" : ""}`).join("; ");
  } else if (decision === "hold") {
    const open = evaluation.verdicts.filter((v) => v.verdict === "inconclusive");
    reason = open.map((v) => `${v.id}: ${v.reason ?? "undecided"}`).join("; ");
  }

  const record: DecisionRecord = {
    callUuid: str(p["uuid"]) ?? str(p["call_uuid"]),
    conversationUuid: str(p["conversation_uuid"]),
    applicationId: input.applicationId,
    direction,
    fromNumber,
    toNumber,
    humanParty,
    facts,
    policy: input.policy,
    terminal,
    nccoHash: `sha256:${createHash("sha256").update(input.nccoBytes).digest("hex")}`,
    decision,
    reason,
    verdicts: evaluation.verdicts,
    decidedAt: input.now.toISOString(),
    originLatencyMs: input.originLatencyMs,
    verifyLatencyMs: input.verifyLatencyMs,
  };
  return { decision, reason, evaluation, record };
}
