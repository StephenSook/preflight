# Film narration, draft 1 (for approval Mon 2026-09-07 by 12:00)

Five minutes maximum. Every figure below is from `docs/fact-sheet.md`; a figure that changes daily is
marked LIVE and is read off the screen in the take, not spoken from memory. Shots marked SCREEN
depend on the web app and are cut to the API surface if the site misses its Monday 18:00 cutoff.
Real calls, a real phone on the table, no fiction, no synthetic data. The narration is submitted as
text beside the video, as the organizers ask.

Beat timing follows the specification's shot list and the organizers' four required beats: what
the idea is, how it uses the Vonage APIs, how it hits the lenses, what problem it solves.

## 0:00 to 0:25, the problem on a real object (what the idea is)

SCREEN: a call-control object from the reference application, the timeout branch lit red.

> This is a call flow. It is a JSON object my server returns when the Vonage platform asks what to
> do on a call. It plays a greeting and connects you to a scheduler. On one branch, the one that
> runs when nobody presses a key, it speaks with a synthesized voice and offers no way to opt out.
> I wrote this flow at the Atlanta workshop, and I did not know that branch was there until I built
> this.

## 0:25 to 0:45, the promise

> Preflight reads the call flow my server is about to serve, decides whether it would break federal
> law, and stops the call before the network ever sees it. No model decides. A monitor compiled from
> the statute does.

## 0:45 to 1:30, declared versus actual (how it uses the Voice API)

SCREEN: the flow graph. Two colours: declared states, one undeclared state in red.

> The platform asks my server for a new object every time a caller presses a key or stays silent,
> so no single document contains the flow. Preflight sits on the answer and event webhooks, verifies
> the platform's signed callbacks, and discovers the graph from real traffic. Here is what I
> declared my flow does. Here is what it actually served. One state I never declared, and it
> speaks.

## 1:30 to 2:30, the block, live (real-time window, uncut)

SCREEN: the live monitor. The phone on the table, in frame. A number is submitted through the
consent gate; the verification call is answered; the code is entered; the call is requested.

> This is my phone. Preflight is also the create-call gateway, because the platform only asks for
> the flow once a call is answered; I measured that: the call was answered at 868 milliseconds and
> the flow was asked for at 1,009. So the request goes to Preflight first. It pre-fetches the flow,
> runs every monitor, and refuses it. 47 CFR 64.1200(b)(3): no opt-out reachable from a state that
> speaks. The row goes dark. The citation prints. And the phone stays silent.

Hold the silence for a full beat. The absence is the product.

## 2:30 to 3:15, the counterexample and the fix

SCREEN: block detail with the witness path; the reference application switched to its fixed
flow; the same number submitted again.

> This is not a summary. It is the exact sequence of actions that would have reached the
> prohibited state. The fix is one action: the keypress goes to the declared opt-out handler. Same
> phone, same number, a few minutes apart.

The phone rings. Answer it on camera.

## 3:15 to 3:50, the evidence

SCREEN: the evidence log, then a terminal.

> Every decision is an entry in a hash-chained log. The head is signed and uploaded to Sigstore's
> public transparency log once a day. And every night, the platform's own call records are pulled
> and reconciled against the log: every record a call the interlock decided, and no record lining
> up with a request the gateway refused.

Terminal, typed live: `npx -y preflight-interlock verify-ledger https://preflight-api-rc34.onrender.com`.

> LIVE: read the entry count and "every hash and link recomputed from genesis" off the terminal.
> You cannot rewrite this, and neither can I.

## 3:50 to 4:20, real-world potential (what problem it solves, who it is for)

> Liability under the federal rule is per call, not per campaign: 500 dollars for each violation,
> up to three times that at the court's discretion when it is willful. Georgia removed the knowledge
> requirement from its own statute on July 1, 2024 and extended liability to whoever the call is
> made on behalf of: up to 2,000 dollars for each violation in Attorney General proceedings, up to
> 1,000 in a private action, with no cap in a class action. A clinic, a county office, a campus
> alert system running notification calls on Vonage is now exposed for a vendor's flow it cannot
> read. Preflight is the thing that reads it.

## 4:20 to 4:45, the honest limit

SCREEN: the header's coverage counter.

> LIVE: read the coverage figure off the header. It has seen this many of the declared endpoints.
> It has not verified the rest, and it says so. It checks structure and position, never whether the
> words spoken are true. It is a compliance tool, not legal advice.

## 4:45 to 5:00, close

SCREEN: the public number, the URL, the repository.

> Dial it yourself: plus one, nine four three, two four four, five zero two three. The code, the
> corpus, the mutants and the log are public.

## Not in this script, on purpose

- No registry size, no settlement figure: neither has a fact-sheet row with a primary source yet.
- No latency number spoken; the header shows LIVE percentiles if the take wants them.
