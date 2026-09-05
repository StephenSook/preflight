import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { SoftphoneStore } from "../store/softphoneStore.js";
import { mintApplicationJwt } from "../vonage/mintApplicationJwt.js";

/**
 * The browser softphone (plan addition A2): a judge with no phone at hand places the demonstration
 * call from the page as a Client SDK user and hears the interlock intervene; the scheduler answers
 * the fixed flow's live leg in the browser. Both need a user token minted here from the
 * application's private key: the application token plus a subject and an ACL, with a short life.
 *
 * Judges are public and capped per day; the scheduler is the dashboard's. The user is created
 * through the Users API the first time (an existing user is fine). The application must carry the
 * RTC capability (scripts/vonage/enable-rtc.mjs); without it the platform refuses the session.
 */
export interface SoftphoneDeps {
  config: Config;
  fetchImpl: typeof fetch;
  clock: () => number;
  /** Absent when the application private key is not configured: the route then answers 404. */
  applicationPrivateKeyPem: string | undefined;
  dashboardAuth: (authorization: string | undefined) => boolean;
  store: SoftphoneStore;
}

/** The ACL Vonage's own backend guide gives a Client SDK voice user. */
export const CLIENT_ACL = {
  paths: {
    "/*/users/**": {},
    "/*/conversations/**": {},
    "/*/sessions/**": {},
    "/*/devices/**": {},
    "/*/image/**": {},
    "/*/media/**": {},
    "/*/push/**": {},
    "/*/knocking/**": {},
    "/*/legs/**": {},
  },
};

export type EnsureUser = { ok: true; created: boolean } | { ok: false; status: number; error: string };

/** Creates the user through the Users API; an existing user (409) is treated as present. */
export async function ensureUser(name: string, displayName: string, appToken: string, fetchImpl: typeof fetch, host = "https://api.nexmo.com"): Promise<EnsureUser> {
  const res = await fetchImpl(`${host.replace(/\/$/, "")}/v1/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name, display_name: displayName }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 201 || res.status === 200) return { ok: true, created: true };
  if (res.status === 409) return { ok: true, created: false };
  const text = await res.text();
  return { ok: false, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
}

export function registerSoftphone(app: FastifyInstance, deps: SoftphoneDeps): void {
  const { config, fetchImpl, clock, applicationPrivateKeyPem, dashboardAuth, store } = deps;
  const applicationId = config.VONAGE_APPLICATION_ID;

  // The platform posts RTC events here once the capability is on; the softphone needs none of them
  // and nothing is stored, so nothing can be injected.
  app.route({ method: ["GET", "POST"], url: "/v/rtc", handler: async (_req, reply) => reply.code(204).send() });

  app.post<{ Body: string }>("/api/softphone/token", async (req, reply) => {
    if (!applicationPrivateKeyPem || !applicationId) return reply.code(404).send({ error: "the softphone is not enabled on this deployment (application private key absent)" });
    let body: { role?: unknown };
    try {
      body = JSON.parse(typeof req.body === "string" && req.body.length > 0 ? req.body : "{}") as { role?: unknown };
    } catch {
      return reply.code(400).send({ error: "body must be JSON" });
    }
    const role = body.role === "scheduler" ? "scheduler" : body.role === "judge" || body.role === undefined ? "judge" : undefined;
    if (!role) return reply.code(400).send({ error: 'expected {"role": "judge" | "scheduler"}' });
    if (role === "scheduler" && !dashboardAuth(req.headers.authorization)) return reply.code(config.DASHBOARD_TOKEN ? 403 : 404).send({ error: config.DASHBOARD_TOKEN ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });

    const now = clock();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const user = role === "scheduler" ? config.REFERENCE_AGENT : `judge-${randomBytes(4).toString("hex")}`;
    const appToken = mintApplicationJwt(applicationId, applicationPrivateKeyPem, now, 300);
    const ensured = await ensureUser(user, role === "scheduler" ? "Scheduler" : "Judge", appToken, fetchImpl, config.VONAGE_API_HOST);
    if (!ensured.ok) return reply.code(502).send({ error: `the platform refused to create the user: ${ensured.error}`, platform_status: ensured.status });

    // The day's allowance is taken as the token is recorded, in one step under the store's lock, so no two
    // requests (in this process or another sharing the database) can both issue the last token; a platform
    // refusal above spends nothing.
    const recorded = await store.tryRecord(role, user, new Date(now).toISOString(), role === "judge" ? { since: dayStart.toISOString(), max: config.SOFTPHONE_TOKENS_PER_DAY } : undefined);
    if (!recorded) return reply.code(429).send({ error: "no more softphone sessions today; dial the public number instead" });
    const ttl = config.SOFTPHONE_TOKEN_TTL_MINUTES * 60;
    const token = mintApplicationJwt(applicationId, applicationPrivateKeyPem, now, ttl, { sub: user, acl: CLIENT_ACL });
    req.log.info({ role, user, created: ensured.created, ttl }, "softphone token minted");
    return reply.code(201).send({ role, user, token, expires_at: new Date(now + ttl * 1000).toISOString(), application_id: applicationId, created: ensured.created });
  });
}
