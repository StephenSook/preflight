import { actionAtoms, type ActionAtoms, type FlowDeclaration } from "../ncco/atoms.js";
import type { NccoAction } from "../ncco/types.js";
import { isBranching, type EdgeKind, type FlowGraph } from "./graph.js";

/**
 * The declared-versus-actual diff (spec section 12, screen 3). The developer declares which callback
 * endpoints their flow has and, per endpoint, the action sequences they believe it serves. The
 * discovered graph is what the application actually served. The diff has three colours:
 *
 *   declared    observed and declared (green);
 *   undeclared  observed, not declared: the surprise (red);
 *   missing     declared, never observed: the honest gap (amber, hollow).
 *
 * A node is declared when its endpoint is declared and either the endpoint has no action list (the
 * developer declared only that it exists) or one of its declared sequences has that action type at
 * that position. Nothing here decides a call; it renders what discovery found against what was said.
 */

export type DiffStatus = "declared" | "undeclared";

export interface DiffNode {
  id: string;
  endpoint: string;
  index: number;
  /** The action type, e.g. talk, input, connect. */
  action: string;
  /** e.g. talk#0 */
  label: string;
  status: DiffStatus;
  /** Synthetic speech with no live leg on this node: the kind of surprise the film names. */
  speaksSynthetic: boolean;
  atoms: ActionAtoms;
  observations: number;
  firstSeen: string;
  lastSeen: string;
  /** What a talk action says, first 120 characters, so the graph screen can quote it. */
  text?: string;
}

export interface DiffEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  observations: number;
}

/** A declared endpoint or a declared action at a position that discovery has never seen. */
export interface DiffMissing {
  endpoint: string;
  /** null when the whole endpoint was never observed. */
  index: number | null;
  action: string | null;
}

export interface FlowDiff {
  nodes: DiffNode[];
  edges: DiffEdge[];
  /** First actions of the answer endpoint's objects: where every path begins. */
  roots: string[];
  missing: DiffMissing[];
  /** Branching nodes whose callback has never returned an object. */
  openBranches: string[];
  declared: { endpoints: string[]; flow: Record<string, string[][]> };
  counts: {
    states: number;
    declared: number;
    undeclared: number;
    undeclaredSpeaking: number;
    neverObserved: number;
    endpointsDeclared: number;
    endpointsObserved: number;
  };
}

const ANSWER = "answer";

/** Every endpoint the developer declared, the answer endpoint first, each once, in declaration order. */
export function declaredEndpointsOf(declaration: FlowDeclaration): string[] {
  const out: string[] = [ANSWER];
  for (const e of [...Object.keys(declaration.flow ?? {}), ...(declaration.endpoints ?? [])]) if (!out.includes(e)) out.push(e);
  return out;
}

const textOf = (a: NccoAction): string | undefined => {
  const t = (a as { text?: unknown }).text;
  return typeof t === "string" ? t.slice(0, 120) : undefined;
};

const endpointRank = (endpoint: string, order: readonly string[]): number => {
  const i = order.indexOf(endpoint);
  return i === -1 ? order.length : i;
};

export function diffDeclared(graph: FlowGraph, declaration: FlowDeclaration): FlowDiff {
  const flow = declaration.flow ?? {};
  const endpoints = declaredEndpointsOf(declaration);
  const declaredSet = new Set(endpoints);
  const isDeclared = (endpoint: string, index: number, action: string): boolean => {
    if (!declaredSet.has(endpoint)) return false;
    const sequences = flow[endpoint];
    if (!sequences || sequences.length === 0) return true;
    return sequences.some((seq) => seq[index] === action);
  };

  const nodes: DiffNode[] = [...graph.nodes.values()]
    .map((n) => {
      const atoms = actionAtoms(n.action, declaration);
      const text = textOf(n.action);
      const node: DiffNode = {
        id: n.id,
        endpoint: n.endpoint,
        index: n.index,
        action: n.action.action,
        label: `${n.action.action}#${n.index}`,
        status: isDeclared(n.endpoint, n.index, n.action.action) ? "declared" : "undeclared",
        speaksSynthetic: atoms.speaks && atoms.synthetic && !atoms.connects_human,
        atoms,
        observations: n.observations,
        firstSeen: n.firstSeen,
        lastSeen: n.lastSeen,
      };
      if (text !== undefined) node.text = text;
      return node;
    })
    .sort((a, b) => endpointRank(a.endpoint, endpoints) - endpointRank(b.endpoint, endpoints) || a.endpoint.localeCompare(b.endpoint) || a.index - b.index || a.action.localeCompare(b.action) || a.firstSeen.localeCompare(b.firstSeen) || a.id.localeCompare(b.id));

  const edges: DiffEdge[] = [...graph.edges.values()]
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind, observations: e.observations }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));

  const observedEndpoints = new Set(nodes.map((n) => n.endpoint));
  const missing: DiffMissing[] = [];
  for (const endpoint of endpoints) {
    if (!observedEndpoints.has(endpoint)) {
      missing.push({ endpoint, index: null, action: null });
      continue;
    }
    const seen = new Set(nodes.filter((n) => n.endpoint === endpoint).map((n) => `${n.index}\n${n.action}`));
    for (const seq of flow[endpoint] ?? []) {
      seq.forEach((action, index) => {
        if (!seen.has(`${index}\n${action}`) && !missing.some((m) => m.endpoint === endpoint && m.index === index && m.action === action)) missing.push({ endpoint, index, action });
      });
    }
  }

  const openBranches = [...graph.nodes.values()].filter((n) => isBranching(n.action) && graph.traversable(n.id).length === 0).map((n) => n.id).sort();
  const roots = nodes.filter((n) => n.endpoint === ANSWER && n.index === 0).map((n) => n.id);
  const declaredCount = nodes.filter((n) => n.status === "declared").length;
  const undeclared = nodes.filter((n) => n.status === "undeclared");

  return {
    nodes,
    edges,
    roots,
    missing,
    openBranches,
    declared: { endpoints, flow },
    counts: {
      states: nodes.length,
      declared: declaredCount,
      undeclared: undeclared.length,
      undeclaredSpeaking: undeclared.filter((n) => n.speaksSynthetic).length,
      neverObserved: missing.length,
      endpointsDeclared: endpoints.length,
      endpointsObserved: endpoints.filter((e) => observedEndpoints.has(e)).length,
    },
  };
}
