import { describe, expect, it } from "vitest";
import { negate, show } from "./ast.js";
import { compileMonitor, letterOf, MonitorRun, type CompiledMonitor, type Verdict } from "./monitor.js";
import { parseLtl } from "./parse.js";

type Val = Record<string, boolean>;
const run = (m: CompiledMonitor, trace: Val[]): Verdict => MonitorRun.run(m, trace.map((v) => letterOf(m, v))).verdict();
const atEnd = (m: CompiledMonitor, trace: Val[], silent: Val): Verdict => MonitorRun.run(m, trace.map((v) => letterOf(m, v))).verdictAtEnd(letterOf(m, silent));
const P = { p: true };
const NP = { p: false };
const Q = { q: true };

describe("LTL3 verdicts on the textbook formulas", () => {
  it("G p: inconclusive while p holds, false the moment it does not, never true", () => {
    const m = compileMonitor("G p");
    expect(run(m, [])).toBe("inconclusive");
    expect(run(m, [P, P, P])).toBe("inconclusive");
    expect(run(m, [P, NP])).toBe("false");
    expect(run(m, [NP])).toBe("false");
    expect(run(m, [P, NP, P])).toBe("false");
    expect(atEnd(m, [P, P], P)).toBe("true");
    expect(atEnd(m, [P, P], NP)).toBe("false");
  });

  it("F p: inconclusive until p, then true forever", () => {
    const m = compileMonitor("F p");
    expect(run(m, [])).toBe("inconclusive");
    expect(run(m, [NP, NP])).toBe("inconclusive");
    expect(run(m, [P])).toBe("true");
    expect(run(m, [NP, P, NP])).toBe("true");
    expect(atEnd(m, [NP], NP)).toBe("false");
    expect(atEnd(m, [NP], P)).toBe("true");
  });

  it("p U q: true at the first q, false the first time neither holds", () => {
    const m = compileMonitor("p U q");
    expect(run(m, [])).toBe("inconclusive");
    expect(run(m, [P])).toBe("inconclusive");
    expect(run(m, [Q])).toBe("true");
    expect(run(m, [P, P, Q])).toBe("true");
    expect(run(m, [{ p: false, q: false }])).toBe("false");
    expect(run(m, [P, { p: false, q: false }])).toBe("false");
    expect(atEnd(m, [P, P], NP)).toBe("false");
  });

  it("X p: decided exactly at the second letter", () => {
    const m = compileMonitor("X p");
    expect(run(m, [])).toBe("inconclusive");
    expect(run(m, [NP])).toBe("inconclusive");
    expect(run(m, [NP, P])).toBe("true");
    expect(run(m, [P, NP])).toBe("false");
  });

  it("p R q: q must hold up to and including the first p", () => {
    const m = compileMonitor("p R q");
    expect(run(m, [Q])).toBe("inconclusive");
    expect(run(m, [{ p: false, q: false }])).toBe("false");
    expect(run(m, [{ p: true, q: true }])).toBe("true");
    expect(run(m, [Q, { p: true, q: false }])).toBe("false");
  });

  it("G F p is not monitorable: no finite prefix ever decides it, only the end of the flow does", () => {
    const m = compileMonitor("G F p");
    for (const t of [[], [P], [NP], [P, NP, P, NP], [NP, NP, NP, NP, NP]]) expect(run(m, t)).toBe("inconclusive");
    expect(atEnd(m, [P, NP], P)).toBe("true");
    expect(atEnd(m, [P, P], NP)).toBe("false");
  });

  it("G (p -> X q): a p must be followed by a q on the very next step", () => {
    const m = compileMonitor("G (p -> X q)");
    expect(run(m, [P])).toBe("inconclusive");
    expect(run(m, [P, { p: false, q: false }])).toBe("false");
    expect(run(m, [P, { p: false, q: true }])).toBe("inconclusive");
    expect(run(m, [NP, NP, NP])).toBe("inconclusive");
    expect(atEnd(m, [P], { p: false, q: false })).toBe("false");
    expect(atEnd(m, [NP], { p: false, q: false })).toBe("true");
  });

  it("G (a -> F b), the shape of the opt-out property: never false on a prefix, false when the flow ends without b", () => {
    const m = compileMonitor("G (a -> F b)");
    const A = { a: true, b: false };
    const B = { a: false, b: true };
    const N = { a: false, b: false };
    expect(run(m, [A])).toBe("inconclusive");
    expect(run(m, [A, N, N, N])).toBe("inconclusive");
    expect(run(m, [A, B])).toBe("inconclusive");
    expect(atEnd(m, [A, N], N)).toBe("false");
    expect(atEnd(m, [A, B], N)).toBe("true");
    expect(atEnd(m, [N, N], N)).toBe("true");
  });
});

describe("the identification formulas", () => {
  const S = { speaks: true, synthetic: true, connects_human: false, identifies: false };
  const ID = { speaks: true, synthetic: true, connects_human: false, identifies: true };
  const H = { speaks: false, synthetic: false, connects_human: true, identifies: false };

  it("the spec's literal P5, !( !identifies U speaks ), is false on a flow whose first action IS the identification", () => {
    const m = compileMonitor("!( !identifies U speaks )");
    expect(run(m, [ID])).toBe("false");
  });

  it("the weak-until encoding is true when identification speaks first, false when anything speaks before it", () => {
    const p5 = compileMonitor("(!speaks) W identifies");
    expect(run(p5, [ID])).toBe("true");
    expect(run(p5, [ID, S, S])).toBe("true");
    expect(run(p5, [S])).toBe("false");
    expect(run(p5, [H, ID])).toBe("true");
    expect(run(p5, [H])).toBe("inconclusive");
    expect(atEnd(p5, [H], { speaks: false, identifies: false })).toBe("true");
  });

  it("P2, no synthetic speech before identification, allows a live human leg first and the identifying beat itself", () => {
    const p2 = compileMonitor("(!(speaks & synthetic & !connects_human)) W identifies");
    expect(run(p2, [ID, S])).toBe("true");
    expect(run(p2, [H, ID, S])).toBe("true");
    expect(run(p2, [S, ID])).toBe("false");
    expect(run(p2, [H])).toBe("inconclusive");
    expect(atEnd(p2, [H], { speaks: false, synthetic: false, connects_human: false, identifies: false })).toBe("true");
  });
});

describe("construction invariants", () => {
  const formulas = ["G p", "F p", "p U q", "X p", "p R q", "G F p", "F G p", "G (p -> X q)", "G (p -> F q)", "(p -> X q) U r", "!(p U q) | X X r", "(!p) W q", "G (p & q) | F !r"];
  const atoms = ["p", "q", "r"];
  const seed = { s: 20260904 };
  const rnd = (): number => {
    seed.s = (seed.s * 1103515245 + 12345) & 0x7fffffff;
    return seed.s / 0x7fffffff;
  };
  const randomTrace = (len: number): number[] => Array.from({ length: len }, () => Math.floor(rnd() * 8));

  it("compiles deterministically: the same formula yields byte-identical tables", () => {
    for (const f of formulas) {
      const a = compileMonitor(f, atoms);
      const b = compileMonitor(f, atoms);
      expect(b).toEqual(a);
    }
  });

  it("verdicts are final: once true or false, every extension keeps the verdict (n=100 random traces per formula)", () => {
    for (const f of formulas) {
      const m = compileMonitor(f, atoms);
      for (let i = 0; i < 100; i++) {
        const r = new MonitorRun(m);
        let decided: Verdict | undefined;
        for (const letter of randomTrace(12)) {
          const v = r.step(letter);
          if (decided) expect(v).toBe(decided);
          else if (v !== "inconclusive") decided = v;
        }
      }
    }
  });

  it("a formula and its negation are complementary on every prefix and at every end", () => {
    for (const f of formulas) {
      const phi = parseLtl(f);
      const m = compileMonitor(phi, atoms);
      const n = compileMonitor(negate(phi), atoms);
      expect(show(negate(negate(phi)))).toBe(show(phi));
      for (let i = 0; i < 60; i++) {
        const t = randomTrace(8);
        const a = MonitorRun.run(m, t);
        const b = MonitorRun.run(n, t);
        const flip: Record<Verdict, Verdict> = { true: "false", false: "true", inconclusive: "inconclusive" };
        expect(b.verdict()).toBe(flip[a.verdict()]);
        for (let s = 0; s < 8; s++) expect(b.verdictAtEnd(s)).toBe(flip[a.verdictAtEnd(s)]);
      }
    }
  });

  it("the minimised monitor for G p has exactly two states", () => {
    const m = compileMonitor("G p");
    expect(m.verdicts).toHaveLength(2);
    expect(new Set(m.verdicts)).toEqual(new Set(["inconclusive", "false"]));
  });
});
