import { actionAtoms, campaignRates, telemetryFromEvents, type CampaignRates, type FlowDeclaration } from "@preflight/engine";
import type { EventStore } from "./store/eventStore.js";
import type { GraphStore } from "./store/graphStore.js";

/**
 * The rate properties (P6 to P8) over a window, assembled from what this host already holds: the
 * signed event webhooks (answer status, machine detection, the platform's timestamps, talk time)
 * and, per call, the path it actually ran through the discovered graph, which says whether a
 * person was ever connected to a live endpoint. Nothing here is simulated: an empty window says so.
 */
export interface CampaignWindow extends CampaignRates {
  window: { start: string; end: string };
  events: number;
}

export interface CampaignDeps {
  store: EventStore;
  graphStore: GraphStore;
  declaration: () => Promise<FlowDeclaration>;
}

export const MAX_EVENTS = 50000;

export async function campaignWindow(deps: CampaignDeps, startIso: string, endIso: string): Promise<CampaignWindow> {
  const events = await deps.store.eventsBetween(startIso, endIso, MAX_EVENTS);
  const graph = await deps.graphStore.load();
  const declaration = await deps.declaration();
  const uuids = [...new Set(events.map((e) => e.callUuid ?? (typeof e.payload?.["uuid"] === "string" ? (e.payload["uuid"] as string) : undefined)).filter((u): u is string => typeof u === "string"))];
  const connected = new Map<string, boolean>();
  for (const uuid of uuids) {
    const path = (await deps.graphStore.callPath(uuid)) ?? [];
    connected.set(uuid, path.some((id) => {
      const node = graph.nodes.get(id);
      return node ? actionAtoms(node.action, declaration).connects_human : false;
    }));
  }
  const telemetry = telemetryFromEvents(events.map((e) => ({ callUuid: e.callUuid, payload: e.payload, receivedAt: e.receivedAt })), (uuid) => connected.get(uuid) ?? false);
  return { window: { start: startIso, end: endIso }, events: events.length, ...campaignRates(telemetry) };
}
