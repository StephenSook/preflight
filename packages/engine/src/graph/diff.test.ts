import { describe, expect, it } from "vitest";
import type { FlowDeclaration } from "../ncco/atoms.js";
import { parseNcco } from "../ncco/parse.js";
import { declaredEndpointsOf, diffDeclared } from "./diff.js";
import { FlowGraph } from "./graph.js";

const T = "2026-09-05T12:00:00.000Z";
const actions = (ncco: unknown) => parseNcco(ncco).actions;

/** The reference application as its developer believes it is: greeting, a menu, press 1 for a person. */
const decl: FlowDeclaration = {
  identification: { phrases: ["This is a message from Preflight Demo Clinic"] },
  optOut: { eventUrlPatterns: ["/reference/optout"] },
  endpoints: ["/reference/menu", "/reference/optout"],
  flow: { answer: [["talk", "input"]], "/reference/menu": [["connect"]], "/reference/optout": [["connect"], ["talk"]] },
};

const ANSWER = actions([
  { action: "talk", text: "This is a message from Preflight Demo Clinic. Press 1 to speak with a scheduler." },
  { action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/reference/menu"], dtmf: { maxDigits: 1, timeOut: 5 } },
]);
const DIGIT = actions([{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }]);
const TIMEOUT = actions([{ action: "talk", text: "We could not reach you. We will try again tomorrow. Goodbye." }]);

function referenceGraph(): { g: FlowGraph; answerIds: string[]; digitIds: string[]; timeoutIds: string[] } {
  const g = new FlowGraph();
  const answer = g.observeObject("answer", ANSWER, T);
  const inputId = answer.nodeIds[1] as string;
  const digit = g.observeObject("/reference/menu", DIGIT, T, { nodeId: inputId, kind: "input_branch" });
  const timeout = g.observeObject("/reference/menu", TIMEOUT, "2026-09-05T12:01:00.000Z", { nodeId: inputId, kind: "input_branch" });
  return { g, answerIds: answer.nodeIds, digitIds: digit.nodeIds, timeoutIds: timeout.nodeIds };
}

describe("declared versus actual", () => {
  it("lists every declared endpoint once, with the answer endpoint always first", () => {
    expect(declaredEndpointsOf(decl)).toEqual(["answer", "/reference/menu", "/reference/optout"]);
    expect(declaredEndpointsOf({ flow: { "/x": [["talk"]] }, endpoints: ["/x", "/y"] })).toEqual(["answer", "/x", "/y"]);
    expect(declaredEndpointsOf({})).toEqual(["answer"]);
  });

  it("marks the branch nobody traced as undeclared, names that it speaks synthetically, and lists the declared endpoint never observed", () => {
    const { g, answerIds, digitIds, timeoutIds } = referenceGraph();
    const d = diffDeclared(g, decl);
    const byId = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
    expect(byId[answerIds[0] as string]).toMatchObject({ endpoint: "answer", index: 0, action: "talk", label: "talk#0", status: "declared", speaksSynthetic: true, atoms: expect.objectContaining({ identifies: true }) });
    expect(byId[answerIds[1] as string]).toMatchObject({ endpoint: "answer", index: 1, action: "input", status: "declared" });
    expect(byId[digitIds[0] as string]).toMatchObject({ endpoint: "/reference/menu", action: "connect", status: "declared", speaksSynthetic: false, atoms: expect.objectContaining({ connects_human: true }) });
    expect(byId[timeoutIds[0] as string]).toMatchObject({ endpoint: "/reference/menu", action: "talk", status: "undeclared", speaksSynthetic: true, text: "We could not reach you. We will try again tomorrow. Goodbye." });
    expect(d.missing).toEqual([{ endpoint: "/reference/optout", index: null, action: null }]);
    expect(d.counts).toEqual({ states: 4, declared: 3, undeclared: 1, undeclaredSpeaking: 1, neverObserved: 1, endpointsDeclared: 3, endpointsObserved: 2 });
    expect(d.roots).toEqual([answerIds[0]]);
    expect(d.openBranches).toEqual([]);
    expect(d.edges).toEqual(expect.arrayContaining([
      { from: answerIds[0], to: answerIds[1], kind: "sequential", observations: 1 },
      { from: answerIds[1], to: digitIds[0], kind: "input_branch", observations: 1 },
      { from: answerIds[1], to: timeoutIds[0], kind: "input_branch", observations: 1 },
    ]));
    expect(d.declared).toEqual({ endpoints: ["answer", "/reference/menu", "/reference/optout"], flow: decl.flow });
  });

  it("orders nodes by endpoint with answer first, then by position, so the graph screen reads top to bottom", () => {
    const { g } = referenceGraph();
    const d = diffDeclared(g, decl);
    expect(d.nodes.map((n) => `${n.endpoint} ${n.index} ${n.action}`)).toEqual(["answer 0 talk", "answer 1 input", "/reference/menu 0 connect", "/reference/menu 0 talk"]);
  });

  it("an endpoint declared without an action list accepts whatever it serves; an endpoint never declared accepts nothing", () => {
    const { g, timeoutIds, digitIds } = referenceGraph();
    const byEndpointOnly = diffDeclared(g, { endpoints: ["/reference/menu"] });
    const byId = Object.fromEntries(byEndpointOnly.nodes.map((n) => [n.id, n]));
    expect(byId[timeoutIds[0] as string]?.status).toBe("declared");
    expect(byId[digitIds[0] as string]?.status).toBe("declared");
    const undeclared = diffDeclared(g, {});
    expect(undeclared.nodes.filter((n) => n.endpoint === "/reference/menu").map((n) => n.status)).toEqual(["undeclared", "undeclared"]);
    expect(undeclared.counts).toMatchObject({ declared: 2, undeclared: 2, undeclaredSpeaking: 1, neverObserved: 0 });
  });

  it("reports a declared action that was never observed at its position, without inventing a node for it", () => {
    const { g } = referenceGraph();
    const d = diffDeclared(g, { ...decl, flow: { ...decl.flow, answer: [["talk", "input", "talk"]] } });
    expect(d.missing).toEqual(expect.arrayContaining([{ endpoint: "answer", index: 2, action: "talk" }, { endpoint: "/reference/optout", index: null, action: null }]));
    expect(d.counts.neverObserved).toBe(2);
    expect(d.nodes).toHaveLength(4);
  });

  it("keeps an open branch visible: an input whose callback has never returned is listed, not hidden", () => {
    const g = new FlowGraph();
    const { nodeIds } = g.observeObject("answer", ANSWER, T);
    const d = diffDeclared(g, decl);
    expect(d.openBranches).toEqual([nodeIds[1]]);
    expect(d.missing).toEqual(expect.arrayContaining([{ endpoint: "/reference/menu", index: null, action: null }]));
  });

  it("declares by position, not by presence: the same action types in another order are undeclared", () => {
    const g = new FlowGraph();
    g.observeObject("answer", actions([{ action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/reference/menu"] }, { action: "talk", text: "Goodbye." }]), T);
    const d = diffDeclared(g, { flow: { answer: [["talk", "input"]] } });
    expect(d.nodes.map((n) => [n.label, n.status])).toEqual([["input#0", "undeclared"], ["talk#1", "undeclared"]]);
    expect(d.missing).toEqual([{ endpoint: "answer", index: 0, action: "talk" }, { endpoint: "answer", index: 1, action: "input" }]);
  });

  it("is deterministic: the same graph and declaration produce byte-identical output", () => {
    const a = JSON.stringify(diffDeclared(referenceGraph().g, decl));
    const b = JSON.stringify(diffDeclared(referenceGraph().g, decl));
    expect(a).toBe(b);
  });
});
