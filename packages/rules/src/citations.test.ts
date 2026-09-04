import { PROPERTIES } from "@preflight/engine";
import { describe, expect, it } from "vitest";
import { citationParts, citationsFor, loadRules, sha256Hex } from "./index.js";

const rules = loadRules();

describe("the committed statute texts", () => {
  it("match the manifest hash by hash, so a text cannot change without the manifest changing", () => {
    for (const [name, meta] of Object.entries(rules.sources.files)) {
      expect(sha256Hex(rules.texts[name] ?? "")).toBe(meta.sha256);
      expect(meta.url).toMatch(/^https:\/\//);
      expect(meta.vintage.length).toBeGreaterThan(8);
    }
    expect(rules.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loadRules().digest).toBe(rules.digest);
  });

  it("carry the three clauses the federal properties rest on, at the pinned eCFR vintage", () => {
    const cfr = rules.texts["47-cfr-64.1200.txt"] ?? "";
    expect(cfr).toContain("before the hour of 8 a.m. or after 9 p.m. (local time at the called party's location)");
    expect(cfr).toContain("state clearly the identity of the business, individual, or other entity that is responsible for initiating the call");
    expect(cfr).toContain("provide an automated, interactive voice- and/or key press-activated opt-out mechanism");
    expect(rules.sources.files["47-cfr-64.1200.txt"]?.vintage).toContain("2026-09-02");
  });

  it("carry the post-SB 73 Georgia text: no knowing requirement, vicarious liability, the two figures", () => {
    const ga = rules.texts["ocga-46-5-27.txt"] ?? "";
    expect(ga).toContain("Ga. L. 2024, p. 912, § 2/SB 73, effective July 1, 2024");
    expect(ga).toContain("on behalf of any person or entity any telephone solicitation");
    expect(ga).toContain("civil penalty up to a maximum of $2,000.00 for each violation");
    expect(ga).toContain("up to $1,000.00 in damages for each such violation");
    expect(ga).toContain("for which the damages limitation in subparagraph (A) of this paragraph shall not apply");
    expect(ga).not.toMatch(/\$2,000\.00 for each knowing violation/);
  });
});

describe("citation enforcement (HR163: a quoted clause is either used by a live code path or excused in writing)", () => {
  it("every quote is a byte-for-byte substring of its source text", () => {
    for (const c of rules.citations) {
      const text = rules.texts[c.source];
      expect(text, `${c.id}: unknown source ${c.source}`).toBeDefined();
      expect(text?.includes(c.quote), `${c.id}: quote is not a substring of ${c.source}`).toBe(true);
      expect(c.quote.length).toBeGreaterThan(40);
    }
  });

  it("every citation a property carries resolves to a quoted clause that names that property", () => {
    for (const p of PROPERTIES) {
      const parts = citationParts(p.citation);
      expect(parts.length).toBeGreaterThan(0);
      for (const clause of citationsFor(rules, p.citation)) expect(clause.usedBy, `${clause.id} does not list ${p.id}`).toContain(p.id);
    }
  });

  it("every quoted clause is used by a property or excused with a reason, never merely decorative", () => {
    const propertyIds = new Set(PROPERTIES.map((p) => p.id));
    for (const c of rules.citations) {
      const byProperty = c.usedBy.filter((u) => propertyIds.has(u as never));
      const byDoc = c.usedBy.filter((u) => !propertyIds.has(u as never));
      if (byProperty.length === 0) {
        expect(byDoc.length, `${c.id} is used by nothing`).toBeGreaterThan(0);
        expect(c.reason, `${c.id} needs a written reason`).toBeTruthy();
      }
      for (const id of byProperty) expect(citationParts(PROPERTIES.find((p) => p.id === id)?.citation ?? "")).toContain(c.citation);
    }
    expect(new Set(rules.citations.map((c) => c.id)).size).toBe(rules.citations.length);
  });

  it("names the Georgia subsections correctly: identification is (g)(1) and caller id is (g)(2), not (b) and (c)", () => {
    const p5 = PROPERTIES.find((p) => p.id === "P5");
    const p4 = PROPERTIES.find((p) => p.id === "P4");
    expect(p5?.citation).toContain("46-5-27(g)(1)");
    expect(p4?.citation).toContain("46-5-27(g)(2)");
    expect(citationsFor(rules, p5?.citation ?? "").map((c) => c.quote).join(" ")).toContain("state clearly the identity of the person or entity initiating the call");
    expect(citationsFor(rules, p4?.citation ?? "").map((c) => c.quote).join(" ")).toContain("caller identification service");
  });
});
