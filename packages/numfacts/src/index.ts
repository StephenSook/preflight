import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoCodeTable, type CoCodeRow, type LineClass } from "./nanpa.js";
import { TimezoneMap, withinCallingHours } from "./timezone.js";

export { CoCodeTable };
export type { CoCodeRow, LineClass };
export { TimezoneMap, withinCallingHours, localMinutes, CALLING_WINDOW } from "./timezone.js";

export interface Sources {
  fetchedAt: string;
  nanpa: { url: string; fileUpdated: string; sha256: string; rows: number };
  timezoneMap: { url: string; license: string; sha256: string; nanpEntries: number };
}

export interface NumberFacts {
  /** Ten national digits, or undefined when the input was not a NANP number. */
  nationalNumber: string | undefined;
  /** Why the number could not be resolved at all, when it could not. */
  unsupported?: string;
  state: string | undefined;
  rateCenter: string | undefined;
  ocn: string | undefined;
  lineType: LineClass | "unknown";
  lineTypeSource: "nanpa" | "none";
  /** The free prior is always low confidence: it cannot see porting. */
  lineTypeConfidence: "low" | "none";
  zones: string[];
  withinHours: boolean | null;
  /** Human-readable basis for withinHours, shown next to the verdict. */
  hoursBasis: string;
}

/** Digits only; accepts +1NPANXXXXXX, 1NPANXXXXXX and NPANXXXXXX. Returns the ten national digits or undefined. */
export function nationalDigits(input: string): string | undefined {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10 && /^[2-9]\d\d[2-9]\d{6}$/.test(digits)) return digits;
  return undefined;
}

export class NumberFactsResolver {
  constructor(readonly coCodes: CoCodeTable, readonly timezones: TimezoneMap, readonly sources: Sources) {}

  /** Loads the committed tables from the package's data directory (or another directory). */
  static load(dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data")): NumberFactsResolver {
    const coCodes = CoCodeTable.parse(readFileSync(path.join(dataDir, "co-codes.tsv"), "utf8"));
    const timezones = TimezoneMap.parse(readFileSync(path.join(dataDir, "tz-map.txt"), "utf8"));
    const sources = JSON.parse(readFileSync(path.join(dataDir, "SOURCES.json"), "utf8")) as Sources;
    return new NumberFactsResolver(coCodes, timezones, sources);
  }

  resolve(to: string, at: Date): NumberFacts {
    const national = nationalDigits(to);
    if (!national) {
      return { nationalNumber: undefined, unsupported: "not a North American number; number facts cover NANP destinations only", state: undefined, rateCenter: undefined, ocn: undefined, lineType: "unknown", lineTypeSource: "none", lineTypeConfidence: "none", zones: [], withinHours: null, hoursBasis: "no timezone: not a NANP number" };
    }
    const row = this.coCodes.lookup(national);
    const zones = this.timezones.zonesFor(`1${national}`);
    const withinHours = withinCallingHours(zones, at);
    const hoursBasis =
      zones.length === 0 ? "no timezone known for this prefix"
      : zones.length === 1 ? `${zones[0]} by prefix ${national.slice(0, 3)}`
      : withinHours === null ? `prefix spans ${zones.join(", ")} and they disagree at this instant`
      : `prefix spans ${zones.join(", ")}, all agree at this instant`;
    return {
      nationalNumber: national,
      state: row?.state || undefined,
      rateCenter: row?.rateCenter || undefined,
      ocn: row?.ocn || undefined,
      lineType: row?.lineClass ?? "unknown",
      lineTypeSource: row ? "nanpa" : "none",
      lineTypeConfidence: row ? "low" : "none",
      zones,
      withinHours,
      hoursBasis,
    };
  }
}
