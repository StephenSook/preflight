import { letterOf, MonitorRun, type Verdict } from "./ltl/monitor.js";
import { actionAtoms, callAtoms, type ActionAtoms, type CallAtoms, type CallFacts, type FlowDeclaration } from "./ncco/atoms.js";
import type { ParseResult } from "./ncco/parse.js";
import type { NccoAction } from "./ncco/types.js";
import { compiledProperties, PROPERTIES, type PropertyId } from "./properties.js";

export interface EvaluationContext {
  declaration?: FlowDeclaration | undefined;
  facts: CallFacts;
  /**
   * True when the path ends here: the object has no further action and no branching action whose
   * replacement object has not been observed. A terminal path gets a definite verdict; an open path
   * that is still undecided is inconclusive and is held.
   */
  terminal: boolean;
}

export interface WitnessStep {
  index: number;
  /** e.g. talk#0, input#2, unknown#1 */
  label: string;
  atoms: ActionAtoms;
}

export interface PropertyVerdict {
  id: PropertyId;
  citation: string;
  verdict: Verdict;
  /** Present when the verdict is false: the exact sequence of actions that reached the prohibited state. */
  witness?: WitnessStep[];
  /** True when the false verdict came from the flow ending, e.g. no opt-out before the object ran out. */
  atEnd?: boolean;
  /** Present when the verdict is inconclusive: why the monitor could not decide. */
  reason?: string;
}

export type Decision = "pass" | "block" | "hold";

export interface Evaluation {
  verdicts: PropertyVerdict[];
  callAtoms: CallAtoms;
  steps: WitnessStep[];
  decision: Decision;
}

export const labelOf = (a: NccoAction): string => `${a.action}#${a.index}`;

const REASON_FOR_NULL: Record<keyof CallAtoms, string> = {
  within_hours: "destination timezone unresolved, so calling hours cannot be checked",
  dest_wireless: "destination line type unresolved",
  dest_residential: "destination line type unresolved",
  caller_id_present: "caller id unresolved",
};

/**
 * Runs every armed property over one path of actions. A property whose formula needs a call fact
 * that is still null is inconclusive with the reason, never guessed. An action the parser could not
 * type ends the evaluation: verdicts already false stay false, everything else is inconclusive.
 */
export function evaluatePath(actions: readonly NccoAction[], ctx: EvaluationContext): Evaluation {
  const monitors = compiledProperties();
  const cAtoms = callAtoms(ctx.facts);
  const steps: WitnessStep[] = actions.map((a) => ({ index: a.index, label: labelOf(a), atoms: actionAtoms(a, ctx.declaration) }));
  const firstUnknown = actions.findIndex((a) => a.action === "unknown");
  const usable = firstUnknown === -1 ? steps : steps.slice(0, firstUnknown);
  const terminal = ctx.terminal && firstUnknown === -1;

  const verdicts: PropertyVerdict[] = PROPERTIES.map((p) => {
    const m = monitors.get(p.id);
    if (!m) throw new Error(`monitor for ${p.id} is not compiled`);
    const nullFact = (Object.keys(cAtoms) as Array<keyof CallAtoms>).find((k) => m.atoms.includes(k) && cAtoms[k] === null);
    if (nullFact) return { id: p.id, citation: p.citation, verdict: "inconclusive", reason: REASON_FOR_NULL[nullFact] };

    const run = new MonitorRun(m);
    for (const [i, s] of usable.entries()) {
      const v = run.step(letterOf(m, { ...cAtoms, ...s.atoms }));
      if (v === "false") return { id: p.id, citation: p.citation, verdict: "false", witness: usable.slice(0, i + 1) };
      if (v === "true") return { id: p.id, citation: p.citation, verdict: "true" };
    }
    if (firstUnknown !== -1) {
      const u = steps[firstUnknown];
      return { id: p.id, citation: p.citation, verdict: "inconclusive", reason: `action ${u?.label ?? firstUnknown} could not be typed, so the path is undecidable from there` };
    }
    if (!terminal) return { id: p.id, citation: p.citation, verdict: "inconclusive", reason: "the path continues through a branch that has not been observed" };
    const end = run.verdictAtEnd(letterOf(m, cAtoms));
    return end === "true" ? { id: p.id, citation: p.citation, verdict: "true" } : { id: p.id, citation: p.citation, verdict: "false", witness: [...usable], atEnd: true };
  });

  return { verdicts, callAtoms: cAtoms, steps, decision: decide(verdicts, "strict") };
}

/** Evaluates a whole parsed object as one path. An object that did not parse is held, never passed. */
export function evaluateNcco(parsed: ParseResult, ctx: EvaluationContext): Evaluation {
  if (!parsed.ok && parsed.actions.length === 0) {
    const cAtoms = callAtoms(ctx.facts);
    const reason = `the object is not a valid NCCO: ${parsed.issues.find((i) => i.severity === "error")?.message ?? "unknown defect"}`;
    return {
      verdicts: PROPERTIES.map((p) => ({ id: p.id, citation: p.citation, verdict: "inconclusive", reason })),
      callAtoms: cAtoms,
      steps: [],
      decision: "hold",
    };
  }
  return evaluatePath(parsed.actions, ctx);
}

/**
 * Any false verdict blocks. Under strict policy any inconclusive verdict holds the call for a human;
 * under advisory policy it passes with the inconclusive verdicts reported as warnings.
 */
export function decide(verdicts: readonly PropertyVerdict[], policy: "strict" | "advisory"): Decision {
  if (verdicts.some((v) => v.verdict === "false")) return "block";
  if (verdicts.some((v) => v.verdict === "inconclusive")) return policy === "strict" ? "hold" : "pass";
  return "pass";
}
