/**
 * @preflight/engine
 * Hand-built LTL3 (Bauer, Leucker, Schallhart 2011) runtime-verification monitors over NCCO call flows.
 * Zero dependencies; runs in Node and the browser.
 */
export const ENGINE_VERSION = "0.1.0";
export type Verdict = "true" | "false" | "inconclusive";

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
