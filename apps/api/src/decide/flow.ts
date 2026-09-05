import { createHash } from "node:crypto";
import { decide, declaredEndpointsOf, diffDeclared, evaluateGraph, evaluatePath, isBranching, parseNcco, propertySpec, type CallFacts, type Decision, type Evaluation, type FlowDeclaration, type FlowDiff, type FlowGraph, type NccoAction, type PropertyVerdict } from "@preflight/engine";
import type { NumberFactsResolver } from "@preflight/numfacts";
import type { Config } from "../config.js";
import type { DecisionRecord } from "../store/decisionStore.js";
import type { DeclarationStore } from "../store/declarationStore.js";
import type { GraphStore } from "../store/graphStore.js";

export interface FlowDeps {
  config: Config;
  graphStore: GraphStore;
  /** The declaration the environment seeds (FLOW_DECLARATION_JSON); a stored declaration, when one exists, wins. */
  declaration: FlowDeclaration;
  declarations?: DeclarationStore | undefined;
  resolver: NumberFactsResolver;
}

export interface FlowInput {
  payload: Record<string, unknown> | undefined;
  /** The object as the origin returned it; empty when a callback returned nothing. */
  nccoBytes: string;
  /** "answer" for the answer webhook, the callback's path for a branch callback. */
  endpoint: string;
  /** The branching node whose callback produced this object, for a branch callback. */
  from?: { nodeId: string; kind: "input_branch" | "notify_branch" } | undefined;
  now: Date;
  originLatencyMs: number | null;
  verifyLatencyMs: number | null;
}

export interface FlowOutcome {
  decision: Decision;
  reason: string | undefined;
  evaluation: Evaluation;
  record: DecisionRecord;
  /** The bytes to serve on pass: the origin's bytes, or the same object with branch callbacks routed through Preflight. */
  responseBytes: string;
  /** Indices whose eventUrl was rewritten, for the response header and the log. */
  rewrote: number[];
  /** Node ids of the executed path after this decision (for the next callback of this call). */
  pathNodeIds: string[];
  coverage: ReturnType<FlowGraph["coverage"]>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** The path of a callback URL, the key the coverage report and the graph use for an endpoint. */
export function endpointKeyOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

/**
 * The flow decider: merges what the origin served into the discovered graph, evaluates every armed
 * property over every observed path from here (prefixed by what the call already executed), and
 * on pass routes the object's branch callbacks through Preflight so their replacements are
 * observed too. Byte-for-byte pass-through holds whenever the object has no branch to route.
 */
export class FlowDecider {
  constructor(private readonly deps: FlowDeps) {}

  /** The hook carries only the node id and the method; the origin callback is read back from the node at call time. */
  private hookUrl(nodeId: string, method: string): string | undefined {
    const base = this.deps.config.PUBLIC_BASE_URL;
    if (!base) return undefined;
    const u = new URL("/v/hook", base);
    u.searchParams.set("n", nodeId);
    u.searchParams.set("m", method === "GET" ? "GET" : "POST");
    return u.toString();
  }

  /** Rewrites eventUrl on branching actions to the hook. Returns the original bytes untouched when nothing needs routing. */
  private route(bytes: string, actions: readonly NccoAction[], nodeIds: readonly string[]): { bytes: string; rewrote: number[] } {
    const rewrote: number[] = [];
    if (!this.deps.config.PUBLIC_BASE_URL || !actions.some(isBranching)) return { bytes, rewrote };
    let raw: unknown;
    try {
      raw = JSON.parse(bytes);
    } catch {
      return { bytes, rewrote };
    }
    if (!Array.isArray(raw)) return { bytes, rewrote };
    for (const a of actions) {
      if (!isBranching(a)) continue;
      const item = raw[a.index] as Record<string, unknown> | undefined;
      const nodeId = nodeIds[a.index];
      if (!item || !nodeId || !Array.isArray(item["eventUrl"]) || typeof item["eventUrl"][0] !== "string") continue;
      const hook = this.hookUrl(nodeId, typeof item["eventMethod"] === "string" ? item["eventMethod"] : "POST");
      if (!hook) continue;
      item["eventUrl"] = [hook];
      rewrote.push(a.index);
    }
    return { bytes: rewrote.length > 0 ? JSON.stringify(raw) : bytes, rewrote };
  }

  /** The declaration in force: the newest one a person entered in Setup, else the environment's seed. */
  async currentDeclaration(): Promise<FlowDeclaration> {
    return (await this.deps.declarations?.current())?.declaration ?? this.deps.declaration;
  }

  async decide(input: FlowInput, prefixNodeIds: readonly string[] = []): Promise<FlowOutcome> {
    const { config, resolver } = this.deps;
    const declaration = await this.currentDeclaration();
    const p = input.payload ?? {};
    const rawDirection = str(p["direction"]);
    const direction: DecisionRecord["direction"] = rawDirection === "inbound" || rawDirection === "outbound" ? rawDirection : "unknown";
    const fromNumber = str(p["from"]);
    const toNumber = str(p["to"]);
    const humanParty = direction === "inbound" ? fromNumber : toNumber;
    const callerId = direction === "inbound" ? toNumber : fromNumber;
    const facts = resolver.resolve(humanParty ?? "", input.now);
    const callFacts = { from: callerId, lineType: facts.lineType, withinHours: facts.withinHours };

    const parsed = parseNcco(input.nccoBytes.trim().length === 0 ? "[]" : input.nccoBytes);
    const invalid = !parsed.ok && parsed.actions.length === 0 && input.nccoBytes.trim().length > 0;

    const graph = await this.deps.graphStore.load();
    const at = input.now.toISOString();
    const observed = invalid ? { nodeIds: [], newNodes: 0, newEdges: 0 } : graph.observeObject(input.endpoint, parsed.actions, at, input.from);
    await this.deps.graphStore.save([...graph.nodes.values()], [...graph.edges.values()]);

    const prefixActions = prefixNodeIds.map((id) => graph.nodes.get(id)?.action).filter((a): a is NccoAction => a !== undefined);
    const prefixLabels = labelsFor(graph, prefixNodeIds);
    let rootId = observed.nodeIds[0];
    if (!rootId && input.from && !invalid) rootId = graph.sequentialSuccessor(input.from.nodeId); // an empty callback: the object continues
    let evaluation: Evaluation;
    let decision: Decision;
    let reason: string | undefined;
    let terminal = false;
    if (invalid) {
      evaluation = { verdicts: [], callAtoms: { dest_wireless: null, dest_residential: null, within_hours: null, caller_id_present: false }, steps: [], decision: "block" };
      decision = "block";
      reason = `the application's server returned something that is not a call-control object: ${parsed.issues[0]?.message ?? "unknown defect"}`;
    } else if (!rootId) {
      // An empty callback at the end of an object: the call ends here. Evaluate the executed path as terminal.
      const ev = evaluateGraphFromPrefix(prefixActions, prefixLabels, callFacts, declaration, config.POLICY_MODE);
      evaluation = ev.evaluation;
      decision = ev.decision;
      reason = ev.reason;
      terminal = true;
    } else {
      const ge = evaluateGraph(graph, rootId, { declaration, facts: callFacts, policy: config.POLICY_MODE, prefix: { actions: prefixActions, labels: prefixLabels } });
      evaluation = { verdicts: ge.verdicts, callAtoms: { dest_wireless: null, dest_residential: null, within_hours: facts.withinHours, caller_id_present: callFacts.from !== undefined }, steps: [], decision: ge.decision };
      decision = ge.decision;
      terminal = ge.paths.every((x) => x.path.end === "terminal");
      reason = reasonFor(decision, ge.verdicts);
    }

    // What this call runs next: from the object's first action (or the continuation) up to and including the first branching node.
    const executed = rootId ? executedFrom(graph, rootId) : [];
    const pathNodeIds = [...prefixNodeIds, ...executed];
    const routed = decision === "pass" && !invalid ? this.route(input.nccoBytes, parsed.actions, observed.nodeIds) : { bytes: input.nccoBytes, rewrote: [] };

    const record: DecisionRecord = {
      callUuid: str(p["uuid"]) ?? str(p["call_uuid"]),
      conversationUuid: str(p["conversation_uuid"]),
      applicationId: config.VONAGE_APPLICATION_ID,
      direction,
      fromNumber,
      toNumber,
      humanParty,
      facts,
      policy: config.POLICY_MODE,
      terminal,
      nccoHash: `sha256:${createHash("sha256").update(input.nccoBytes).digest("hex")}`,
      decision,
      reason,
      verdicts: evaluation.verdicts,
      decidedAt: at,
      originLatencyMs: input.originLatencyMs,
      verifyLatencyMs: input.verifyLatencyMs,
    };
    return { decision, reason, evaluation, record, responseBytes: routed.bytes, rewrote: routed.rewrote, pathNodeIds, coverage: graph.coverage(declaredEndpointsOf(declaration)) };
  }

  async coverage(): Promise<ReturnType<FlowGraph["coverage"]>> {
    const graph = await this.deps.graphStore.load();
    return graph.coverage(declaredEndpointsOf(await this.currentDeclaration()));
  }

  /** The declared-versus-actual diff over the discovered graph (spec screen 3). Reads only; decides nothing. */
  async diff(): Promise<FlowDiff> {
    const graph = await this.deps.graphStore.load();
    return diffDeclared(graph, await this.currentDeclaration());
  }
}

function executedFrom(graph: FlowGraph, rootId: string): string[] {
  const ids: string[] = [];
  let id: string | undefined = rootId;
  while (id) {
    ids.push(id);
    const node = graph.nodes.get(id);
    if (!node || isBranching(node.action)) break;
    id = graph.sequentialSuccessor(id);
  }
  return ids;
}

function labelsFor(graph: FlowGraph, nodeIds: readonly string[]): string[] {
  const labels: string[] = [];
  let primes = 0;
  let prevEndpoint: string | undefined;
  for (const id of nodeIds) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    if (prevEndpoint !== undefined && n.endpoint !== prevEndpoint) primes += 1;
    prevEndpoint = n.endpoint;
    labels.push(`${n.action.action}#${n.index}${"'".repeat(primes)}`);
  }
  return labels;
}

function reasonFor(decision: Decision, verdicts: readonly PropertyVerdict[]): string | undefined {
  if (decision === "block") {
    return verdicts.filter((v) => v.verdict === "false").map((v) => `${v.id} ${propertySpec(v.id).title}, ${v.citation}${v.atEnd ? " (no opt-out before the flow ends)" : ""}`).join("; ");
  }
  if (decision === "hold") return verdicts.filter((v) => v.verdict === "inconclusive").map((v) => `${v.id}: ${v.reason ?? "undecided"}`).join("; ");
  return undefined;
}

/** A callback returned nothing and the object had no next action: the executed prefix is the whole call. */
function evaluateGraphFromPrefix(actions: NccoAction[], labels: string[], facts: CallFacts, declaration: FlowDeclaration, policy: "strict" | "advisory"): { evaluation: Evaluation; decision: Decision; reason: string | undefined } {
  const ev = evaluatePath(actions.map((a, i) => ({ ...a, index: i })), { declaration, facts, terminal: true });
  const verdicts = ev.verdicts.map((v) => (v.witness ? { ...v, witness: v.witness.map((w, i) => ({ ...w, label: labels[i] ?? w.label })) } : v));
  const decision = decide(verdicts, policy);
  return { evaluation: { ...ev, verdicts, decision }, decision, reason: reasonFor(decision, verdicts) };
}
