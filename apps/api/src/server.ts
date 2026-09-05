import { timingSafeEqual } from "node:crypto";
import { declaredEndpointsOf, type FlowDeclaration } from "@preflight/engine";
import { referenceApp } from "@preflight/reference";
import type { NumberFactsResolver } from "@preflight/numfacts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { GENESIS_HASH, type Canonical } from "@preflight/ledger";
import { declarationSchema, type Config } from "./config.js";
import { campaignWindow, MAX_EVENTS } from "./campaign.js";
import { reconcile, type CarrierRecord } from "./reconcile.js";
import { InsightLookups } from "./insights/lookups.js";
import { PushNotifier, type PushSender } from "./push/notify.js";
import { registerPush } from "./push/routes.js";
import { registerSoftphone } from "./softphone/routes.js";
import { MemoryPushStore, type PushStore } from "./store/pushStore.js";
import { MemorySoftphoneStore, type SoftphoneStore } from "./store/softphoneStore.js";
import { preflightWebhooks, readApplication, writeWebhooks, type Credentials, type Hook, type VoiceWebhooks } from "./setup/application.js";
import { declarationHash, MemoryDeclarationStore, type DeclarationStore } from "./store/declarationStore.js";
import { MemoryInsightStore, type InsightStore } from "./store/insightStore.js";
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
import { mintApplicationJwt } from "./vonage/mintApplicationJwt.js";
import { verifyVonageWebhook } from "./vonage/verifyWebhook.js";
import { registerConsent } from "./consent/routes.js";
import { vonageVerify } from "./consent/verify.js";
import { MemoryConsentStore, type ConsentStore } from "./store/consentStore.js";

export interface ServerDeps {
  config: Config;
  store: EventStore;
  decisions: DecisionStore;
  ledger: LedgerStore;
  graphStore: GraphStore;
  holds: HoldStore;
  resolver: NumberFactsResolver;
  /** The environment's seed declaration; a stored one (Setup screen) wins when present. */
  declaration: FlowDeclaration;
  declarations?: DeclarationStore;
  /** Cached Identity Insights answers; used only when IDENTITY_INSIGHTS is on and the application key is present. */
  insights?: InsightStore;
  /** Web Push subscriptions for the held queue; used only when the VAPID keys are configured. */
  pushStore?: PushStore;
  /** Injected push transport, so tests never reach a push service. */
  pushSender?: PushSender;
  /** Softphone tokens issued, for the durable daily allowance. */
  softphoneStore?: SoftphoneStore;
  /** PEM of the application's public key; without it the create-call gateway refuses every caller. */
  applicationPublicKeyPem?: string | undefined;
  /** PEM of the application's private key; with it the consent gate and the demonstration call are enabled. */
  applicationPrivateKeyPem?: string | undefined;
  consents?: ConsentStore;
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

/** The most decisions one reconciliation window may span; a larger window is refused rather than truncated. */
export const RECONCILE_DECISION_LIMIT = 100000;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[i] as number).toFixed(1));
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, store, ledger, graphStore, holds, resolver, declaration } = deps;
  const declarations = deps.declarations ?? new MemoryDeclarationStore();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const clock = deps.now ?? Date.now;
  const bus = new DecisionBus();
  const decisions = publishing(deps.decisions, bus);
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  const privateKeyPem = deps.applicationPrivateKeyPem;
  const applicationId = config.VONAGE_APPLICATION_ID;
  const mintToken = privateKeyPem && applicationId ? () => mintApplicationJwt(applicationId, privateKeyPem, clock()) : undefined;
  // The paid lookup that resolves a hold the free tables could not: only with the application key, only when switched on.
  const lookups = config.IDENTITY_INSIGHTS === "on" && mintToken ? new InsightLookups({ store: deps.insights ?? new MemoryInsightStore(), host: config.IDENTITY_INSIGHTS_HOST, fetchImpl, token: mintToken, perDay: config.INSIGHTS_PER_DAY, now: clock, log: app.log }) : undefined;
  const flow = new FlowDecider({ config, graphStore, declaration, declarations, resolver, lookups });

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
  // Web Push for the held queue: on only when all three VAPID values are configured. A hold's push is
  // fire-and-forget from the gateway; the decision never waits on it.
  const pushStore = deps.pushStore ?? new MemoryPushStore();
  const vapid = config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT ? { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT } : undefined;
  const notifier = vapid ? new PushNotifier({ store: pushStore, vapid, dashboardBaseUrl: config.PUBLIC_WEB_URL ?? config.PUBLIC_BASE_URL ?? "", send: deps.pushSender, now: clock, log: app.log }) : undefined;
  registerCallGateway(app, { config, flow, graphStore, decisions, ledger, holds, fetchImpl, clock, applicationPublicKeyPem: deps.applicationPublicKeyPem, onHold: notifier ? (hold) => notifier.holdCreated(hold) : undefined });
  // The consent gate mints the application's own tokens for Verify v2 and for the demonstration call.
  const verify = mintToken ? vonageVerify({ apiHost: config.VONAGE_API_HOST, fetchImpl, token: mintToken }) : undefined;
  registerConsent(app, { config, consents: deps.consents ?? new MemoryConsentStore(), ledger, verify, mintToken, hashKey: privateKeyPem, clock });
  // The held queue and the stream both need the dashboard token: a phone number is personal data.
  const dashboardAuth = (authorization: string | undefined): boolean => {
    if (!config.DASHBOARD_TOKEN) return false;
    const presented = (authorization ?? "").replace(/^Bearer\s+/i, "");
    return presented.length === config.DASHBOARD_TOKEN.length && timingSafeEqual(Buffer.from(presented), Buffer.from(config.DASHBOARD_TOKEN));
  };
  registerStream(app, bus, (presented) => (!config.DASHBOARD_TOKEN ? "disabled" : dashboardAuth(presented ? `Bearer ${presented}` : undefined) ? "ok" : "forbidden"));
  registerPush(app, { store: pushStore, notifier, dashboardAuth, dashboardEnabled: Boolean(config.DASHBOARD_TOKEN), clock, maxSubscriptions: config.PUSH_SUBSCRIPTIONS_MAX });
  registerSoftphone(app, { config, fetchImpl, clock, applicationPrivateKeyPem: privateKeyPem, dashboardAuth, store: deps.softphoneStore ?? new MemorySoftphoneStore() });
  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/held", async (req, reply) => {
    if (!dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
    const status = (["open", "placed", "cancelled", "all"].includes(req.query.status ?? "") ? req.query.status : "open") as "open" | "placed" | "cancelled" | "all";
    const list = await holds.list(status, Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100)));
    // Each row says where the paid lookup stands for its line: pending, ok (with the answer), error, none, or off.
    const rows = await Promise.all(list.map(async (h) => ({ ...h, lookup: lookups ? await lookups.status(h.humanParty) : { state: "off" as const } })));
    return { status, lookups: lookups ? "on" : "off", holds: rows };
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

  // Carrier-side reconciliation (plan addition A6). The nightly workflow pulls the account's call records
  // from the platform's Reports API and posts them here. Every record must be a call this interlock
  // decided; the result is an evidence-log entry either way. Presents the same workflow token as the seal.
  app.post<{ Body: string }>("/api/reconcile", async (req, reply) => {
    if (!config.SEAL_TOKEN) return reply.code(404).send({ error: "reconciliation is not enabled on this deployment" });
    const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const expected = config.SEAL_TOKEN;
    if (!(presented.length === expected.length && timingSafeEqual(Buffer.from(presented), Buffer.from(expected)))) return reply.code(403).send({ error: "workflow token rejected" });
    let body: { window?: { start?: unknown; end?: unknown }; records?: unknown };
    try {
      body = JSON.parse(typeof req.body === "string" ? req.body : "") as typeof body;
    } catch {
      return reply.code(400).send({ error: "body must be JSON" });
    }
    const start = body.window?.start;
    const end = body.window?.end;
    if (typeof start !== "string" || typeof end !== "string" || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) > Date.parse(end) || Date.parse(end) - Date.parse(start) > 31 * 86_400_000) {
      return reply.code(400).send({ error: "expected window {start, end} as ISO times, start before end, at most 31 days apart" });
    }
    if (!Array.isArray(body.records) || body.records.length > 5000) return reply.code(400).send({ error: "expected records as an array of at most 5000 carrier records" });
    const records: CarrierRecord[] = [];
    for (const r of body.records as unknown[]) {
      const o = r as Record<string, unknown>;
      if (typeof o["call_id"] !== "string" || o["call_id"].length === 0 || typeof o["from"] !== "string" || typeof o["to"] !== "string" || typeof o["date_start"] !== "string" || !Number.isFinite(Date.parse(o["date_start"]))) {
        return reply.code(400).send({ error: "every record needs call_id, from, to and an ISO date_start" });
      }
      records.push({ call_id: o["call_id"], direction: typeof o["direction"] === "string" ? o["direction"] : "unknown", from: o["from"], to: o["to"], date_start: o["date_start"] });
    }
    // A refusal moments before the window opened can still explain a record just inside it.
    const margin = 15 * 60 * 1000;
    const inWindow = await decisions.between(new Date(Date.parse(start) - margin).toISOString(), new Date(Date.parse(end) + margin).toISOString(), RECONCILE_DECISION_LIMIT);
    // A window the store could not return whole is refused, never silently reconciled against its newest part.
    if (inWindow.length >= RECONCILE_DECISION_LIMIT) return reply.code(422).send({ error: `more than ${RECONCILE_DECISION_LIMIT} decisions in the window; narrow it` });
    const report = reconcile({ start, end }, records, inWindow);
    const entry = await ledger.append({
      ts: new Date(clock()).toISOString(),
      kind: "reconciliation",
      call_uuid: null,
      decision: null,
      property: null,
      citation: null,
      witness: [],
      ncco_hash: null,
      line_type: null,
      detail: report as unknown as { [key: string]: Canonical },
    });
    req.log.info({ seq: entry.seq, carrier_records: report.carrier_records, unmatched: report.unmatched, leaks: report.leaks }, "carrier reconciliation recorded");
    return reply.code(201).send({ report, ledger: { seq: entry.seq, entry_hash: entry.entry_hash } });
  });

  const lastReconciliation = async () => {
    const last = await ledger.lastOfKind("reconciliation");
    if (!last) return null;
    const d = (last.detail ?? {}) as Record<string, Canonical | undefined>;
    return { ts: last.ts, seq: last.seq, window: d["window"] ?? null, carrier_records: d["carrier_records"] ?? null, matched: d["matched"] ?? null, unmatched: d["unmatched"] ?? null, leaks: d["leaks"] ?? null, refused_in_window: d["refused_in_window"] ?? null, decided_not_in_records: d["decided_not_in_records"] ?? null };
  };

  // Public, unauthenticated recompute endpoints: what the user gets, never whether the system is right.
  app.get("/api/coverage", async () => flow.coverage());
  // The rate properties (P6 to P8) over a window, default the last thirty days (the rule's own period). Counts only.
  app.get<{ Querystring: { since?: string; until?: string } }>("/api/campaign", async (req, reply) => {
    const untilMs = req.query.until === undefined ? clock() : Date.parse(req.query.until);
    const sinceMs = req.query.since === undefined ? untilMs - 30 * 86_400_000 : Date.parse(req.query.since);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) return reply.code(400).send({ error: "since and until must be ISO times, since before until" });
    // Normalised to the instant, so the store compares times and not the spelling of an offset.
    const result = await campaignWindow({ store, graphStore, declaration: () => flow.currentDeclaration() }, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString());
    // A window the store could not return whole is refused, never folded from its oldest part.
    if (result.events > MAX_EVENTS) return reply.code(422).send({ error: `more than ${MAX_EVENTS} event webhooks in the window; narrow it` });
    return result;
  });
  // The declared-versus-actual diff: the discovered graph coloured against what the developer declared.
  // No phone numbers here, only the application's own call-control objects.
  app.get("/api/flow", async () => flow.diff());

  // Setup (spec screen 6): the three URLs to point the application at, the origin, the policy, and the
  // declaration in force. Reading it needs the dashboard token because the origin is an internal address.
  const setupView = async () => {
    const stored = await declarations.current();
    const base = config.PUBLIC_BASE_URL?.replace(/\/$/, "");
    return {
      urls: base ? { answer: `${base}/v/answer`, event: `${base}/v/event`, fallback: `${base}/v/fallback` } : null,
      origin: config.ORIGIN_ANSWER_URL,
      policy: config.POLICY_MODE,
      declaration: stored?.declaration ?? declaration,
      declaration_source: stored ? "stored" : "environment",
      declaration_hash: stored?.hash ?? declarationHash(declaration),
      declared_by: stored?.declaredBy ?? null,
      declared_at: stored?.declaredAt ?? null,
    };
  };
  app.get("/api/setup", async (req, reply) => {
    if (!dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
    return setupView();
  });
  // A declaration shapes two atoms (identifies, offers_optout) and the coverage denominator, so every
  // change names who made it and becomes an evidence-log entry carrying the declaration's hash.
  app.put<{ Body: string }>("/api/setup/declaration", async (req, reply) => {
    if (!dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
    let body: { declaration?: unknown; by?: unknown };
    try {
      body = JSON.parse(typeof req.body === "string" ? req.body : "{}") as { declaration?: unknown; by?: unknown };
    } catch {
      return reply.code(400).send({ error: "body must be JSON" });
    }
    const by = typeof body.by === "string" ? body.by.trim() : "";
    if (by.length === 0) return reply.code(400).send({ error: 'expected {"declaration": {...}, "by": "<name>"}: every declaration names who made it' });
    const parsed = declarationSchema.safeParse(body.declaration);
    if (!parsed.success) return reply.code(400).send({ error: "declaration is invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) });
    const previous = (await declarations.current())?.hash ?? declarationHash(declaration);
    const at = new Date(clock()).toISOString();
    const rec = await declarations.set(parsed.data as FlowDeclaration, by, at);
    const entry = await ledger.append({
      ts: at,
      kind: "declaration",
      call_uuid: null,
      decision: null,
      property: null,
      citation: null,
      witness: [],
      ncco_hash: null,
      line_type: null,
      detail: { declaration_hash: rec.hash, previous_hash: previous, by, endpoints: declaredEndpointsOf(rec.declaration), identification_phrases: rec.declaration.identification?.phrases?.length ?? 0, optout_patterns: rec.declaration.optOut?.eventUrlPatterns?.length ?? 0 },
    });
    req.log.info({ by, hash: rec.hash, seq: entry.seq }, "flow declaration replaced");
    return { ...(await setupView()), ledger: { seq: entry.seq, entry_hash: entry.entry_hash } };
  });

  // One-click install and rollback through the Application API (plan addition A5). The account
  // credentials travel through for two or three platform requests and are kept nowhere: not in a
  // store, not in the log, not in the ledger. What the ledger keeps is what the hooks were and are.
  const parseSetupBody = (raw: unknown): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(typeof raw === "string" ? raw : "{}") as unknown;
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const credentialsOf = (body: Record<string, unknown>): { creds: Credentials; by: string } | { error: string } => {
    const applicationId = typeof body["application_id"] === "string" ? body["application_id"].trim() : "";
    const apiKey = typeof body["api_key"] === "string" ? body["api_key"].trim() : "";
    const apiSecret = typeof body["api_secret"] === "string" ? body["api_secret"] : "";
    const by = typeof body["by"] === "string" ? body["by"].trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(applicationId) || apiKey.length === 0 || apiSecret.length === 0 || by.length === 0) {
      return { error: 'expected {"application_id": "<uuid>", "api_key": "...", "api_secret": "...", "by": "<name>"}: the credentials are used for the requests and kept nowhere; every change names who made it' };
    }
    return { creds: { applicationId, apiKey, apiSecret }, by };
  };
  const hookOf = (v: unknown): Hook | undefined => {
    const r = typeof v === "object" && v !== null ? (v as { address?: unknown; http_method?: unknown }) : undefined;
    if (!r || typeof r.address !== "string" || !/^https?:\/\/\S+$/.test(r.address) || (r.http_method !== "GET" && r.http_method !== "POST")) return undefined;
    return { address: r.address, http_method: r.http_method };
  };
  const setupEntry = async (action: "install" | "rollback", creds: Credentials, by: string, previous: VoiceWebhooks | undefined, current: VoiceWebhooks | undefined) =>
    ledger.append({
      ts: new Date(clock()).toISOString(),
      kind: "setup",
      call_uuid: null,
      decision: null,
      property: null,
      citation: null,
      witness: [],
      ncco_hash: null,
      line_type: null,
      detail: { action, application_id: creds.applicationId, by, previous: previous ? hooksCanonical(previous) : null, current: current ? hooksCanonical(current) : null, signed_callbacks: true },
    });
  function hooksCanonical(w: VoiceWebhooks): Canonical {
    return { answer: { address: w.answer.address, http_method: w.answer.http_method }, event: { address: w.event.address, http_method: w.event.http_method }, fallback: { address: w.fallback.address, http_method: w.fallback.http_method } };
  }
  app.post<{ Body: string }>("/api/setup/install", async (req, reply) => {
    if (!dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
    if (!config.PUBLIC_BASE_URL) return reply.code(409).send({ error: "PUBLIC_BASE_URL is not set on this deployment, so there is no address to point the application at" });
    const body = parseSetupBody(req.body);
    if (!body) return reply.code(400).send({ error: "body must be a JSON object" });
    const parsed = credentialsOf(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const before = await readApplication(parsed.creds, { fetchImpl });
    if (!before.ok) return reply.code(502).send({ error: `the platform refused to read the application: ${before.error}`, platform_status: before.status });
    const target = preflightWebhooks(config.PUBLIC_BASE_URL);
    const after = await writeWebhooks(parsed.creds, before.raw, target, { fetchImpl });
    if (!after.ok) return reply.code(502).send({ error: `the install did not verify: ${after.error}`, platform_status: after.status, previous: before.view.webhooks ?? null });
    const entry = await setupEntry("install", parsed.creds, parsed.by, before.view.webhooks, after.view.webhooks);
    req.log.info({ applicationId: parsed.creds.applicationId, by: parsed.by, seq: entry.seq }, "application pointed at preflight");
    return { action: "install", application: { id: after.view.id, name: after.view.name }, previous: before.view.webhooks ?? null, current: after.view.webhooks, signed_callbacks: after.view.signedCallbacks, ledger: { seq: entry.seq, entry_hash: entry.entry_hash } };
  });
  app.post<{ Body: string }>("/api/setup/rollback", async (req, reply) => {
    if (!dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
    const body = parseSetupBody(req.body);
    if (!body) return reply.code(400).send({ error: "body must be a JSON object" });
    const parsed = credentialsOf(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const prev = typeof body["previous"] === "object" && body["previous"] !== null ? (body["previous"] as Record<string, unknown>) : undefined;
    const answer = hookOf(prev?.["answer"]);
    const event = hookOf(prev?.["event"]);
    const fallback = hookOf(prev?.["fallback"]);
    if (!answer || !event || !fallback) return reply.code(400).send({ error: "expected previous {answer, event, fallback}, each {address: http(s) URL, http_method: GET | POST}, as the install returned them" });
    const previous: VoiceWebhooks = { answer, event, fallback };
    const before = await readApplication(parsed.creds, { fetchImpl });
    if (!before.ok) return reply.code(502).send({ error: `the platform refused to read the application: ${before.error}`, platform_status: before.status });
    const after = await writeWebhooks(parsed.creds, before.raw, previous, { fetchImpl });
    if (!after.ok) return reply.code(502).send({ error: `the rollback did not verify: ${after.error}`, platform_status: after.status });
    const entry = await setupEntry("rollback", parsed.creds, parsed.by, before.view.webhooks, after.view.webhooks);
    req.log.info({ applicationId: parsed.creds.applicationId, by: parsed.by, seq: entry.seq }, "application webhooks restored");
    return { action: "rollback", application: { id: after.view.id, name: after.view.name }, previous: before.view.webhooks ?? null, current: after.view.webhooks, signed_callbacks: after.view.signedCallbacks, ledger: { seq: entry.seq, entry_hash: entry.entry_hash } };
  });
  app.get("/api/summary", async () => {
    const recent = await decisions.recent(500);
    const verify = recent.map((r) => r.verifyLatencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const origin = recent.map((r) => r.originLatencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return {
      decisions: await decisions.counts(),
      ledger: await ledger.head(),
      coverage: await flow.coverage(),
      latency: { sample: recent.length, verifyP50Ms: percentile(verify, 50), verifyP95Ms: percentile(verify, 95), originP50Ms: percentile(origin, 50), originP95Ms: percentile(origin, 95) },
      reconciliation: await lastReconciliation(),
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
    // The sealed head must be this ledger's: the entry at that seq, or genesis for an empty chain.
    const sealedSeq = sealed.seq as number;
    const at = sealedSeq === 0 ? { seq: 0, entry_hash: GENESIS_HASH } : (await ledger.entries(sealedSeq - 1, 1))[0];
    if (!at || at.seq !== sealedSeq || at.entry_hash !== sealed.entry_hash) return reply.code(409).send({ error: "the sealed head is not an entry of this ledger", ledger: at ? { seq: at.seq, entry_hash: at.entry_hash } : null });
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
