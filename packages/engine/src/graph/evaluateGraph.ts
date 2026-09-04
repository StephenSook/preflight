import { decide, type Decision, type PropertyVerdict, type WitnessStep } from "../evaluate.js";
import { evaluatePath, labelOf } from "../evaluate.js";
import type { CallFacts, FlowDeclaration } from "../ncco/atoms.js";
import { PROPERTIES, type PropertyId } from "../properties.js";
import type { FlowGraph, FlowPath } from "./graph.js";

export interface PathEvaluation {
  path: FlowPath;
  verdicts: PropertyVerdict[];
}

export interface GraphEvaluation {
  /** One verdict per property, aggregated over every observed path from the root. */
  verdicts: PropertyVerdict[];
  paths: PathEvaluation[];
  decision: Decision;
}

/**
 * Evaluates every observed path from a node. A property is false if any path makes it false (that
 * path is the witness), inconclusive if any path is open, cyclic, or undecided, and true only when
 * every path decides it true. The bound is the honest one: a branch nobody has observed holds under
 * strict policy, and coverage says so.
 */
export function evaluateGraph(graph: FlowGraph, rootId: string, ctx: { declaration?: FlowDeclaration | undefined; facts: CallFacts; policy: "strict" | "advisory" }): GraphEvaluation {
  const paths = graph.paths(rootId);
  const evaluations: PathEvaluation[] = paths.map((path) => {
    const ev = evaluatePath(path.actions, { declaration: ctx.declaration, facts: ctx.facts, terminal: path.end === "terminal" });
    const relabelled = ev.verdicts.map((v) => {
      if (v.verdict === "inconclusive" && path.end === "cyclic") return { ...v, reason: "the flow loops back on itself; a looping path is never decided, it is held" };
      if (v.verdict === "inconclusive" && path.end === "open") return { ...v, reason: `the path continues through ${path.labels[path.labels.length - 1] ?? "a branch"} and no continuation has been observed yet` };
      return v.witness ? { ...v, witness: primeWitness(v.witness, path) } : v;
    });
    return { path, verdicts: relabelled };
  });

  const verdicts: PropertyVerdict[] = PROPERTIES.map((p) => aggregate(p.id, p.citation, evaluations));
  return { verdicts, paths: evaluations, decision: decide(verdicts, ctx.policy) };
}

function primeWitness(witness: WitnessStep[], path: FlowPath): WitnessStep[] {
  return witness.map((w, i) => ({ ...w, label: path.labels[i] ?? w.label }));
}

function aggregate(id: PropertyId, citation: string, evaluations: PathEvaluation[]): PropertyVerdict {
  const mine = evaluations.map((e) => e.verdicts.find((v) => v.id === id)).filter((v): v is PropertyVerdict => v !== undefined);
  const falsy = mine.find((v) => v.verdict === "false");
  if (falsy) return falsy;
  const undecided = mine.find((v) => v.verdict === "inconclusive");
  if (undecided) return undecided;
  if (mine.length === 0) return { id, citation, verdict: "inconclusive", reason: "no observed path from this node" };
  return { id, citation, verdict: "true" };
}

export { labelOf };
