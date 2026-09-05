#!/usr/bin/env node
/**
 * Refreshes the statute texts under packages/rules/data from their sources and rewrites the
 * manifest hashes. Re-run scripts/fetch-rules.mjs, then the citations test tells you whether any
 * quoted clause moved. Fails closed: a source that cannot be fetched leaves its committed file alone
 * and the run exits non-zero.
 *
 * The codified O.C.G.A. text (ocga-46-5-27.txt) comes from a page that needs a browser; refresh it
 * by hand from the URL in SOURCES.json and paste the statute body through "History" plus the
 * history line. Everything else is fetched here.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../packages/rules/data");
const manifestPath = path.join(dataDir, "SOURCES.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ua = { "user-agent": "preflight-build/0.1 (+https://github.com/StephenSook/preflight)" };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
let failed = 0;

async function refresh(name, produce) {
  try {
    const text = await produce();
    if (!text || text.length < 500) throw new Error("empty or implausibly short");
    writeFileSync(path.join(dataDir, name), text.endsWith("\n") ? text : text + "\n");
    manifest.files[name].sha256 = sha(readFileSync(path.join(dataDir, name)));
    console.log(`${name}: ${text.length} chars`);
  } catch (err) {
    failed += 1;
    console.error(`${name}: NOT refreshed (${err instanceof Error ? err.message : String(err)}); committed copy kept`);
  }
}

await refresh("47-cfr-64.1200.txt", async () => {
  const titles = await (await fetch("https://www.ecfr.gov/api/versioner/v1/titles.json", { headers: ua })).json();
  const date = titles.titles.find((t) => t.number === 47).up_to_date_as_of;
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-47.xml?part=64&section=64.1200`;
  const res = await fetch(url, { headers: ua });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  manifest.files["47-cfr-64.1200.txt"].url = url;
  manifest.files["47-cfr-64.1200.txt"].vintage = `eCFR up to date as of ${date}`;
  return xml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x2014;|&mdash;/g, "—").replace(/\s+/g, " ").trim();
});

await refresh("16-cfr-310.4.txt", async () => {
  const titles = await (await fetch("https://www.ecfr.gov/api/versioner/v1/titles.json", { headers: ua })).json();
  const date = titles.titles.find((t) => t.number === 16).up_to_date_as_of;
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-16.xml?part=310&section=310.4`;
  const res = await fetch(url, { headers: ua });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  manifest.files["16-cfr-310.4.txt"].url = url;
  manifest.files["16-cfr-310.4.txt"].vintage = `eCFR up to date as of ${date}`;
  return xml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x2014;|&mdash;/g, "—").replace(/\s+/g, " ").trim();
});

// The Vonage Acceptable Use Policy (vonage-aup-2025-02-03.txt) renders only in a browser and is an
// excerpt of a copyrighted page, committed by hand from a Chromium render; it is not refreshed here.

await refresh("ga-comp-r-regs-515-14-1-03.txt", async () => {
  const res = await fetch(manifest.files["ga-comp-r-regs-515-14-1-03.txt"].url, { headers: { ...ua, accept: "text/html" } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const p = strip(await res.text());
  const i = p.indexOf("(a) No person or entity shall make or cause to be made any telephone solicitation");
  const j = p.indexOf("Notes", i);
  if (i < 0 || j < 0) throw new Error("rule text markers not found");
  return p.slice(i, j).trim();
});

await refresh("ga-sb73-2024-signed.txt", async () => {
  const res = await fetch(manifest.files["ga-sb73-2024-signed.txt"].url, { headers: ua, redirect: "follow" });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString() !== "%PDF-") throw new Error("not a PDF");
  mkdirSync(path.join(dataDir, "raw"), { recursive: true });
  const pdf = path.join(dataDir, "raw", "sb73.pdf");
  writeFileSync(pdf, buf);
  const out = path.join(dataDir, "raw", "sb73.txt");
  execFileSync("pdftotext", ["-layout", pdf, out]);
  return readFileSync(out, "utf8");
});

manifest.fetchedAt = new Date().toISOString();
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
if (!existsSync(path.join(dataDir, "ocga-46-5-27.txt"))) { console.error("ocga-46-5-27.txt is missing; refresh it by hand"); failed += 1; }
console.log(failed === 0 ? "all fetched sources refreshed" : `${failed} source(s) not refreshed`);
process.exit(failed === 0 ? 0 : 1);
