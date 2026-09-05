import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The README says the engine runs in Node and in the browser with zero dependencies. This makes the
 * claim a test: bundle the package entry for the browser, refuse any Node built-in in the output,
 * then run the bundle in a bare context with no `require`, no `process` and no `Buffer`, and have it
 * parse an object, evaluate it, and diff a discovered graph.
 */
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

describe("the engine in a browser", () => {
  it("bundles without any Node built-in and decides a call flow in a bare context", async () => {
    const result = await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "iife", globalName: "PreflightEngine", write: false, target: "es2022", logLevel: "silent" });
    const code = result.outputFiles[0]?.text ?? "";
    expect(code.length).toBeGreaterThan(10000);
    expect(code).not.toMatch(/require\(["']node:/);
    expect(code).not.toMatch(/from ["']node:/);
    expect(code).not.toMatch(/\bprocess\.env\b/);

    const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder, console: { warn: () => undefined, error: () => undefined } };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { timeout: 5000 });
    const engine = sandbox["PreflightEngine"] as {
      parseNcco: (v: unknown) => { actions: unknown[] };
      evaluateNcco: (parsed: unknown, ctx: unknown) => { decision: string; verdicts: Array<{ id: string; verdict: string }> };
      FlowGraph: new () => { observeObject: (endpoint: string, actions: unknown[], at: string) => { nodeIds: string[] } };
      diffDeclared: (graph: unknown, declaration: unknown) => { counts: { states: number; undeclared: number } };
      nodeIdOf: (endpoint: string, index: number, action: unknown) => string;
      PROPERTIES: Array<{ id: string }>;
    };
    expect(engine.PROPERTIES.map((p) => p.id)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
    const declaration = { identification: { phrases: ["This is a message from Preflight Demo Clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };
    const parsed = engine.parseNcco([{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "talk", text: "Your appointment is tomorrow." }]);
    const ev = engine.evaluateNcco(parsed, { declaration, facts: { from: "14045550100", lineType: "wireless", withinHours: true }, terminal: true });
    expect(ev.decision).toBe("block");
    expect(ev.verdicts.find((v) => v.id === "P3")?.verdict).toBe("false");
    const graph = new engine.FlowGraph();
    const { nodeIds } = graph.observeObject("answer", parsed.actions, "2026-09-05T12:00:00.000Z");
    expect(nodeIds[0]).toBe(engine.nodeIdOf("answer", 0, parsed.actions[0]));
    expect(nodeIds[0]).toMatch(/^[0-9a-f]{24}$/);
    expect(engine.diffDeclared(graph, { ...declaration, flow: { answer: [["talk"]] } }).counts).toMatchObject({ states: 2, undeclared: 1 });
  });
});
