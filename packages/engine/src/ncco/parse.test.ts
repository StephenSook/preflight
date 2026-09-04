import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { actionAtoms, callAtoms, callerIdPresent, normalizePhrase, type ActionAtoms, type FlowDeclaration } from "./atoms.js";
import { parseNcco } from "./parse.js";

const corpusDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../corpus/ncco");

interface CorpusFile {
  name: string;
  declaration?: FlowDeclaration;
  ncco: unknown;
  expect: { kinds: string[]; atoms: ActionAtoms[]; errors: number };
}

const files = readdirSync(corpusDir).filter((f) => f.endsWith(".json")).sort();

describe("NCCO parser and atoms against the labelled corpus", () => {
  it("has at least ten labelled objects", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    const c = JSON.parse(readFileSync(path.join(corpusDir, file), "utf8")) as CorpusFile;
    it(`${file}: ${c.name}`, () => {
      const result = parseNcco(c.ncco);
      expect(result.actions.map((a) => a.action)).toEqual(c.expect.kinds);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(c.expect.errors);
      expect(result.ok).toBe(c.expect.errors === 0);
      expect(result.actions.map((a) => actionAtoms(a, c.declaration))).toEqual(c.expect.atoms);
      for (const [i, a] of result.actions.entries()) expect(a.index).toBe(i);
      // The parser accepts the raw bytes a server returns, not only decoded JSON.
      const fromBytes = parseNcco(JSON.stringify(c.ncco));
      expect(fromBytes.actions).toEqual(result.actions);
    });
  }
});

describe("parser edge cases", () => {
  it("reports a body that is not JSON without throwing", () => {
    const r = parseNcco("[{");
    expect(r.ok).toBe(false);
    expect(r.actions).toHaveLength(0);
    expect(r.issues[0]?.message).toMatch(/not JSON/);
  });

  it("warns on an empty NCCO and on fields outside the reference, without failing", () => {
    const r = parseNcco([]);
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.severity)).toEqual(["warning"]);
    const s = parseNcco([{ action: "talk", text: "hi", voiceName: "Amy" }]);
    expect(s.ok).toBe(true);
    expect(s.issues).toEqual([{ path: "[0].voiceName", severity: "warning", message: expect.stringContaining("not in the NCCO reference") }]);
  });

  it("keeps a malformed action in position as unknown with its raw bytes", () => {
    const r = parseNcco([{ action: "talk" }, { action: "talk", text: "second" }]);
    expect(r.actions[0]).toMatchObject({ action: "unknown", index: 0, declaredAction: "talk", raw: { action: "talk" } });
    expect(r.actions[1]).toMatchObject({ action: "talk", index: 1 });
    expect(r.issues).toEqual([{ path: "[0].text", severity: "error", message: "talk requires text" }]);
  });

  it("drops an endpoint it cannot type but keeps the connect when another endpoint is valid", () => {
    const r = parseNcco([{ action: "connect", endpoint: [{ type: "fax", number: "1" }, { type: "sip", user: "a", domain: "example.com" }] }]);
    expect(r.actions[0]).toMatchObject({ action: "connect", endpoint: [{ type: "sip", user: "a", domain: "example.com" }] });
    expect(r.issues).toEqual([{ path: "[0].endpoint[0].type", severity: "error", message: 'unknown endpoint type "fax"' }]);
  });
});

describe("atom helpers", () => {
  it("normalises phrases so punctuation and case never decide identification", () => {
    expect(normalizePhrase("  This is  KENNESAW State!  ")).toBe("this is kennesaw state");
  });

  it("matches an opt-out input by URL path as well as by substring", () => {
    const decl: FlowDeclaration = { optOut: { eventUrlPatterns: ["/dnc"] } };
    const byPath = parseNcco([{ action: "input", type: ["dtmf"], eventUrl: ["https://o.example/dnc"] }]).actions[0];
    const other = parseNcco([{ action: "input", type: ["dtmf"], eventUrl: ["https://o.example/menu"] }]).actions[0];
    expect(byPath && actionAtoms(byPath, decl).offers_optout).toBe(true);
    expect(other && actionAtoms(other, decl).offers_optout).toBe(false);
  });

  it("treats suppressed and malformed caller ids as absent", () => {
    expect(callerIdPresent("14045550100")).toBe(true);
    expect(callerIdPresent("+14045550100")).toBe(true);
    for (const bad of ["anonymous", "Restricted", "", "555-0100", "12345", undefined, 14045550100]) expect(callerIdPresent(bad)).toBe(false);
  });

  it("leaves unresolved call facts as null rather than guessing", () => {
    expect(callAtoms({ from: "14045550100", lineType: "unknown", withinHours: null })).toEqual({ dest_wireless: null, dest_residential: null, within_hours: null, caller_id_present: true });
    expect(callAtoms({ from: undefined, lineType: "wireless", withinHours: true })).toEqual({ dest_wireless: true, dest_residential: false, within_hours: true, caller_id_present: false });
  });
});
