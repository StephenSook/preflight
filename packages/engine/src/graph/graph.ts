import { sha256Hex } from "../hash.js";
import type { NccoAction } from "../ncco/types.js";

/**
 * Passive discovery of the call-flow graph (spec section 09). The flow is spread across the
 * developer's webhook handlers: an input or notify callback can return a replacement object, so no
 * single document contains it. Preflight watches what the application actually emits and merges
 * each observed object into this transition system. It learns; it never probes.
 *
 * Merge rules: an object from an endpoint creates or confirms one node per action with sequential
 * edges; an object returned by an input or notify callback adds an input_branch or notify_branch
 * edge from the branching node to the replacement's first action; a callback that returns nothing
 * adds a continue edge from the branching node to the next action of the same object; an identical
 * payload seen again bumps the observation count and last-seen. A connect action's far end belongs
 * to another application and is out of scope.
 */
export type EdgeKind = "sequential" | "input_branch" | "notify_branch" | "continue";

export interface FlowNode {
  id: string;
  endpoint: string;
  index: number;
  action: NccoAction;
  payloadHash: string;
  firstSeen: string;
  lastSeen: string;
  observations: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  firstSeen: string;
  observations: number;
}

export interface ObserveResult {
  nodeIds: string[];
  newNodes: number;
  newEdges: number;
}

export interface FlowPath {
  /** Node ids in order. */
  nodeIds: string[];
  actions: NccoAction[];
  /** Display labels, primes marking each later object: talk#0, input#1, talk#0', hangup#1'. */
  labels: string[];
  /** terminal: the object ran out. open: a branch nobody has observed yet. cyclic: the path revisited a node. */
  end: "terminal" | "open" | "cyclic";
  /** The branching node the path is open at, when it is. */
  openAt?: string;
}

export interface Coverage {
  declared: string[];
  observed: string[];
  unobserved: string[];
  states: number;
  edges: number;
  branchPoints: number;
  /** Branching nodes with no observed continuation. */
  openBranches: string[];
}

export const isBranching = (a: NccoAction): boolean => a.action === "input" || a.action === "notify";

const canonicalAction = (a: NccoAction): string => {
  const { index: _i, ...rest } = a as NccoAction & { index: number };
  void _i;
  return stableStringify(rest);
};

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export const payloadHashOf = (a: NccoAction): string => `sha256:${sha256Hex(canonicalAction(a))}`;
export const nodeIdOf = (endpoint: string, index: number, action: NccoAction): string => sha256Hex(`${endpoint}\n${index}\n${canonicalAction(action)}`).slice(0, 24);
const edgeKey = (from: string, to: string, kind: EdgeKind): string => `${from}|${to}|${kind}`;

export class FlowGraph {
  readonly nodes = new Map<string, FlowNode>();
  readonly edges = new Map<string, FlowEdge>();

  static from(nodes: Iterable<FlowNode>, edges: Iterable<FlowEdge>): FlowGraph {
    const g = new FlowGraph();
    for (const n of nodes) g.nodes.set(n.id, n);
    for (const e of edges) g.edges.set(edgeKey(e.from, e.to, e.kind), e);
    return g;
  }

  private touchNode(endpoint: string, action: NccoAction, at: string): { node: FlowNode; created: boolean } {
    const id = nodeIdOf(endpoint, action.index, action);
    const existing = this.nodes.get(id);
    if (existing) {
      existing.lastSeen = at;
      existing.observations += 1;
      return { node: existing, created: false };
    }
    const node: FlowNode = { id, endpoint, index: action.index, action, payloadHash: payloadHashOf(action), firstSeen: at, lastSeen: at, observations: 1 };
    this.nodes.set(id, node);
    return { node, created: true };
  }

  private touchEdge(from: string, to: string, kind: EdgeKind, at: string): boolean {
    const k = edgeKey(from, to, kind);
    const existing = this.edges.get(k);
    if (existing) {
      existing.observations += 1;
      return false;
    }
    this.edges.set(k, { from, to, kind, firstSeen: at, observations: 1 });
    return true;
  }

  /**
   * Merges one observed object. `from` names the branching node whose callback returned it; an empty
   * `actions` with `from` set records that the callback returned nothing and the object continued.
   */
  observeObject(endpoint: string, actions: readonly NccoAction[], at: string, from?: { nodeId: string; kind: "input_branch" | "notify_branch" }): ObserveResult {
    let newNodes = 0;
    let newEdges = 0;
    const nodeIds: string[] = [];
    let prev: string | undefined;
    for (const a of actions) {
      const { node, created } = this.touchNode(endpoint, a, at);
      if (created) newNodes += 1;
      if (prev && this.touchEdge(prev, node.id, "sequential", at)) newEdges += 1;
      nodeIds.push(node.id);
      prev = node.id;
    }
    if (from) {
      const branch = this.nodes.get(from.nodeId);
      if (!branch) throw new Error(`unknown branching node ${from.nodeId}`);
      if (nodeIds.length > 0) {
        if (this.touchEdge(from.nodeId, nodeIds[0] as string, from.kind, at)) newEdges += 1;
      } else {
        // The callback returned nothing: the object continues with its next action, or ends here.
        // A self edge records an observed empty continuation at the end of an object.
        const next = this.sequentialSuccessor(from.nodeId);
        if (this.touchEdge(from.nodeId, next ?? from.nodeId, "continue", at)) newEdges += 1;
        branch.lastSeen = at;
      }
    }
    return { nodeIds, newNodes, newEdges };
  }

  sequentialSuccessor(nodeId: string): string | undefined {
    for (const e of this.edges.values()) if (e.from === nodeId && e.kind === "sequential") return e.to;
    return undefined;
  }

  /** Edges a run can actually take from this node: branch and continue edges from a branching node, the sequential edge otherwise. */
  traversable(nodeId: string): FlowEdge[] {
    const node = this.nodes.get(nodeId);
    if (!node) return [];
    const out = [...this.edges.values()].filter((e) => e.from === nodeId);
    return isBranching(node.action) ? out.filter((e) => e.kind !== "sequential") : out.filter((e) => e.kind === "sequential");
  }

  /** Every observed path from a node. Bounded by maxHops objects so a looping flow cannot run away. */
  paths(rootId: string, maxHops = 16): FlowPath[] {
    const out: FlowPath[] = [];
    const walk = (id: string, nodeIds: string[], hops: number, primes: number): void => {
      const node = this.nodes.get(id);
      if (!node) return;
      if (nodeIds.includes(id)) {
        out.push(this.finish([...nodeIds, id], "cyclic"));
        return;
      }
      const here = [...nodeIds, id];
      const next = this.traversable(id);
      if (next.length === 0) {
        out.push(this.finish(here, isBranching(node.action) ? "open" : "terminal", isBranching(node.action) ? id : undefined));
        return;
      }
      if (hops >= maxHops) {
        out.push(this.finish(here, "cyclic"));
        return;
      }
      for (const e of next) {
        // A self continue edge means the object ended at the branch: the path is terminal there.
        if (e.kind === "continue" && e.to === id) {
          out.push(this.finish(here, "terminal"));
          continue;
        }
        walk(e.to, here, e.kind === "sequential" ? hops : hops + 1, e.kind === "sequential" ? primes : primes + 1);
      }
    };
    walk(rootId, [], 0, 0);
    return out;
  }

  private finish(nodeIds: string[], end: FlowPath["end"], openAt?: string): FlowPath {
    const actions: NccoAction[] = [];
    const labels: string[] = [];
    let primes = 0;
    let prevEndpoint: string | undefined;
    for (const id of nodeIds) {
      const n = this.nodes.get(id);
      if (!n) continue;
      if (prevEndpoint !== undefined && n.endpoint !== prevEndpoint) primes += 1;
      prevEndpoint = n.endpoint;
      actions.push(n.action);
      labels.push(`${n.action.action}#${n.index}${"'".repeat(primes)}`);
    }
    return openAt ? { nodeIds, actions, labels, end, openAt } : { nodeIds, actions, labels, end };
  }

  coverage(declaredEndpoints: readonly string[]): Coverage {
    const observed = new Set([...this.nodes.values()].map((n) => n.endpoint));
    const declared = [...new Set(declaredEndpoints)];
    const openBranches = [...this.nodes.values()].filter((n) => isBranching(n.action) && this.traversable(n.id).length === 0).map((n) => n.id);
    return {
      declared,
      observed: declared.filter((d) => observed.has(d)),
      unobserved: declared.filter((d) => !observed.has(d)),
      states: this.nodes.size,
      edges: this.edges.size,
      branchPoints: [...this.nodes.values()].filter((n) => isBranching(n.action)).length,
      openBranches,
    };
  }
}
