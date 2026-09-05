import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.js";
import type { ConsentStore } from "../store/consentStore.js";
import type { LedgerStore } from "../store/ledgerStore.js";
import type { VerifyClient } from "./verify.js";

/**
 * The consent gate on "call my phone". A visitor asks Preflight to call them; Verify v2 first calls
 * that phone over the voice channel and speaks a four-digit code; the checked code grants consent to
 * ONE demonstration call within a short window, written to the ledger with the number's hash. The
 * demonstration call itself goes through the create-call gateway like any other call, so the
 * interlock decides it and the evidence log records it. A blocked attempt never rang the phone and
 * does not consume the consent; a placed call does, exactly once.
 *
 * This is consent to this demonstration call. It is not campaign-level prior-express-consent record
 * keeping, which stays a Tier 3 declaration.
 */
export interface ConsentDeps {
  config: Config;
  consents: ConsentStore;
  ledger: LedgerStore;
  /** Undefined when the process holds no application private key; every route then answers 404. */
  verify: VerifyClient | undefined;
  mintToken: (() => string) | undefined;
  /** Keys the number hash in the ledger; the application private key on a real deployment. Undefined disables the gate. */
  hashKey: string | undefined;
  clock: () => number;
}

const NANP = /^1[2-9][0-9]{2}[2-9][0-9]{6}$/;
const COOLDOWN_MS = 10 * 60 * 1000;

/** Digits of a North American number as E.164 without the plus, or undefined. Ten digits get the country code. */
export function normalizeNumber(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const digits = raw.replace(/[^0-9]/g, "");
  const national = digits.length === 10 ? `1${digits}` : digits;
  return NANP.test(national) ? national : undefined;
}

export function maskNumber(n: string): string {
  return `+${n.slice(0, 1)} ${n.slice(1, 4)} *** ${n.slice(-4)}`;
}

/** Keyed, so the public ledger cannot be walked back to a number by hashing the eight billion NANP values. The key never leaves the host. */
export function numberHash(n: string, key: string): string {
  return `hmac-sha256:${createHmac("sha256", key).update(n).digest("hex")}`;
}

function startOfUtcDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function parseJson(body: unknown): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(typeof body === "string" && body.length > 0 ? body : "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function registerConsent(app: FastifyInstance, deps: ConsentDeps): void {
  const { config, consents, ledger, verify, mintToken, hashKey, clock } = deps;
  const notEnabled = (reply: FastifyReply) => reply.code(404).send({ error: "the consent gate is not enabled on this deployment: the process holds no application private key" });

  app.post<{ Body: string }>("/api/consent/start", async (req, reply) => {
    if (!verify || !hashKey) return notEnabled(reply);
    const body = parseJson(req.body);
    if (!body) return reply.code(400).send({ error: "body must be JSON" });
    const number = normalizeNumber(body["number"]);
    if (!number) return reply.code(400).send({ error: "number must be a North American phone number, for example +1 404 555 0100" });
    const nowMs = clock();
    const now = new Date(nowMs).toISOString();
    if ((await consents.countRequestedSince(startOfUtcDay(nowMs))) >= config.VERIFY_STARTS_PER_DAY) {
      return reply.code(429).send({ error: "the daily allowance of verification calls is used up; try again tomorrow" });
    }
    const latest = await consents.latestForNumber(number);
    if (latest && Date.parse(latest.requestedAt) > nowMs - COOLDOWN_MS) {
      if (latest.grantedAt && !latest.usedAt && latest.expiresAt && latest.expiresAt > now) {
        return reply.code(200).send({ request_id: latest.requestId, status: "granted", expires_at: latest.expiresAt, number: maskNumber(number) });
      }
      const retryAfter = Math.ceil((Date.parse(latest.requestedAt) + COOLDOWN_MS - nowMs) / 1000);
      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({ error: "that number was called for a code less than ten minutes ago; wait before asking again", retry_after_seconds: retryAfter });
    }
    const started = await verify.start(number);
    if (!started.ok) {
      req.log.warn({ status: started.status, error: started.error, number: maskNumber(number) }, "verification call could not be started");
      return reply.code(502).send({ error: "the verification call could not be started", detail: started.error });
    }
    await consents.create({ requestId: started.requestId, number, requestedAt: now, grantedAt: undefined, expiresAt: undefined, usedAt: undefined });
    req.log.info({ requestId: started.requestId, number: maskNumber(number) }, "consent verification started");
    return reply.code(202).send({ request_id: started.requestId, channel: "voice", number: maskNumber(number), next: "answer the call, then POST /api/consent/check with the code it speaks" });
  });

  app.post<{ Body: string }>("/api/consent/check", async (req, reply) => {
    if (!verify || !hashKey) return notEnabled(reply);
    const body = parseJson(req.body);
    if (!body) return reply.code(400).send({ error: "body must be JSON" });
    const requestId = typeof body["request_id"] === "string" ? body["request_id"].trim() : "";
    const code = typeof body["code"] === "string" || typeof body["code"] === "number" ? String(body["code"]).replace(/[^0-9]/g, "") : "";
    if (!requestId || code.length < 4 || code.length > 6) return reply.code(400).send({ error: "expected request_id and the 4 to 6 digit code the call spoke" });
    const consent = await consents.get(requestId);
    if (!consent) return reply.code(404).send({ error: "no verification with that request id" });
    if (consent.grantedAt) return reply.code(200).send({ granted: true, request_id: requestId, expires_at: consent.expiresAt, used: consent.usedAt !== undefined });
    const checked = await verify.check(requestId, code);
    if (!checked.ok) {
      req.log.info({ requestId, status: checked.status, error: checked.error }, "consent code rejected");
      return reply.code(checked.status === 0 ? 502 : 400).send({ granted: false, reason: checked.error });
    }
    const nowMs = clock();
    const grantedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + config.CONSENT_TTL_MINUTES * 60 * 1000).toISOString();
    const granted = await consents.grant(requestId, grantedAt, expiresAt);
    if (!granted) return reply.code(409).send({ granted: false, reason: "consent was already recorded for this request" });
    const entry = await ledger.append({
      ts: grantedAt,
      kind: "consent",
      call_uuid: null,
      decision: null,
      property: null,
      citation: null,
      witness: [],
      ncco_hash: null,
      line_type: null,
      detail: { request_id: requestId, number_hash: numberHash(consent.number, hashKey ?? ""), channel: "voice", expires_at: expiresAt, scope: "one demonstration call to the verified number" },
    });
    req.log.info({ requestId, number: maskNumber(consent.number), seq: entry.seq }, "consent granted");
    return reply.code(200).send({ granted: true, request_id: requestId, expires_at: expiresAt, ledger: { seq: entry.seq, entry_hash: entry.entry_hash } });
  });

  app.post<{ Body: string }>("/api/demo/call", async (req, reply) => {
    if (!mintToken) return notEnabled(reply);
    if (!config.VONAGE_FROM_NUMBER || !config.PUBLIC_BASE_URL) {
      return reply.code(404).send({ error: "the demonstration call needs VONAGE_FROM_NUMBER and PUBLIC_BASE_URL on this deployment" });
    }
    const body = parseJson(req.body);
    if (!body) return reply.code(400).send({ error: "body must be JSON" });
    const requestId = typeof body["request_id"] === "string" ? body["request_id"].trim() : "";
    if (!requestId) return reply.code(400).send({ error: "expected request_id of a checked consent" });
    const consent = await consents.get(requestId);
    if (!consent) return reply.code(404).send({ error: "no consent with that request id" });
    const nowMs = clock();
    const now = new Date(nowMs).toISOString();
    if ((await consents.countUsedSince(startOfUtcDay(nowMs))) >= config.DEMO_CALLS_PER_DAY) {
      return reply.code(429).send({ placed: false, reason: "the daily allowance of demonstration calls is used up; try again tomorrow" });
    }
    // Reserve the consent before anything reaches the platform, so two requests cannot both place a call.
    const reserved = await consents.use(requestId, now);
    if (!reserved) {
      const reason = !consent.grantedAt ? "the code has not been checked yet" : consent.usedAt ? "that consent was already used for a call" : "that consent has expired; ask for a new code";
      return reply.code(403).send({ placed: false, reason });
    }
    const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
    const request = {
      to: [{ type: "phone", number: reserved.number }],
      from: { type: "phone", number: config.VONAGE_FROM_NUMBER },
      answer_url: [`${base}/v/answer`],
      answer_method: "POST",
      event_url: [`${base}/v/event`],
      event_method: "POST",
    };
    const res = await app.inject({ method: "POST", url: "/v/calls", headers: { authorization: `Bearer ${mintToken()}`, "content-type": "application/json" }, payload: JSON.stringify(request) });
    const placed = res.statusCode === 201;
    if (!placed) await consents.release(requestId, now);
    let result: unknown;
    try {
      result = JSON.parse(res.body) as unknown;
    } catch {
      result = { raw: res.body.slice(0, 500) };
    }
    const decision = typeof res.headers["x-preflight-decision"] === "string" ? res.headers["x-preflight-decision"] : undefined;
    req.log.info({ requestId, decision, status: res.statusCode, placed, number: maskNumber(reserved.number) }, "demonstration call decided");
    if (decision) reply.header("x-preflight-decision", decision);
    return reply.code(res.statusCode).send({ consent: requestId, number: maskNumber(reserved.number), decision, placed, consent_remaining: !placed, result });
  });
}
