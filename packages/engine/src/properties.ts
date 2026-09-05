import { compileMonitor, type CompiledMonitor } from "./ltl/monitor.js";

/**
 * The Tier 1 property set (spec section 05): mechanically verified from the call-control object plus
 * number facts, armed by default, a false verdict blocks the call. Formulas are over the atom
 * vocabulary in ./ncco/atoms.ts.
 *
 * P2 and P5 use weak until, "nothing of this kind strictly before the identification beat". The
 * spec's first draft wrote them as !( !identifies U speaks ), which is false on every flow whose
 * identification beat speaks; see ltl/monitor.test.ts, "the identification formulas".
 *
 * P3 is anchored on the identification beat, as 47 CFR 64.1200(b)(3) is ("within two (2) seconds of
 * providing the identification information required in paragraph (b)(1)"). The spec's printed
 * formula obliged every synthetic utterance, which flagged a closing sentence after the opt-out and
 * the spec's own declared agent path; a live human leg satisfies the obligation because the
 * example in the spec treats the agent path as compliant.
 *
 * P1 is a fact about the call, not about its spoken actions. 47 CFR 64.1200(c)(1) forbids
 * INITIATING the solicitation outside the window, and the ring is the intrusion, so a flow that goes
 * straight to a live agent at 6 a.m., or an empty object, is a violation too. The spec's first draft
 * wrote G( speaks -> within_hours ), which passed both; corpus object 39 pinned the gap.
 *
 * On an object, P2 and P5 cannot differ: the only speech an object shows is synthetic (talk, stream,
 * pay prompts) and a live agent's words are not in it. Both stay, because they are two rules with two
 * citations, but on observed objects their verdicts coincide. That is a stated limit, not a defect.
 */
export type PropertyId = "P1" | "P2" | "P3" | "P4" | "P5";

export interface PropertySpec {
  id: PropertyId;
  title: string;
  /** What the rule requires, in one sentence a non-lawyer can read. */
  summary: string;
  /** What Preflight checks structurally, which is narrower than the rule. */
  checks: string;
  formula: string;
  citation: string;
  shape: "guard" | "ordering";
}

export const PROPERTIES: readonly PropertySpec[] = [
  {
    id: "P1",
    title: "Calling hours",
    summary: "No telephone solicitation before 8am or after 9pm local time at the called party's location.",
    checks: "The call is initiated inside 8am to 9pm at the destination, resolved from the destination NPA-NXX to a rate center to a timezone against the call timestamp. Every call, not only its spoken actions: a flow that goes straight to a live agent at 6am is still initiated at 6am.",
    formula: "within_hours",
    citation: "47 CFR 64.1200(c)(1)",
    shape: "guard",
  },
  {
    id: "P2",
    title: "Identification present",
    summary: "An artificial or prerecorded voice message must, at the beginning, state the identity of the business, individual or other entity responsible for the call.",
    checks: "No synthetic speech with no live human leg occurs strictly before the declared identification beat.",
    formula: "(!(speaks & synthetic & !connects_human)) W identifies",
    citation: "47 CFR 64.1200(b)(1)",
    shape: "ordering",
  },
  {
    id: "P3",
    title: "Interactive opt-out present",
    summary: "An artificial or prerecorded voice message must provide an automated, interactive voice- and/or key press-activated opt-out mechanism.",
    checks: "From the identification beat, an input declared as the opt-out handler, or a connection to a live endpoint, is reachable later on the path. The rule anchors the opt-out to the identification; speech after the opt-out is not a violation.",
    formula: "G( identifies -> F (offers_optout | connects_human) )",
    citation: "47 CFR 64.1200(b)(3)",
    shape: "ordering",
  },
  {
    id: "P4",
    title: "Caller ID integrity",
    summary: "No person or entity that makes a telephone solicitation shall utilize any method to block or otherwise circumvent the subscriber's use of a caller identification service.",
    checks: "A valid, non-suppressed caller id is set on the call request. A fact about the call like P1, decided at the first action whatever it is, so an open path with a caller id is not held on this rule and an empty object with none is refused at its end.",
    formula: "caller_id_present",
    citation: "O.C.G.A. 46-5-27(g)(2); Ga. Comp. R. & Regs. 515-14-1-.03(c)",
    shape: "guard",
  },
  {
    id: "P5",
    title: "Georgia identification first",
    summary: "A telephone solicitation shall, at the beginning of the call, state clearly the identity of the person or entity initiating it; the Commission's rule says the call shall begin by clearly stating it.",
    checks: "Nothing is spoken strictly before the declared identification beat. Stricter than P2: position, not presence.",
    formula: "(!speaks) W identifies",
    citation: "O.C.G.A. 46-5-27(g)(1); Ga. Comp. R. & Regs. 515-14-1-.03(b)",
    shape: "ordering",
  },
];

let compiled: Map<PropertyId, CompiledMonitor> | undefined;

/** Monitors are compiled once per process; the hot path is a table lookup. */
export function compiledProperties(): ReadonlyMap<PropertyId, CompiledMonitor> {
  if (!compiled) {
    compiled = new Map();
    for (const p of PROPERTIES) compiled.set(p.id, compileMonitor(p.formula));
  }
  return compiled;
}

export function propertySpec(id: PropertyId): PropertySpec {
  const p = PROPERTIES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown property ${id}`);
  return p;
}
