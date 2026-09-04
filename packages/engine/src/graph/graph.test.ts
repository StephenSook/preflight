import { describe, expect, it } from "vitest";
import type { CallFacts, FlowDeclaration } from "../ncco/atoms.js";
import { parseNcco } from "../ncco/parse.js";
import { evaluateGraph } from "./evaluateGraph.js";
import { FlowGraph, nodeIdOf } from "./graph.js";

/** As in the spec example: the question input collects a digit and is not an opt-out; only /webhooks/optout is. */
const decl: FlowDeclaration = { identification: { phrases: ["This is a message from Preflight Demo Clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };
const facts: CallFacts = { from: "14045550100", lineType: "wireless", withinHours: true };
const T = "2026-09-06T21:14:00.000Z";
const actions = (ncco: unknown) => parseNcco(ncco).actions;

/** The spec's own example: greeting, a question, and a branch the developer never traced. */
const ANSWER = actions([
  { action: "talk", text: "This is a message from Preflight Demo Clinic." },
  { action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/webhooks/question"], dtmf: { maxDigits: 1, timeOut: 5 } },
]);
const DIGIT_BRANCH = actions([{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }]);
const TIMEOUT_BRANCH = actions([{ action: "talk", text: "We could not reach you. Goodbye." }]);
const OPTOUT_MENU = actions([{ action: "talk", text: "Press nine to stop these calls." }, { action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/webhooks/optout"] }]);

describe("passive graph discovery", () => {
  it("merges an object into nodes and sequential edges, and counts repeat observations instead of duplicating", () => {
    const g = new FlowGraph();
    const first = g.observeObject("answer", ANSWER, T);
    expect(first).toMatchObject({ newNodes: 2, newEdges: 1 });
    const again = g.observeObject("answer", ANSWER, "2026-09-06T21:15:00.000Z");
    expect(again).toMatchObject({ newNodes: 0, newEdges: 0 });
    expect(g.nodes.get(first.nodeIds[0] as string)).toMatchObject({ observations: 2, firstSeen: T, lastSeen: "2026-09-06T21:15:00.000Z", endpoint: "answer", index: 0 });
    expect(first.nodeIds[0]).toBe(nodeIdOf("answer", 0, ANSWER[0] as never));
  });

  it("reports a never-observed branch as an open path and holds it", () => {
    const g = new FlowGraph();
    const { nodeIds } = g.observeObject("answer", ANSWER, T);
    const paths = g.paths(nodeIds[0] as string);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ end: "open", openAt: nodeIds[1], labels: ["talk#0", "input#1"] });
    const ev = evaluateGraph(g, nodeIds[0] as string, { declaration: decl, facts, policy: "strict" });
    expect(ev.decision).toBe("hold");
    expect(ev.verdicts.find((v) => v.id === "P3")).toMatchObject({ verdict: "inconclusive", reason: expect.stringContaining("input#1") });
    expect(g.coverage(["answer", "/webhooks/question"])).toMatchObject({ observed: ["answer"], unobserved: ["/webhooks/question"], states: 2, edges: 1, branchPoints: 1, openBranches: [nodeIds[1]] });
  });

  it("finds the untraced synthetic branch once it is observed, with the primed witness path from the spec", () => {
    const g = new FlowGraph();
    const { nodeIds } = g.observeObject("answer", ANSWER, T);
    const input = nodeIds[1] as string;
    g.observeObject("/webhooks/question", DIGIT_BRANCH, T, { nodeId: input, kind: "input_branch" });
    g.observeObject("/webhooks/question", TIMEOUT_BRANCH, T, { nodeId: input, kind: "input_branch" });
    const paths = g.paths(nodeIds[0] as string);
    expect(paths.map((p) => p.labels.join(" > ")).sort()).toEqual(["talk#0 > input#1 > connect#0'", "talk#0 > input#1 > talk#0'"]);
    expect(paths.every((p) => p.end === "terminal")).toBe(true);
    const ev = evaluateGraph(g, nodeIds[0] as string, { declaration: decl, facts, policy: "strict" });
    expect(ev.decision).toBe("block");
    const p3 = ev.verdicts.find((v) => v.id === "P3");
    expect(p3).toMatchObject({ verdict: "false", atEnd: true });
    expect(p3?.witness?.map((w) => w.label)).toEqual(["talk#0", "input#1", "talk#0'"]);
    expect(g.coverage(["answer", "/webhooks/question", "/webhooks/voicemail-fallback"])).toMatchObject({ observed: ["answer", "/webhooks/question"], unobserved: ["/webhooks/voicemail-fallback"], branchPoints: 1, openBranches: [] });
  });

  it("passes once every observed continuation reaches the declared opt-out, and the fix is a second object", () => {
    const g = new FlowGraph();
    const { nodeIds } = g.observeObject("answer", ANSWER, T);
    const input = nodeIds[1] as string;
    g.observeObject("/webhooks/question", DIGIT_BRANCH, T, { nodeId: input, kind: "input_branch" });
    const menu = g.observeObject("/webhooks/question", OPTOUT_MENU, T, { nodeId: input, kind: "input_branch" });
    // The opt-out input's own callback has not been observed: that path is open, so strict holds.
    expect(evaluateGraph(g, nodeIds[0] as string, { declaration: decl, facts, policy: "strict" }).decision).toBe("hold");
    // Observe that the opt-out callback returns nothing and the object ends: now every path is terminal.
    g.observeObject("/webhooks/optout", [], T, { nodeId: menu.nodeIds[1] as string, kind: "input_branch" });
    const ev = evaluateGraph(g, nodeIds[0] as string, { declaration: decl, facts, policy: "strict" });
    expect(ev.decision).toBe("pass");
    expect(ev.paths.map((p) => p.path.end)).toEqual(["terminal", "terminal"]);
  });

  it("records an empty callback as a continue edge to the next action of the same object", () => {
    const g = new FlowGraph();
    const obj = actions([{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "notify", payload: { step: 1 }, eventUrl: ["https://origin.example/webhooks/notify"] }, { action: "talk", text: "Goodbye." }]);
    const { nodeIds } = g.observeObject("answer", obj, T);
    expect(g.paths(nodeIds[0] as string)[0]).toMatchObject({ end: "open", labels: ["talk#0", "notify#1"] });
    const r = g.observeObject("/webhooks/notify", [], T, { nodeId: nodeIds[1] as string, kind: "notify_branch" });
    expect(r.newEdges).toBe(1);
    expect(g.paths(nodeIds[0] as string)[0]).toMatchObject({ end: "terminal", labels: ["talk#0", "notify#1", "talk#2"] });
  });

  it("stops on a loop and holds it rather than deciding an infinite path", () => {
    const g = new FlowGraph();
    const { nodeIds } = g.observeObject("answer", ANSWER, T);
    // The question callback returns the same object again: a menu that repeats forever.
    g.observeObject("answer", ANSWER, T, { nodeId: nodeIds[1] as string, kind: "input_branch" });
    const paths = g.paths(nodeIds[0] as string);
    expect(paths[0]?.end).toBe("cyclic");
    const ev = evaluateGraph(g, nodeIds[0] as string, { declaration: decl, facts, policy: "strict" });
    expect(ev.decision).toBe("hold");
    expect(ev.verdicts.find((v) => v.id === "P3")?.reason).toContain("loops");
  });

  it("reports a violation on one branch even while a sibling branch is still open: false outranks undecided", () => {
    const g = new FlowGraph();
    const { nodeIds } = g.observeObject("answer", ANSWER, T);
    const input = nodeIds[1] as string;
    g.observeObject("/webhooks/question", TIMEOUT_BRANCH, T, { nodeId: input, kind: "input_branch" });
    g.observeObject("/webhooks/question", OPTOUT_MENU, T, { nodeId: input, kind: "input_branch" });
    const ev = evaluateGraph(g, nodeIds[0] as string, { declaration: decl, facts, policy: "strict" });
    expect(ev.paths.map((p) => p.path.end).sort()).toEqual(["open", "terminal"]);
    const p3 = ev.verdicts.find((v) => v.id === "P3");
    expect(p3).toMatchObject({ verdict: "false", atEnd: true });
    expect(p3?.witness?.map((w) => w.label)).toEqual(["talk#0", "input#1", "talk#0'"]);
    expect(ev.decision).toBe("block");
  });

  it("round-trips through the node and edge collections a store would persist", () => {
    const g = new FlowGraph();
    const { nodeIds } = g.observeObject("answer", ANSWER, T);
    g.observeObject("/webhooks/question", TIMEOUT_BRANCH, T, { nodeId: nodeIds[1] as string, kind: "input_branch" });
    const copy = FlowGraph.from(g.nodes.values(), g.edges.values());
    expect(copy.paths(nodeIds[0] as string)).toEqual(g.paths(nodeIds[0] as string));
    expect(copy.coverage(["answer"])).toEqual(g.coverage(["answer"]));
  });
});
