import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nationalDigits, NumberFactsResolver } from "./index.js";
import { CoCodeTable } from "./nanpa.js";
import { localMinutes, TimezoneMap, withinCallingHours } from "./timezone.js";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
const resolver = NumberFactsResolver.load(dataDir);

describe("the committed number-facts tables", () => {
  it("carry a sources manifest with hashes, the NANPA file date and the counts the tables were derived from", () => {
    const s = resolver.sources;
    expect(s.nanpa.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.timezoneMap.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.nanpa.fileUpdated).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(s.timezoneMap.license).toContain("Apache-2.0");
    expect(resolver.coCodes.size).toBe(s.nanpa.rows);
    expect(resolver.coCodes.size).toBeGreaterThan(150000);
  });

  it("refuse a table whose header changed", () => {
    expect(() => CoCodeTable.parse("npanxx\tstate\n404200\tGA\n")).toThrow(/header/);
    expect(() => TimezoneMap.parse("1404 America/New_York\n")).toThrow(/bad timezone map line/);
  });

  it("resolve real Atlanta prefixes to Georgia rate centers with a low-confidence line class", () => {
    const at = new Date("2026-09-04T16:00:00Z"); // 12:00 EDT
    expect(resolver.resolve("+1 404 201 0000", at)).toMatchObject({ nationalNumber: "4042010000", state: "GA", rateCenter: "ATLANTA", ocn: "6214", lineType: "wireless", lineTypeSource: "nanpa", lineTypeConfidence: "low", zones: ["America/New_York"], withinHours: true });
    expect(resolver.resolve("14042000000", at)).toMatchObject({ state: "GA", rateCenter: "ATLANTA", lineType: "landline" });
    expect(resolver.resolve("4702000000", at)).toMatchObject({ state: "GA", rateCenter: "CONYERS", lineType: "voip" });
  });

  it("still resolve a timezone for a prefix NANPA has not assigned, and say the line type is unknown", () => {
    // 404 is exhausted (every exchange assigned, even 404-555), so look for a gap in the 943 overlay.
    let nxx = 200;
    while (nxx < 1000 && resolver.coCodes.lookup(`943${nxx}`)) nxx += 1;
    expect(nxx).toBeLessThan(1000);
    const f = resolver.resolve(`1943${nxx}0100`, new Date("2026-09-04T16:00:00Z"));
    expect(f).toMatchObject({ lineType: "unknown", lineTypeSource: "none", lineTypeConfidence: "none", zones: ["America/New_York"], withinHours: true });
  });

  it("use the longest matching prefix in a split area code", () => {
    expect(resolver.resolve("12082010000", new Date("2026-09-04T16:00:00Z")).zones).toEqual(["America/Denver"]);
  });

  it("refuse a non-NANP or malformed number without guessing", () => {
    const f = resolver.resolve("+44 20 7946 0000", new Date());
    expect(f.unsupported).toMatch(/NANP/);
    expect(f.withinHours).toBeNull();
    expect(nationalDigits("555-0100")).toBeUndefined();
    expect(nationalDigits("1-404-555-0100")).toBe("4045550100");
    expect(nationalDigits("0404555010")).toBeUndefined();
  });
});

describe("calling hours, 47 CFR 64.1200(c)(1)", () => {
  const NY = ["America/New_York"];
  it("open at exactly 8:00 local, closed at exactly 21:00 local", () => {
    expect(withinCallingHours(NY, new Date("2026-09-04T12:00:00Z"))).toBe(true); // 08:00 EDT
    expect(withinCallingHours(NY, new Date("2026-09-04T11:59:00Z"))).toBe(false); // 07:59 EDT
    expect(withinCallingHours(NY, new Date("2026-09-05T00:59:00Z"))).toBe(true); // 20:59 EDT
    expect(withinCallingHours(NY, new Date("2026-09-05T01:00:00Z"))).toBe(false); // 21:00 EDT
  });

  it("follows the zone's own daylight rules", () => {
    expect(localMinutes("America/New_York", new Date("2026-01-15T13:00:00Z"))).toBe(8 * 60); // EST
    expect(localMinutes("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe(8 * 60); // EDT
    expect(localMinutes("America/Phoenix", new Date("2026-07-15T15:00:00Z"))).toBe(8 * 60); // no DST
  });

  it("is three-valued over a prefix that spans zones", () => {
    const split = ["America/New_York", "America/Chicago"];
    expect(withinCallingHours(split, new Date("2026-09-04T12:30:00Z"))).toBeNull(); // 08:30 vs 07:30
    expect(withinCallingHours(split, new Date("2026-09-04T15:00:00Z"))).toBe(true); // 11:00 vs 10:00
    expect(withinCallingHours(split, new Date("2026-09-04T09:00:00Z"))).toBe(false); // 05:00 vs 04:00
    expect(withinCallingHours([], new Date())).toBeNull();
  });

  it("uses the same tables the manifest describes", () => {
    const raw = readFileSync(path.join(dataDir, "tz-map.txt"), "utf8");
    expect(raw.split("\n").filter((l) => /^1\d*\|/.test(l)).length).toBe(resolver.sources.timezoneMap.nanpEntries);
  });
});
