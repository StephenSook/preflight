import { describe, expect, it } from "vitest";
import { atomsOf, show } from "./ast.js";
import { LtlSyntaxError, parseLtl } from "./parse.js";

describe("LTL parser", () => {
  it("parses the five property formulas into negation normal form", () => {
    expect(show(parseLtl("G( speaks -> within_hours )"))).toBe("(false R (!speaks | within_hours))");
    expect(show(parseLtl("!( !identifies U (speaks & synthetic & !connects_human) )"))).toBe("(identifies R ((!speaks | !synthetic) | connects_human))");
    expect(show(parseLtl("G( (speaks & synthetic & !connects_human) -> F offers_optout )"))).toBe("(false R (((!speaks | !synthetic) | connects_human) | (true U offers_optout)))");
    expect(show(parseLtl("G( caller_id_present )"))).toBe("(false R caller_id_present)");
    expect(show(parseLtl("!( !identifies U speaks )"))).toBe("(identifies R !speaks)");
  });

  it("honours precedence: & binds tighter than |, -> is right-associative, U is left-associative", () => {
    expect(show(parseLtl("a | b & c"))).toBe("(a | (b & c))");
    expect(show(parseLtl("a -> b -> c"))).toBe("(!a | (!b | c))");
    expect(show(parseLtl("a U b U c"))).toBe("((a U b) U c)");
    expect(show(parseLtl("a <-> b"))).toBe("((!a | b) & (!b | a))");
    expect(show(parseLtl("a W b"))).toBe("(b R (a | b))");
    expect(show(parseLtl("X !a"))).toBe("X!a");
  });

  it("collects atoms in first-seen order and ignores keywords", () => {
    expect(atomsOf(parseLtl("G (speaks -> F offers_optout) & true"))).toEqual(["speaks", "offers_optout"]);
  });

  it("reports syntax errors with a position", () => {
    expect(() => parseLtl("G (a ->")).toThrow(LtlSyntaxError);
    expect(() => parseLtl("a b")).toThrow(/unexpected "b"/);
    expect(() => parseLtl("a ^ b")).toThrow(/unexpected character/);
  });
});
