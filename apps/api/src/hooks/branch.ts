import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { endpointKeyOf, type FlowDecider } from "../decide/flow.js";
import { ledgerDraftFor } from "../decide/record.js";
import { forwardToOrigin } from "../proxy/forward.js";
import type { DecisionStore } from "../store/decisionStore.js";
import type { EventStore, StoredWebhook, WebhookKind } from "../store/eventStore.js";
import type { GraphStore } from "../store/graphStore.js";
import type { LedgerStore } from "../store/ledgerStore.js";
import { holdNcco, safeNcco } from "../decide/ncco.js";

export interface HookDeps {
  config: Config;
  flow: FlowDecider;
  graphStore: GraphStore;
  decisions: DecisionStore;
  ledger: LedgerStore;
  store: EventStore;
  fetchImpl: typeof fetch;
  clock: () => number;
  ingress: (req: FastifyRequest) => { verifyStart: number; raw: string; verified: { ok: boolean; reason?: string }; payload: Record<string, unknown> | undefined };
  record: (kind: WebhookKind, req: FastifyRequest, raw: string, payload: Record<string, unknown> | undefined, extra: Partial<StoredWebhook>) => Promise<void>;
}

/**
 * The branch hook. When Preflight passes an object whose input or notify action names a callback,
 * it rewrites that callback to point here, carrying the branching node (n), the origin URL (u,
 * base64url) and the method (m). Vonage calls this with the input result or the notify payload,
 * signed like every other webhook. Preflight verifies, forwards to the origin, observes what came
 * back (a replacement object, or nothing), and decides the continuation as a path that starts with
 * everything the call has already executed.
 */
export function registerBranchHook(app: FastifyInstance, deps: HookDeps): void {
  const { config, flow, graphStore, decisions, ledger, fetchImpl, clock, ingress, record } = deps;
  app.route<{ Querystring: { n?: string; u?: string; m?: string } }>({
    method: ["GET", "POST"],
    url: "/v/hook",
    handler: async (req, reply) => {
      const { verifyStart, raw, verified, payload } = ingress(req);
      if (!verified.ok) {
        req.log.warn({ reason: verified.reason }, "rejected unsigned or invalid branch callback");
        return reply.code(403).send({ error: "webhook signature rejected", reason: verified.reason });
      }
      const verifyLatencyMs = performance.now() - verifyStart;
      const nodeId = req.query.n;
      let originUrl: string | undefined;
      try {
        originUrl = req.query.u ? Buffer.from(req.query.u, "base64url").toString("utf8") : undefined;
        if (originUrl) new URL(originUrl);
      } catch {
        originUrl = undefined;
      }
      if (!nodeId || !originUrl) return reply.code(400).send({ error: "hook needs n (branching node) and u (origin callback, base64url)" });
      const graph = await graphStore.load();
      const branch = graph.nodes.get(nodeId);
      if (!branch || (branch.action.action !== "input" && branch.action.action !== "notify")) return reply.code(404).send({ error: "unknown branching node" });
      const kind = branch.action.action === "input" ? "input_branch" : "notify_branch";

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
      const callUuid = typeof payload?.["uuid"] === "string" ? payload["uuid"] : undefined;
      const prefix = callUuid ? (await graphStore.callPath(callUuid)) ?? [] : [];
      const decideStart = performance.now();
      const outcome = await flow.decide(
        { payload, nccoBytes: forwarded.bodyText, endpoint: endpointKeyOf(originUrl), from: { nodeId, kind }, now: new Date(clock()), originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs },
        prefix,
      );
      const totalVerifyMs = verifyLatencyMs + (performance.now() - decideStart);
      outcome.record.verifyLatencyMs = totalVerifyMs;
      if (callUuid) await graphStore.setCallPath(callUuid, outcome.pathNodeIds);
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
