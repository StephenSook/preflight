import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENESIS_HASH, makeEntry, type LedgerBody, type LedgerEntry } from "@preflight/ledger";
import { describe, expect, it } from "vitest";
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
  it("verifies an intact chain from a file and from a paged host, and reports a break", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-ledger-"));
    const entries = chain(7);
    const file = path.join(dir, "entries.json");
    writeFileSync(file, JSON.stringify({ entries }));
    expect(await verifyLedgerSource(file)).toMatchObject({ ok: true, entries: 7, head: entries[6]?.entry_hash });
    const fetchImpl: typeof fetch = async (input) => {
      const u = new URL(typeof input === "string" ? input : (input as Request).url);
      const after = Number(u.searchParams.get("after") ?? 0);
      const page = entries.filter((e) => e.seq > after).slice(0, 3);
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
