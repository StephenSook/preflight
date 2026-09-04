import { atomsOf, negate, type Formula } from "./ast.js";
import { admits, liveStates, ltlToNba, type Nba } from "./buchi.js";
import { parseLtl } from "./parse.js";

export type Verdict = "true" | "false" | "inconclusive";

/**
 * A compiled LTL3 monitor (Bauer, Leucker, Schallhart 2011): a minimal deterministic automaton whose
 * states carry one of three verdicts over the prefix read so far. The construction is the paper's:
 * Büchi automata for the property and its negation, per-state emptiness, subset construction of
 * each as a finite-word automaton, product, labelling, minimisation. One table lookup per step.
 *
 * `endTrue` answers a question the paper does not need but a call flow does: when the flow
 * TERMINATES after the prefix (the object ends, nothing more is spoken), does the property hold?
 * That is the property evaluated on the prefix followed by the "silent" letter forever, and it is
 * what turns "no opt-out yet" into "no opt-out, ever, on this path".
 */
export interface CompiledMonitor {
  source: string;
  atoms: string[];
  letters: number;
  initial: number;
  /** delta[state * letters + letter] */
  delta: number[];
  verdicts: Verdict[];
  /** endTrue[state * letters + letter]: the property holds on prefix followed by that letter forever. */
  endTrue: boolean[];
}

interface Subset {
  key: string;
  members: number[];
  /** True for the pre-initial state, before any letter has been read. */
  pre: boolean;
}

interface FiniteAutomaton {
  nba: Nba;
  live: boolean[];
  states: Subset[];
  delta: number[];
  accepting: boolean[];
  /** stutter[state * letters + letter]: an infinite run on that letter exists from this state. */
  stutter: boolean[];
}

function determinise(nba: Nba, letters: number): FiniteAutomaton {
  const live = liveStates(nba);
  const liveByLetter: boolean[][] = [];
  for (let a = 0; a < letters; a++) liveByLetter.push(liveStates(nba, a));
  const states: Subset[] = [{ key: "pre", members: [], pre: true }];
  const index = new Map<string, number>([["pre", 0]]);
  const delta: number[] = [];
  const stutter: boolean[] = [];
  const successorsOn = (s: Subset, a: number): number[] => {
    const out = new Set<number>();
    for (const t of nba.states) {
      if (!admits(t, a)) continue;
      if (s.pre ? t.incoming.includes(-1) : t.incoming.some((p) => s.members.includes(p))) out.add(t.id);
    }
    return [...out].sort((x, y) => x - y);
  };
  for (let i = 0; i < states.length; i++) {
    const s = states[i] as Subset;
    for (let a = 0; a < letters; a++) {
      const members = successorsOn(s, a);
      const k = members.join(",");
      let j = index.get(k);
      if (j === undefined) {
        j = states.length;
        index.set(k, j);
        states.push({ key: k, members, pre: false });
      }
      delta[i * letters + a] = j;
      const lv = liveByLetter[a] as boolean[];
      stutter[i * letters + a] = members.some((m) => lv[m]);
    }
  }
  const accepting = states.map((s) => (s.pre ? nba.initial.some((q) => live[q]) : s.members.some((m) => live[m])));
  return { nba, live, states, delta, accepting, stutter };
}

export function compileMonitor(input: Formula | string, atomOrder?: string[]): CompiledMonitor {
  const source = typeof input === "string" ? input : "";
  const phi = typeof input === "string" ? parseLtl(input) : input;
  const atoms = atomOrder ?? atomsOf(phi);
  for (const a of atomsOf(phi)) if (!atoms.includes(a)) throw new Error(`atom "${a}" is not in the atom order`);
  if (atoms.length > 16) throw new Error("monitors support at most 16 atoms");
  const letters = 1 << atoms.length;
  const pos = determinise(ltlToNba(phi, atoms), letters);
  const neg = determinise(ltlToNba(negate(phi), atoms), letters);

  // Product of the two finite automata, reachable part only.
  const prodStates: Array<[number, number]> = [[0, 0]];
  const prodIndex = new Map<string, number>([["0,0", 0]]);
  const prodDelta: number[] = [];
  for (let i = 0; i < prodStates.length; i++) {
    const [p, q] = prodStates[i] as [number, number];
    for (let a = 0; a < letters; a++) {
      const p2 = pos.delta[p * letters + a] as number;
      const q2 = neg.delta[q * letters + a] as number;
      const k = `${p2},${q2}`;
      let j = prodIndex.get(k);
      if (j === undefined) {
        j = prodStates.length;
        prodIndex.set(k, j);
        prodStates.push([p2, q2]);
      }
      prodDelta[i * letters + a] = j;
    }
  }
  const verdictOf = ([p, q]: [number, number]): Verdict => {
    if (!neg.accepting[q]) return "true";
    if (!pos.accepting[p]) return "false";
    return "inconclusive";
  };
  const prodVerdicts = prodStates.map(verdictOf);
  const prodEnd: boolean[] = [];
  prodStates.forEach(([p, q], i) => {
    for (let a = 0; a < letters; a++) {
      const t = pos.stutter[p * letters + a] as boolean;
      const f = neg.stutter[q * letters + a] as boolean;
      if (t === f) throw new Error(`end-of-flow verdict is not definite in state ${i} on letter ${a}; the construction is inconsistent`);
      prodEnd[i * letters + a] = t;
    }
  });

  // Moore minimisation: refine the partition by (verdict, end bits) until the block map is stable.
  const n = prodStates.length;
  const outputOf = (i: number): string => `${prodVerdicts[i]}|${Array.from({ length: letters }, (_, a) => (prodEnd[i * letters + a] ? 1 : 0)).join("")}`;
  let block = new Array<number>(n).fill(0);
  {
    const ids = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const o = outputOf(i);
      if (!ids.has(o)) ids.set(o, ids.size);
      block[i] = ids.get(o) as number;
    }
  }
  for (;;) {
    const ids = new Map<string, number>();
    const nextBlock = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const sig = `${block[i]}:${Array.from({ length: letters }, (_, a) => block[prodDelta[i * letters + a] as number]).join(",")}`;
      if (!ids.has(sig)) ids.set(sig, ids.size);
      nextBlock[i] = ids.get(sig) as number;
    }
    const stable = ids.size === new Set(block).size;
    block = nextBlock;
    if (stable) break;
  }
  const blockCount = new Set(block).size;
  const delta = new Array<number>(blockCount * letters).fill(0);
  const verdicts = new Array<Verdict>(blockCount).fill("inconclusive");
  const endTrue = new Array<boolean>(blockCount * letters).fill(false);
  for (let i = 0; i < n; i++) {
    const b = block[i] as number;
    verdicts[b] = prodVerdicts[i] as Verdict;
    for (let a = 0; a < letters; a++) {
      delta[b * letters + a] = block[prodDelta[i * letters + a] as number] as number;
      endTrue[b * letters + a] = prodEnd[i * letters + a] as boolean;
    }
  }
  return { source, atoms, letters, initial: block[0] as number, delta, verdicts, endTrue };
}

/** Encodes a valuation of the monitor's atoms as a letter. Atoms absent from the valuation read false. */
export function letterOf(monitor: Pick<CompiledMonitor, "atoms">, valuation: Record<string, boolean | null | undefined>): number {
  let letter = 0;
  monitor.atoms.forEach((a, i) => {
    if (valuation[a] === true) letter |= 1 << i;
  });
  return letter;
}

/** One run of a compiled monitor. Stepping is a single table lookup. */
export class MonitorRun {
  private state: number;
  constructor(readonly monitor: CompiledMonitor) {
    this.state = monitor.initial;
  }
  step(letter: number): Verdict {
    this.state = this.monitor.delta[this.state * this.monitor.letters + letter] as number;
    return this.verdict();
  }
  verdict(): Verdict {
    return this.monitor.verdicts[this.state] as Verdict;
  }
  /** The definite verdict if the flow ends here and `silent` is what every later step would read. */
  verdictAtEnd(silent: number): Verdict {
    return (this.monitor.endTrue[this.state * this.monitor.letters + silent] as boolean) ? "true" : "false";
  }
  /** Runs a whole trace from the initial state; the run is left positioned at its end. */
  static run(monitor: CompiledMonitor, trace: readonly number[]): MonitorRun {
    const r = new MonitorRun(monitor);
    for (const a of trace) r.step(a);
    return r;
  }
}
