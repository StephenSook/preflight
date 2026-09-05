import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decide, evaluateNcco, evaluatePath, type PropertyVerdict } from "./evaluate.js";
import type { Verdict } from "./ltl/monitor.js";
import type { CallFacts, FlowDeclaration } from "./ncco/atoms.js";
import { parseNcco } from "./ncco/parse.js";
import { compiledProperties, PROPERTIES, type PropertyId } from "./properties.js";

const corpusDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../corpus/ncco");

interface CorpusFile {
  name: string;
  declaration?: FlowDeclaration;
  ncco: unknown;
  expect: {
    terminal: { facts: CallFacts; verdicts: Record<PropertyId, Verdict>; decision: "pass" | "block" | "hold"; witness?: Partial<Record<PropertyId, { path: string[]; atEnd: boolean }>> };
  };
}

const files = readdirSync(corpusDir).filter((f) => f.endsWith(".json")).sort();
const byId = (vs: PropertyVerdict[]): Record<string, PropertyVerdict> => Object.fromEntries(vs.map((v) => [v.id, v]));

describe("P1..P5 against the labelled corpus, each object taken as one terminal path", () => {
  it("compiles every property once and every formula names only known atoms", () => {
    const m = compiledProperties();
    expect([...m.keys()]).toEqual(PROPERTIES.map((p) => p.id));
    expect(compiledProperties()).toBe(m);
    for (const p of PROPERTIES) expect(m.get(p.id)?.verdicts.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const c = JSON.parse(readFileSync(path.join(corpusDir, file), "utf8")) as CorpusFile;
    it(`${file}: ${c.name}`, () => {
      const label = c.expect.terminal;
      const parsed = parseNcco(c.ncco);
      const ev = evaluateNcco(parsed, { declaration: c.declaration, facts: label.facts, terminal: true });
      const got = byId(ev.verdicts);
      expect(Object.fromEntries(ev.verdicts.map((v) => [v.id, v.verdict]))).toEqual(label.verdicts);
      expect(ev.decision).toBe(label.decision);
      for (const v of ev.verdicts) {
        // A false verdict names the action that reached the prohibited state; an empty object has none, and the call itself is the witness.
        if (v.verdict === "false") expect((v.witness?.length ?? 0) > 0 || parsed.actions.length === 0).toBe(true);
        if (v.verdict === "inconclusive") expect(v.reason).toBeTruthy();
        expect(v.citation).toBe(PROPERTIES.find((p) => p.id === v.id)?.citation);
      }
      for (const [id, w] of Object.entries(label.witness ?? {})) {
        expect(got[id]?.witness?.map((s) => s.label)).toEqual(w.path);
        expect(got[id]?.atEnd ?? false).toBe(w.atEnd);
      }
      // Every false verdict on this corpus is labelled, so an unlabelled false is a test defect.
      for (const v of ev.verdicts) if (v.verdict === "false") expect(Object.keys(label.witness ?? {})).toContain(v.id);
    });
  }
});

describe("what the evaluator refuses to guess", () => {
  const decl: FlowDeclaration = { identification: { phrases: ["this is a message from preflight demo clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };
  const compliant = parseNcco([
    { action: "talk", text: "This is a message from Preflight Demo Clinic." },
    { action: "input", type: ["dtmf"], eventUrl: ["https://o.example/webhooks/optout"] },
  ]);

  it("holds P1 when the destination timezone is unresolved, and decides the rest", () => {
    const ev = evaluateNcco(compliant, { declaration: decl, facts: { from: "14045550100", lineType: "wireless", withinHours: null }, terminal: true });
    const got = byId(ev.verdicts);
    expect(got["P1"]).toMatchObject({ verdict: "inconclusive", reason: expect.stringContaining("timezone") });
    for (const id of ["P2", "P3", "P4", "P5"]) expect(got[id]?.verdict).toBe("true");
    expect(ev.decision).toBe("hold");
    expect(decide(ev.verdicts, "advisory")).toBe("pass");
  });

  it("blocks on a missing caller id regardless of anything else on the path", () => {
    const ev = evaluateNcco(compliant, { declaration: decl, facts: { from: undefined, lineType: "wireless", withinHours: true }, terminal: true });
    expect(byId(ev.verdicts)["P4"]).toMatchObject({ verdict: "false", witness: [expect.objectContaining({ label: "talk#0" })] });
    expect(ev.decision).toBe("block");
  });

  it("P4 is a fact about the call: decided at the first action on an open path, and at the end of an empty object", () => {
    const noCallerId: CallFacts = { from: "anonymous", lineType: "wireless", withinHours: true };
    const open = evaluateNcco(compliant, { declaration: decl, facts: noCallerId, terminal: false });
    expect(byId(open.verdicts)["P4"]).toMatchObject({ verdict: "false", witness: [expect.objectContaining({ label: "talk#0" })] });
    expect(byId(open.verdicts)["P4"]?.atEnd).toBeUndefined();
    expect(open.decision).toBe("block");
    const empty = evaluateNcco(parseNcco([]), { declaration: decl, facts: noCallerId, terminal: true });
    expect(byId(empty.verdicts)["P4"]).toMatchObject({ verdict: "false", atEnd: true, witness: [] });
    const present = evaluateNcco(parseNcco([]), { declaration: decl, facts: { from: "14045550100", lineType: "wireless", withinHours: true }, terminal: true });
    expect(byId(present.verdicts)["P4"]?.verdict).toBe("true");
  });

  it("holds an open path whose branch has not been observed, then decides it once the branch is seen", () => {
    const facts: CallFacts = { from: "14045550100", lineType: "wireless", withinHours: true };
    // An always-property is never true on an open prefix: a later branch could still violate it.
    // P1 and P4 are facts about the call, known at the first action, so they are decided even while the path is open.
    const open = evaluateNcco(compliant, { declaration: decl, facts, terminal: false });
    expect(byId(open.verdicts)["P3"]).toMatchObject({ verdict: "inconclusive", reason: expect.stringContaining("not been observed") });
    for (const id of ["P1", "P2", "P4", "P5"]) expect(byId(open.verdicts)[id]?.verdict).toBe("true");
    expect(open.decision).toBe("hold");
    expect(evaluateNcco(compliant, { declaration: decl, facts, terminal: true }).decision).toBe("pass");
    const noOptOut = parseNcco([{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "input", type: ["dtmf"], eventUrl: ["https://o.example/menu"] }]);
    const held = evaluateNcco(noOptOut, { declaration: decl, facts, terminal: false });
    expect(byId(held.verdicts)["P3"]).toMatchObject({ verdict: "inconclusive", reason: expect.stringContaining("not been observed") });
    expect(held.decision).toBe("hold");
    const closed = evaluateNcco(noOptOut, { declaration: decl, facts, terminal: true });
    expect(byId(closed.verdicts)["P3"]).toMatchObject({ verdict: "false", atEnd: true });
    expect(closed.decision).toBe("block");
  });

  it("keeps a false verdict reached before an unparseable action, and holds everything after it", () => {
    const parsed = parseNcco([{ action: "talk", text: "Buy now." }, { action: "beep" }, { action: "talk", text: "This is a message from Preflight Demo Clinic." }]);
    const ev = evaluatePath(parsed.actions, { declaration: decl, facts: { from: "14045550100", lineType: "wireless", withinHours: true }, terminal: true });
    const got = byId(ev.verdicts);
    expect(got["P5"]).toMatchObject({ verdict: "false", witness: [expect.objectContaining({ label: "talk#0" })] });
    expect(got["P3"]).toMatchObject({ verdict: "inconclusive", reason: expect.stringContaining("unknown#1") });
    expect(ev.decision).toBe("block");
  });

  it("is deterministic and independent of property order", () => {
    const facts: CallFacts = { from: "14045550100", lineType: "wireless", withinHours: true };
    const a = evaluateNcco(compliant, { declaration: decl, facts, terminal: true });
    const b = evaluateNcco(compliant, { declaration: decl, facts, terminal: true });
    expect(b).toEqual(a);
    const shuffled = [...a.verdicts].reverse();
    expect(decide(shuffled, "strict")).toBe(decide(a.verdicts, "strict"));
  });
});

describe("the property table where the corpus is silent", () => {
  const decl: FlowDeclaration = { identification: { phrases: ["this is a message from preflight demo clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };
  const inHours: CallFacts = { from: "14045550100", lineType: "wireless", withinHours: true };
  const afterHours: CallFacts = { from: "14045550100", lineType: "wireless", withinHours: false };
  const labels = (v: PropertyVerdict | undefined): string[] | undefined => v?.witness?.map((s) => s.label);

  it("P2 and P5 are weak: a flow that never identifies and never speaks synthetically satisfies them when it ends", () => {
    // Every corpus object identifies early or violates early, so only a live-leg-only flow tells the
    // table's weak until from a strong until, which would fail both properties at the end of the flow.
    const liveOnly = parseNcco([{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }]);
    const ev = evaluateNcco(liveOnly, { declaration: decl, facts: inHours, terminal: true });
    const got = byId(ev.verdicts);
    expect(got["P2"]?.verdict).toBe("true");
    expect(got["P5"]?.verdict).toBe("true");
    expect(ev.decision).toBe("pass");
  });

  it("P1 blocks a call outside calling hours at its first action, whatever that action is: the ring is the intrusion", () => {
    const spoken = parseNcco([{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "input", type: ["dtmf"], eventUrl: ["https://o.example/webhooks/optout"] }]);
    const ev = evaluateNcco(spoken, { declaration: decl, facts: afterHours, terminal: true });
    const got = byId(ev.verdicts);
    expect(got["P1"]?.verdict).toBe("false");
    expect(labels(got["P1"])).toEqual(["talk#0"]);
    expect(got["P1"]?.atEnd).toBeUndefined();
    for (const id of ["P2", "P3", "P4", "P5"]) expect(got[id]?.verdict).toBe("true");
    expect(ev.decision).toBe("block");
    // A flow that goes straight to a live agent at 6 a.m. was still initiated at 6 a.m.
    const humanFirst = parseNcco([{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }, { action: "talk", text: "This is a message from Preflight Demo Clinic." }]);
    const late = byId(evaluateNcco(humanFirst, { declaration: decl, facts: afterHours, terminal: true }).verdicts);
    expect(late["P1"]?.verdict).toBe("false");
    expect(labels(late["P1"])).toEqual(["connect#0"]);
    // An empty object still places the call: false at the end of the flow, and the call itself is the witness.
    const empty = byId(evaluateNcco(parseNcco([]), { declaration: decl, facts: afterHours, terminal: true }).verdicts);
    expect(empty["P1"]?.verdict).toBe("false");
    expect(empty["P1"]?.atEnd).toBe(true);
    expect(labels(empty["P1"])).toEqual([]);
  });

  it("pay prompts are synthetic speech: a pay action before the identification beat breaks P2 and P5", () => {
    const pay = parseNcco([{ action: "pay", amount: 9.99, prompts: [{ type: "CardNumber", text: "Please enter your card number." }] }]);
    const got = byId(evaluateNcco(pay, { declaration: decl, facts: inHours, terminal: true }).verdicts);
    expect(got["P2"]?.verdict).toBe("false");
    expect(got["P5"]?.verdict).toBe("false");
    expect(labels(got["P2"])).toEqual(["pay#0"]);
    const silent = parseNcco([{ action: "pay", amount: 9.99 }]);
    const quiet = byId(evaluateNcco(silent, { declaration: decl, facts: inHours, terminal: true }).verdicts);
    expect(quiet["P2"]?.verdict).toBe("true");
    expect(quiet["P5"]?.verdict).toBe("true");
  });
});
