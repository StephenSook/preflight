import type { FastifyInstance } from "fastify";
import type { PushStore, PushSubscriptionRecord } from "../store/pushStore.js";
import type { PushNotifier } from "./notify.js";

export interface PushRouteDeps {
  store: PushStore;
  /** Absent when the VAPID keys are not configured: the routes then answer 404 so nothing pretends. */
  notifier: PushNotifier | undefined;
  dashboardAuth: (authorization: string | undefined) => boolean;
  dashboardEnabled: boolean;
  clock: () => number;
  /** How many subscriptions the table keeps; a broadcast walks every one. */
  maxSubscriptions: number;
}

function subscriptionOf(v: unknown): PushSubscriptionRecord | undefined {
  const r = typeof v === "object" && v !== null ? (v as { endpoint?: unknown; keys?: unknown; expirationTime?: unknown }) : undefined;
  const keys = typeof r?.keys === "object" && r.keys !== null ? (r.keys as { p256dh?: unknown; auth?: unknown }) : undefined;
  if (!r || typeof r.endpoint !== "string" || !/^https:\/\/\S+$/.test(r.endpoint) || typeof keys?.p256dh !== "string" || typeof keys.auth !== "string" || keys.p256dh.length === 0 || keys.auth.length === 0) return undefined;
  return { endpoint: r.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, expirationTime: typeof r.expirationTime === "number" ? r.expirationTime : null };
}

/**
 * Subscribing needs the dashboard token, because a subscription receives held numbers (masked) and
 * the row links; the VAPID public key is public by definition. A test push proves the pipe end to
 * end on a real phone before any hold depends on it.
 */
export function registerPush(app: FastifyInstance, deps: PushRouteDeps): void {
  const { store, notifier, dashboardAuth, dashboardEnabled, clock } = deps;
  const off = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(404).send({ error: "web push is not configured on this deployment (VAPID keys absent)" });
  const forbidden = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(dashboardEnabled ? 403 : 404).send({ error: dashboardEnabled ? "dashboard token rejected" : "the dashboard is not enabled on this deployment" });
  const parse = (raw: unknown): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(typeof raw === "string" ? raw : "{}") as unknown;
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  app.get("/api/push/vapid", async (_req, reply) => {
    if (!notifier) return off(reply);
    return { publicKey: notifier.publicKey };
  });

  app.post<{ Body: string }>("/api/push/subscribe", async (req, reply) => {
    if (!notifier) return off(reply);
    if (!dashboardAuth(req.headers.authorization)) return forbidden(reply);
    const body = parse(req.body);
    const sub = subscriptionOf(body?.["subscription"] ?? body);
    if (!sub) return reply.code(400).send({ error: "expected a PushSubscription: {endpoint: https URL, keys: {p256dh, auth}}" });
    const label = typeof body?.["label"] === "string" ? body["label"].slice(0, 80) : undefined;
    // A bounded table: a held queue has a handful of phones, and a broadcast walks every row.
    const existing = await store.list();
    if (!existing.some((s) => s.endpoint === sub.endpoint) && existing.length >= deps.maxSubscriptions) return reply.code(409).send({ error: `at most ${deps.maxSubscriptions} subscriptions are kept; remove one first` });
    await store.upsert(sub, label, new Date(clock()).toISOString());
    req.log.info({ endpoint: sub.endpoint.slice(0, 40), label }, "push subscription stored");
    return reply.code(201).send({ subscribed: true, endpoint: sub.endpoint, subscriptions: (await store.list()).length });
  });

  app.delete<{ Body: string }>("/api/push/subscribe", async (req, reply) => {
    if (!notifier) return off(reply);
    if (!dashboardAuth(req.headers.authorization)) return forbidden(reply);
    const body = parse(req.body);
    const endpoint = typeof body?.["endpoint"] === "string" ? body["endpoint"] : "";
    if (endpoint.length === 0) return reply.code(400).send({ error: "expected {endpoint}" });
    return { removed: await store.remove(endpoint) };
  });

  app.post("/api/push/test", async (req, reply) => {
    if (!notifier) return off(reply);
    if (!dashboardAuth(req.headers.authorization)) return forbidden(reply);
    const report = await notifier.broadcast({ title: "Preflight test", body: "A test push from the interlock. Holds will arrive like this.", url: "", tag: `test-${clock()}`, kind: "test" });
    return report;
  });
}
