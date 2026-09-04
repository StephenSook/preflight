/* GATE 1 SPIKE leg client. Deterministic tone source + audio-thread 1000 Hz probe. No microphone. */
const $ = s => document.querySelector(s);
const logEl = $('#log');
const L = (m, cls = '') => { logEl.innerHTML += `\n<span class="${cls}">${m}</span>`; logEl.scrollTop = 1e9; console.log(m); };

const TONE_HZ = 1000;

let clockOffsetMs = 0;                 // serverMs = timeOrigin + performance.now() + offset
const nowServer = () => performance.timeOrigin + performance.now() + clockOffsetMs;

const samples = [];                    // { t: serverMs, db }
let ac = null, client = null, callId = null, role = null;
let probe = null, sinkEl = null, anchor = null, meta = {};

/* ---------- clock sync: 9 probes, keep the lowest-RTT estimate ---------- */
async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    const j = await (await fetch('/time', { cache: 'no-store' })).json();
    const t1 = performance.now();
    const rtt = t1 - t0;
    if (rtt < best) { best = rtt; clockOffsetMs = j.server_ms - (performance.timeOrigin + t0 + rtt / 2); }
  }
  meta.clockOffsetMs = clockOffsetMs; meta.clockBestRttMs = best;
  L(`clock synced: offset=${clockOffsetMs.toFixed(1)}ms bestRTT=${best.toFixed(1)}ms (+/-${(best / 2).toFixed(1)}ms residual)`, 'k');
}

/* ---------- SOURCE: synthesized 1000 Hz, injected in place of the mic ---------- */
function buildToneStream() {
  const osc = ac.createOscillator(); osc.type = 'sine'; osc.frequency.value = TONE_HZ;
  const g = ac.createGain(); g.gain.value = 0.5;
  const dest = ac.createMediaStreamDestination();
  osc.connect(g).connect(dest); osc.start();
  L(`tone source built: ${TONE_HZ} Hz sine, ctx=${ac.sampleRate} Hz`, 'ok');
  return dest.stream;
}
function installToneAsMicrophone(toneStream) {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (c && c.audio) { L('getUserMedia intercepted -> synthesized tone (NOT a microphone)', 'ok'); return toneStream.clone(); }
    return orig(c);
  };
}

/* ---------- LISTENER: probe the inbound remote track on the AUDIO THREAD ---------- */
let attached = false;
async function attachProbe(stream) {
  if (attached) { L('ignoring a second inbound stream (already probing one)', 'k'); return; }
  if (!stream.getAudioTracks || stream.getAudioTracks().length === 0) return;
  attached = true;

  // Chrome will not pump a remote WebRTC stream into WebAudio unless it is also
  // attached to a media element. volume 0 keeps it silent without muting the pipeline.
  sinkEl = document.createElement('audio');
  sinkEl.autoplay = true; sinkEl.srcObject = stream; sinkEl.volume = 0;
  document.body.appendChild(sinkEl);

  await ac.audioWorklet.addModule('./tone-probe.worklet.js');
  const src = ac.createMediaStreamSource(stream);
  probe = new AudioWorkletNode(ac, 'tone-probe');
  const zero = ac.createGain(); zero.gain.value = 0;
  src.connect(probe); probe.connect(zero).connect(ac.destination);

  // Anchor the audio clock to the server clock ONCE. Sample times then come from the
  // audio clock, which a background tab cannot throttle.
  anchor = { ctx: ac.currentTime, server: nowServer() };
  meta.baseLatencyMs = (ac.baseLatency || 0) * 1000;
  meta.outputLatencyMs = (ac.outputLatency || 0) * 1000;

  probe.port.onmessage = (e) => {
    const d = e.data;
    if (d.kind === 'ready') {
      meta.probeN = d.N; meta.probeEffectiveHz = d.effectiveHz; meta.sampleRate = d.sampleRate;
      L(`probe ready on audio thread: N=${d.N} samples/window, bin centre ${d.effectiveHz.toFixed(1)} Hz`, 'ok');
      $('#up').disabled = false;
      return;
    }
    const t = anchor.server + (d.ctxTime - anchor.ctx) * 1000;
    samples.push({ t: Math.round(t), db: Number(d.db.toFixed(2)) });
    const pct = Math.max(0, Math.min(100, (d.db + 140) / 140 * 100));
    $('#bar').style.width = pct + '%';
    if (samples.length % 500 === 0) L(`samples=${samples.length} last=${d.db.toFixed(1)} dB`);
  };
}
function installRemoteTrackCapture() {
  const OrigPC = window.RTCPeerConnection;
  function Patched(...a) {
    const pc = new OrigPC(...a);
    pc.addEventListener('track', e => {
      if (e.track.kind !== 'audio') return;
      const st = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      L('remote audio track captured from RTCPeerConnection', 'ok');
      attachProbe(st).catch(err => L('attachProbe failed: ' + err, 'bad'));
    });
    return pc;
  }
  Patched.prototype = OrigPC.prototype;
  window.RTCPeerConnection = Patched;

  // Backup path: some SDK builds assign the stream straight to an element.
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  if (d && d.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      ...d,
      set(v) {
        d.set.call(this, v);
        // never re-capture our own silent sink element, and never capture an outbound stream
        if (v instanceof MediaStream && this !== sinkEl && v.getAudioTracks && v.getAudioTracks().length) {
          L('remote stream captured via srcObject', 'ok');
          attachProbe(v).catch(err => L('attachProbe failed: ' + err, 'bad'));
        }
      },
    });
  }
}

/* ---------- connect ---------- */
async function connect() {
  role = $('#role').value;
  $('#go').disabled = true;
  ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
  try { await ac.resume(); } catch (e) { L('resume rejected: ' + e, 'bad'); }
  L(`AudioContext ${ac.state} @ ${ac.sampleRate} Hz`, ac.state === 'running' ? 'ok' : 'bad');
  if (ac.state !== 'running') { L('FATAL: AudioContext not running. Click the page and retry.', 'bad'); return; }
  await syncClock();

  if (role === 'source') installToneAsMicrophone(buildToneStream());
  else installRemoteTrackCapture();

  const { token } = await (await fetch(`/token?role=${role}`)).json();
  const SDK = window.vonageClientSDK || window.VonageClientSDK || window;
  const Ctor = SDK.VonageClient || window.VonageClient;
  if (!Ctor) { L('FATAL: VonageClient constructor not found on the loaded bundle', 'bad'); return; }

  client = new Ctor();
  client.on('legStatusUpdate', (cid, legId, st) => L(`legStatusUpdate call=${cid} leg=${legId} status=${st}`, 'k'));
  client.on('callHangup', (cid) => L(`callHangup ${cid}`, 'bad'));

  await client.createSession(token);
  L(`session created as "${role}"`, 'ok');
  callId = await client.serverCall({ role });      // context arrives at answer_url as custom_data
  L(`serverCall -> callId=${callId}`, 'ok');
  $('#stop').disabled = false;
}

async function upload() {
  const r = await fetch('/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, samples, clockOffsetMs, meta }),
  });
  const j = await r.json();
  L(`uploaded ${samples.length} samples -> ${j.file}`, 'ok');
}

$('#go').onclick = () => connect().catch(e => L('ERROR ' + e, 'bad'));
$('#up').onclick = () => upload().catch(e => L('ERROR ' + e, 'bad'));
$('#stop').onclick = async () => { try { if (callId) await client.hangup(callId); } catch (e) { L(String(e), 'bad'); } };
L('ready. pick a role and press connect. source must be connected FIRST.');
L('KEEP EVERY TAB VISIBLE. Sampling is on the audio thread so it is throttle-proof, but the SDK is not.', 'k');
