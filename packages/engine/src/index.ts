/**
 * @preflight/engine
 * Hand-built LTL3 (Bauer, Leucker, Schallhart 2011) runtime-verification monitors over NCCO call flows.
 * Zero dependencies; runs in Node and the browser.
 */
export const ENGINE_VERSION = "0.1.0";

export * from "./ncco/types.js";
export { parseNcco, type ParseIssue, type ParseResult } from "./ncco/parse.js";
export {
  ACTION_ATOMS,
  CALL_ATOMS,
  actionAtoms,
  callAtoms,
  callerIdPresent,
  normalizePhrase,
  type ActionAtom,
  type ActionAtoms,
  type Atom,
  type CallAtom,
  type CallAtoms,
  type CallFacts,
  type FlowDeclaration,
} from "./ncco/atoms.js";
export * from "./ltl/ast.js";
export { LtlSyntaxError, parseLtl } from "./ltl/parse.js";
export { compileMonitor, letterOf, MonitorRun, type CompiledMonitor, type Verdict } from "./ltl/monitor.js";
export { PROPERTIES, compiledProperties, propertySpec, type PropertyId, type PropertySpec } from "./properties.js";
export { decide, evaluateNcco, evaluatePath, labelOf, type Decision, type Evaluation, type EvaluationContext, type PropertyVerdict, type WitnessStep } from "./evaluate.js";
