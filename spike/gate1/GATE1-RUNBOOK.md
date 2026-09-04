# GATE 1 SPIKE — runbook

Rig is built and its instrument is verified. It is blocked on ONE thing: **Vonage credentials.**
There are none on this machine (searched `~/dev`, `~/Desktop`, `~/Downloads`, `~/Documents`,
env vars and Keychain — zero hits for vonage/nexmo).

I cannot create the account or handle the private key for you: creating accounts and entering
credentials is off-limits for me. The three steps below are yours; everything after is automated.

## What you do (about 10 minutes)

1. **Create a Vonage application** at <https://dashboard.vonage.com/applications> with the
   **Voice** capability enabled. Generate the public/private key pair; the browser downloads
   `private.key`. Put that file at the root of this folder (it is already gitignored).
2. **Start the tunnel** so Vonage can reach the webhooks:
   ```
   cloudflared tunnel --url http://localhost:3131
   ```
   Copy the `https://<something>.trycloudflare.com` URL it prints.
3. **Fill in `.env`** (copy from `.env.example`):
   ```
   VONAGE_APPLICATION_ID=<from the dashboard>
   VONAGE_PRIVATE_KEY_PATH=./private.key
   PUBLIC_BASE_URL=https://<something>.trycloudflare.com
   PORT=3131
   ```
   Then in the dashboard set the application's
   **Answer URL** to `<PUBLIC_BASE_URL>/answer` and **Event URL** to `<PUBLIC_BASE_URL>/event`.
   Also add three **users** to the application named exactly `source`, `listenerA`, `listenerB`.

No phone number is needed. All three legs are browser legs, so the run costs approximately nothing.

## Then the run (automated)

```
node tools/selftest.mjs                 # instrument must pass BEFORE any real number is trusted
node server.js                          # or: PORT=3131 node server.js
```

Open **three visible tabs** (do not minimise them; the SDK is throttled in background tabs even
though the audio sampling is not):

- `http://localhost:3131/` role **source**  ← connect this FIRST
- `http://localhost:3131/` role **listenerA**
- `http://localhost:3131/` role **listenerB**

Confirm baseline: both listeners should show strong energy near -6 to -30 dB. Then:

```
# 50 flips, 2 s apart, canSpeak mechanism
curl -X POST localhost:3131/control/run -H 'content-type: application/json' \
     -d '{"flips":50,"holdMs":2000,"mechanism":"B1"}'
```

`mechanism` is one of:

| | what it mutates | why |
|---|---|---|
| `B1` | SOURCE's `canSpeak` via transfer + inline `conversation` action | the primary test |
| `B1H` | each LISTENER's `canHear` via transfer | the canHear counterpart, so the answer is not canSpeak-only |
| `B2` | inline `transfer` NCCO action by `conversation_id` | the documented alternative |
| `C` | `earmuff` / `unearmuff` | **latency floor only.** Global, so it CANNOT produce selective routing. A pass here is NOT a project pass. |

When the run finishes: press **upload samples** in both listener tabs, then

```
curl -X POST localhost:3131/dump
node tools/analyze.mjs
```

`analyze.mjs` prints Gate 1 / 2 / 3 and **exits nonzero unless every gate passes.**

## What the rig refuses to do

It will not hand you a number it cannot stand behind. Specifically it fails closed when:

- separation is not finite (an `Infinity` separation is a broken measurement, not a pass — it would
  otherwise sail through `>= 40`);
- Gate 1 fails, in which case Gate 2 is **SUPPRESSED**, because a latency between two states that
  were never distinguishable is meaningless;
- any transition never crosses the midpoint;
- any latency comes out **negative**, which means the clock offset is wrong;
- zero REST requests were recorded, i.e. the run did not happen;
- the input CSVs are missing, in which case it prints `NO NUMBERS PRODUCED` and exits 2.

## Known measurement caveats, stated up front

- **Sampling is on the audio thread** (`public/tone-probe.worklet.js`, Goertzel at 1000 Hz over a
  20 ms window). This is a deliberate deviation from "AnalyserNode every 20 ms": a main-thread
  `setInterval` is throttled to ~1 Hz in a background tab, which was **measured on this machine at
  1.2 Hz** and would have turned Gate 2 into a readout of Chrome's throttle period. Audio-thread
  sampling measured **49.9 Hz**.
- Gate 2 subtracts a server wall-clock instant from a listener sample time, so it inherits the
  clock-sync residual (reported per listener as ±½ the best observed RTT, typically single-digit ms
  on localhost) plus the audio output latency, both recorded in the `.meta.json` sidecar.
- Trial accounts are limited to ~3 calls/sec, roughly 15 REST req/s. At 50 flips 2 s apart this rig
  runs at ~0.5-1.0 req/s. Gate 3 reports the measured peak; if a limit is hit it is reported as a
  finding, not worked around.
