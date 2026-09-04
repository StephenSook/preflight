#!/usr/bin/env node
/**
 * Fetches the two public number-facts sources and derives the compact tables the numfacts package
 * reads at runtime. Run it to refresh the data; the derived tables and SOURCES.json are committed,
 * the raw downloads are not. Fails closed: any defect in a source leaves the committed tables as
 * they were and exits non-zero.
 *
 *   NANPA central office code assignments (public, no account):
 *     https://reports.nanpa.com/public/CoCodeAssignment_Utilized_AllStates_Public.zip
 *   libphonenumber prefix to timezone map (Apache-2.0, The Libphonenumber Authors):
 *     https://raw.githubusercontent.com/google/libphonenumber/master/resources/timezones/map_data.txt
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../packages/numfacts/data");
const rawDir = path.join(dataDir, "raw");
mkdirSync(rawDir, { recursive: true });

const NANPA_URL = "https://reports.nanpa.com/public/CoCodeAssignment_Utilized_AllStates_Public.zip";
const TZ_URL = "https://raw.githubusercontent.com/google/libphonenumber/master/resources/timezones/map_data.txt";
const EXPECTED_HEADER = ["State", "NPA-NXX", "OCN", "Company", "RateCenter", "EffectiveDate", "Use", "AssignDate", "Initial/Growth", "Pooled Code", "In Service"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url, file) {
  const res = await fetch(url, { headers: { "user-agent": "preflight-build/0.1 (+https://github.com/StephenSook/preflight)" } });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

/** Wireless and VoIP carriers by the name patterns that appear in the NANPA company column. A first-pass prior only. */
export const WIRELESS_PATTERN = /WIRELESS|MOBILITY|CELLCO|CELLULAR|T-MOBILE|SPRINT|CRICKET|METRO ?PCS|\bPCS\b|MOBILE|OMNIPOINT|VOICESTREAM|ALLTEL|BOOST|DISH WIRELESS/i;
export const VOIP_PATTERN = /BANDWIDTH\.COM|BANDWIDTH|ONVOY|PEERLESS|LEVEL 3|TWILIO|VONAGE|GOOGLE|INTELIQUENT|NEUTRAL TANDEM|VOIP|TELNYX|YMAX|MAGICJACK|COMCAST IP|SKYPE|NUSO|SINCH|COMMIO|TELEPORT/i;

function lineClass(company) {
  if (WIRELESS_PATTERN.test(company)) return "W";
  if (VOIP_PATTERN.test(company)) return "V";
  return "L";
}

const zipBuf = await download(NANPA_URL, path.join(rawDir, "nanpa.zip"));
if (zipBuf.subarray(0, 2).toString() !== "PK") throw new Error("NANPA download is not a zip archive (a block page served as 200?)");
execFileSync("unzip", ["-o", "-q", path.join(rawDir, "nanpa.zip"), "-d", rawDir]);
const txtName = readdirSync(rawDir).find((f) => f.endsWith(".txt") && f.startsWith("CoCode"));
if (!txtName) throw new Error("NANPA zip did not contain the CoCode text file");
const nanpaText = readFileSync(path.join(rawDir, txtName), "latin1");
const lines = nanpaText.split(/\r?\n/).filter((l) => l.length > 0);
const header = (lines[0] ?? "").split("\t").map((c) => c.trim());
for (const [i, name] of EXPECTED_HEADER.entries()) {
  if (header[i] !== name) throw new Error(`NANPA column ${i} is "${header[i]}", expected "${name}"; the file layout changed`);
}
const updatedMatch = /File Updated (\d{2}\/\d{2}\/\d{4})/.exec(header[11] ?? "");
if (!updatedMatch) throw new Error("NANPA header carries no 'File Updated' date");
const nanpaFileUpdated = updatedMatch[1];

const rows = new Map();
let classes = { W: 0, V: 0, L: 0 };
for (const line of lines.slice(1)) {
  const c = line.split("\t").map((x) => x.trim());
  const npanxx = c[1] ?? "";
  if (!/^\d{3}-\d{3}$/.test(npanxx)) throw new Error(`bad NPA-NXX "${npanxx}" in line: ${line.slice(0, 80)}`);
  const state = c[0] ?? "";
  const ocn = c[2] ?? "";
  const company = (c[3] ?? "").replace(/^"|"$/g, "");
  const rateCenter = c[4] ?? "";
  const cls = lineClass(company);
  classes[cls] += 1;
  const key = npanxx.replace("-", "");
  if (rows.has(key)) throw new Error(`duplicate NPA-NXX ${npanxx}`);
  rows.set(key, `${key}\t${state}\t${rateCenter}\t${ocn}\t${cls}`);
}
if (rows.size < 150000) throw new Error(`NANPA table has only ${rows.size} rows; expected well over 150000`);
const derived = ["npanxx\tstate\trate_center\tocn\tline_class", ...[...rows.keys()].sort().map((k) => rows.get(k))].join("\n") + "\n";

const tzBuf = await download(TZ_URL, path.join(rawDir, "map_data.txt"));
const tzText = tzBuf.toString("utf8");
const nanp = tzText.split("\n").filter((l) => /^1\d*\|/.test(l));
if (nanp.length < 1500) throw new Error(`timezone map has only ${nanp.length} NANP entries`);
if (!/Apache License, Version 2\.0/.test(tzText)) throw new Error("timezone map lost its license header");

writeFileSync(path.join(dataDir, "co-codes.tsv"), derived);
writeFileSync(path.join(dataDir, "tz-map.txt"), tzText);
writeFileSync(
  path.join(dataDir, "SOURCES.json"),
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      nanpa: { url: NANPA_URL, fileUpdated: nanpaFileUpdated, sha256: sha256(zipBuf), rows: rows.size, lineClassCounts: classes, derived: "co-codes.tsv" },
      timezoneMap: { url: TZ_URL, license: "Apache-2.0, The Libphonenumber Authors", sha256: sha256(tzBuf), nanpEntries: nanp.length, derived: "tz-map.txt" },
    },
    null,
    2,
  ) + "\n",
);
console.log(`nanpa: ${rows.size} NPA-NXX rows (W=${classes.W} V=${classes.V} L=${classes.L}), file updated ${nanpaFileUpdated}`);
console.log(`timezone map: ${nanp.length} NANP entries`);
