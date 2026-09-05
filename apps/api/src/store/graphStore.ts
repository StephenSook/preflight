import { FlowGraph, type FlowEdge, type FlowNode, type NccoAction } from "@preflight/engine";
import type { Sql } from "postgres";

/**
 * Persistence for the discovered graph and the executed path of each call. The graph itself is the
 * pure FlowGraph from the engine; the store loads it, and after an observation writes back exactly
 * the nodes and edges that changed.
 */
export interface GraphStore {
  readonly name: "memory" | "postgres";
  load(): Promise<FlowGraph>;
  /** Persists the given nodes and edges (upsert by id / by key). */
  save(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Promise<void>;
  callPath(callUuid: string): Promise<string[] | undefined>;
  /** Stores the executed path, and what the call's answer-time webhook said about it when given (a later write without context keeps the stored one). */
  setCallPath(callUuid: string, nodeIds: readonly string[], context?: CallContext): Promise<void>;
  callContext(callUuid: string): Promise<CallContext | undefined>;
}

/** The fields of an answer-time webhook the decider reads about the call itself. */
export type CallContext = Partial<Record<"direction" | "from" | "to" | "from_user" | "endpoint_type", string>>;
export function callContextOf(payload: Record<string, unknown> | undefined): CallContext {
  const ctx: CallContext = {};
  for (const k of ["direction", "from", "to", "from_user", "endpoint_type"] as const) {
    const v = payload?.[k];
    if (typeof v === "string" && v.length > 0) ctx[k] = v;
  }
  return ctx;
}

export class MemoryGraphStore implements GraphStore {
  readonly name = "memory" as const;
  private readonly graph = new FlowGraph();
  private readonly paths = new Map<string, { nodeIds: string[]; context: CallContext | undefined }>();
  async load(): Promise<FlowGraph> {
    return FlowGraph.from([...this.graph.nodes.values()].map((n) => ({ ...n })), [...this.graph.edges.values()].map((e) => ({ ...e })));
  }
  async save(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Promise<void> {
    for (const n of nodes) this.graph.nodes.set(n.id, { ...n });
    for (const e of edges) this.graph.edges.set(`${e.from}|${e.to}|${e.kind}`, { ...e });
  }
  async callPath(callUuid: string): Promise<string[] | undefined> {
    return this.paths.get(callUuid)?.nodeIds;
  }
  async setCallPath(callUuid: string, nodeIds: readonly string[], context?: CallContext): Promise<void> {
    this.paths.set(callUuid, { nodeIds: [...nodeIds], context: context ?? this.paths.get(callUuid)?.context });
  }
  async callContext(callUuid: string): Promise<CallContext | undefined> {
    return this.paths.get(callUuid)?.context;
  }
}

interface NodeRow { id: string; endpoint: string; action_index: number; action: NccoAction; payload_hash: string; first_seen: Date; last_seen: Date; observation_count: number }
interface EdgeRow { from_node: string; to_node: string; edge_kind: FlowEdge["kind"]; first_seen: Date; observations: number }

export class PgGraphStore implements GraphStore {
  readonly name = "postgres" as const;
  constructor(private readonly sql: Sql, private readonly applicationId: string | undefined) {}

  async load(): Promise<FlowGraph> {
    const nodes = await this.sql<NodeRow[]>`select id, endpoint, action_index, action, payload_hash, first_seen, last_seen, observation_count from flow_nodes where application_id is not distinct from ${this.applicationId ?? null}`;
    const edges = await this.sql<EdgeRow[]>`select e.from_node, e.to_node, e.edge_kind, e.first_seen, e.observations from flow_edges e join flow_nodes n on n.id = e.from_node where n.application_id is not distinct from ${this.applicationId ?? null}`;
    return FlowGraph.from(
      nodes.map((r) => ({ id: r.id, endpoint: r.endpoint, index: r.action_index, action: r.action, payloadHash: r.payload_hash, firstSeen: r.first_seen.toISOString(), lastSeen: r.last_seen.toISOString(), observations: r.observation_count })),
      edges.map((r) => ({ from: r.from_node, to: r.to_node, kind: r.edge_kind, firstSeen: r.first_seen.toISOString(), observations: r.observations })),
    );
  }

  async save(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      for (const n of nodes) {
        await tx`insert into flow_nodes (id, application_id, endpoint, action_index, action_type, action, payload_hash, first_seen, last_seen, observation_count)
          values (${n.id}, ${this.applicationId ?? null}, ${n.endpoint}, ${n.index}, ${n.action.action}, ${tx.json(n.action as never)}, ${n.payloadHash}, ${n.firstSeen}, ${n.lastSeen}, ${n.observations})
          on conflict (id) do update set last_seen = excluded.last_seen, observation_count = excluded.observation_count`;
      }
      for (const e of edges) {
        await tx`insert into flow_edges (from_node, to_node, edge_kind, first_seen, observations)
          values (${e.from}, ${e.to}, ${e.kind}, ${e.firstSeen}, ${e.observations})
          on conflict (from_node, to_node, edge_kind) do update set observations = excluded.observations`;
      }
    });
  }

  async callPath(callUuid: string): Promise<string[] | undefined> {
    const [row] = await this.sql<{ node_ids: string[] }[]>`select node_ids from call_paths where call_uuid = ${callUuid}`;
    return row?.node_ids;
  }

  async setCallPath(callUuid: string, nodeIds: readonly string[], context?: CallContext): Promise<void> {
    await this.sql`insert into call_paths (call_uuid, node_ids, context, updated_at) values (${callUuid}, ${[...nodeIds]}, ${context ? this.sql.json(context as never) : null}, now())
      on conflict (call_uuid) do update set node_ids = excluded.node_ids, context = coalesce(excluded.context, call_paths.context), updated_at = now()`;
  }
  async callContext(callUuid: string): Promise<CallContext | undefined> {
    const [row] = await this.sql<{ context: CallContext | null }[]>`select context from call_paths where call_uuid = ${callUuid}`;
    return row?.context ?? undefined;
  }
}

/** The ids a webhook names a leg by. The platform's input event on a timeout carries `uuid: null` and only the conversation uuid (measured on the live host, 2026-09-05), so a path is kept under both and read by whichever arrives. */
export interface CallIds {
  callUuid?: string | undefined;
  conversationUuid?: string | undefined;
}

export async function rememberCallPath(store: GraphStore, ids: CallIds, nodeIds: readonly string[], context?: CallContext): Promise<void> {
  if (ids.callUuid) await store.setCallPath(ids.callUuid, nodeIds, context);
  if (ids.conversationUuid && ids.conversationUuid !== ids.callUuid) await store.setCallPath(ids.conversationUuid, nodeIds, context);
}

export async function callPathFor(store: GraphStore, ids: CallIds): Promise<string[] | undefined> {
  return (ids.callUuid ? await store.callPath(ids.callUuid) : undefined) ?? (ids.conversationUuid ? await store.callPath(ids.conversationUuid) : undefined);
}

export async function callContextFor(store: GraphStore, ids: CallIds): Promise<CallContext | undefined> {
  return (ids.callUuid ? await store.callContext(ids.callUuid) : undefined) ?? (ids.conversationUuid ? await store.callContext(ids.conversationUuid) : undefined);
}
