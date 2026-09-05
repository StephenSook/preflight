/**
 * Tier 2: rate properties computed from event telemetry (spec section 07). These never block a
 * call. They raise a campaign-level figure from what the event webhook reports (answer status,
 * machine detection, timestamps) over a window, with the denominator the rule names.
 *
 * THE DENOMINATOR IS THE POINT. The abandonment rate is abandoned calls divided by calls answered by
 * a person. Not total dials. Not machine-answered calls. A call without machine detection on it is
 * counted as answered by a person, and the basis says so, because the platform cannot tell and the
 * rule's safe harbour is measured against people, so the conservative reading is the honest one.
 */

export type RateVerdict = "true" | "false" | "inconclusive";

export interface CallTelemetry {
  uuid: string;
  direction: "inbound" | "outbound" | "unknown";
  /** ISO times from the platform's own event timestamps. */
  ringingAt?: string | undefined;
  answeredAt?: string | undefined;
  endedAt?: string | undefined;
  /** The last status the platform reported: completed, unanswered, timeout, busy, cancelled, rejected, failed. */
  outcome: string | undefined;
  /** What machine detection said, when it ran. */
  detected?: "human" | "machine" | undefined;
  /** Talk time in seconds as the platform reported it on the completed event. */
  durationSeconds?: number | undefined;
  /** True when the path the call actually ran reached a connect to a live endpoint (a person). */
  connectedHuman: boolean;
}

export interface RateProperty {
  id: "P6" | "P7" | "P8";
  title: string;
  citation: string;
  verdict: RateVerdict;
  /** The figure the rule is about, as a fraction 0..1, when it exists. */
  figure: number | null;
  /** How many calls the figure stands on. */
  n: number;
  /** One sentence a person can read: what was counted, over what, against which threshold. */
  basis: string;
}

export interface CampaignRates {
  calls: number;
  outbound: number;
  answered: number;
  answeredByPerson: number;
  machineAnswered: number;
  abandoned: number;
  unanswered: number;
  unansweredWithRingTime: number;
  shortRings: number;
  medianAnsweredDurationSeconds: number | null;
  properties: RateProperty[];
}

export const RATE_PROPERTIES: ReadonlyArray<{ id: RateProperty["id"]; title: string; summary: string; citation: string }> = [
  {
    id: "P6",
    title: "Abandonment rate",
    summary: "A call is abandoned when a person answers and is not connected to a representative within two seconds of the completed greeting; the safe harbour allows abandonment of at most three percent of calls answered by a person, measured per campaign over thirty days.",
    citation: "16 CFR 310.4(b)(1)(iv); 16 CFR 310.4(b)(4)(i)",
  },
  {
    id: "P7",
    title: "Ring duration",
    summary: "An unanswered call must ring for at least fifteen seconds or four rings before it is disconnected.",
    citation: "16 CFR 310.4(b)(4)(ii)",
  },
  {
    id: "P8",
    title: "Platform acceptable use",
    summary: "A high volume of unanswered calls, or calls generally shorter than twelve seconds, breaks the platform's acceptable use policy independently of any statute.",
    citation: "Vonage Acceptable Use Policy, Telecommunications-Specific Limitations (updated 2025-02-03)",
  },
];

export const ABANDONMENT_SAFE_HARBOUR = 0.03;
export const MIN_RING_SECONDS = 15;
export const SHORT_CALL_SECONDS = 12;

const seconds = (a: string | undefined, b: string | undefined): number | null => {
  if (!a || !b) return null;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? (y - x) / 1000 : null;
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

const UNANSWERED = new Set(["unanswered", "timeout", "cancelled", "busy", "rejected", "failed"]);

/** Every rate property over one window of calls. Pure; the caller assembles the telemetry from the event store. */
export function campaignRates(calls: readonly CallTelemetry[]): CampaignRates {
  const outbound = calls.filter((c) => c.direction === "outbound");
  const answered = outbound.filter((c) => c.answeredAt !== undefined);
  const machineAnswered = answered.filter((c) => c.detected === "machine");
  const byPerson = answered.filter((c) => c.detected !== "machine");
  const abandoned = byPerson.filter((c) => !c.connectedHuman);
  const unanswered = outbound.filter((c) => c.answeredAt === undefined && (c.outcome === undefined || UNANSWERED.has(c.outcome)) && c.ringingAt !== undefined);
  const ringTimes = unanswered.map((c) => ({ c, s: seconds(c.ringingAt, c.endedAt) })).filter((x): x is { c: CallTelemetry; s: number } => x.s !== null);
  const shortRings = ringTimes.filter((x) => x.s < MIN_RING_SECONDS);
  const durations = answered.map((c) => c.durationSeconds).filter((d): d is number => typeof d === "number" && Number.isFinite(d));
  const medianDuration = median(durations);
  const unansweredShare = outbound.length > 0 ? outbound.filter((c) => c.answeredAt === undefined).length / outbound.length : null;
  const undetected = byPerson.length - byPerson.filter((c) => c.detected === "human").length;

  const p6: RateProperty = byPerson.length === 0
    ? { id: "P6", title: "Abandonment rate", citation: RATE_PROPERTIES[0]!.citation, verdict: "inconclusive", figure: null, n: 0, basis: "no outbound call in the window was answered by a person, so there is no denominator" }
    : {
        id: "P6",
        title: "Abandonment rate",
        citation: RATE_PROPERTIES[0]!.citation,
        verdict: abandoned.length / byPerson.length > ABANDONMENT_SAFE_HARBOUR ? "false" : "true",
        figure: abandoned.length / byPerson.length,
        n: byPerson.length,
        basis: `${abandoned.length} of ${byPerson.length} calls answered by a person ran no connect to a live endpoint (${pct(abandoned.length / byPerson.length)} against the 3% safe harbour); ${machineAnswered.length} machine-answered call(s) excluded from the denominator${undetected > 0 ? `; ${undetected} answered call(s) had no machine detection and count as a person` : ""}`,
      };

  const p7: RateProperty = ringTimes.length === 0
    ? { id: "P7", title: "Ring duration", citation: RATE_PROPERTIES[1]!.citation, verdict: "inconclusive", figure: null, n: 0, basis: "no unanswered outbound call with a ringing and an end time in the window" }
    : {
        id: "P7",
        title: "Ring duration",
        citation: RATE_PROPERTIES[1]!.citation,
        verdict: shortRings.length > 0 ? "false" : "true",
        figure: shortRings.length / ringTimes.length,
        n: ringTimes.length,
        basis: `${shortRings.length} of ${ringTimes.length} unanswered calls were disconnected before ${MIN_RING_SECONDS} seconds of ringing${shortRings.length > 0 ? ` (shortest ${Math.min(...shortRings.map((x) => x.s)).toFixed(1)} s)` : ""}`,
      };

  const p8: RateProperty = answered.length === 0 && outbound.length === 0
    ? { id: "P8", title: "Platform acceptable use", citation: RATE_PROPERTIES[2]!.citation, verdict: "inconclusive", figure: null, n: 0, basis: "no outbound call in the window" }
    : {
        id: "P8",
        title: "Platform acceptable use",
        citation: RATE_PROPERTIES[2]!.citation,
        verdict: medianDuration !== null && medianDuration < SHORT_CALL_SECONDS ? "false" : "true",
        figure: unansweredShare,
        n: outbound.length,
        basis: `${outbound.filter((c) => c.answeredAt === undefined).length} of ${outbound.length} outbound calls went unanswered (${unansweredShare === null ? "n/a" : pct(unansweredShare)}); median talk time ${medianDuration === null ? "unknown" : `${medianDuration.toFixed(1)} s`} against the ${SHORT_CALL_SECONDS}-second line; the policy states no number for "high volume", so the unanswered share is reported and not judged`,
      };

  return {
    calls: calls.length,
    outbound: outbound.length,
    answered: answered.length,
    answeredByPerson: byPerson.length,
    machineAnswered: machineAnswered.length,
    abandoned: abandoned.length,
    unanswered: outbound.filter((c) => c.answeredAt === undefined).length,
    unansweredWithRingTime: ringTimes.length,
    shortRings: shortRings.length,
    medianAnsweredDurationSeconds: medianDuration,
    properties: [p6, p7, p8],
  };
}

/** A Vonage event webhook, as the platform posts it, reduced to what the rates need. */
export interface EventLike {
  callUuid: string | undefined;
  payload: Record<string, unknown> | undefined;
  receivedAt: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * Folds the platform's event webhooks for a window into per-call telemetry. `connectedHuman` is
 * supplied by the caller from the path the call actually ran, because the events do not say who was
 * on the other leg. Events are taken in the order received; the platform's own timestamp wins when present.
 */
export function telemetryFromEvents(events: readonly EventLike[], connectedHuman: (uuid: string) => boolean): CallTelemetry[] {
  const byCall = new Map<string, CallTelemetry>();
  for (const e of events) {
    const uuid = e.callUuid ?? str(e.payload?.["uuid"]);
    if (!uuid) continue;
    const p = e.payload ?? {};
    const status = str(p["status"])?.toLowerCase();
    const at = str(p["timestamp"]) ?? e.receivedAt;
    const rawDirection = str(p["direction"]);
    const t = byCall.get(uuid) ?? { uuid, direction: rawDirection === "inbound" || rawDirection === "outbound" ? rawDirection : "unknown", outcome: undefined, connectedHuman: connectedHuman(uuid) };
    if (t.direction === "unknown" && (rawDirection === "inbound" || rawDirection === "outbound")) t.direction = rawDirection;
    if (status === "ringing" && t.ringingAt === undefined) t.ringingAt = at;
    if (status === "answered" && t.answeredAt === undefined) t.answeredAt = at;
    if (status === "human" || status === "machine") t.detected = status;
    if (status === "completed" || (status !== undefined && UNANSWERED.has(status))) {
      t.endedAt = str(p["end_time"]) ?? at;
      t.outcome = status;
      const d = num(p["duration"]);
      if (d !== undefined) t.durationSeconds = d;
    }
    byCall.set(uuid, t);
  }
  return [...byCall.values()];
}
