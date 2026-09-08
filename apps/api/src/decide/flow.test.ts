import type { FlowDeclaration } from "@preflight/engine";
import { NumberFactsResolver } from "@preflight/numfacts";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { MemoryGraphStore } from "../store/graphStore.js";
import { FlowDecider, type FlowInput } from "./flow.js";

const declaration: FlowDeclaration = { identification: { phrases: ["This is Preflight"] } };
const greeting = { action: "talk", text: "This is Preflight" };
const connect = { action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] };

function fixture() {
  const graphStore = new MemoryGraphStore();
  const config = loadConfig({ VONAGE_API_KEY: "test-key", VONAGE_SIGNATURE_SECRET: "test-signature", ORIGIN_ANSWER_URL: "https://origin.example/answer", PUBLIC_BASE_URL: "https://preflight.example" });
  const decider = new FlowDecider({ config, graphStore, declaration, resolver: NumberFactsResolver.load() });
  const input = (object: unknown): FlowInput => ({ payload: { direction: "inbound", from: "14042010000", to: "14045550100", uuid: "test-call" }, nccoBytes: JSON.stringify(object), endpoint: "answer", now: new Date("2026-09-08T16:00:00Z"), originLatencyMs: 1, verifyLatencyMs: 1 });
  return { decider, graphStore, input };
}

describe("FlowDecider object boundaries and refusals", () => {
  it("keeps the pending hook at the current object's branch, not its evaluated future suffix", async () => {
    const { decider, graphStore, input } = fixture();
    const object = [greeting, { action: "input", type: ["dtmf"], eventUrl: ["https://origin.example/menu"] }, connect];
    const first = await decider.decide(input(object));
    expect(first.pathNodeIds).toHaveLength(2);
    const branchId = first.pathNodeIds.at(-1)!;
    const callback = await decider.decide({ ...input([connect]), endpoint: "/menu", from: { nodeId: branchId, kind: "input_branch" } }, first.pathNodeIds);
    expect(callback.decision).toBe("pass");
    expect(callback.pathNodeIds).toHaveLength(3);
    const repeated = await decider.decide(input(object));
    expect(repeated.decision).toBe("pass");
    expect(repeated.pathNodeIds).toEqual(first.pathNodeIds);
    expect(repeated.rewrote).toEqual([1]);
    expect(repeated.pathNodeIds).not.toContain(callback.pathNodeIds.at(-1));
    await graphStore.setCallPath("pending-call", repeated.pathNodeIds);
    expect(await graphStore.claimBranch("pending-call", branchId)).toBe(true);
  });

  it("does not clear or record a historic suffix after the origin shortens its object", async () => {
    const { decider, graphStore, input } = fixture();
    const first = await decider.decide(input([greeting, connect]));
    expect(first.decision).toBe("pass");
    const shortened = await decider.decide(input([greeting]));
    expect(shortened.decision).toBe("block");
    expect(shortened.pathNodeIds).toHaveLength(1);
    expect(shortened.pathNodeIds[0]).not.toBe(first.pathNodeIds[0]);
    expect(shortened.evaluation.verdicts.find((verdict) => verdict.id === "P3")?.atEnd).toBe(true);
    const graph = await graphStore.load();
    expect(graph.paths(shortened.pathNodeIds[0]!)[0]?.labels).toEqual(["talk#0"]);
    expect((await decider.decide(input([greeting, connect]))).decision).toBe("pass");
  });

  it.each([
    [{ ...connect, timeout: "bad" }],
    [connect, null],
    [{ ...connect, endpoint: [{ type: "fax" }, ...connect.endpoint] }],
    [{ ...connect, eventType: "synchronous", eventUrl: ["https://origin.example/fallback"] }],
  ].map((object) => ({ object })))("blocks malformed and unsupported objects before graph insertion, even on override: $object", async ({ object }) => {
    const { decider, graphStore, input } = fixture();
    const save = vi.spyOn(graphStore, "save");
    const result = await decider.decide({ ...input(object), override: { holdId: "test-hold", by: "test-operator" } });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("not a call-control object");
    expect(result.pathNodeIds).toEqual([]);
    expect(result.rewrote).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect((await graphStore.load()).nodes.size).toBe(0);
  });

  it("refuses legacy executed paths and callbacks without inserting their replacements", async () => {
    const { decider, graphStore, input } = fixture();
    await decider.decide(input([greeting, connect]));
    const graph = await graphStore.load();
    const legacy = [{ ...graph.nodes.get(graph.nodes.keys().next().value!)!, id: "9850c98b54ee77bc5e53b47c" }];
    await graphStore.save(legacy, []);
    const save = vi.spyOn(graphStore, "save");
    const prefix = await decider.decide(input([connect]), legacy.map((node) => node.id));
    expect(prefix.decision).toBe("block");
    expect(prefix.reason).toContain("legacy");
    const callback = await decider.decide({ ...input([connect]), from: { nodeId: legacy[0]!.id, kind: "input_branch" } });
    expect(callback.decision).toBe("block");
    expect(save).not.toHaveBeenCalled();
  });
});
