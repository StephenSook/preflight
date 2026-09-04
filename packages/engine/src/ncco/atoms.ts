import { LIVE_ENDPOINT_TYPES, type NccoAction } from "./types.js";

/**
 * The atom vocabulary the properties are written over (spec section 08). Five atoms are read off
 * each action; four are facts about the call as a whole and hold constant along a path.
 *
 * Two action atoms depend on what the developer DECLARED about their flow, because they cannot be
 * read from bytes alone: which spoken beat identifies the caller, and which input collects a
 * do-not-call request. Preflight matches the declaration structurally (a phrase is present, an
 * event URL matches). It never judges whether the words are truthful; that limit is stated in the
 * interface (spec section 05, Tier 3).
 */
export const ACTION_ATOMS = ["speaks", "synthetic", "identifies", "offers_optout", "connects_human"] as const;
export const CALL_ATOMS = ["dest_wireless", "dest_residential", "within_hours", "caller_id_present"] as const;
export type ActionAtom = (typeof ACTION_ATOMS)[number];
export type CallAtom = (typeof CALL_ATOMS)[number];
export type Atom = ActionAtom | CallAtom;

export type ActionAtoms = Record<ActionAtom, boolean>;
/** null means the fact is not known yet (line type unresolved, timezone unresolved). */
export type CallAtoms = Record<CallAtom, boolean | null>;

export interface FlowDeclaration {
  identification?: {
    /** Phrases the identification beat speaks, matched case- and punctuation-insensitively. */
    phrases?: string[];
    /** Prerecorded identification audio, matched by exact stream URL. */
    streamUrls?: string[];
  };
  optOut?: {
    /** An input whose eventUrl contains one of these (substring, or exact URL path) offers opt-out. */
    eventUrlPatterns?: string[];
  };
  /** Callback paths the developer says their flow has (e.g. "/webhooks/question"); the coverage denominator. */
  endpoints?: string[];
}

export interface CallFacts {
  from: string | undefined;
  lineType: "wireless" | "landline" | "voip" | "unknown";
  /** Computed by the number-facts layer from the rate-center timezone; null when unresolved. */
  withinHours: boolean | null;
}

/** Lowercase, punctuation removed, whitespace collapsed, so "Kennesaw State!" matches "kennesaw state". */
export function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** A pattern matches an event URL that contains it; a path such as "/webhooks/optout" is a substring of its own URL. */
function matchesOptOut(eventUrls: readonly string[] | undefined, patterns: readonly string[] | undefined): boolean {
  if (!eventUrls || !patterns) return false;
  const pats = patterns.map((p) => p.trim()).filter((p) => p.length > 0);
  if (pats.length === 0) return false;
  return eventUrls.some((u) => pats.some((p) => u.includes(p)));
}

/** The texts a pay action speaks: each prompt's text, and the texts of its error prompts. */
function payTexts(prompts: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const p of prompts ?? []) {
    if (typeof p !== "object" || p === null) continue;
    const prompt = p as { text?: unknown; errors?: unknown };
    if (typeof prompt.text === "string" && prompt.text.trim().length > 0) out.push(prompt.text);
    if (typeof prompt.errors === "object" && prompt.errors !== null) {
      for (const e of Object.values(prompt.errors as Record<string, unknown>)) {
        if (typeof e === "object" && e !== null && typeof (e as { text?: unknown }).text === "string") out.push((e as { text: string }).text);
      }
    }
  }
  return out;
}

/** A valid, non-suppressed caller id: 7 to 15 digits after an optional leading plus. */
export function callerIdPresent(from: unknown): boolean {
  if (typeof from !== "string") return false;
  const trimmed = from.trim();
  if (/^(anonymous|restricted|private|unknown|unavailable)$/i.test(trimmed)) return false;
  return /^\+?[0-9]{7,15}$/.test(trimmed);
}

export function actionAtoms(action: NccoAction, declaration: FlowDeclaration = {}): ActionAtoms {
  const atoms: ActionAtoms = { speaks: false, synthetic: false, identifies: false, offers_optout: false, connects_human: false };
  switch (action.action) {
    case "talk": {
      atoms.speaks = true;
      atoms.synthetic = true;
      const text = normalizePhrase(action.text);
      const phrases = (declaration.identification?.phrases ?? []).map(normalizePhrase).filter((p) => p.length > 0);
      atoms.identifies = phrases.some((p) => text.includes(p));
      break;
    }
    case "stream": {
      atoms.speaks = true;
      atoms.synthetic = true;
      const urls = declaration.identification?.streamUrls ?? [];
      atoms.identifies = action.streamUrl.some((u) => urls.includes(u));
      break;
    }
    case "input":
      atoms.offers_optout = matchesOptOut(action.eventUrl, declaration.optOut?.eventUrlPatterns);
      break;
    case "connect":
      atoms.connects_human = action.endpoint.some((e) => LIVE_ENDPOINT_TYPES.includes(e.type));
      break;
    case "pay": {
      // The platform reads the prompts aloud with text-to-speech: synthetic speech, like a talk.
      const texts = payTexts(action.prompts).map(normalizePhrase);
      if (texts.length > 0) {
        atoms.speaks = true;
        atoms.synthetic = true;
        const phrases = (declaration.identification?.phrases ?? []).map(normalizePhrase).filter((p) => p.length > 0);
        atoms.identifies = phrases.some((p) => texts.some((t) => t.includes(p)));
      }
      break;
    }
    default:
      break;
  }
  return atoms;
}

export function callAtoms(facts: CallFacts): CallAtoms {
  return {
    dest_wireless: facts.lineType === "unknown" ? null : facts.lineType === "wireless",
    // A landline; the free prior cannot tell residential from business, and the interface says so.
    dest_residential: facts.lineType === "unknown" ? null : facts.lineType === "landline",
    within_hours: facts.withinHours,
    caller_id_present: callerIdPresent(facts.from),
  };
}
