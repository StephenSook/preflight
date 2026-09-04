# GATE 1 SPIKE — RESULT (run completed 2026-09-03)

**ANSWER: NO. Per-participant audio routing CANNOT be changed on a live Vonage conversation leg.**

**And the reason is not latency.** Mid-call REST control is fast: measured **103 ms median, 183 ms p95**
over 50 flips, comfortably inside the "clean pass" band. What does not exist is the *selectivity*.
The only thing that actually changes audio on a connected leg is an **all-or-nothing** switch.

Per the brief's own criteria: **the project as specified is dead. Pivot today.**

---

## 1. Step 0 findings (docs), all verified first-hand

Authoritative spec, downloaded and kept: `results/step0-evidence/voice-openapi-v1.json`
(62,245 bytes, OpenAPI 3.0.0, Voice API **v1.10.0**), from
`https://developer.vonage.com/api/v1/developer/api/file/voice?format=json&vendorId=vonage`
There is **no public Vonage OpenAPI repo** on GitHub, and the `APIs-guru` mirror is stale (2023) and
carries a real bug (`UpdateCallRequestUnmute` with `"enum":["mute"]`). Do not use the mirror.

- **`canSpeak`/`canHear` take LEG UUIDs** and are `conversation`-action NCCO parameters applied at
  JOIN. <https://developer.vonage.com/en/voice/voice-api/ncco-reference>
  > "A list of leg UUIDs that this participant can be heard by."

  The docs say **nothing** about changing them after join. Also: *"When using `canSpeak`, the `mute`
  parameter is not supported."*
- **`PUT /v1/calls/{uuid}` has exactly six actions** — transfer, hangup, mute, unmute, earmuff,
  unearmuff. The assumption that mute/earmuff are global was **confirmed**: each of those four
  schemas has *exactly one property*, e.g. `"description": "Prevent the specified UUID from hearing
  audio"`. No counterparty argument anywhere. `canspeak`/`canhear` appear **0 times** in the entire spec.
- **Conversation API has no path either.** `PATCH /v1/conversations/{id}/members/{member_id}` carries
  only `{state, from, reason}`; verified against the schema and four server SDKs, none of which sends
  `media` on PATCH. `media.audio_settings` is `{enabled, earmuffed, muted}` — **global booleans**, and
  a *create-member* parameter. `string[]` in the Voice NCCO vs `boolean` in the Conversation API.
- **Client SDK confirmed**: `serverCall(context?)` → callId, context arrives as `custom_data`.

**Mechanism A (direct mutation) does not exist.** Mechanism B did exist on paper — `destination.ncco`
is declared `"items": {"type":"object"}`, completely unconstrained — so the rig was built and B was
tested empirically. That is what follows.

## 2. Mechanisms tested, and how each failed

| mechanism | what it does | result |
|---|---|---|
| **A** direct mutation | — | **does not exist** (docs + spec + 5 SDKs) |
| **B1** `canSpeak` on source, via `transfer` + inline `conversation` NCCO | re-declare who may hear the source | **FAILS** |
| **B1H** `canHear` on each listener, via `transfer` | re-declare what each listener hears | **FAILS, differently** |
| **C** `earmuff`/`unearmuff` | global per-leg deafen | **works, but all-or-nothing** |

**B1 — no effect, then it breaks the call.**
At n=6 every request returned **204** and the measured separation was **0.0 dB**: the NCCO carried the
correct listener leg UUID in `canSpeak`, Vonage accepted it, and *both listeners kept hearing the
source identically*. At n=50 it got worse: the first **3** transfers returned 204 and the remaining
**47 returned HTTP 400 `{"type":"BAD_REQUEST"}`**, with **4 legs dropped**. Repeatedly transferring a
leg into a conversation action is not just ineffective, it is destructive.

**B1H — not selective, just silence.** Transferring the *listeners* with a fresh `canHear` dropped both
listeners from -6.1 dB to **-128.6 dB permanently**; they never recovered. Separation **0.0 dB**.

**C — the control, and the proof the rig is sound.** Runs clean at n=50 (numbers in §3-5). Because C
produces a 122.5 dB swing on the same rig that reports 0.0 dB for B1, **B1's zero is a real negative,
not a broken instrument.** But C is documented as, and behaves as, a global switch on one leg. It
**cannot** express "X is audible to A and not to B", so a C pass is **not** a project pass.

## 3. Gate 1 — separation

| mechanism | separation | verdict |
|---|---|---|
| **C** (50 flips) | **122.5 dB** | PASS (threshold 40 dB) |
| B1 (50 flips) | **0.5 dB** | FAIL |
| B1 (6 flips) | **0.0 dB** | FAIL |
| B1H (6 flips) | **0.0 dB** | FAIL (both legs silent) |

Audible state measured at -6.1 dB, muted at -128.6 dB.

## 4. Gate 2 — latency

**Only mechanism C produced a valid latency number**, because latency between two states is
meaningless if the two states were never distinguishable. The analyzer **suppresses** Gate 2 whenever
Gate 1 fails, and it did so for B1 and B1H.

**Mechanism C, 50 flips, 98/98 transitions resolved:**
- **median 103 ms**, **p95 183 ms**
- fall (goes silent): median 66 ms, p95 109 ms
- rise (becomes audible): median 138 ms, p95 184 ms

That is a **clean pass** (median < 400 ms, p95 < 800 ms). Flips completed: **50 of 50**.

This matters for the pivot: **mid-call REST control of audio is fast and reliable.** The constraint is
purely that the control is global.

## 5. Gate 3 — stability

| | mechanism C (50 flips) | mechanism B1 (50 flips) |
|---|---|---|
| REST requests | 100 | 50 |
| non-2xx | **0** | **47 (HTTP 400)** |
| dropped legs | **0** | **4** |
| peak request rate | 2 req/s | 1 req/s |
| verdict | **PASS** | **FAIL** |

Peak rate stayed far under the ~15 req/s trial ceiling; no rate limit was ever hit.

## 6. Raw data on disk

Workspace `~/Desktop/DIALED IN Builder Challenge`:

- `results/FINAL_C_50flips_serverlog.json` + `FINAL_C_50flips_listenerA.csv` / `...listenerB.csv`
- `results/FINAL_B1_50flips_serverlog.json` + `FINAL_B1_50flips_listenerA.csv` / `...listenerB.csv`
- `results/step0-evidence/voice-openapi-v1.json` — the spec every Step 0 claim is checked against

CSV columns are `timestamp_ms,bin_magnitude_db`, timestamps on the server clock.
Every latency number derives from the server-side wall clock of the HTTP 2xx, recorded per request in
the serverlog alongside the exact body sent and the exact response returned.

Regenerate the verdicts: `node tools/analyze.mjs`
Re-run a mechanism end to end: `node tools/run-spike.mjs <B1|B1H|C> 50 2000`
Prove the instrument before trusting it: `node tools/selftest.mjs`

## 7. Surprises, and they changed the result

1. **The spec'd measurement method could not have worked.** The brief asked for an `AnalyserNode`
   sampled every 20 ms. Chrome throttles main-thread timers to ~1 Hz in a background tab — **measured
   here at 1.2 Hz**. Gate 2 would have been a readout of Chrome's throttle period wearing a
   millisecond costume. Detection was moved onto the **audio thread** (`AudioWorkletProcessor`,
   Goertzel at 1000 Hz, timestamped from the audio clock). Measured after the fix: **49.9 Hz**.
2. **`-Infinity` dB satisfies `>= 40`.** Against digital silence the muted median was `-Infinity`, so
   separation was `Infinity` and the harness printed "INSTRUMENT OK". Every threshold now requires
   `Number.isFinite` first.
3. **The fail-closed guard earned its place twice.** For B1 the analyzer suppressed a very tempting
   "median 14 ms" and for B1H a "median 5 ms" — beautiful latency numbers for mechanisms that do
   nothing at all. Without that suppression this report would have claimed B1 works with a 14 ms
   response time.
4. **A control run is the only reason the negative is trustworthy.** Mechanism C exists in the rig
   purely to prove the instrument can see a change. It is why "B1 does nothing" can be asserted rather
   than "we measured nothing".
5. **A stale artifact read as a fresh pass.** One B1H run never started (server was down) and
   `analyze.mjs` silently re-analysed the *previous* run's files and printed PASS. A freshness and
   coherence guard now refuses inputs that are not from one run.
6. **Cross-run contamination is real.** Reusing one conversation name let earlier runs' legs linger in
   the room and silently poisoned a later run's baseline (one listener sat at -128 dB from the start).
   Each run now gets a fresh room and hangs up leftovers, and the driver aborts if either listener is
   not hearing the tone *before* any flip.
7. Firecrawl is out of API credits (HTTP 402) — reported rather than silently worked around.

## What this means for the design

- A design needing **continuous, selective, per-pair** routing changes mid-call is **not buildable**
  on the Vonage Voice API today.
- A design needing **discrete global** audio changes per participant **is** buildable, and it is fast:
  103 ms median, 183 ms p95, 0 errors and 0 dropped legs across 50 flips.
- Selective routing remains available **at join time only** (`canSpeak`/`canHear` in the `conversation`
  action). Any change to it requires the participant to re-join, and re-joining via `transfer` was
  measured to be either inert (B1) or destructive (B1H, and B1 at scale: 47×400 plus 4 dropped legs).
