/**
 * Drives the whole Gate 1 run: 3 browser legs, N flips, sample upload, dump.
 * Playwright is used ONLY because Chrome's autoplay policy otherwise requires a
 * human gesture per tab, and because MCP-managed tabs proved too short-lived
 * to survive a multi-minute run.
 *
 * Usage: node tools/run-spike.mjs [mechanism] [flips] [holdMs]
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3131';
const MECH = process.argv[2] || 'B1';
const FLIPS = Number(process.argv[3] || 50);
const HOLD = Number(process.argv[4] || 2000);
const ROLES = ['source', 'listenerA', 'listenerB'];

const j = async (p, o) => (await fetch(BASE + p, o)).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`\n=== GATE 1 RUN: mechanism=${MECH} flips=${FLIPS} hold=${HOLD}ms ===\n`);
await j('/reset', { method: 'POST' });
console.log('[1] server state reset');

const browser = await chromium.launch({
  headless: false,
  args: [
    '--autoplay-policy=no-user-gesture-required',   // the whole reason for Playwright
    '--use-fake-ui-for-media-stream',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const pages = {};

for (const role of ROLES) {
  const pg = await ctx.newPage();
  pg.on('console', m => { const t = m.text(); if (/FATAL|ERROR|captured|session created|serverCall|probe ready|intercepted/.test(t)) console.log(`   [${role}] ${t}`); });
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.connect === 'function');
  await pg.evaluate(r => { document.querySelector('#role').value = r; connect(); }, role);
  pages[role] = pg;
  console.log(`[2] ${role}: connect() invoked`);
  // SOURCE must be in the conversation before the listeners join
  await sleep(role === 'source' ? 9000 : 7000);
}

// wait until the server has a leg UUID for all three
let st, waited = 0;
while (waited < 45000) {
  st = await j('/state');
  if (st.ready) break;
  await sleep(1500); waited += 1500;
}
if (!st.ready) {
  console.error('[FAIL] not all legs connected:', Object.keys(st.legs));
  console.error('NO NUMBERS PRODUCED.');
  await browser.close(); process.exit(2);
}
console.log('[3] all three legs connected:');
for (const r of ROLES) console.log(`      ${r.padEnd(10)} ${st.legs[r].uuid}`);
console.log(`      conversation ${st.legs.source.conversation_uuid}`);

// baseline: both listeners must actually be hearing the tone before we flip anything
await sleep(6000);
const lvl = {};
for (const r of ['listenerA', 'listenerB']) {
  // NOTE: leg.js is a classic script, so `samples` is a lexical global, NOT window.samples.
  lvl[r] = await pages[r].evaluate(() => {
    const s = (typeof samples !== 'undefined') ? samples : [];
    const last = s.slice(-100).map(x => x.db).filter(Number.isFinite).sort((a, b) => a - b);
    return { n: s.length, median: last.length ? last[last.length >> 1] : null };
  });
}
console.log('[4] BASELINE:', JSON.stringify(lvl));
// A listener can be sampling happily and still be receiving SILENCE. Counting samples
// does not establish that the tone is arriving, so check the LEVEL too: without this the
// run produces a confident 0.0 dB "separation" for a leg that was simply never audible.
const BASELINE_FLOOR_DB = -60;
for (const r of ['listenerA', 'listenerB']) {
  if (!lvl[r].n) {
    console.error(`[FAIL] ${r} captured ZERO samples -> probe never attached. NO NUMBERS PRODUCED.`);
    await browser.close(); process.exit(3);
  }
  if (!(lvl[r].median > BASELINE_FLOOR_DB)) {
    console.error(`[FAIL] ${r} baseline is ${lvl[r].median} dB, below ${BASELINE_FLOOR_DB} dB -> it is NOT hearing the source.`);
    console.error('       Both listeners must hear the tone BEFORE any flip, or the run is meaningless.');
    console.error('NO NUMBERS PRODUCED.');
    await browser.close(); process.exit(4);
  }
}
console.log(`[4b] baseline OK: both listeners above ${BASELINE_FLOOR_DB} dB`);

console.log(`[5] running ${FLIPS} flips...`);
await fetch(BASE + '/control/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ flips: FLIPS, holdMs: HOLD, mechanism: MECH }) });
const total = FLIPS * HOLD + 8000;
for (let t = 0; t < total; t += 15000) {
  await sleep(Math.min(15000, total - t));
  const s = await j('/state');
  console.log(`      ${s.flips}/${FLIPS} flips, errors=${s.errors}`);
}

console.log('[6] uploading listener samples');
for (const r of ['listenerA', 'listenerB']) {
  const res = await pages[r].evaluate(() => upload().then(() => samples.length));
  console.log(`      ${r}: ${res} samples`);
}
const d = await j('/dump', { method: 'POST' });
console.log('[7] dumped:', d.json);
await browser.close();
console.log('\nNow run:  node tools/analyze.mjs\n');
