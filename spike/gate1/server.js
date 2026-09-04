/**
 * GATE 1 SPIKE — Vonage live per-participant audio routing.
 *
 * Answers ONE question: can canSpeak/canHear be changed on an ALREADY-CONNECTED
 * conversation leg, and how fast.
 *
 * Throwaway. No product code here. No polish.
 */
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.stderr.write('BOOT-PROBE: imports done\n');

// ---------- config (env only; never hardcode secrets) ----------
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const CFG = {
  appId: process.env.VONAGE_APPLICATION_ID,
  keyPath: process.env.VONAGE_PRIVATE_KEY_PATH || './private.key',
  publicBase: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  apiHost: (process.env.VONAGE_API_HOST || 'https://api.nexmo.com').replace(/\/$/, ''),
  port: Number(process.env.PORT || 3000),
  convName: process.env.CONVERSATION_NAME || 'gate1-spike',
};

let PRIVATE_KEY = null;
try { PRIVATE_KEY = fs.readFileSync(path.resolve(__dirname, CFG.keyPath), 'utf8'); }
catch { console.warn(`[boot] WARNING: private key not readable at ${CFG.keyPath}. /token and REST calls will fail.`); }

const ROLES = ['source', 'listenerA', 'listenerB'];

// ---------- shared mutable test state ----------
const STATE = {
  epochMs: Date.now(),           // shared epoch, all timestamps are ms since UNIX epoch
  legs: {},                      // role -> { uuid, conversation_uuid, region_url, answeredAt, status }
  // routing[role] = { canSpeak: [uuid]|null, canHear: [uuid]|null }; null means "omit" (= everyone)
  routing: { source: { canSpeak: null, canHear: null }, listenerA: {}, listenerB: {} },
  audibleTo: null,               // 'listenerA' | 'listenerB' | null (baseline: both)
  mechanism: process.env.MECH || 'B1',
  convName: CFG.convName,
  flips: [],                     // { n, at_ms, target, http_status, http_ms, mechanism, requests }
  events: [],
  restRequests: [],              // { t_ms, status } — for the request-rate gate
  errors: [],
};

function legUuid(role) { return STATE.legs[role]?.uuid || null; }
function regionBase() {
  const r = Object.values(STATE.legs).find(l => l?.region_url)?.region_url;
  return (r || CFG.apiHost).replace(/\/$/, '');
}

// ---------- JWT ----------
function appJwt(extra = {}) {
  if (!PRIVATE_KEY) throw new Error('private key not loaded');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { application_id: CFG.appId, iat: now, exp: now + 3600, jti: uuidv4(), ...extra },
    PRIVATE_KEY, { algorithm: 'RS256' }
  );
}
function clientJwt(sub) {
  return appJwt({
    sub,
    acl: { paths: {
      '/*/users/**': {}, '/*/conversations/**': {}, '/*/sessions/**': {},
      '/*/devices/**': {}, '/*/image/**': {}, '/*/media/**': {},
      '/*/applications/**': {}, '/*/push/**': {}, '/*/knocking/**': {}, '/*/legs/**': {},
    } },
  });
}

// ---------- NCCO ----------
function conversationNcco(role) {
  const a = { action: 'conversation', name: STATE.convName, startOnEnter: true, endOnExit: false };
  const r = STATE.routing[role] || {};
  if (Array.isArray(r.canSpeak)) a.canSpeak = r.canSpeak;
  if (Array.isArray(r.canHear)) a.canHear = r.canHear;
  return [a];
}

// ---------- REST to Vonage, with exact 2xx wall-clock capture ----------
async function vonagePut(uuid, body) {
  const url = `${regionBase()}/v1/calls/${uuid}`;
  const sentAt = Date.now();
  let res, text = '', err = null, headersAt = null, bodyAt = null;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${appJwt()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // fetch resolves on HEADERS. Anchor here. Reading the body first would shift the
    // anchor later and silently SUBTRACT that delay from the reported latency.
    headersAt = Date.now();
    text = await res.text();
    bodyAt = Date.now();
  } catch (e) { err = String(e); }
  const ackAt = headersAt !== null ? headersAt : Date.now();
  const rec = {
    t_sent_ms: sentAt, t_ack_ms: ackAt, rtt_ms: ackAt - sentAt,
    t_body_ms: bodyAt, body_delay_ms: bodyAt !== null ? bodyAt - ackAt : null,
    status: res ? res.status : 0, url, body, response: text.slice(0, 500), error: err,
  };
  STATE.restRequests.push({ t_ms: sentAt, status: rec.status });
  if (!res || res.status < 200 || res.status >= 300) STATE.errors.push(rec);
  return rec;
}

// ---------- the three mechanisms ----------
/** B1: transfer the SOURCE leg into an inline conversation action with the SAME name and new canSpeak. */
async function mechB1(audibleTo) {
  const src = legUuid('source'), tgt = legUuid(audibleTo);
  if (!src || !tgt) throw new Error(`missing legs: source=${src} ${audibleTo}=${tgt}`);
  STATE.routing.source.canSpeak = [tgt];
  const ncco = [{ action: 'conversation', name: STATE.convName, startOnEnter: true, endOnExit: false, canSpeak: [tgt] }];
  return [await vonagePut(src, { action: 'transfer', destination: { type: 'ncco', ncco } })];
}

/** B2: transfer NCCO action into the conversation BY ID, carrying canSpeak. */
async function mechB2(audibleTo) {
  const src = legUuid('source'), tgt = legUuid(audibleTo);
  const conv = STATE.legs.source?.conversation_uuid;
  if (!src || !tgt || !conv) throw new Error(`missing legs/conversation: src=${src} tgt=${tgt} conv=${conv}`);
  STATE.routing.source.canSpeak = [tgt];
  const ncco = [{ action: 'transfer', conversation_id: conv, canSpeak: [tgt] }];
  return [await vonagePut(src, { action: 'transfer', destination: { type: 'ncco', ncco } })];
}

/** C: earmuff the listener that must not hear, unearmuff the one that must. GLOBAL, latency floor only. */
async function mechC(audibleTo) {
  const deaf = audibleTo === 'listenerA' ? 'listenerB' : 'listenerA';
  const a = legUuid(audibleTo), d = legUuid(deaf);
  if (!a || !d) throw new Error(`missing legs: ${audibleTo}=${a} ${deaf}=${d}`);
  const r1 = await vonagePut(d, { action: 'earmuff' });
  const r2 = await vonagePut(a, { action: 'unearmuff' });
  return [r1, r2];
}

/** B1H: the canHear counterpart. Re-declares each LISTENER's canHear list.
 *  The deaf listener keeps a non-empty canHear (the other listener) so this is a genuine
 *  SELECTIVE hearing test, not a disguised global mute. */
async function mechB1H(audibleTo) {
  const src = legUuid('source');
  const a = legUuid('listenerA'), b = legUuid('listenerB');
  if (!src || !a || !b) throw new Error(`missing legs: source=${src} A=${a} B=${b}`);
  const deaf = audibleTo === 'listenerA' ? 'listenerB' : 'listenerA';
  const other = r => (r === 'listenerA' ? b : a);
  const mk = (role, hear) => ({ action: 'conversation', name: STATE.convName, startOnEnter: true, endOnExit: false, canHear: hear });
  STATE.routing[audibleTo] = { canHear: [src, other(audibleTo)] };
  STATE.routing[deaf] = { canHear: [other(deaf)] };
  const r1 = await vonagePut(legUuid(audibleTo), { action: 'transfer', destination: { type: 'ncco', ncco: [mk(audibleTo, [src, other(audibleTo)])] } });
  const r2 = await vonagePut(legUuid(deaf), { action: 'transfer', destination: { type: 'ncco', ncco: [mk(deaf, [other(deaf)])] } });
  return [r1, r2];
}

const MECHS = { B1: mechB1, B1H: mechB1H, B2: mechB2, C: mechC };

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '64mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_q, r) => r.json({ ok: true, appId: !!CFG.appId, key: !!PRIVATE_KEY, publicBase: CFG.publicBase }));

// clock sync: client estimates offset from these
app.get('/time', (_q, res) => res.json({ server_ms: Date.now() }));

app.get('/token', (req, res) => {
  const role = String(req.query.role || '');
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES}` });
  try { res.json({ token: clientJwt(role), role, conversationName: CFG.convName }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

/** Extract role from however Vonage delivered custom_data (GET query vs POST body). */
function extractRole(req) {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  if (ROLES.includes(src.role)) return src.role;
  let cd = src.custom_data;
  if (typeof cd === 'string') { try { cd = JSON.parse(cd); } catch { cd = null; } }
  if (cd && ROLES.includes(cd.role)) return cd.role;
  for (const k of Object.keys(src)) {
    const m = k.match(/^custom_data[\[.]?role[\]]?$/);
    if (m && ROLES.includes(src[k])) return src[k];
  }
  return null;
}

app.all('/answer', (req, res) => {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const role = extractRole(req);
  const uuid = src.uuid || src.call_uuid;
  if (role && uuid) {
    STATE.legs[role] = {
      ...(STATE.legs[role] || {}), role, uuid,
      conversation_uuid: src.conversation_uuid || STATE.legs[role]?.conversation_uuid,
      region_url: src.region_url || STATE.legs[role]?.region_url,
      answeredAt: Date.now(),
    };
    console.log(`[answer] role=${role} uuid=${uuid} conv=${src.conversation_uuid} region=${src.region_url || '-'}`);
  } else {
    console.warn('[answer] could NOT resolve role/uuid. keys=', Object.keys(src).join(','));
  }
  res.json(role ? conversationNcco(role) : [{ action: 'talk', text: 'Role missing.' }]);
});

app.all('/event', (req, res) => {
  const b = { ...(req.query || {}), ...(req.body || {}) };
  STATE.events.push({ t_ms: Date.now(), ...b });
  const role = Object.keys(STATE.legs).find(r => STATE.legs[r]?.uuid === b.uuid);
  if (role) STATE.legs[role].status = b.status;
  if (b.status && ['completed', 'failed', 'rejected', 'unanswered', 'busy'].includes(b.status)) {
    console.warn(`[event] LEG DROP status=${b.status} uuid=${b.uuid} role=${role || '?'}`);
  }
  res.sendStatus(204);
});

app.post('/reset', async (_q, res) => {
  // Hang up anything still in progress. Stale legs from an earlier run stay in the
  // named conversation and silently poison the next run's baseline.
  let hungUp = 0;
  try {
    const r = await fetch(`${regionBase()}/v1/calls?status=started`, { headers: { Authorization: `Bearer ${appJwt()}` } });
    if (r.ok) {
      const j = await r.json();
      for (const c of (j._embedded?.calls || [])) {
        await fetch(`${regionBase()}/v1/calls/${c.uuid}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${appJwt()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'hangup' }),
        }).catch(() => {});
        hungUp++;
      }
    }
  } catch (e) { console.warn('[reset] cleanup skipped:', String(e).slice(0, 80)); }

  STATE.legs = {}; STATE.flips = []; STATE.events = []; STATE.restRequests = []; STATE.errors = [];
  STATE.routing = { source: { canSpeak: null, canHear: null }, listenerA: {}, listenerB: {} };
  STATE.audibleTo = null; STATE.epochMs = Date.now();
  // A FRESH room every run. Reusing one name lets a previous run's participants and
  // routing state leak into the next one.
  STATE.convName = `${CFG.convName}-${Date.now().toString(36)}`;
  console.log(`[reset] state cleared, hung up ${hungUp} stale call(s), room=${STATE.convName}`);
  res.json({ ok: true, conversationName: STATE.convName, hungUp });
});

app.get('/state', (_q, res) => res.json({
  epochMs: STATE.epochMs, mechanism: STATE.mechanism, conversationName: CFG.convName,
  legs: STATE.legs, routing: STATE.routing, audibleTo: STATE.audibleTo, room: STATE.convName,
  flips: STATE.flips.length, errors: STATE.errors.length,
  ready: ROLES.every(r => !!legUuid(r)),
}));

/** One flip. Returns the exact wall-clock ms at which Vonage returned 2xx. */
app.post('/control/flip', async (req, res) => {
  const audibleTo = req.body?.audibleTo === 'listenerB' ? 'listenerB' : 'listenerA';
  const mech = MECHS[req.body?.mechanism || STATE.mechanism];
  if (!mech) return res.status(400).json({ error: 'unknown mechanism' });
  try {
    const reqs = await mech(audibleTo);
    STATE.audibleTo = audibleTo;
    const ok = reqs.every(r => r.status >= 200 && r.status < 300);
    const flip = {
      n: STATE.flips.length + 1,
      audibleTo, mechanism: req.body?.mechanism || STATE.mechanism,
      // Gate 2 anchor: wall clock of the LAST 2xx for this flip
      t_ack_ms: Math.max(...reqs.map(r => r.t_ack_ms)),
      t_sent_ms: Math.min(...reqs.map(r => r.t_sent_ms)),
      ok, statuses: reqs.map(r => r.status), requests: reqs,
    };
    STATE.flips.push(flip);
    res.json(flip);
  } catch (e) {
    STATE.errors.push({ error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

/** Full sequence: baseline, then N flips spaced holdMs apart. */
app.post('/control/run', async (req, res) => {
  const flips = Number(req.body?.flips ?? 50);
  const holdMs = Number(req.body?.holdMs ?? 2000);
  const mechanism = req.body?.mechanism || STATE.mechanism;
  if (!ROLES.every(r => legUuid(r))) return res.status(409).json({ error: 'not all three legs connected', legs: STATE.legs });
  res.json({ started: true, flips, holdMs, mechanism });
  (async () => {
    for (let i = 0; i < flips; i++) {
      const audibleTo = i % 2 === 0 ? 'listenerA' : 'listenerB';
      try {
        const reqs = await MECHS[mechanism](audibleTo);
        STATE.audibleTo = audibleTo;
        STATE.flips.push({
          n: STATE.flips.length + 1, audibleTo, mechanism,
          t_ack_ms: Math.max(...reqs.map(r => r.t_ack_ms)),
          t_sent_ms: Math.min(...reqs.map(r => r.t_sent_ms)),
          ok: reqs.every(r => r.status >= 200 && r.status < 300),
          statuses: reqs.map(r => r.status), requests: reqs,
        });
        console.log(`[flip ${i + 1}/${flips}] audibleTo=${audibleTo} status=${reqs.map(r => r.status).join(',')}`);
      } catch (e) {
        STATE.errors.push({ flip: i + 1, error: String(e) });
        console.error(`[flip ${i + 1}] ERROR ${e}`);
      }
      await new Promise(r => setTimeout(r, holdMs));
    }
    console.log('[run] sequence complete');
  })();
});

/** Listeners POST their sample arrays here at the end of the run. */
app.post('/ingest', (req, res) => {
  const { role, samples, clockOffsetMs, meta } = req.body || {};
  if (!role || !Array.isArray(samples)) return res.status(400).json({ error: 'role and samples[] required' });
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csv = path.join(dir, `samples_${role}_${stamp}.csv`);
  const out = ['timestamp_ms,bin_magnitude_db'];
  for (const s of samples) out.push(`${s.t},${s.db}`);
  fs.writeFileSync(csv, out.join('\n'));
  fs.writeFileSync(csv.replace(/\.csv$/, '.meta.json'), JSON.stringify({ role, clockOffsetMs, meta, count: samples.length }, null, 2));
  console.log(`[ingest] ${role}: ${samples.length} samples -> ${csv} (clockOffsetMs=${clockOffsetMs})`);
  res.json({ ok: true, file: csv, count: samples.length });
});

/** Dump every server-side fact needed to compute the gates. */
app.post('/dump', (_q, res) => {
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const f = path.join(dir, `serverlog_${stamp}.json`);
  fs.writeFileSync(f, JSON.stringify({
    epochMs: STATE.epochMs,
    mechanism: [...new Set(STATE.flips.map(f => f.mechanism))].join('+') || STATE.mechanism,
    conversationName: CFG.convName,
    legs: STATE.legs, flips: STATE.flips, events: STATE.events,
    restRequests: STATE.restRequests, errors: STATE.errors,
  }, null, 2));
  const fcsv = path.join(dir, `flips_${stamp}.csv`);
  const rows = ['flip_n,audibleTo,mechanism,t_sent_ms,t_ack_ms,rtt_ms,statuses,ok'];
  for (const f2 of STATE.flips) rows.push([f2.n, f2.audibleTo, f2.mechanism, f2.t_sent_ms, f2.t_ack_ms, f2.t_ack_ms - f2.t_sent_ms, `"${f2.statuses.join('|')}"`, f2.ok].join(','));
  fs.writeFileSync(fcsv, rows.join('\n'));
  console.log(`[dump] ${f}\n[dump] ${fcsv}`);
  res.json({ ok: true, json: f, csv: fcsv, flips: STATE.flips.length, errors: STATE.errors.length });
});

app.listen(CFG.port, () => {
  console.log(`\nGATE 1 SPIKE server on http://localhost:${CFG.port}`);
  console.log(`  mechanism = ${STATE.mechanism}   conversation = ${CFG.convName}`);
  console.log(`  answer_url = ${CFG.publicBase || '<SET PUBLIC_BASE_URL>'}/answer`);
  console.log(`  event_url  = ${CFG.publicBase || '<SET PUBLIC_BASE_URL>'}/event`);
  if (!CFG.appId) console.log('  !! VONAGE_APPLICATION_ID unset — copy .env.example to .env');
});
