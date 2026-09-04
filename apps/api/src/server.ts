import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { forwardToOrigin } from "./proxy/forward.js";
import type { EventStore, StoredWebhook, WebhookKind } from "./store/eventStore.js";
import { verifyVonageWebhook } from "./vonage/verifyWebhook.js";

export interface ServerDeps {
  config: Config;
  store: EventStore;
  fetchImpl?: typeof fetch;
  /** Injected clock so tests can pin token freshness. */
  now?: () => number;
}

/**
 * The safe NCCO returned when Preflight cannot let the origin's flow through. It is deliberately a
 * plain spoken sentence and a hangup: no branch, no input, nothing a monitor could object to.
 */
export function safeNcco(reason: string): unknown[] {
  return [
    { action: "talk", text: `This call was stopped by Preflight. ${reason}` },
  ];
}

function rawPayloadOf(req: FastifyRequest): string {
  if (req.method === "GET") {
    const q = req.url.indexOf("?");
    return q >= 0 ? req.url.slice(q + 1) : "";
  }
  return typeof req.body === "string" ? req.body : "";
}

function parsePayload(req: FastifyRequest, raw: string): Record<string, unknown> | undefined {
  if (req.method === "GET") return Object.fromEntries(new URLSearchParams(raw).entries());
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, store } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
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
  }));

  const secretFor = (apiKey: string) => (apiKey === config.VONAGE_API_KEY ? config.VONAGE_SIGNATURE_SECRET : undefined);

  async function ingress(kind: WebhookKind, req: FastifyRequest) {
    const verifyStart = performance.now();
    const raw = rawPayloadOf(req);
    const verified = verifyVonageWebhook({
      authorization: req.headers.authorization,
      rawPayload: raw,
      secretFor,
      ...(deps.now ? { now: deps.now } : {}),
    });
    const payload = parsePayload(req, raw);
    return { verifyStart, raw, verified, payload };
  }

  function record(kind: WebhookKind, req: FastifyRequest, raw: string, payload: Record<string, unknown> | undefined, extra: Partial<StoredWebhook>): Promise<void> {
    const row: StoredWebhook = {
      kind,
      receivedAt: new Date().toISOString(),
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

  // Answer webhook: verify, forward to the origin, return the origin's NCCO untouched (pass-through
  // until the monitor bank lands), fail closed with a safe NCCO if the origin does not answer.
  app.route({
    method: ["GET", "POST"],
    url: "/v/answer",
    handler: async (req, reply) => {
      const { verifyStart, raw, verified, payload } = await ingress("answer", req);
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
      await record("answer", req, raw, payload, { originLatencyMs: forwarded.originLatencyMs, verifyLatencyMs, decision: "forwarded" });
      reply.header("x-preflight-origin-ms", forwarded.originLatencyMs.toFixed(1));
      reply.header("x-preflight-verify-ms", verifyLatencyMs.toFixed(1));
      return reply.code(200).type(forwarded.contentType ?? "application/json").send(forwarded.bodyText);
    },
  });

  // Event webhook: verify, store every body, forward to the origin's event URL if one is configured,
  // always acknowledge to Vonage.
  app.route({
    method: ["GET", "POST"],
    url: "/v/event",
    handler: async (req, reply) => {
      const { verifyStart, raw, verified, payload } = await ingress("event", req);
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
      const { raw, verified, payload } = await ingress("fallback", req);
      if (!verified.ok) {
        return reply.code(403).send({ error: "webhook signature rejected", reason: verified.reason });
      }
      await record("fallback", req, raw, payload, { decision: "block" });
      return reply.code(200).type("application/json").send(JSON.stringify(safeNcco("The application's server could not be reached.")));
    },
  });

  return app;
}
