import { show, type Formula } from "./ast.js";

/**
 * LTL to generalised Büchi automaton by the tableau construction of Gerth, Peled, Vardi and Wolper
 * (1995), the construction the LTL3 monitor paper builds on. States are labelled with the literals
 * they require of the letter being read: a run enters state q on letter a only if a satisfies q's
 * literals. Acceptance is one set per until-subformula.
 */
export interface NbaState {
  id: number;
  /** Atoms that must be true in the letter read on entering this state (bitmask over `atoms`). */
  posMask: number;
  /** Atoms that must be false. */
  negMask: number;
  /** Predecessor states; -1 stands for the initial pseudo-state. */
  incoming: number[];
  /** The formulas this state has committed to (the GPVW "old" set), as canonical text. */
  old: string[];
}

export interface Nba {
  atoms: string[];
  states: NbaState[];
  /** Ids of states a run may start in (reading the first letter). */
  initial: number[];
  /** One accepting set per until-subformula, as state ids. */
  acceptance: number[][];
}

type FSet = Map<string, Formula>;

interface Node {
  id: number;
  incoming: Set<number>;
  fresh: FSet;
  old: FSet;
  next: FSet;
}

const key = show;
const setOf = (fs: Iterable<Formula>): FSet => {
  const m: FSet = new Map();
  for (const f of fs) m.set(key(f), f);
  return m;
};
const union = (a: FSet, b: FSet): FSet => {
  const m = new Map(a);
  for (const [k, v] of b) m.set(k, v);
  return m;
};
const minus = (a: FSet, b: FSet): FSet => {
  const m = new Map(a);
  for (const k of b.keys()) m.delete(k);
  return m;
};
const sameSet = (a: FSet, b: FSet): boolean => a.size === b.size && [...a.keys()].every((k) => b.has(k));
const isLiteral = (f: Formula): boolean => f.kind === "true" || f.kind === "false" || f.kind === "atom" || (f.kind === "not" && f.of.kind === "atom");

export function ltlToNba(phi: Formula, atoms: string[]): Nba {
  let nextId = 0;
  const done: Node[] = [];

  function expand(node: Node): void {
    if (node.fresh.size === 0) {
      const twin = done.find((n) => sameSet(n.old, node.old) && sameSet(n.next, node.next));
      if (twin) {
        for (const i of node.incoming) twin.incoming.add(i);
        return;
      }
      done.push(node);
      expand({ id: nextId++, incoming: new Set([node.id]), fresh: new Map(node.next), old: new Map(), next: new Map() });
      return;
    }
    const [k, eta] = node.fresh.entries().next().value as [string, Formula];
    node.fresh.delete(k);

    if (isLiteral(eta)) {
      if (eta.kind === "false") return;
      if (eta.kind === "atom" && node.old.has(key({ kind: "not", of: eta }))) return;
      if (eta.kind === "not" && node.old.has(key(eta.of))) return;
      if (eta.kind !== "true") node.old.set(k, eta);
      expand(node);
      return;
    }
    const oldWithEta = new Map(node.old);
    oldWithEta.set(k, eta);
    const branch = (fresh1: Formula[], next1: Formula[]): Node => ({
      id: nextId++,
      incoming: new Set(node.incoming),
      fresh: union(node.fresh, minus(setOf(fresh1), node.old)),
      old: new Map(oldWithEta),
      next: union(node.next, setOf(next1)),
    });
    switch (eta.kind) {
      case "and":
        expand(branch([eta.left, eta.right], []));
        return;
      case "next":
        expand(branch([], [eta.of]));
        return;
      case "or":
        expand(branch([eta.left], []));
        expand(branch([eta.right], []));
        return;
      case "until":
        expand(branch([eta.left], [eta]));
        expand(branch([eta.right], []));
        return;
      case "release":
        expand(branch([eta.right], [eta]));
        expand(branch([eta.left, eta.right], []));
        return;
      default:
        throw new Error(`unreachable formula kind ${eta.kind}`);
    }
  }

  expand({ id: nextId++, incoming: new Set([-1]), fresh: setOf([phi]), old: new Map(), next: new Map() });

  const idMap = new Map<number, number>();
  done.forEach((n, i) => idMap.set(n.id, i));
  const states: NbaState[] = done.map((n, i) => {
    let posMask = 0;
    let negMask = 0;
    for (const f of n.old.values()) {
      if (f.kind === "atom") posMask |= 1 << atoms.indexOf(f.name);
      if (f.kind === "not" && f.of.kind === "atom") negMask |= 1 << atoms.indexOf(f.of.name);
    }
    const incoming = [...n.incoming].map((src) => (src === -1 ? -1 : (idMap.get(src) ?? -2))).filter((x) => x !== -2);
    return { id: i, posMask, negMask, incoming, old: [...n.old.keys()].sort() };
  });
  const untils = collectUntils(phi);
  const acceptance = untils.map((u) => {
    const uk = key(u);
    const rk = key(u.right);
    return states.filter((s) => !s.old.includes(uk) || s.old.includes(rk)).map((s) => s.id);
  });
  return { atoms, states, initial: states.filter((s) => s.incoming.includes(-1)).map((s) => s.id), acceptance };
}

type UntilFormula = Extract<Formula, { kind: "until" }>;

function collectUntils(f: Formula, out: UntilFormula[] = []): UntilFormula[] {
  switch (f.kind) {
    case "until":
      if (!out.some((g) => key(g) === key(f))) out.push(f);
      collectUntils(f.left, out);
      collectUntils(f.right, out);
      return out;
    case "and":
    case "or":
    case "release":
      collectUntils(f.left, out);
      collectUntils(f.right, out);
      return out;
    case "not":
    case "next":
      return collectUntils(f.of, out);
    default:
      return out;
  }
}

export const admits = (s: NbaState, letter: number): boolean => (letter & s.posMask) === s.posMask && (letter & s.negMask) === 0;

/**
 * States with a non-empty omega-language: those from which an accepting cycle (a non-trivial
 * strongly connected component meeting every acceptance set) is reachable. With `letter` given, only
 * transitions readable on that letter count, which answers "does an infinite run exist reading this
 * letter forever" for the end-of-flow verdict.
 */
export function liveStates(nba: Nba, letter?: number): boolean[] {
  const n = nba.states.length;
  const succ: number[][] = Array.from({ length: n }, () => []);
  for (const t of nba.states) {
    if (letter !== undefined && !admits(t, letter)) continue;
    for (const s of t.incoming) if (s >= 0) succ[s]?.push(t.id);
  }
  // Tarjan's algorithm, iterative to keep stack depth bounded.
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const comp = new Array<number>(n).fill(-1);
  let counter = 0;
  let compCount = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: Array<[number, number]> = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const top = work[work.length - 1] as [number, number];
      const [v, i] = top;
      const edges = succ[v] ?? [];
      if (i < edges.length) {
        top[1] = i + 1;
        const w = edges[i] as number;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v] as number, index[w] as number);
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = (work[work.length - 1] as [number, number])[0];
          low[parent] = Math.min(low[parent] as number, low[v] as number);
        }
        if (low[v] === index[v]) {
          for (;;) {
            const w = stack.pop() as number;
            onStack[w] = false;
            comp[w] = compCount;
            if (w === v) break;
          }
          compCount++;
        }
      }
    }
  }
  const members: number[][] = Array.from({ length: compCount }, () => []);
  comp.forEach((c, v) => members[c]?.push(v));
  const acceptingComp = members.map((vs) => {
    const nontrivial = vs.length > 1 || vs.some((v) => succ[v]?.includes(v));
    return nontrivial && nba.acceptance.every((set) => vs.some((v) => set.includes(v)));
  });
  const live = new Array<boolean>(n).fill(false);
  // Reverse reachability from accepting components.
  const pred: number[][] = Array.from({ length: n }, () => []);
  succ.forEach((ws, v) => ws.forEach((w) => pred[w]?.push(v)));
  const queue: number[] = [];
  for (let v = 0; v < n; v++) if (acceptingComp[comp[v] as number]) { live[v] = true; queue.push(v); }
  while (queue.length > 0) {
    const w = queue.shift() as number;
    for (const v of pred[w] ?? []) if (!live[v]) { live[v] = true; queue.push(v); }
  }
  return live;
}
