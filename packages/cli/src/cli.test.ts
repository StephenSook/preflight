import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENESIS_HASH, makeEntry, type LedgerBody, type LedgerEntry } from "@preflight/ledger";
import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { checkObject, loadLedger, renderVerdicts, replayCorpus, verifyLedgerSource } from "./index.js";

const corpusDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../corpus/ncco");
const decl = { identification: { phrases: ["This is a message from Preflight Demo Clinic"] }, optOut: { eventUrlPatterns: ["/webhooks/optout"] } };

function chain(n: number): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const body: LedgerBody = { seq, ts: `2026-09-06T21:14:0${seq}.000Z`, kind: "block", call_uuid: `c${seq}`, decision: "block", property: "P3", citation: "47 CFR 64.1200(b)(3)", witness: ["talk#0"], ncco_hash: "sha256:" + "0".repeat(64), line_type: null, detail: null, prev_hash: prev };
    const e = makeEntry(body);
    out.push(e);
    prev = e.entry_hash;
  }
  return out;
}

describe("preflight check", () => {
  it.each([
    [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }], timeout: "bad" }],
    [{ action: "connect", endpoint: [{ type: "fax" }, { type: "phone", number: "14045550123" }] }],
    [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }], eventType: "synchronous", eventUrl: ["https://origin.example/fallback"] }],
    [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }, null],
  ].map((object) => ({ object })))("never clears malformed or unsupported objects under either policy: $object", ({ object }) => {
    for (const policy of ["strict", "advisory"] as const) {
      const result = checkObject(object, { facts: { from: "14045550100", lineType: "wireless", withinHours: true }, policy });
      expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
      expect(result.decision).not.toBe("pass");
    }
  });
  it("blocks a synthetic object with no opt-out and prints the witness", () => {
    const r = checkObject([{ action: "talk", text: "This is a message from Preflight Demo Clinic." }, { action: "talk", text: "Bye." }], { declaration: decl, facts: { from: "14045550100", lineType: "wireless", withinHours: true } });
    expect(r.decision).toBe("block");
    const text = renderVerdicts(r);
    expect(text).toContain("P3");
    expect(text).toContain("witness: talk#0 > talk#1 > end of flow");
    expect(text).toContain("decision: BLOCK");
  });

  it("holds when a fact is unknown under strict and passes under advisory", () => {
    const obj = [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }];
    expect(checkObject(obj, { facts: { from: "14045550100", lineType: "unknown", withinHours: null } }).decision).toBe("hold");
    expect(checkObject(obj, { facts: { from: "14045550100", lineType: "unknown", withinHours: null }, policy: "advisory" }).decision).toBe("pass");
    expect(checkObject(obj, { facts: { from: "14045550100", lineType: "wireless", withinHours: true } }).decision).toBe("pass");
  });

  it("runs from the command line with exit codes 0, 2 and 3", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-cli-"));
    const ok = path.join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify([{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }]));
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([{ action: "talk", text: "Buy now." }]));
    const d = path.join(dir, "decl.json");
    writeFileSync(d, JSON.stringify(decl));
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await main(["check", ok, "--from", "14045550100", "--line-type", "wireless", "--within-hours", "true"], out)).toBe(0);
    expect(await main(["check", bad, "--declaration", d, "--from", "14045550100", "--line-type", "wireless", "--within-hours", "true"], out)).toBe(2);
    expect(await main(["check", ok, "--from", "14045550100"], out)).toBe(3);
    // A corpus file carries its own object and declaration.
    expect(await main(["check", path.join(corpusDir, "02-synthetic-no-optout.json"), "--from", "14045550100", "--line-type", "wireless", "--within-hours", "true"], out)).toBe(2);
    expect(await main(["check", path.join(corpusDir, "10-not-an-ncco.json"), "--from", "14045550100", "--line-type", "wireless", "--within-hours", "true"], out)).toBe(3);
    expect(await main(["check"], out)).toBe(1);
    expect(await main([], out)).toBe(1);
    expect(await main(["--version"], out)).toBe(0);
    expect(lines.join("\n")).toContain("decision: BLOCK");
  });
});

describe("preflight replay", () => {
  it("reproduces every corpus label offline", () => {
    const { rows, ok } = replayCorpus(corpusDir);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => r.mismatches.length > 0)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("reports a label that no longer matches, so a silent engine change cannot pass", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-replay-"));
    writeFileSync(path.join(dir, "01.json"), JSON.stringify({ name: "wrong label", ncco: [{ action: "connect", endpoint: [{ type: "phone", number: "1" }] }], expect: { terminal: { facts: { from: "14045550100", lineType: "wireless", withinHours: true }, verdicts: { P1: "false", P2: "true", P3: "true", P4: "true", P5: "true" }, decision: "block" } } }));
    const { rows, ok } = replayCorpus(dir);
    expect(ok).toBe(false);
    expect(rows[0]?.mismatches).toEqual(["P1: expected false, got true", "decision: expected block, got pass"]);
  });
});

describe("preflight verify-ledger", () => {
  it.each([null, {}, { error: "unavailable" }, { entries: null }, { entries: {} }, { entries: [null] }, { entries: [{ seq: 0 }] }])("rejects a malformed successful ledger page: %j", async (page) => {
    const fetchImpl: typeof fetch = async (input) => new Response(JSON.stringify(String(input).endsWith("/head") ? { seq: 1, entry_hash: chain(1)[0]?.entry_hash } : page));
    await expect(verifyLedgerSource("https://preflight.example", fetchImpl)).rejects.toThrow("invalid ledger page");
  });

  it("accepts a genesis snapshot without requesting entries", async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      requests++;
      expect(String(input)).toBe("https://preflight.example/api/ledger/head");
      return Response.json({ seq: 0, entry_hash: GENESIS_HASH });
    };
    await expect(verifyLedgerSource("https://preflight.example", fetchImpl)).resolves.toMatchObject({ ok: true, entries: 0 });
    expect(requests).toBe(1);
  });

  it.each([null, {}, { seq: -1, entry_hash: GENESIS_HASH }, { seq: 1.5, entry_hash: GENESIS_HASH }, { seq: Number.MAX_SAFE_INTEGER + 1, entry_hash: GENESIS_HASH }, { seq: 0, entry_hash: "sha256:" + "1".repeat(64) }, { seq: 1, entry_hash: "bad" }])("rejects a malformed advertised head: %j", async (head) => {
    await expect(loadLedger("https://preflight.example", async () => Response.json(head))).rejects.toThrow("invalid ledger head");
  });

  it.each([[], chain(1)].map((entries) => ({ entries })))("rejects an empty or truncated valid prefix before the advertised head", async ({ entries }) => {
    const fetchImpl: typeof fetch = async (input) => Response.json(String(input).endsWith("/head") ? { seq: 2, entry_hash: chain(2)[1]?.entry_hash } : { entries });
    await expect(loadLedger("https://preflight.example", fetchImpl)).rejects.toThrow("expected 2 entries");
  });

  it("rejects advancing junk on the first page instead of chasing it", async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      requests++;
      return Response.json(String(input).endsWith("/head") ? { seq: 2, entry_hash: GENESIS_HASH } : { entries: [{ seq: 1 }, { seq: 2 }] });
    };
    await expect(loadLedger("https://preflight.example", fetchImpl)).rejects.toThrow("malformed entry");
    expect(requests).toBe(2);
  });

  it.each(["empty", "junk", "repeat"])("rejects a bad second page without another request: %s", async (mode) => {
    const entries = chain(1001);
    let requests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      requests++;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/head")) return Response.json({ seq: 1001, entry_hash: entries[1000]?.entry_hash });
      if (url.searchParams.get("after") === "0") return Response.json({ entries: entries.slice(0, 1000) });
      return Response.json({ entries: mode === "empty" ? [] : mode === "junk" ? [{ seq: 1001 }] : [entries[999]] });
    };
    await expect(loadLedger("https://preflight.example", fetchImpl)).rejects.toThrow("invalid ledger page");
    expect(requests).toBe(3);
  });

  it("bounds pages to the snapshot while the host grows", async () => {
    const entries = chain(1002);
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requested.push(url.pathname + url.search);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname.endsWith("/head")) return Response.json({ seq: 1001, entry_hash: entries[1000]?.entry_hash });
      const after = Number(url.searchParams.get("after"));
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({ after, entries: entries.slice(after, after + limit) });
    };
    await expect(verifyLedgerSource("https://preflight.example", fetchImpl)).resolves.toMatchObject({ ok: true, entries: 1001, head: entries[1000]?.entry_hash });
    expect(requested).toEqual(["/api/ledger/head", "/api/ledger/entries?after=0&limit=1000", "/api/ledger/entries?after=1000&limit=1"]);
  });

  it.each(["repeat", "tamper", "wrong-head", "oversized", "cursor"])("rejects inconsistent pages: %s", async (mode) => {
    const entries = chain(2);
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/head")) return Response.json({ seq: 2, entry_hash: mode === "wrong-head" ? GENESIS_HASH : entries[1]?.entry_hash });
      const page = mode === "repeat" ? [entries[0], entries[0]] : mode === "tamper" ? [entries[0], { ...entries[1], witness: ["changed"] }] : mode === "oversized" ? chain(3) : entries;
      return Response.json({ after: mode === "cursor" ? 1 : 0, entries: page });
    };
    await expect(loadLedger("https://preflight.example", fetchImpl)).rejects.toThrow();
  });

  it("sets a 30-second timeout for each fetch and propagates failures", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(loadLedger("https://preflight.example", async () => { throw new DOMException("timed out", "TimeoutError"); })).rejects.toThrow("timed out");
      expect(timeout).toHaveBeenCalledWith(30_000);
      await expect(loadLedger("https://preflight.example", async () => new Response("unavailable", { status: 503 }))).rejects.toThrow("HTTP 503");
    } finally {
      timeout.mockRestore();
    }
  });
  it("verifies an intact chain from a file and from a paged host, and reports a break", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-ledger-"));
    const entries = chain(7);
    const file = path.join(dir, "entries.json");
    writeFileSync(file, JSON.stringify({ entries }));
    expect(await verifyLedgerSource(file)).toMatchObject({ ok: true, entries: 7, head: entries[6]?.entry_hash });
    const fetchImpl: typeof fetch = async (input) => {
      const u = new URL(typeof input === "string" ? input : (input as Request).url);
      if (u.pathname.endsWith("/head")) return Response.json({ seq: entries.length, entry_hash: entries.at(-1)?.entry_hash });
      const after = Number(u.searchParams.get("after") ?? 0);
      const page = entries.filter((e) => e.seq > after).slice(0, Number(u.searchParams.get("limit")));
      return new Response(JSON.stringify({ after, entries: page }), { status: 200, headers: { "content-type": "application/json" } });
    };
    expect((await loadLedger("https://preflight.example/", fetchImpl)).length).toBe(7);
    expect(await verifyLedgerSource("https://preflight.example", fetchImpl)).toMatchObject({ ok: true, entries: 7 });
    const tampered = entries.map((e, i) => (i === 3 ? { ...e, witness: ["talk#9"] } : e));
    writeFileSync(file, JSON.stringify(tampered));
    expect(await verifyLedgerSource(file)).toMatchObject({ ok: false, brokenAt: { seq: 4 } });
    expect(await main(["verify-ledger", file], () => undefined)).toBe(4);
  });
});
