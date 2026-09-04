/**
 * Prefix to timezone, from libphonenumber's map_data.txt (Apache-2.0, The Libphonenumber Authors),
 * committed as packages/numfacts/data/tz-map.txt. Lines are `<country code + prefix>|<zone>[&<zone>...]`;
 * the longest matching prefix wins, and a line with several zones means the prefix genuinely spans
 * them, which the calling-hours check treats as three-valued rather than picking one.
 */
export class TimezoneMap {
  private constructor(private readonly byPrefix: Map<string, string[]>, private readonly longest: number) {}

  static parse(text: string): TimezoneMap {
    const byPrefix = new Map<string, string[]>();
    let longest = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const bar = line.indexOf("|");
      if (bar <= 0) throw new Error(`bad timezone map line: ${line}`);
      const prefix = line.slice(0, bar);
      const zones = line.slice(bar + 1).split("&").map((z) => z.trim()).filter((z) => z.length > 0);
      if (!/^\d+$/.test(prefix) || zones.length === 0) throw new Error(`bad timezone map line: ${line}`);
      byPrefix.set(prefix, zones);
      longest = Math.max(longest, prefix.length);
    }
    return new TimezoneMap(byPrefix, longest);
  }

  /** Candidate zones for an E.164 number given as digits with the country code, e.g. "14045550100". */
  zonesFor(e164Digits: string): string[] {
    for (let len = Math.min(this.longest, e164Digits.length); len >= 1; len--) {
      const zones = this.byPrefix.get(e164Digits.slice(0, len));
      if (zones) return zones;
    }
    return [];
  }
}

/** Minutes past local midnight in `zone` at instant `at`. */
export function localMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) throw new Error(`could not read local time in zone ${zone}`);
  return hour * 60 + minute;
}

/** 47 CFR 64.1200(c)(1): no telephone solicitation before 8am or after 9pm local time at the called party's location. */
export const CALLING_WINDOW = { openMinutes: 8 * 60, closeMinutes: 21 * 60 } as const;

/**
 * True or false when every candidate zone agrees; null when the zones disagree or none is known,
 * because a monitor that cannot decide does not guess (spec section 08).
 */
export function withinCallingHours(zones: readonly string[], at: Date): boolean | null {
  if (zones.length === 0) return null;
  const answers = new Set(zones.map((z) => {
    const m = localMinutes(z, at);
    return m >= CALLING_WINDOW.openMinutes && m < CALLING_WINDOW.closeMinutes;
  }));
  return answers.size === 1 ? [...answers][0] ?? null : null;
}
