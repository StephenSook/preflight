import type { FastifyBaseLogger } from "fastify";
import webpush from "web-push";
import type { Hold } from "../store/holdStore.js";
import type { PushStore, PushSubscriptionRecord } from "../store/pushStore.js";

/**
 * Web Push for the held queue (plan addition A7). A hold under strict policy waits for a person, and
 * the person is not at the dashboard; their phone is. Every subscription gets the hold as a
 * notification carrying the reason and the row's link. A push service that answers 404 or 410 has
 * retired that subscription, and so does the store. Sending is fire-and-forget: a decision never
 * waits on a push.
 */
export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export type PushSender = (subscription: PushSubscriptionRecord, payload: string, vapid: VapidDetails) => Promise<{ statusCode: number }>;

export const webPushSender: PushSender = async (subscription, payload, vapid) => {
  // A push service that does not answer in ten seconds has failed this send; a broadcast never hangs on one endpoint.
  const r = await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, timeout: 10000 });
  return { statusCode: r.statusCode };
};

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap opens: the held row on the dashboard. */
  url: string;
  tag: string;
  kind: "hold" | "test";
}

export interface NotifierOptions {
  store: PushStore;
  vapid: VapidDetails;
  /** Base URL of the web app the notification opens; the API host when the web app is not deployed. */
  dashboardBaseUrl: string;
  send?: PushSender | undefined;
  now: () => number;
  log?: FastifyBaseLogger | undefined;
}

export interface SendReport {
  attempted: number;
  delivered: number;
  retired: number;
  failed: number;
}

const maskNumber = (n: string | undefined): string => (n ? n.replace(/\d(?=\d{4})/g, "x") : "unknown number");

export class PushNotifier {
  private readonly send: PushSender;
  constructor(private readonly opts: NotifierOptions) {
    this.send = opts.send ?? webPushSender;
  }

  get publicKey(): string {
    return this.opts.vapid.publicKey;
  }

  /** The payload a hold produces; the number is masked, the row carries the digits behind the token. */
  holdPayload(hold: Hold): PushPayload {
    const first = hold.verdicts.find((v) => v.verdict === "inconclusive");
    return {
      title: `Held: ${maskNumber(hold.humanParty)}`,
      body: first ? `${first.id} inconclusive: ${first.reason ?? hold.reason}` : hold.reason,
      url: `${this.opts.dashboardBaseUrl.replace(/\/$/, "")}/held/${encodeURIComponent(hold.holdId)}`,
      tag: `hold-${hold.holdId}`,
      kind: "hold",
    };
  }

  /** Fire-and-forget from the gateway: never awaited on the decision path. */
  holdCreated(hold: Hold): void {
    void this.broadcast(this.holdPayload(hold)).catch((err: unknown) => this.opts.log?.error({ err: err instanceof Error ? err.message : String(err) }, "push broadcast failed"));
  }

  /** Sends one payload to every subscription; retires the ones the push service no longer serves. */
  async broadcast(payload: PushPayload): Promise<SendReport> {
    const subs = await this.opts.store.list();
    const report: SendReport = { attempted: subs.length, delivered: 0, retired: 0, failed: 0 };
    const body = JSON.stringify(payload);
    for (const s of subs) {
      const at = new Date(this.opts.now()).toISOString();
      try {
        const r = await this.send(s.subscription, body, this.opts.vapid);
        await this.opts.store.markSent(s.endpoint, at, undefined);
        report.delivered += 1;
        this.opts.log?.info({ endpoint: s.endpoint.slice(0, 40), statusCode: r.statusCode, kind: payload.kind }, "push sent");
      } catch (err) {
        const status = (err as { statusCode?: unknown }).statusCode;
        const message = err instanceof Error ? err.message : String(err);
        if (status === 404 || status === 410) {
          await this.opts.store.remove(s.endpoint);
          report.retired += 1;
          this.opts.log?.info({ endpoint: s.endpoint.slice(0, 40), statusCode: status }, "push subscription retired by the push service");
        } else {
          await this.opts.store.markSent(s.endpoint, at, typeof status === "number" ? `${status}: ${message}` : message);
          report.failed += 1;
          this.opts.log?.warn({ endpoint: s.endpoint.slice(0, 40), statusCode: status, err: message }, "push failed");
        }
      }
    }
    return report;
  }
}
