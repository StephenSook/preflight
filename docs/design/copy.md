# Public site copy, first draft for the Sat 2026-09-05 20:00 checkpoint

Every number here comes from `docs/fact-sheet.md`. Where a figure is live it is marked LIVE and the
site reads it from `/api/summary` on every load; the copy never hard-codes it. Where a figure would
help but has no fact-sheet row yet, the line is marked NOT YET SOURCED and stays out of the build
until the row exists. Plain declaratives, no exclamation marks, no adjectives doing the work.

Voice: a pilot's checklist read aloud. Short sentences. The tower says "cleared", "hold short" or
"no-go", and so does the product.

## Preloader

- Mark: the runway centreline draws across the screen, the handset mark pops in, then out.
- No words. Reduced motion: no preloader.

## 1. Hero (paper)

**Headline, option A (recommended):**
Watch a call that would break federal law stop before the network ever hears it.

**Headline, option B:**
The call that doesn't happen.

**Headline, option C:**
Your server is about to serve a call flow. Preflight reads it first.

**Subheadline:**
Preflight sits inside your Vonage account, in the call-control path. It reads the flow your own
server is about to serve, runs monitors compiled from the federal and Georgia telemarketing rules
over it, and refuses the call before the carrier is asked to place it. Then the fix is made and the
same phone rings.

**Handwritten note beside the hero:** no model decides.

**Primary call to action:** Dial it yourself (scrolls to section 5)
**Secondary:** Read the evidence log (scrolls to section 7)

Why A: a sensory verb first, the restraint claim second, one sentence a judge can repeat. B is the
README's own line and works as a section title later. C names the mechanism but loses the phone.

## 2. The problem, on a real object (sky)

**Section title:** One branch nobody traced.

A call flow is a JSON object your server returns when the platform asks what to do. This one plays
a greeting and connects you to a scheduler. On one branch, the one that runs when nobody presses a
key, it speaks with a synthesized voice and offers no way to opt out. Nobody traced it, because no
single document contains it: the platform asks your server for a new object every time a caller
presses a key or stays silent.

**Handwritten note on the red branch:** this line breaks 47 CFR 64.1200(b)(3)

**Under the object:**
Liability accrues per call, not per campaign: 500 USD for each violation under 47 U.S.C. 227(b)(3),
up to three times that at the court's discretion for a willful or knowing violation. Georgia
removed the knowledge requirement from its own statute on July 1, 2024 and extended liability to
whoever the call is made on behalf of: up to 2,000 USD for each violation in Attorney General
proceedings, up to 1,000 USD for each violation in a private action, no cap in a class action.

## 3. The block, live (paper, safety-orange sticker)

**Section title:** Recomputed on every load.

Three counters, read from `/api/summary`: blocked before dial, held for a person, placed. Beneath
them the evidence-log head hash and the verify command. LIVE.

**Caption:** These are the interlock's own counts on the deployed host, not a screenshot. Reload
and they recompute. The chain head below is sealed to a public transparency log once a day.

**Sticker:** the phone stayed silent

## 4. How it works (pale sky, four fanned cards)

**Section title:** Four things, in order, every call.

1. **Read the flow.** The platform calls Preflight instead of your server. Preflight verifies the
   platform's signature, forwards the request to your real server unchanged, and reads the object
   that comes back.
2. **Compile the statute.** Five properties, each a formula over what the object does: calling
   hours, identification first, an opt-out that can be reached, a caller id that is set, Georgia's
   identification-first rule. Each carries its citation, and each quoted clause is a byte-for-byte
   substring of the fetched text, enforced by a test.
3. **Decide before the dial.** Every monitor is true, the object passes through byte for byte. Any
   monitor is false, the call is refused and a safe object names the rule. A monitor that cannot
   decide holds the call for a person, because it does not guess.
4. **Write the receipt.** Every decision is an entry in a hash-chained log. The head is sealed to
   Sigstore Rekor daily, and the platform's own call records are reconciled against the log every
   night: nothing the interlock refused has reached the carrier.

**Card note (handwritten, card 3):** outbound calls go through the gateway, because the platform
only asks for the flow once a call is answered. Measured: answered at 868 ms, the flow asked for at
1,009 ms.

## 5. Dial it yourself (cobalt, white text)

**Section title:** +1 943 244 5023

**Body:** That number runs the small notification flow from section 2, on purpose, with the defect
in it. Call it and you hear the interlock intervene.

**The consent gate, one sentence:** To have Preflight call you instead, enter your number; the
platform calls it first and speaks a four-digit code, and only that code lets one demonstration
call through. Your number is kept as a hash, never as digits.

**Buttons:** Call me with the code · I have the code

**Below:** No phone at hand? The browser softphone places the same call from this page. (Built on
`/phone/`; the call itself has not yet been placed from a browser, and the README says so.)

## 6. Sandbox (paper, mono)

**Section title:** Paste an object. No account.

**Body:** The same engine that decides on the host runs here in your browser. Paste a call-control
object and every property answers in under a second, with its citation and, on a false, the exact
sequence of actions that reached the prohibited state.

**Small print:** A single object, not your whole flow. Discovery of the branches your server
serves at runtime happens on the host, from traffic.

## 7. The evidence (cockpit dark)

**Section title:** You cannot rewrite this, and neither can we.

**Body:** Every decision is an entry. Each entry hashes its own canonical form together with the
previous entry's hash. The head is signed and uploaded to a public transparency log once a day.
Anyone with the URL recomputes the chain from genesis:

```
npx preflight-interlock verify-ledger https://preflight-api-rc34.onrender.com
```

**Reconciliation line, LIVE:** last carrier reconciliation: N records from the platform's own
report, N matched, 0 leaked past a refusal.

**Rekor line:** `rekor-cli verify --uuid <last seal>` printed with the last seal's uuid, LIVE.

## 8. Honest limits (paper, accordion)

The same text as the README's honesty section, verbatim, so the two cannot drift:

- Preflight verifies the structure of your call flow against a published set of rules. It does not
  verify consent, business relationships, or the content of what is spoken.
- Coverage is reported as endpoints observed over endpoints declared. A branch never exercised has
  never been checked, and the header says so.
- A rate center is a proxy for where the called party is. Mobile numbers travel.
- The consent gate records that a person consented to this demonstration call. It is not
  campaign-level consent record-keeping.
- Compliance tool, not legal advice.

## 9. Footer (parallax)

The public number, large. The repository. The evidence-log head. The handset visual swings in.

**Line:** Built for the DIALED IN Builder Challenge, Atlanta cohort. Apache-2.0.

## Dashboard copy (six screens, cockpit)

Header, always visible: PREFLIGHT · LIVE · coverage N of M endpoints · N states · verify p50 N ms.
Rows carry three tokens and three colours only: BLOCKED, HELD, PLACED.

- Live Monitor: destination · rule / path · state.
- Block Detail: "P3 · no opt-out reachable from a synthetic-speech state", the citation sentence,
  WITNESS PATH, then the destination line: number · line type · via · confidence.
- Flow Graph: green observed and declared; red observed, not declared, "NOT DECLARED"; amber
  hollow declared, never observed, "declared, never observed, never verified".
- Held Queue: reason, the lookup state (pending · resolved · off), two buttons: Place anyway,
  Cancel. "Every override is a ledger entry."
- Evidence Log: seq · time · kind · property · citation · hash, the verify command on the page.
- Setup: three URLs to copy, the origin, the policy toggle, the declaration, Install and Roll back.

## Devpost tagline (draft, sensory verb first, restraint second)

Watch a call that would break federal law stop before the network ever hears it, then ring the
moment the flow is fixed. No model decides; a monitor compiled from the statute does.

## NOT YET SOURCED (kept out of the build until a fact-sheet row exists)

- The size of the beneficiary population (registered numbers on the national registry; the FTC data
  book figure) needs its primary-source row before it is printed anywhere.
- The Capital One settlement figure, same rule.
