import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.js";
import { GENESIS_HASH, hashBody, makeEntry, verifyChain, type LedgerBody, type LedgerEntry } from "./chain.js";

const body = (seq: number, prev: string, overrides: Partial<LedgerBody> = {}): LedgerBody => ({
  seq,
  ts: `2026-09-06T21:14:0${seq}.000Z`,
  kind: "block",
  call_uuid: `call-${seq}`,
  decision: "block",
  property: "P3",
  citation: "47 CFR 64.1200(b)(3)",
  witness: ["talk#0", "input#1", "talk#0'", "hangup#1'"],
  ncco_hash: "sha256:" + "7f".repeat(32),
  line_type: { value: "wireless", source: "nanpa", conf: "low" },
  detail: null,
  prev_hash: prev,
  ...overrides,
});

function chain(n: number): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const e = makeEntry(body(i, prev));
    out.push(e);
    prev = e.entry_hash;
  }
  return out;
}

describe("canonical JSON", () => {
  it("sorts keys, drops undefined, keeps arrays ordered, and refuses non-integer numbers", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: undefined, d: { z: "1", y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"d":{"y":2,"z":"1"}}');
    expect(canonicalize("quote\"and\\slash")).toBe('"quote\\"and\\\\slash"');
    expect(() => canonicalize({ latency: 7.5 })).toThrow(/safe integers/);
    expect(() => canonicalize({ big: 2 ** 53 })).toThrow(/safe integers/);
  });

  it("is independent of key insertion order, so two writers hash alike", () => {
    const a = hashBody(body(1, GENESIS_HASH));
    const reordered = Object.fromEntries(Object.entries(body(1, GENESIS_HASH)).reverse()) as unknown as LedgerBody;
    expect(hashBody(reordered)).toBe(a);
  });
});

describe("the hash chain", () => {
  it("verifies an intact chain and reports its head", () => {
    const c = chain(5);
    const r = verifyChain(c);
    expect(r).toEqual({ ok: true, entries: 5, head: c[4]?.entry_hash });
    expect(verifyChain([])).toEqual({ ok: true, entries: 0, head: GENESIS_HASH });
  });

  it("detects a rewritten historical entry at that entry", () => {
    const c = chain(5);
    const tampered = c.map((e, i) => (i === 2 ? { ...e, witness: ["talk#0"] } : e));
    expect(verifyChain(tampered)).toMatchObject({ ok: false, brokenAt: { seq: 3, problem: expect.stringContaining("entry_hash") } });
  });

  it("detects a rewritten entry whose hash was recomputed, because the next link no longer matches", () => {
    const c = chain(5);
    const { entry_hash: _old, ...b } = c[2] as LedgerEntry;
    void _old;
    const recomputed = makeEntry({ ...b, witness: ["talk#0"] });
    const tampered = c.map((e, i) => (i === 2 ? recomputed : e));
    expect(verifyChain(tampered)).toMatchObject({ ok: false, brokenAt: { seq: 4, problem: expect.stringContaining("prev_hash") } });
  });

  it("detects a deleted entry as a sequence gap", () => {
    const c = chain(5);
    expect(verifyChain(c.filter((e) => e.seq !== 2))).toMatchObject({ ok: false, brokenAt: { seq: 3, problem: expect.stringContaining("sequence gap") } });
  });

  it("detects a truncated chain only relative to a known head, never by itself", () => {
    // Truncation is what the transparency-log seal exists to catch: a shorter chain verifies.
    const c = chain(5);
    expect(verifyChain(c.slice(0, 3)).ok).toBe(true);
    expect(verifyChain(c.slice(0, 3)).head).not.toBe(c[4]?.entry_hash);
  });
});
