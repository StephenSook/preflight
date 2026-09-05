/**
 * Tier 2: rate properties computed from event telemetry (spec section 07). These never block a
 * call. They raise a campaign-level figure from what the event webhook reports (answer status,
 * machine detection, timestamps) over a window, with the denominator the rule names.
 *
 * THE DENOMINATOR IS THE POINT. The abandonment rate is abandoned calls divided by calls answered by
 * a person. Not total dials. Not machine-answered calls. A call without machine detection on it is
 * counted as answered by a person, and the basis says so, because the platform cannot tell and the
 * rule's safe harbour is measured against people, so the conservative reading is the honest one.
 *
 * Only calls that have ended are counted: a call still in progress has not abandoned anyone yet and
 * has not been rung out. "Connected to a representative" is evidence, not a plan: the call's
 * executed path must reach a connect AND another leg of the same conversation must have been
 * answered. A connect that is on the path but never produced an answered leg counts as abandoned,
 * which errs toward flagging ourselves, the conservative side for a compliance tool.
 */

export type RateVerdict = "true" | "false" | "inconclusive";

export interface CallTelemetry {
  uuid: string;
  conversationUuid: string | undefined;
  direction: "inbound" | "outbound" | "unknown";
  /** ISO times from the platform's own event timestamps: the earliest ringing, the earliest answer, the latest end. */
  ringingAt?: string | undefined;
  answeredAt?: string | undefined;
  endedAt?: string | undefined;
  /** The terminal status the platform reported: completed, unanswered, timeout, busy, cancelled, rejected, failed; undefined while in progress. */
  outcome: string | undefined;
  /** What machine detection said, when it ran. */
  detected?: "human" | "machine" | undefined;
  /** Talk time in seconds as the platform reported it on the completed event. */
  durationSeconds?: number | undefined;
  /** True when the path the call actually ran reached a connect to a live endpoint. A plan, not proof. */
  pathHasConnect: boolean;
  /** True when another leg of the same conversation was answered: the proof that a person was connected. */
  otherLegAnswered: boolean;
  /** True when this leg is the target of another leg's connect (a representative's leg), so it is not a dial to a consumer. */
  connectLeg: boolean;
}

export interface RateProperty {
  id: "P6" | "P7" | "P8";
  title: string;
  citation: string;
  verdict: RateVerdict;
  /** The quantity the verdict is about, in `unit`, when it exists. */
  figure: number | null;
  unit: "fraction" | "seconds";
  /** How many calls the figure stands on. */
  n: number;
  /** One sentence a person can read: what was counted, over what, against which threshold. */
  basis: string;
}

export interface CampaignRates {
  calls: number;
  /** Outbound calls that have ended; the only ones any property counts. */
  outbound: number;
  inProgress: number;
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

/** Every status that ends a call. */
const TERMINAL = new Set(["completed", "unanswered", "timeout", "cancelled", "busy", "rejected", "failed"]);
/** The unanswered outcomes where the dialer, not the network or the callee, ended the ringing: the ring-duration rule's cases. */
const RUNG_OUT = new Set(["unanswered", "timeout", "cancelled"]);

/** Every rate property over one window of calls. Pure; the caller assembles the telemetry from the event store. */
export function campaignRates(calls: readonly CallTelemetry[]): CampaignRates {
  // Dials are outbound legs that are not the far end of a connect; only ended ones are counted.
  const dials = calls.filter((c) => c.direction === "outbound" && !c.connectLeg);
  const ended = dials.filter((c) => c.outcome !== undefined && TERMINAL.has(c.outcome));
  const inProgress = dials.length - ended.length;
  const answered = ended.filter((c) => c.answeredAt !== undefined);
  const machineAnswered = answered.filter((c) => c.detected === "machine");
  const byPerson = answered.filter((c) => c.detected !== "machine");
  const abandoned = byPerson.filter((c) => !(c.pathHasConnect && c.otherLegAnswered));
  const unansweredAll = ended.filter((c) => c.answeredAt === undefined);
  const rungOut = unansweredAll.filter((c) => c.outcome !== undefined && RUNG_OUT.has(c.outcome) && c.ringingAt !== undefined);
  const ringTimes = rungOut.map((c) => ({ c, s: seconds(c.ringingAt, c.endedAt) })).filter((x): x is { c: CallTelemetry; s: number } => x.s !== null && x.s > 0);
  const shortRings = ringTimes.filter((x) => x.s < MIN_RING_SECONDS);
  const durations = answered.map((c) => c.durationSeconds).filter((d): d is number => typeof d === "number" && Number.isFinite(d));
  const medianDuration = median(durations);
  const unansweredShare = ended.length > 0 ? unansweredAll.length / ended.length : null;
  const undetected = byPerson.length - byPerson.filter((c) => c.detected === "human").length;
  const plannedOnly = byPerson.filter((c) => c.pathHasConnect && !c.otherLegAnswered).length;

  const p6: RateProperty = byPerson.length === 0
    ? { id: "P6", title: "Abandonment rate", citation: RATE_PROPERTIES[0]!.citation, verdict: "inconclusive", figure: null, unit: "fraction", n: 0, basis: "no ended outbound call in the window was answered by a person, so there is no denominator" }
    : {
        id: "P6",
        title: "Abandonment rate",
        citation: RATE_PROPERTIES[0]!.citation,
        verdict: abandoned.length / byPerson.length > ABANDONMENT_SAFE_HARBOUR ? "false" : "true",
        figure: abandoned.length / byPerson.length,
        unit: "fraction",
        n: byPerson.length,
        basis: `${abandoned.length} of ${byPerson.length} ended calls answered by a person were never connected to a representative (${pct(abandoned.length / byPerson.length)} against the 3% safe harbour); a connect counts only when another leg of the same conversation was answered${plannedOnly > 0 ? ` (${plannedOnly} had a connect on the path and no answered leg)` : ""}; ${machineAnswered.length} machine-answered call(s) excluded from the denominator${undetected > 0 ? `; ${undetected} answered call(s) had no machine detection and count as a person` : ""}; the two-second greeting window is not observable from events`,
      };

  const p7: RateProperty = ringTimes.length === 0
    ? { id: "P7", title: "Ring duration", citation: RATE_PROPERTIES[1]!.citation, verdict: "inconclusive", figure: null, unit: "fraction", n: 0, basis: "no rung-out outbound call (timeout, unanswered or cancelled) with a ringing time before its end in the window; busy, rejected and failed legs are the network's, not a disconnected ring" }
    : {
        id: "P7",
        title: "Ring duration",
        citation: RATE_PROPERTIES[1]!.citation,
        verdict: shortRings.length > 0 ? "false" : "true",
        figure: shortRings.length / ringTimes.length,
        unit: "fraction",
        n: ringTimes.length,
        basis: `${shortRings.length} of ${ringTimes.length} rung-out calls were disconnected before ${MIN_RING_SECONDS} seconds of ringing${shortRings.length > 0 ? ` (shortest ${Math.min(...shortRings.map((x) => x.s)).toFixed(1)} s)` : ""}; busy, rejected and failed legs are not counted`,
      };

  const p8: RateProperty = medianDuration === null
    ? { id: "P8", title: "Platform acceptable use", citation: RATE_PROPERTIES[2]!.citation, verdict: "inconclusive", figure: null, unit: "seconds", n: ended.length, basis: ended.length === 0 ? "no ended outbound call in the window" : `${unansweredAll.length} of ${ended.length} ended outbound calls went unanswered (${unansweredShare === null ? "n/a" : pct(unansweredShare)}); no answered call carried a talk time, so the twelve-second line cannot be judged; the policy states no number for "high volume", so the unanswered share is reported and not judged` }
    : {
        id: "P8",
        title: "Platform acceptable use",
        citation: RATE_PROPERTIES[2]!.citation,
        verdict: medianDuration < SHORT_CALL_SECONDS ? "false" : "true",
        figure: medianDuration,
        unit: "seconds",
        n: durations.length,
        basis: `median talk time ${medianDuration.toFixed(1)} s over ${durations.length} answered call(s) against the ${SHORT_CALL_SECONDS}-second line; ${unansweredAll.length} of ${ended.length} ended outbound calls went unanswered (${unansweredShare === null ? "n/a" : pct(unansweredShare)}), reported and not judged because the policy states no number for "high volume"`,
      };

  return {
    calls: calls.length,
    outbound: ended.length,
    inProgress,
    answered: answered.length,
    answeredByPerson: byPerson.length,
    machineAnswered: machineAnswered.length,
    abandoned: abandoned.length,
    unanswered: unansweredAll.length,
    unansweredWithRingTime: ringTimes.length,
    shortRings: shortRings.length,
    medianAnsweredDurationSeconds: medianDuration,
    properties: [p6, p7, p8],
  };
}

/** A Vonage event webhook, as the platform posts it, reduced to what the rates need. */
export interface EventLike {
  callUuid: string | undefined;
  conversationUuid?: string | undefined;
  payload: Record<string, unknown> | undefined;
  receivedAt: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** 0 none, 1 the closing "completed", 2 a specific terminal (timeout, unanswered, cancelled, busy, rejected, failed). */
const terminalRank = (s: string | undefined): number => (s === undefined ? 0 : s === "completed" ? 1 : 2);
const earliest = (a: string | undefined, b: string): string => (a === undefined || Date.parse(b) < Date.parse(a) ? b : a);

/**
 * Folds the platform's event webhooks for a window into per-call telemetry. Order of receipt does
 * not matter: the earliest ringing, the earliest answer and the latest terminal event win, by the
 * platform's own timestamp when present and the receipt time otherwise. `pathHasConnect` is
 * supplied by the caller from the path the call actually ran; `otherLegAnswered` is computed here
 * from the other legs of the same conversation.
 */
export function telemetryFromEvents(events: readonly EventLike[], pathHasConnect: (uuid: string) => boolean): CallTelemetry[] {
  const byCall = new Map<string, CallTelemetry>();
  for (const e of events) {
    const uuid = e.callUuid ?? str(e.payload?.["uuid"]);
    if (!uuid) continue;
    const p = e.payload ?? {};
    const status = str(p["status"])?.toLowerCase();
    const stamped = str(p["timestamp"]);
    const at = stamped !== undefined && Number.isFinite(Date.parse(stamped)) ? stamped : e.receivedAt;
    const rawDirection = str(p["direction"]);
    const t = byCall.get(uuid) ?? { uuid, conversationUuid: e.conversationUuid ?? str(p["conversation_uuid"]), direction: rawDirection === "inbound" || rawDirection === "outbound" ? rawDirection : "unknown", outcome: undefined, pathHasConnect: pathHasConnect(uuid), otherLegAnswered: false, connectLeg: false };
    if (t.direction === "unknown" && (rawDirection === "inbound" || rawDirection === "outbound")) t.direction = rawDirection;
    if (t.conversationUuid === undefined) t.conversationUuid = e.conversationUuid ?? str(p["conversation_uuid"]);
    if (status === "ringing") t.ringingAt = earliest(t.ringingAt, at);
    if (status === "answered") t.answeredAt = earliest(t.answeredAt, at);
    if (status === "human" || status === "machine") t.detected = status;
    if (status !== undefined && TERMINAL.has(status)) {
      const end = str(p["end_time"]) ?? at;
      // The platform closes every call with "completed", after a timeout or a busy as well; a specific terminal
      // outranks it whatever the order of receipt, and among equals the later end wins.
      const later = t.endedAt === undefined || Date.parse(end) >= Date.parse(t.endedAt);
      if (terminalRank(status) > terminalRank(t.outcome) || (terminalRank(status) === terminalRank(t.outcome) && later)) {
        t.endedAt = end;
        t.outcome = status;
      }
      const d = num(p["duration"]);
      if (d !== undefined) t.durationSeconds = d;
    }
    byCall.set(uuid, t);
  }
  // A person was connected when another leg of the same conversation was answered.
  const answeredByConversation = new Map<string, Set<string>>();
  for (const t of byCall.values()) {
    if (t.conversationUuid && t.answeredAt !== undefined) {
      const set = answeredByConversation.get(t.conversationUuid) ?? new Set<string>();
      set.add(t.uuid);
      answeredByConversation.set(t.conversationUuid, set);
    }
  }
  const connectingByConversation = new Map<string, number>();
  for (const t of byCall.values()) if (t.conversationUuid && t.pathHasConnect) connectingByConversation.set(t.conversationUuid, (connectingByConversation.get(t.conversationUuid) ?? 0) + 1);
  for (const t of byCall.values()) {
    const others = t.conversationUuid ? answeredByConversation.get(t.conversationUuid) : undefined;
    t.otherLegAnswered = others !== undefined && [...others].some((u) => u !== t.uuid);
    // The far end of a connect shares the conversation with the leg whose path connects; it is not a dial.
    t.connectLeg = !t.pathHasConnect && t.conversationUuid !== undefined && (connectingByConversation.get(t.conversationUuid) ?? 0) > 0;
  }
  return [...byCall.values()];
}
