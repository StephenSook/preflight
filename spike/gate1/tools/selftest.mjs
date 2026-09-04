/**
 * Proves the ANALYSIS instrument before it is ever allowed to produce a real number.
 * Synthesizes CSVs with a KNOWN separation and KNOWN latency, runs analyze.mjs against
 * them, and asserts it recovers what was planted. If this fails, no measured number
 * from this rig can be trusted.
 *
 * Usage: node tools/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = path.join(process.cwd(), 'results', '_selftest');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const PLANTED_SEP_DB = 55;      // audible -30 dB, muted -85 dB
const PLANTED_LATENCY_MS = 260;
const FLIPS = 20, HOLD = 2000, STEP = 20;
const AUD = -30, MUT = -85;

const t0 = 1_800_000_000_000;
const flips = [];
for (let i = 0; i < FLIPS; i++) {
  const sent = t0 + i * HOLD;
  flips.push({ n: i + 1, audibleTo: i % 2 === 0 ? 'listenerA' : 'listenerB', mechanism: 'SELFTEST',
    t_sent_ms: sent, t_ack_ms: sent + 40, ok: true, statuses: [200] });
}
const stateAt = (t) => { let s = null; for (const f of flips) if (t >= f.t_ack_ms + PLANTED_LATENCY_MS) s = f.audibleTo; return s; };
for (const role of ['listenerA', 'listenerB']) {
  const rows = ['timestamp_ms,bin_magnitude_db'];
  for (let t = t0 - 500; t < t0 + FLIPS * HOLD; t += STEP) {
    const s = stateAt(t);
    const db = s === null ? AUD : (s === role ? AUD : MUT);
    rows.push(`${t},${(db + (Math.random() - 0.5) * 0.4).toFixed(2)}`);
  }
  fs.writeFileSync(path.join(TMP, `samples_${role}_selftest.csv`), rows.join('\n'));
}
fs.writeFileSync(path.join(TMP, 'serverlog_selftest.json'), JSON.stringify({
  mechanism: 'SELFTEST', flips, events: [],
  restRequests: flips.map(f => ({ t_ms: f.t_sent_ms, status: 200 })), errors: [],
}, null, 2));

let out = '';
try { out = execFileSync(process.execPath, [path.join('tools', 'analyze.mjs'), TMP], { encoding: 'utf8' }); }
catch (e) { out = String(e.stdout || ''); console.error(`!! analyze.mjs exited ${e.status} on the POSITIVE control`); }
console.log(out);

const sepM = out.match(/WORST-CASE SEPARATION = ([-\d.]+) dB/);
const latM = out.match(/ALL transitions: n=\d+ median=(\d+) p95=(\d+)/);
let fail = 0;
const chk = (name, ok, got, want) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}, expected ${want}`); if (!ok) fail++; };
chk('recovers planted separation', sepM && Math.abs(+sepM[1] - PLANTED_SEP_DB) < 1.5, sepM ? sepM[1] + ' dB' : 'NOT PARSED', `${PLANTED_SEP_DB} dB +/-1.5`);
chk('recovers planted latency (median)', latM && Math.abs(+latM[1] - PLANTED_LATENCY_MS) <= STEP + 5, latM ? latM[1] + ' ms' : 'NOT PARSED', `${PLANTED_LATENCY_MS} ms +/-${STEP + 5}`);
chk('Gate 1 verdict correct for a 55 dB gap', /GATE 1 PASS/.test(out), /GATE 1 (PASS|FAIL)/.exec(out)?.[1], 'PASS');
chk('Gate 2 verdict correct for 260 ms', /GATE 2 PASS \(clean\)/.test(out), /GATE 2 (PASS \(clean\)|MARGINAL|FAIL)/.exec(out)?.[1], 'PASS (clean)');

// negative control: the instrument must also be able to say FAIL
const rows = ['timestamp_ms,bin_magnitude_db'];
for (let t = t0 - 500; t < t0 + FLIPS * HOLD; t += STEP) rows.push(`${t},${(AUD + (Math.random() - .5) * .4).toFixed(2)}`);
fs.writeFileSync(path.join(TMP, 'samples_listenerB_selftest.csv'), rows.join('\n'));  // B never goes quiet
let out2 = '', code2 = 0;
try { out2 = execFileSync(process.execPath, [path.join('tools', 'analyze.mjs'), TMP], { encoding: 'utf8' }); }
catch (e) { out2 = String(e.stdout || ''); code2 = e.status ?? 1; }
chk('NEGATIVE CONTROL: Gate 1 FAILS when there is no separation', /GATE 1 FAIL/.test(out2), /GATE 1 (PASS|FAIL)/.exec(out2)?.[1], 'FAIL');
// The defect this guards: a listener that never transitioned can still yield a tidy-looking
// latency number. Gate 2 must refuse to report one at all, not report a clean pass.
chk('NEGATIVE CONTROL: Gate 2 is SUPPRESSED, not a clean pass',
    /GATE 2 SUPPRESSED/.test(out2) && !/GATE 2 PASS/.test(out2),
    /GATE 2 ([A-Z]+)/.exec(out2)?.[1], 'SUPPRESSED');
chk('NEGATIVE CONTROL: overall verdict is NOT ESTABLISHED',
    /Overall: NOT ESTABLISHED/.test(out2), /Overall: ([^\n.]*)/.exec(out2)?.[1]?.trim(), 'NOT ESTABLISHED');
chk('NEGATIVE CONTROL: analyzer exits NONZERO', code2 !== 0, `exit ${code2}`, 'nonzero');

// CONTROL 3: no inputs at all must not read as a pass.
const EMPTY = path.join(process.cwd(), 'results', '_selftest_empty');
fs.rmSync(EMPTY, { recursive: true, force: true }); fs.mkdirSync(EMPTY, { recursive: true });
let out3 = '', code3 = 0;
try { out3 = execFileSync(process.execPath, [path.join('tools', 'analyze.mjs'), EMPTY], { encoding: 'utf8' }); }
catch (e) { out3 = String(e.stdout || '') + String(e.stderr || ''); code3 = e.status ?? 1; }
chk('CONTROL 3: missing inputs exit nonzero and produce NO numbers',
    code3 !== 0 && /NO NUMBERS PRODUCED/.test(out3), `exit ${code3}`, 'nonzero + refusal');

console.log(fail === 0
  ? '\nSELF-TEST PASSED — the analysis instrument recovers planted truth in both directions.'
  : `\nSELF-TEST FAILED (${fail}) — do NOT trust any number this rig produces.`);
process.exit(fail === 0 ? 0 : 1);
