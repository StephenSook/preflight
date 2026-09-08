import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { endpointKeyOf, nodeStamp, type FlowDecider } from "../decide/flow.js";
import { ledgerDraftFor } from "../decide/record.js";
import { forwardToOrigin } from "../proxy/forward.js";
import type { DecisionStore } from "../store/decisionStore.js";
import type { EventStore, StoredWebhook, WebhookKind } from "../store/eventStore.js";
import { callUuidFor, type GraphStore } from "../store/graphStore.js";
import { overrideFor, type HoldStore } from "../store/holdStore.js";
import type { LedgerStore } from "../store/ledgerStore.js";
import { holdNcco, safeNcco } from "../decide/ncco.js";

export interface HookDeps {
  config: Config;
  flow: FlowDecider;
  graphStore: GraphStore;
  decisions: DecisionStore;
  ledger: LedgerStore;
  holds: HoldStore;
  store: EventStore;
  fetchImpl: typeof fetch;
  clock: () => number;
  ingress: (req: FastifyRequest) => { verifyStart: number; raw: string; verified: { ok: boolean; reason?: string }; payload: Record<string, unknown> | undefined };
  record: (kind: WebhookKind, req: FastifyRequest, raw: string, payload: Record<string, unknown> | undefined, extra: Partial<StoredWebhook>) => Promise<void>;
}

function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields).sort().map((key) => `${JSON.stringify(key)}:${canonicalPayload(fields[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The branch hook. When Preflight passes an object whose input or notify action names a callback,
 * it rewrites that callback to point here, carrying the branching node (n) and the method (m).
 * The origin URL is read back from the node, never from the query. Vonage calls this with the
 * input result or the notify payload,
 * signed like every other webhook. Preflight verifies, forwards to the origin, observes what came
 * back (a replacement object, or nothing), and decides the continuation as a path that starts with
 * everything the call has already executed.
 */
export function registerBranchHook(app: FastifyInstance, deps: HookDeps): void {
  const { config, flow, graphStore, decisions, ledger, holds, fetchImpl, clock, ingress, record } = deps;
  app.route<{ Querystring: { n?: string; m?: string; s?: string } }>({
    method: ["GET", "POST"],
    url: "/v/hook",
    handler: async (req, reply) => {
      const { verifyStart, raw, verified, payload } = ingress(req);
      if (!verified.ok) {
        req.log.warn({ reason: verified.reason }, "rejected unsigned or invalid branch callback");
        return reply.code(403).send({ error: "webhook signature rejected", reason: verified.reason });
      }
      const verifyLatencyMs = performance.now() - verifyStart;
      // The origin callback is the one the operator's own object named for this node, read back from
      // the graph. The query string is not covered by the webhook signature, so nothing in it is
      // trusted for a fetch target.
      const nodeId = req.query.n;
      if (!nodeId) return reply.code(400).send({ error: "hook needs n (the branching node)" });
      // The query string is outside the platform's signature, so the node id carries its own stamp.
      const expected = nodeStamp(config.VONAGE_SIGNATURE_SECRET, nodeId);
      const stamp = typeof req.query.s === "string" ? req.query.s : "";
      if (Buffer.byteLength(stamp) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(stamp), Buffer.from(expected))) {
        req.log.warn({ nodeId }, "rejected a hook whose node stamp does not match");
        return reply.code(403).send({ error: "hook stamp rejected: the node named in the query is not one this host issued a hook for" });
      }
      const graph = await graphStore.load();
      const branch = graph.nodes.get(nodeId);
      if (!branch || (branch.action.action !== "input" && branch.action.action !== "notify")) return reply.code(404).send({ error: "unknown branching node" });
      const kind = branch.action.action === "input" ? "input_branch" : "notify_branch";
      const originUrl = branch.action.eventUrl?.[0];
      if (!originUrl || !/^https?:\/\//.test(originUrl)) return reply.code(404).send({ error: "the branching node names no callback URL" });

      const signedUuid = payload?.["uuid"];
      if (signedUuid !== undefined && signedUuid !== null && (typeof signedUuid !== "string" || signedUuid.length === 0)) {
        return reply.code(403).send({ error: "hook call UUID is invalid" });
      }
      const conversationUuid = typeof payload?.["conversation_uuid"] === "string" ? payload["conversation_uuid"] : undefined;
      const callUuid = await callUuidFor(graphStore, { callUuid: typeof signedUuid === "string" ? signedUuid : undefined, conversationUuid });
      const prefix = callUuid ? await graphStore.callPath(callUuid) : undefined;
      const eventFingerprint = createHash("sha256").update(canonicalPayload([req.method, payload])).digest("hex");
      if (!callUuid || !prefix || prefix.at(-1) !== nodeId || !await graphStore.claimBranch(callUuid, nodeId, typeof signedUuid === "string" ? undefined : conversationUuid, eventFingerprint)) {
        return reply.code(403).send({ error: "hook is not the known call's pending branch" });
      }
      const context = await graphStore.callContext(callUuid);

      // The query string Vonage sends on a GET callback rides along to the origin; on POST the body does.
      const forwardUrl = req.method === "GET" && raw ? `${originUrl}${originUrl.includes("?") ? "&" : "?"}${raw}` : originUrl;
      const forwarded = await forwardToOrigin(
        {
          method: req.method === "GET" ? "GET" : "POST",
          url: forwardUrl,
          ...(req.method === "POST" ? { body: raw, contentType: req.headers["content-type"] ?? "application/json" } : {}),
          timeoutMs: config.ORIGIN_TIMEOUT_MS,
          headers: { "x-preflight": "live" },
        },
        fetchImpl,
      );
      if (!forwarded.ok) {
        await record("hook", req, raw, payload, { originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs, decision: "block" });
        req.log.error({ error: forwarded.error, status: forwarded.status, originUrl }, "origin callback failed; failing closed at the branch");
        return reply.code(200).type("application/json").send(JSON.stringify(safeNcco("The application's server did not answer at a branch in the flow.")));
      }
      // The event names the branch result and little else about the call; what the answer-time webhook said
      // (direction, numbers, the app user) is read back so the continuation is decided as the same call.
      const known: Record<string, unknown> = { ...(payload ?? {}), uuid: callUuid };
      for (const [k, v] of Object.entries(context ?? {})) if (typeof known[k] !== "string" || (known[k] as string).length === 0) known[k] = v;
      const decideStart = performance.now();
      const override = await overrideFor(holds, known);
      const outcome = await flow.decide(
        { payload: known, nccoBytes: forwarded.bodyText, endpoint: endpointKeyOf(originUrl), from: { nodeId, kind }, now: new Date(clock()), originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs, override },
        prefix,
      );
      const totalVerifyMs = verifyLatencyMs + (performance.now() - decideStart);
      outcome.record.verifyLatencyMs = totalVerifyMs;
      outcome.record.source = "webhook";
      const pendingNodeId = outcome.decision === "pass" && outcome.pathNodeIds.length > prefix.length ? outcome.pathNodeIds.at(-1) ?? null : null;
      await graphStore.setCallPath(callUuid, outcome.pathNodeIds, undefined, pendingNodeId);
      await decisions.append(outcome.record);
      await ledger.append(ledgerDraftFor(outcome));
      await record("hook", req, raw, payload, { originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs: totalVerifyMs, decision: outcome.decision });
      req.log.info({ decision: outcome.decision, reason: outcome.reason, callUuid, endpoint: endpointKeyOf(originUrl), replacement: forwarded.bodyText.trim().length > 0, rewrote: outcome.rewrote }, "branch decided");
      reply.header("x-preflight-origin-ms", forwarded.originLatencyMs.toFixed(1));
      reply.header("x-preflight-verify-ms", totalVerifyMs.toFixed(1));
      reply.header("x-preflight-decision", outcome.decision);
      if (outcome.rewrote.length > 0) reply.header("x-preflight-routed", outcome.rewrote.join(","));
      if (outcome.decision === "pass") {
        if (forwarded.bodyText.trim().length === 0) return reply.code(204).send();
        return reply.code(200).type(forwarded.contentType ?? "application/json").send(outcome.responseBytes);
      }
      const body = outcome.decision === "block" ? safeNcco(outcome.reason ?? "") : holdNcco(outcome.reason ?? "");
      return reply.code(200).type("application/json").send(JSON.stringify(body));
    },
  });
}
