/**
 * Computes Gate 1 / 2 / 3 from the saved CSVs + server log. No judgment calls.
 * Usage: node tools/analyze.mjs [resultsDir]
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || path.join(process.cwd(), 'results');
const SETTLE_MS = 1000;   // ignore this much after an ack when measuring a STEADY state

const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };

function newest(re) {
  const f = fs.readdirSync(dir).filter(x => re.test(x)).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
}
function readCsv(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').slice(1)
    .map(l => { const [t, db] = l.split(','); return { t: +t, db: +db }; })
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.db));
}

const logP = newest(/^serverlog_.*\.json$/);
const aP = newest(/^samples_listenerA_.*\.csv$/);
const bP = newest(/^samples_listenerB_.*\.csv$/);
if (!logP || !aP || !bP) {
  console.error('MISSING INPUTS — cannot compute gates. Found:');
  console.error('  serverlog:', logP || 'NONE');
  console.error('  listenerA:', aP || 'NONE');
  console.error('  listenerB:', bP || 'NONE');
  console.error('\nNO NUMBERS PRODUCED. The run did not happen.');
  process.exit(2);
}
const log = JSON.parse(fs.readFileSync(logP, 'utf8'));
const S = { listenerA: readCsv(aP), listenerB: readCsv(bP) };
const flips = (log.flips || []).filter(f => Number.isFinite(f.t_ack_ms));

// FRESHNESS GUARD. A previous run's files sitting on disk will otherwise be
// re-analysed and print a confident PASS for a run that never happened.
const ages = [logP, aP, bP].map(f => fs.statSync(f).mtimeMs);
const spreadMin = (Math.max(...ages) - Math.min(...ages)) / 60000;
const ageMin = (Date.now() - Math.max(...ages)) / 60000;
if (spreadMin > 5) {
  console.error(`REFUSING TO ANALYSE: inputs are ${spreadMin.toFixed(1)} min apart, so they are NOT from one run.`);
  console.error('NO NUMBERS PRODUCED.');
  process.exit(3);
}
if (ageMin > 30) console.log(`  !! WARNING: newest input is ${ageMin.toFixed(0)} min old. Confirm this is the run you mean.`);

console.log('=== INPUTS ===');
console.log(' serverlog :', logP);
console.log(' listenerA :', aP, `(${S.listenerA.length} samples)`);
console.log(' listenerB :', bP, `(${S.listenerB.length} samples)`);
console.log(' mechanism :', log.mechanism, '| flips recorded:', flips.length);

/* ---- windows: [ackOf(i), sentOf(i+1)) with state audibleTo ---- */
const windows = flips.map((f, i) => ({
  n: f.n, audibleTo: f.audibleTo, ack: f.t_ack_ms,
  end: i + 1 < flips.length ? flips[i + 1].t_sent_ms : Math.max(...['listenerA', 'listenerB'].flatMap(r => S[r].map(s => s.t))),
}));

/* ---- Gate 1: steady-state separation ---- */
const steady = { listenerA: { aud: [], mut: [] }, listenerB: { aud: [], mut: [] } };
for (const w of windows) {
  for (const role of ['listenerA', 'listenerB']) {
    const bucket = w.audibleTo === role ? 'aud' : 'mut';
    for (const s of S[role]) if (s.t >= w.ack + SETTLE_MS && s.t < w.end) steady[role][bucket].push(s.db);
  }
}
console.log('\n=== GATE 1 — separation (audible minus muted, dB) ===');
const seps = [];
for (const role of ['listenerA', 'listenerB']) {
  const A = median(steady[role].aud), M = median(steady[role].mut);
  const sep = A - M; seps.push(sep);
  console.log(` ${role}: audible=${A.toFixed(1)} dB (n=${steady[role].aud.length})  muted=${M.toFixed(1)} dB (n=${steady[role].mut.length})  separation=${sep.toFixed(1)} dB`);
}
const worstSep = seps.length ? Math.min(...seps) : NaN;
// FAIL CLOSED. A non-finite separation is a BROKEN MEASUREMENT, not a spectacular pass:
// Infinity satisfies ">= 40" and would sail straight through.
const sepFinite = seps.every(Number.isFinite) && Number.isFinite(worstSep);
const G1 = sepFinite && worstSep >= 40;
if (!sepFinite) console.log(' !! separation is NOT FINITE -> the measurement is broken, not passing.');
console.log(` WORST-CASE SEPARATION = ${Number.isFinite(worstSep) ? worstSep.toFixed(1) + ' dB' : 'INVALID'}   -> GATE 1 ${G1 ? 'PASS' : 'FAIL'} (threshold 40 dB)`);

/* ---- Gate 2: latency from HTTP 2xx to midpoint crossing ---- */
console.log('\n=== GATE 2 — latency, HTTP 2xx -> midpoint crossing (ms) ===');
const mid = {};
for (const role of ['listenerA', 'listenerB']) mid[role] = (median(steady[role].aud) + median(steady[role].mut)) / 2;
const lat = { fall: [], rise: [], all: [] };
let unresolved = 0;
for (let i = 1; i < windows.length; i++) {           // flip 1 has no prior state
  const w = windows[i], prev = windows[i - 1];
  for (const role of ['listenerA', 'listenerB']) {
    const was = prev.audibleTo === role, now = w.audibleTo === role;
    if (was === now) continue;                        // this listener did not change
    const win = S[role].filter(s => s.t >= w.ack && s.t < Math.min(w.end, w.ack + 5000));
    const crossed = win.find(s => now ? s.db >= mid[role] : s.db <= mid[role]);
    if (!crossed) { unresolved++; continue; }
    const d = crossed.t - w.ack;
    lat.all.push(d); (now ? lat.rise : lat.fall).push(d);
  }
}
const rep = (name, arr) => console.log(` ${name}: n=${arr.length} median=${arr.length ? median(arr).toFixed(0) : 'n/a'} p95=${arr.length ? pct(arr, 95).toFixed(0) : 'n/a'}`);
rep('fall (goes silent)', lat.fall); rep('rise (becomes audible)', lat.rise); rep('ALL transitions', lat.all);
if (unresolved) console.log(` !! ${unresolved} transitions never crossed the midpoint within 5000 ms`);
const m2 = median(lat.all), p2 = pct(lat.all, 95);
const expectedTransitions = Math.max(0, (windows.length - 1) * 2);
let g2 = 'FAIL', G2 = false;
if (!G1) {
  // Latency between two states is meaningless if the two states were never distinguishable.
  g2 = 'SUPPRESSED — Gate 1 did not establish two distinguishable states, so no latency number is valid';
} else if (unresolved > 0) {
  g2 = `FAIL — ${unresolved} of ${expectedTransitions} transitions never crossed the midpoint`;
} else if (!Number.isFinite(m2) || !Number.isFinite(p2) || lat.all.length === 0) {
  g2 = 'FAIL — no usable transitions measured';
} else if (lat.all.some(d => d < 0)) {
  g2 = `FAIL — ${lat.all.filter(d => d < 0).length} NEGATIVE latencies (clock offset is wrong; the audio appears to change before the 2xx)`;
} else if (m2 < 400 && p2 < 800) { g2 = 'PASS (clean)'; G2 = true; }
else if (m2 < 1000 && p2 < 2000) { g2 = 'MARGINAL — discrete announced transitions only, NOT continuous movement'; G2 = 'marginal'; }
console.log(` GATE 2 ${g2}   (median=${Number.isFinite(m2) ? m2.toFixed(0) : 'n/a'} ms, p95=${Number.isFinite(p2) ? p2.toFixed(0) : 'n/a'} ms, transitions=${lat.all.length}/${expectedTransitions}, flips=${flips.length})`);

/* ---- Gate 3: stability ---- */
console.log('\n=== GATE 3 — stability ===');
const bad = (log.restRequests || []).filter(r => r.status < 200 || r.status >= 300);
const drops = (log.events || []).filter(e => ['completed', 'failed', 'rejected', 'unanswered', 'busy'].includes(e.status));
let peak = 0;
const ts = (log.restRequests || []).map(r => r.t_ms).sort((a, b) => a - b);
for (let i = 0; i < ts.length; i++) { let j = i; while (j < ts.length && ts[j] - ts[i] < 1000) j++; peak = Math.max(peak, j - i); }
console.log(` REST requests total   : ${ts.length}`);
console.log(` non-2xx responses     : ${bad.length}${bad.length ? ' -> ' + JSON.stringify(bad.slice(0, 5)) : ''}`);
console.log(` leg-drop events       : ${drops.length}${drops.length ? ' -> ' + drops.map(d => d.status).join(',') : ''}`);
console.log(` peak request rate     : ${peak} req/s (limit 15)`);
const G3 = bad.length === 0 && drops.length === 0 && peak <= 15 && ts.length > 0;
if (ts.length === 0) console.log(' !! ZERO REST requests recorded -> the run did not happen; this is not a pass.');
console.log(` GATE 3 ${G3 ? 'PASS' : 'FAIL'}`);

console.log('\n=== VERDICT ===');
console.log(` GATE 1 ${G1 ? 'PASS' : 'FAIL'} | GATE 2 ${G2 === true ? 'PASS' : G2 === 'marginal' ? 'MARGINAL' : 'FAIL/SUPPRESSED'} | GATE 3 ${G3 ? 'PASS' : 'FAIL'}`);
const allOk = G1 && (G2 === true || G2 === 'marginal') && G3;
console.log(allOk ? ' Overall: mechanism VIABLE at the level reported above.' : ' Overall: NOT ESTABLISHED. Do not treat any number above as a green light.');
console.log('\nRegenerate with:  node tools/analyze.mjs');
process.exit(allOk ? 0 : 1);
