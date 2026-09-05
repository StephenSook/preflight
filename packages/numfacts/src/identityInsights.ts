import type { LineClass } from "./nanpa.js";

/**
 * Vonage Identity Insights (the successor to Number Insight, which sunsets 2027-02-04): one paid
 * request answers with the number's format (including its IANA time zones), its current carrier and
 * its original carrier. Preflight uses two facts from it, never inside a decision: the time zones as a
 * second source for calling hours when the free prefix table cannot decide, and the carrier's network
 * type as a high-confidence line type over the free prior, which cannot see porting.
 */

export interface Insight {
  /** IANA zones the platform reports for the number; empty when it reported none. */
  timeZones: string[];
  /** Mapped from the current carrier's network type, else the original carrier's; "unknown" when neither is a line type. */
  lineType: LineClass | "unknown";
  /** Which carrier record the line type came from. */
  lineTypeFrom: "current_carrier" | "original_carrier" | "none";
  carrier: string | undefined;
  /** The platform's own validity flag for the number, when it reported one. */
  valid: boolean | undefined;
  requestId: string | undefined;
}

export type InsightResult = { ok: true; status: number; insight: Insight; latencyMs: number } | { ok: false; status: number; error: string; latencyMs: number };

const NETWORK_TYPE: Record<string, LineClass> = {
  MOBILE: "wireless",
  LANDLINE: "landline",
  VIRTUAL: "voip",
  LANDLINE_PREMIUM: "landline",
  LANDLINE_TOLLFREE: "landline",
};

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** True when the answer carries something a decision can use: at least one zone or a line type. */
export const insightIsUsable = (i: Insight): boolean => i.timeZones.length > 0 || i.lineType !== "unknown";
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Reads the facts Preflight uses off a response body. Tolerates both the flat and the nested carrier shapes. */
export function normalizeInsight(body: unknown): Insight {
  const root = asRecord(body) ?? {};
  const insights = asRecord(root["insights"]) ?? root;
  const format = asRecord(insights["format"]);
  const location = asRecord(format?.["location"]);
  const zonesRaw = format?.["time_zones"] ?? location?.["time_zones"];
  // Only IANA zones this runtime can evaluate are kept: a string the platform sends that Intl rejects
  // would otherwise be cached as a fact and throw inside the next decision.
  const timeZones = Array.isArray(zonesRaw) ? zonesRaw.filter((z): z is string => typeof z === "string" && z.length > 0 && isValidZone(z)) : [];
  const validRaw = format?.["is_valid"] ?? format?.["is_format_valid"];
  const valid = typeof validRaw === "boolean" ? validRaw : undefined;

  const carrierOf = (key: "current_carrier" | "original_carrier"): { type: LineClass | undefined; name: string | undefined } => {
    const c = asRecord(insights[key]);
    if (!c) return { type: undefined, name: undefined };
    const inner = asRecord(c["carrier"]);
    const networkType = str(c["network_type"]) ?? str(inner?.["network_type"]);
    const name = str(c["name"]) ?? str(inner?.["name"]);
    return { type: networkType ? NETWORK_TYPE[networkType.toUpperCase()] : undefined, name };
  };
  const current = carrierOf("current_carrier");
  const original = carrierOf("original_carrier");
  const picked = current.type ? { type: current.type, from: "current_carrier" as const, name: current.name } : original.type ? { type: original.type, from: "original_carrier" as const, name: original.name } : undefined;

  return {
    timeZones,
    lineType: picked?.type ?? "unknown",
    lineTypeFrom: picked?.from ?? "none",
    carrier: picked?.name ?? current.name ?? original.name,
    valid,
    requestId: str(root["request_id"]),
  };
}

export interface IdentityInsightsOptions {
  /** e.g. https://api-eu.vonage.com */
  host: string;
  fetchImpl: typeof fetch;
  /** An application JWT, minted per request by the caller. */
  token: () => string;
  timeoutMs?: number;
}

const USER_AGENT = "preflight/0.1 (+https://github.com/StephenSook/preflight)";

/** One lookup. Never called from a decision; the caller runs it after the response and caches the result. */
export async function lookupIdentityInsights(number: string, opts: IdentityInsightsOptions): Promise<InsightResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await opts.fetchImpl(`${opts.host.replace(/\/$/, "")}/identity-insights/v1/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token()}`, "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ phone_number: number.startsWith("+") ? number : `+${number.replace(/\D/g, "")}`, insights: { format: {}, current_carrier: {}, original_carrier: {} } }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const b = asRecord(body);
      const detail = [str(b?.["title"]), str(b?.["detail"])].filter(Boolean).join(": ");
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}`, latencyMs };
    }
    return { ok: true, status: res.status, insight: normalizeInsight(body), latencyMs };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
