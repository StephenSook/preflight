import { timingSafeEqual } from "node:crypto";
import type { FlowDeclaration } from "@preflight/engine";
import { referenceApp } from "@preflight/reference";
import type { NumberFactsResolver } from "@preflight/numfacts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { FlowDecider } from "./decide/flow.js";
import { holdNcco, safeNcco } from "./decide/ncco.js";
import { ledgerDraftFor } from "./decide/record.js";
import { registerCallGateway } from "./gateway/calls.js";
import { registerBranchHook } from "./hooks/branch.js";
import { forwardToOrigin } from "./proxy/forward.js";
import type { DecisionStore } from "./store/decisionStore.js";
import type { EventStore, StoredWebhook, WebhookKind } from "./store/eventStore.js";
import type { GraphStore } from "./store/graphStore.js";
import type { HoldStore } from "./store/holdStore.js";
import { DecisionBus, publishing, registerStream } from "./stream.js";
import type { LedgerStore } from "./store/ledgerStore.js";
import { verifyVonageWebhook } from "./vonage/verifyWebhook.js";

export interface ServerDeps {
  config: Config;
  store: EventStore;
  decisions: DecisionStore;
  ledger: LedgerStore;
  graphStore: GraphStore;
  holds: HoldStore;
  resolver: NumberFactsResolver;
  declaration: FlowDeclaration;
  /** PEM of the application's public key; without it the create-call gateway refuses every caller. */
  applicationPublicKeyPem?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Injected clock so tests can pin token freshness. */
  now?: () => number;
}

export { holdNcco, safeNcco } from "./decide/ncco.js";

export function rawPayloadOf(req: FastifyRequest): string {
  if (req.method === "GET") {
    const q = req.url.indexOf("?");
    return q >= 0 ? req.url.slice(q + 1) : "";
  }
  return typeof req.body === "string" ? req.body : "";
}

export function parsePayload(req: FastifyRequest, raw: string): Record<string, unknown> | undefined {
  if (req.method === "GET") return Object.fromEntries(new URLSearchParams(raw).entries());
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[i] as number).toFixed(1));
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, store, ledger, graphStore, holds, resolver, declaration } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const clock = deps.now ?? Date.now;
  const bus = new DecisionBus();
  const decisions = publishing(deps.decisions, bus);
  const flow = new FlowDecider({ config, graphStore, declaration, resolver });
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  // Keep the exact bytes: payload_hash is computed over what Vonage sent, not over a re-serialisation.
  app.addContentTypeParser(["application/json", "application/x-www-form-urlencoded", "text/plain"], { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/health", async () => ({
    ok: true,
    service: "preflight-api",
    version: "0.1.0",
    policy: config.POLICY_MODE,
    store: store.name,
    events: await store.count(),
    decisions: await decisions.counts(),
    ledger: await ledger.head(),
    numfacts: { nanpaFileUpdated: resolver.sources.nanpa.fileUpdated, prefixes: resolver.coCodes.size },
  }));

  const secretFor = (apiKey: string) => (apiKey === config.VONAGE_API_KEY ? config.VONAGE_SIGNATURE_SECRET : undefined);

  function ingress(req: FastifyRequest) {
    const verifyStart = performance.now();
    const raw = rawPayloadOf(req);
    const verified = verifyVonageWebhook({
      authorization: req.headers.authorization,
      rawPayload: raw,
      method: req.method === "GET" ? "GET" : "POST",
      secretFor,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (verified.ok) app.log.info({ method: req.method, path: req.url.split("?")[0], payloadForm: verified.payloadForm }, "webhook verified");
    const payload = parsePayload(req, raw);
    return { verifyStart, raw, verified, payload };
  }

  function record(kind: WebhookKind, req: FastifyRequest, raw: string, payload: Record<string, unknown> | undefined, extra: Partial<StoredWebhook>): Promise<void> {
    const row: StoredWebhook = {
      kind,
      receivedAt: new Date(clock()).toISOString(),
      method: req.method === "GET" ? "GET" : "POST",
      applicationId: config.VONAGE_APPLICATION_ID,
      callUuid: str(payload?.["uuid"]) ?? str(payload?.["call_uuid"]),
      conversationUuid: str(payload?.["conversation_uuid"]),
      raw,
      payload,
      originLatencyMs: null,
      verifyLatencyMs: null,
      decision: null,
      ...extra,
    };
    return store.append(row);
  }

  // Answer webhook: verify, forward to the origin, merge the object into the discovered graph, run
  // every armed monitor over every observed path, return the object on pass (branch callbacks routed
  // through Preflight), the safe object on block, the hold object on hold. Fail closed with the safe
  // object if the origin does not answer.
  app.route({
    method: ["GET", "POST"],
    url: "/v/answer",
    handler: async (req, reply) => {
      const { verifyStart, raw, verified, payload } = ingress(req);
      if (!verified.ok) {
        req.log.warn({ reason: verified.reason }, "rejected unsigned or invalid answer webhook");
        return reply.code(403).send({ error: "webhook signature rejected", reason: verified.reason });
      }
      const verifyLatencyMs = performance.now() - verifyStart;
      const originUrl = req.method === "GET" && raw ? `${config.ORIGIN_ANSWER_URL}?${raw}` : config.ORIGIN_ANSWER_URL;
      const forwarded = await forwardToOrigin(
        {
          method: req.method === "GET" ? "GET" : "POST",
          url: originUrl,
          ...(req.method === "POST" ? { body: raw, contentType: req.headers["content-type"] ?? "application/json" } : {}),
          timeoutMs: config.ORIGIN_TIMEOUT_MS,
          headers: { "x-preflight": "live" },
        },
        fetchImpl,
      );
      if (!forwarded.ok) {
        await record("answer", req, raw, payload, { originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs, decision: "block" });
        req.log.error({ error: forwarded.error, status: forwarded.status }, "origin did not return an NCCO; failing closed");
        return reply.code(200).type("application/json").send(JSON.stringify(safeNcco("The application's server did not answer in time.")));
      }
      const decideStart = performance.now();
      const outcome = await flow.decide({ payload, nccoBytes: forwarded.bodyText, endpoint: "answer", now: new Date(clock()), originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs });
      const totalVerifyMs = verifyLatencyMs + (performance.now() - decideStart);
      outcome.record.verifyLatencyMs = totalVerifyMs;
      if (outcome.record.callUuid) await graphStore.setCallPath(outcome.record.callUuid, outcome.pathNodeIds);
      await decisions.append(outcome.record);
      await ledger.append(ledgerDraftFor(outcome));
      await record("answer", req, raw, payload, { originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs: totalVerifyMs, decision: outcome.decision });
      req.log.info({ decision: outcome.decision, reason: outcome.reason, callUuid: outcome.record.callUuid, terminal: outcome.record.terminal, rewrote: outcome.rewrote, coverage: outcome.coverage }, "answer decided");
      reply.header("x-preflight-origin-ms", forwarded.originLatencyMs.toFixed(1));
      reply.header("x-preflight-verify-ms", totalVerifyMs.toFixed(1));
      reply.header("x-preflight-decision", outcome.decision);
      if (outcome.rewrote.length > 0) reply.header("x-preflight-routed", outcome.rewrote.join(","));
      if (outcome.decision === "pass") return reply.code(200).type(forwarded.contentType ?? "application/json").send(outcome.responseBytes);
      const body = outcome.decision === "block" ? safeNcco(outcome.reason ?? "") : holdNcco(outcome.reason ?? "");
      return reply.code(200).type("application/json").send(JSON.stringify(body));
    },
  });

  if (config.REFERENCE_APP === "on") {
    // The reference application lives on this host so the demonstration needs one service.
    // Preflight still reaches it over HTTP, exactly as it would any developer's server.
    void app.register(referenceApp, { prefix: "/reference", selfBaseUrl: `${config.PUBLIC_BASE_URL ?? `http://127.0.0.1:${config.PORT}`}/reference`, mode: config.REFERENCE_MODE, agent: config.REFERENCE_AGENT, adminToken: config.REFERENCE_ADMIN_TOKEN });
  }

  registerBranchHook(app, { config, flow, graphStore, decisions, ledger, store, fetchImpl, clock, ingress, record });
  registerCallGateway(app, { config, flow, graphStore, decisions, ledger, holds, fetchImpl, clock, applicationPublicKeyPem: deps.applicationPublicKeyPem });
  // The held queue and the stream both need the dashboard token: a phone number is personal data.
  const dashboardAuth = (authorization: string | undefined): boolean => {
    if (!config.DASHBOARD_TOKEN) return false;
    const presented = (authorization ?? "").replace(/^Bearer\s+/i, "");
    return presented.length === config.DASHBOARD_TOKEN.length && timingSafeEqual(Buffer.from(presented), Buffer.from(config.DASHBOARD_TOKEN));
  };
  registerStream(app, bus, (presented) => (!config.DASHBOARD_TOKEN ? "disabled" : dashboardAuth(presented ? `Bearer ${presented}` : undefined) ? "ok" : "forbidden"));
  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/held", async (req, reply) => {
    if (!dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
    const status = (["open", "placed", "cancelled", "all"].includes(req.query.status ?? "") ? req.query.status : "open") as "open" | "placed" | "cancelled" | "all";
    return { status, holds: await holds.list(status, Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100))) };
  });
  app.post<{ Params: { id: string }; Body: string }>("/api/held/:id/decide", async (req, reply) => {
    if (!dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
    let body: { action?: unknown; by?: unknown };
    try {
      body = JSON.parse(typeof req.body === "string" ? req.body : "{}") as { action?: unknown; by?: unknown };
    } catch {
      return reply.code(400).send({ error: "body must be JSON" });
    }
    const action = body.action;
    const by = typeof body.by === "string" ? body.by.trim() : "";
    if ((action !== "place" && action !== "cancel") || by.length === 0) return reply.code(400).send({ error: 'expected {"action": "place" | "cancel", "by": "<name>"}: every override names who made it' });
    const at = new Date(clock()).toISOString();
    const hold = await holds.decide(req.params.id, action === "place" ? "placed" : "cancelled", by, at);
    if (!hold) return reply.code(404).send({ error: "no open hold with that id" });
    const entry = await ledger.append({
      ts: at,
      kind: "override",
      call_uuid: hold.callUuid ?? null,
      decision: null,
      property: hold.verdicts.find((v) => v.verdict === "inconclusive")?.id ?? null,
      citation: hold.verdicts.find((v) => v.verdict === "inconclusive")?.citation ?? null,
      witness: [],
      ncco_hash: null,
      line_type: null,
      detail: { hold_id: hold.holdId, action, by, reason: hold.reason },
    });
    return { hold, ledger: { seq: entry.seq, entry_hash: entry.entry_hash } };
  });

  // Public, unauthenticated recompute endpoints: what the user gets, never whether the system is right.
  app.get("/api/coverage", async () => flow.coverage());
  app.get("/api/summary", async () => {
    const recent = await decisions.recent(500);
    const verify = recent.map((r) => r.verifyLatencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const origin = recent.map((r) => r.originLatencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return {
      decisions: await decisions.counts(),
      ledger: await ledger.head(),
      coverage: await flow.coverage(),
      latency: { sample: recent.length, verifyP50Ms: percentile(verify, 50), verifyP95Ms: percentile(verify, 95), originP50Ms: percentile(origin, 50), originP95Ms: percentile(origin, 95) },
      policy: config.POLICY_MODE,
    };
  });

  // The evidence log, readable by anyone. The verify command a stranger runs is printed on the site.
  app.get("/api/ledger/head", async () => ledger.head());
  app.get<{ Querystring: { after?: string; limit?: string } }>("/api/ledger/entries", async (req) => {
    const after = Math.max(0, Number(req.query.after ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
    return { after, entries: await ledger.entries(after, limit) };
  });
  app.get("/api/ledger/verify", async () => ledger.verify());

  // The seal workflow records where the chain head was anchored in the public transparency log.
  app.post<{ Body: string }>("/api/ledger/seals", async (req, reply) => {
    if (!config.SEAL_TOKEN) return reply.code(404).send({ error: "sealing is not enabled on this deployment" });
    const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const expected = config.SEAL_TOKEN;
    const ok = presented.length === expected.length && timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
    if (!ok) return reply.code(403).send({ error: "seal token rejected" });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(typeof req.body === "string" ? req.body : "") as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: "body must be JSON" });
    }
    const sealed = body["sealed"] as { seq?: unknown; entry_hash?: unknown } | undefined;
    const uuid = body["rekor_uuid"];
    const logIndex = body["rekor_log_index"];
    if (typeof uuid !== "string" || !Number.isSafeInteger(logIndex) || !sealed || !Number.isSafeInteger(sealed.seq) || typeof sealed.entry_hash !== "string") {
      return reply.code(400).send({ error: "expected rekor_uuid, rekor_log_index and sealed {seq, entry_hash}" });
    }
    const entry = await ledger.append({
      ts: new Date(clock()).toISOString(),
      kind: "seal",
      call_uuid: null,
      decision: null,
      property: null,
      citation: null,
      witness: [],
      ncco_hash: null,
      line_type: null,
      detail: { rekor_uuid: uuid, rekor_log_index: logIndex as number, sealed_seq: sealed.seq as number, sealed_head: sealed.entry_hash, signature_b64: typeof body["signature_b64"] === "string" ? body["signature_b64"] : null },
    });
    return reply.code(201).send(entry);
  });

  // Event webhook: verify, store every body, forward to the origin's event URL if one is configured,
  // always acknowledge to Vonage.
  app.route({
    method: ["GET", "POST"],
    url: "/v/event",
    handler: async (req, reply) => {
      const { verifyStart, raw, verified, payload } = ingress(req);
      if (!verified.ok) {
        req.log.warn({ reason: verified.reason }, "rejected unsigned or invalid event webhook");
        return reply.code(403).send({ error: "webhook signature rejected", reason: verified.reason });
      }
      const verifyLatencyMs = performance.now() - verifyStart;
      let originLatencyMs: number | null = null;
      if (config.ORIGIN_EVENT_URL) {
        const f = await forwardToOrigin(
          {
            method: req.method === "GET" ? "GET" : "POST",
            url: req.method === "GET" && raw ? `${config.ORIGIN_EVENT_URL}?${raw}` : config.ORIGIN_EVENT_URL,
            ...(req.method === "POST" ? { body: raw, contentType: req.headers["content-type"] ?? "application/json" } : {}),
            timeoutMs: config.ORIGIN_TIMEOUT_MS,
            headers: { "x-preflight": "live" },
          },
          fetchImpl,
        );
        originLatencyMs = f.originLatencyMs;
      }
      await record("event", req, raw, payload, { originLatencyMs, verifyLatencyMs, decision: "stored" });
      return reply.code(204).send();
    },
  });

  // Fallback answer webhook: Vonage calls this after the primary answer URL failed twice. Preflight
  // records it and returns the safe NCCO, because a fallback firing means the origin is down.
  app.route({
    method: ["GET", "POST"],
    url: "/v/fallback",
    handler: async (req, reply) => {
      const { raw, verified, payload } = ingress(req);
      if (!verified.ok) {
        return reply.code(403).send({ error: "webhook signature rejected", reason: verified.reason });
      }
      await record("fallback", req, raw, payload, { decision: "block" });
      return reply.code(200).type("application/json").send(JSON.stringify(safeNcco("The application's server could not be reached.")));
    },
  });

  return app;
}
