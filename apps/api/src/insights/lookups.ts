import { lookupIdentityInsights, nationalDigits, type Insight } from "@preflight/numfacts";
import type { FastifyBaseLogger } from "fastify";
import type { InsightRecord, InsightStore } from "../store/insightStore.js";

/**
 * The paid lookup, kept out of every decision. A hold the free tables could not resolve enqueues the
 * number; the lookup runs after the response is sent, its answer is cached by line, and the next
 * decision for that line reads the cache through the resolver. Bounded by a daily allowance (the
 * store's own count, so a restart does not reset it), one in flight per line, and no retry of a
 * failure inside the cool-down.
 */
export interface LookupOptions {
  store: InsightStore;
  host: string;
  fetchImpl: typeof fetch;
  token: () => string;
  perDay: number;
  now: () => number;
  log?: FastifyBaseLogger | undefined;
  /** Hours before a failed lookup may be tried again. */
  retryAfterHours?: number;
}

export interface LookupStatus {
  state: "pending" | "ok" | "error" | "none";
  record?: InsightRecord | undefined;
}

export const lineOf = (number: string | undefined): string | undefined => {
  const national = nationalDigits(number ?? "");
  return national;
};

export class InsightLookups {
  private readonly inflight = new Set<string>();
  private readonly retryMs: number;
  constructor(private readonly opts: LookupOptions) {
    this.retryMs = (opts.retryAfterHours ?? 6) * 3600_000;
  }

  /** The cached answer for a line, or nothing; what the resolver reads before deciding. */
  async cached(number: string | undefined): Promise<Insight | undefined> {
    const line = lineOf(number);
    if (!line) return undefined;
    const rec = await this.opts.store.get(line);
    return rec?.status === "ok" ? rec.insight : undefined;
  }

  async status(number: string | undefined): Promise<LookupStatus> {
    const line = lineOf(number);
    if (!line) return { state: "none" };
    if (this.inflight.has(line)) return { state: "pending" };
    const rec = await this.opts.store.get(line);
    if (!rec) return { state: "none" };
    return { state: rec.status, record: rec };
  }

  /**
   * Schedules a lookup for the number after the current turn of the event loop. Returns what it
   * decided to do, for the log and for tests; never throws and never awaits the platform.
   */
  async enqueue(number: string | undefined): Promise<"scheduled" | "cached" | "inflight" | "cooling" | "allowance" | "unsupported"> {
    const line = lineOf(number);
    if (!line) return "unsupported";
    if (this.inflight.has(line)) return "inflight";
    const existing = await this.opts.store.get(line);
    if (existing?.status === "ok") return "cached";
    if (existing?.status === "error" && this.opts.now() - Date.parse(existing.lookedUpAt) < this.retryMs) return "cooling";
    const dayStart = new Date(this.opts.now());
    dayStart.setUTCHours(0, 0, 0, 0);
    if ((await this.opts.store.countSince(dayStart.toISOString())) >= this.opts.perDay) {
      this.opts.log?.warn({ line: `...${line.slice(-4)}`, perDay: this.opts.perDay }, "identity insights allowance for today is spent; the hold stays");
      return "allowance";
    }
    this.inflight.add(line);
    setImmediate(() => {
      void this.run(line);
    });
    return "scheduled";
  }

  private async run(line: string): Promise<void> {
    try {
      const r = await lookupIdentityInsights(`1${line}`, { host: this.opts.host, fetchImpl: this.opts.fetchImpl, token: this.opts.token });
      const lookedUpAt = new Date(this.opts.now()).toISOString();
      const rec: InsightRecord = r.ok
        ? { line, status: "ok", insight: r.insight, error: undefined, httpStatus: r.status, latencyMs: r.latencyMs, lookedUpAt }
        : { line, status: "error", insight: undefined, error: r.error, httpStatus: r.status, latencyMs: r.latencyMs, lookedUpAt };
      await this.opts.store.put(rec);
      this.opts.log?.info({ line: `...${line.slice(-4)}`, status: rec.status, httpStatus: rec.httpStatus, latencyMs: rec.latencyMs, zones: rec.insight?.timeZones, lineType: rec.insight?.lineType }, "identity insights lookup recorded");
    } catch (err) {
      this.opts.log?.error({ err: err instanceof Error ? err.message : String(err) }, "identity insights lookup could not be recorded");
    } finally {
      this.inflight.delete(line);
    }
  }

  /** Resolves once nothing is in flight; tests use it, the server never waits on it. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await new Promise((r) => setTimeout(r, 5));
  }
}
