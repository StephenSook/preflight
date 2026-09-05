import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { FlowDecider, FlowOutcome } from "../decide/flow.js";
import { ledgerDraftFor } from "../decide/record.js";
import { forwardToOrigin } from "../proxy/forward.js";
import type { DecisionStore } from "../store/decisionStore.js";
import type { GraphStore } from "../store/graphStore.js";
import type { Hold, HoldStore } from "../store/holdStore.js";
import type { LedgerStore } from "../store/ledgerStore.js";
import { verifyApplicationJwt } from "../vonage/verifyApplicationJwt.js";

export interface GatewayDeps {
  config: Config;
  flow: FlowDecider;
  graphStore: GraphStore;
  decisions: DecisionStore;
  ledger: LedgerStore;
  holds: HoldStore;
  fetchImpl: typeof fetch;
  clock: () => number;
  applicationPublicKeyPem?: string | undefined;
  /** Called after a hold is queued, fire-and-forget: the person's phone hears about it. */
  onHold?: ((hold: Hold) => void) | undefined;
}

interface CreateCallBody {
  to?: Array<{ type?: unknown; number?: unknown }>;
  from?: { type?: unknown; number?: unknown };
  random_from_number?: unknown;
  ncco?: unknown;
  answer_url?: unknown;
  answer_method?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * The create-call gateway. Vonage fires the answer webhook only once a call is answered, so a
 * webhook-only interlock cannot keep an outbound phone silent. Here the developer's application
 * posts its outbound call to Preflight instead of to the platform. Preflight obtains the flow the
 * call would run (the inline object, or a dry-run pre-fetch of the answer URL marked as such),
 * runs every armed monitor, and only on pass forwards the request byte for byte to the platform
 * with the caller's own bearer token, which is never stored. Block and hold return 409 with the
 * verdicts and nothing reaches the carrier.
 */
export function registerCallGateway(app: FastifyInstance, deps: GatewayDeps): void {
  const { config, flow, graphStore, decisions, ledger, holds, fetchImpl, clock, applicationPublicKeyPem } = deps;

  app.post<{ Body: string }>("/v/calls", async (req, reply) => {
    // Nothing is fetched and nothing is forwarded for a caller who is not this application.
    const authorization = req.headers.authorization;
    if (!applicationPublicKeyPem || !config.VONAGE_APPLICATION_ID) {
      return reply.code(503).send({ error: "the gateway needs VONAGE_APPLICATION_ID and VONAGE_APPLICATION_PUBLIC_KEY_PATH to verify callers; it refuses everyone until then" });
    }
    const caller = verifyApplicationJwt({ authorization, publicKeyPem: applicationPublicKeyPem, applicationId: config.VONAGE_APPLICATION_ID, now: clock });
    if (!caller.ok || !authorization) {
      return reply.code(401).send({ error: "the calling application's Vonage JWT is required in Authorization and must be signed by this application's private key; Preflight forwards it to the platform and never stores it", reason: caller.reason });
    }
    const rawBody = typeof req.body === "string" ? req.body : "";
    let body: CreateCallBody;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!isObject(parsed)) throw new Error("not an object");
      body = parsed as CreateCallBody;
    } catch {
      return reply.code(400).send({ error: "body must be a JSON create-call request" });
    }
    const first = Array.isArray(body.to) ? body.to[0] : undefined;
    const toNumber = first && isObject(first) ? str(first.number) : undefined;
    if (!toNumber || (first && first.type !== undefined && first.type !== "phone")) {
      return reply.code(400).send({ error: "to[0] must be a phone endpoint with a number" });
    }
    const fromNumber = isObject(body.from) ? str(body.from.number) : undefined;
    const randomFrom = body.random_from_number === true;
    if (!fromNumber && !randomFrom) return reply.code(400).send({ error: "from.number or random_from_number is required" });
    const answerUrl = Array.isArray(body.answer_url) ? str(body.answer_url[0]) : undefined;
    const hasInline = Array.isArray(body.ncco);
    if (!hasInline && !answerUrl) return reply.code(400).send({ error: "either ncco or answer_url is required" });
    // The pre-fetch reaches exactly one place: the configured origin. Either the caller named
    // Preflight's own answer URL (the installed shape), or the same host as ORIGIN_ANSWER_URL.
    if (answerUrl && !isPreflightAnswerUrl(answerUrl, config) && !isConfiguredOrigin(answerUrl, config)) {
      return reply.code(400).send({ error: "answer_url must be this Preflight's /v/answer or a URL on the configured origin host; the pre-dial check fetches nowhere else" });
    }

    const verifyStart = performance.now();
    const dryRunId = `preflight-dryrun-${randomBytes(6).toString("hex")}`;
    let nccoBytes: string;
    let originLatencyMs: number | null = null;
    let originFailure: string | undefined;
    if (hasInline) {
      nccoBytes = JSON.stringify(body.ncco);
    } else {
      // A developer who installed Preflight points answer_url at Preflight itself; the pre-fetch
      // then goes to the real origin, not back into this service.
      const target = isPreflightAnswerUrl(answerUrl as string, config) ? config.ORIGIN_ANSWER_URL : (answerUrl as string);
      const method = body.answer_method === "POST" ? "POST" : "GET";
      const params = { to: toNumber, from: fromNumber ?? "", uuid: dryRunId, conversation_uuid: "preflight-dryrun", direction: "outbound" };
      const forwarded = await forwardToOrigin(
        method === "GET"
          ? { method, url: `${target}${target.includes("?") ? "&" : "?"}${new URLSearchParams(params).toString()}`, timeoutMs: config.ORIGIN_TIMEOUT_MS, headers: { "x-preflight": "dry-run" } }
          : { method, url: target, body: JSON.stringify(params), contentType: "application/json", timeoutMs: config.ORIGIN_TIMEOUT_MS, headers: { "x-preflight": "dry-run" } },
        fetchImpl,
      );
      originLatencyMs = forwarded.originLatencyMs;
      nccoBytes = forwarded.ok ? forwarded.bodyText : "";
      if (!forwarded.ok) originFailure = `the application's answer URL did not return a flow during the pre-dial check (${forwarded.error ?? "error"}${forwarded.status ? ` HTTP ${forwarded.status}` : ""})`;
    }

    const outcome: FlowOutcome = await flow.decide({
      payload: { direction: "outbound", to: toNumber, from: fromNumber ?? (randomFrom ? "random_from_number" : undefined), uuid: dryRunId },
      nccoBytes,
      endpoint: "answer",
      now: new Date(clock()),
      originLatencyMs,
      verifyLatencyMs: null,
    });
    if (originFailure) {
      outcome.decision = "block";
      outcome.reason = originFailure;
      outcome.record.decision = "block";
      outcome.record.reason = originFailure;
    }
    // A person decided a held call may be placed: the caller re-submits with the hold id. The override
    // is already in the ledger; here it is checked against the same destination and recorded again.
    const overrideId = typeof req.headers["x-preflight-override"] === "string" ? req.headers["x-preflight-override"] : undefined;
    let override: { holdId: string; by: string } | undefined;
    if (overrideId) {
      const hold = await holds.get(overrideId);
      if (!hold || hold.status !== "placed" || hold.humanParty !== toNumber) {
        return reply.code(409).send({ decision: "hold", placed: false, reason: hold ? `override ${overrideId} is ${hold.status} or names another destination` : `no hold ${overrideId}` });
      }
      override = { holdId: hold.holdId, by: hold.decidedBy ?? "unknown" };
      if (outcome.decision === "hold") {
        outcome.decision = "pass";
        outcome.record.decision = "pass";
        outcome.reason = `placed on the override recorded for hold ${hold.holdId} by ${override.by}`;
        outcome.record.reason = outcome.reason;
      }
    }
    if (randomFrom && !fromNumber) {
      // The platform picks one of the account's own numbers: a caller id will be present.
      for (const v of outcome.evaluation.verdicts) if (v.id === "P4" && v.verdict === "false") Object.assign(v, { verdict: "true", witness: undefined });
      if (outcome.decision === "block" && !outcome.evaluation.verdicts.some((v) => v.verdict === "false")) {
        outcome.decision = outcome.evaluation.verdicts.some((v) => v.verdict === "inconclusive") && config.POLICY_MODE === "strict" ? "hold" : "pass";
        outcome.record.decision = outcome.decision;
        outcome.reason = outcome.decision === "pass" ? undefined : outcome.reason;
        outcome.record.reason = outcome.reason;
      }
    }

    // An inline object whose branch callbacks were routed through Preflight goes to the platform routed.
    let forwardBody = rawBody;
    if (hasInline && outcome.rewrote.length > 0) forwardBody = JSON.stringify({ ...body, ncco: JSON.parse(outcome.responseBytes) as unknown });

    let placed: { status: number; bodyText: string; contentType: string | null } | undefined;
    if (outcome.decision === "pass") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetchImpl(`${config.VONAGE_API_HOST}/v1/calls`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json", accept: "application/json", "user-agent": "preflight/0.1 (+https://github.com/StephenSook/preflight)" },
          body: forwardBody,
          signal: controller.signal,
        });
        placed = { status: res.status, bodyText: await res.text(), contentType: res.headers.get("content-type") };
      } catch (err) {
        placed = { status: 502, bodyText: JSON.stringify({ error: "the platform did not accept the call request", detail: err instanceof Error ? err.message : String(err) }), contentType: "application/json" };
      } finally {
        clearTimeout(timer);
      }
      try {
        const v = JSON.parse(placed.bodyText) as { uuid?: unknown; conversation_uuid?: unknown };
        if (typeof v.uuid === "string") {
          outcome.record.callUuid = v.uuid;
          await graphStore.setCallPath(v.uuid, outcome.pathNodeIds);
        }
        if (typeof v.conversation_uuid === "string") outcome.record.conversationUuid = v.conversation_uuid;
      } catch {
        // The platform's body is returned to the caller verbatim whatever it is.
      }
    }

    let holdId: string | undefined;
    if (outcome.decision === "hold") {
      holdId = `hold-${randomBytes(8).toString("hex")}`;
      const hold: Hold = { holdId, callUuid: outcome.record.callUuid, humanParty: toNumber, reason: outcome.reason ?? "undecided", verdicts: outcome.evaluation.verdicts, status: "open", createdAt: outcome.record.decidedAt, decidedBy: undefined, decidedAt: undefined };
      await holds.create(hold);
      deps.onHold?.(hold);
    }
    outcome.record.verifyLatencyMs = performance.now() - verifyStart - (originLatencyMs ?? 0);
    await decisions.append(outcome.record);
    await ledger.append(ledgerDraftFor(outcome));
    req.log.info({ decision: outcome.decision, reason: outcome.reason, to: toNumber, callUuid: outcome.record.callUuid, placed: placed?.status, holdId, override }, "create-call gateway decided");

    reply.header("x-preflight-decision", outcome.decision);
    reply.header("x-preflight-verify-ms", (outcome.record.verifyLatencyMs ?? 0).toFixed(1));
    if (originLatencyMs !== null) reply.header("x-preflight-origin-ms", originLatencyMs.toFixed(1));
    if (placed) return reply.code(placed.status).type(placed.contentType ?? "application/json").send(placed.bodyText);
    return reply.code(409).send({
      decision: outcome.decision,
      placed: false,
      reason: outcome.reason,
      verdicts: outcome.evaluation.verdicts,
      coverage: outcome.coverage,
      ...(holdId ? { holdId, decide: "a person decides this hold in the dashboard; re-submit the same request with X-Preflight-Override: <holdId> once it is placed" } : {}),
      facts: { state: outcome.record.facts.state, rateCenter: outcome.record.facts.rateCenter, lineType: outcome.record.facts.lineType, zones: outcome.record.facts.zones, withinHours: outcome.record.facts.withinHours, hoursBasis: outcome.record.facts.hoursBasis },
      terminal: outcome.record.terminal,
    });
  });
}

function isConfiguredOrigin(url: string, config: Config): boolean {
  try {
    const u = new URL(url);
    const o = new URL(config.ORIGIN_ANSWER_URL);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host === o.host;
  } catch {
    return false;
  }
}

function isPreflightAnswerUrl(url: string, config: Config): boolean {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith("/v/answer")) return false;
    if (!config.PUBLIC_BASE_URL) return true;
    return u.host === new URL(config.PUBLIC_BASE_URL).host;
  } catch {
    return false;
  }
}
