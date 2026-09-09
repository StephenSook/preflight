# Devpost write-up, local draft awaiting organizer confirmation

This is a local draft, not a submitted entry. Confirm organizer eligibility, city/workshop-code requirements, the submission deadline and media limits before publication. No definite September 8 deadline or sanctioned fallback is assumed. Pending confirmation is not a claim of disqualification.

Revalidate the deployed frontend/API SHAs, actual recording and public links before copying this draft into any external form. Current source may be ahead of deployment. Numbers and dated evidence come from `docs/fact-sheet.md`; refresh counts separately after release. Verify persisted fields by full reload after any authorized submission edit.

The [demonstration is published on YouTube](https://www.youtube.com/watch?v=jKxf2M5xBuE). Its gateway run, silent iPhone footage and separately labelled browser-call audio are distinct evidence. Video publication does not establish submission status or organizer eligibility.

## Tagline

Inspect a failing call flow before the carrier is asked to dial. Preflight gives Vonage developers structural verdicts and a path to investigate.

## What it does

Preflight checks call-control objects and observed callback paths against encoded structural properties. The checks cite selected federal and Georgia provisions; they do not determine whether a call is lawful.

Outbound creation requests must go through its gateway for pre-dial enforcement. A block or hold stops forwarding. Passing requests go to Vonage, whose response determines whether a call was accepted. Signed answer and branch callbacks check flows after placement; changing webhooks alone cannot prevent dialing.

A failing monitor supplies a citation and witness path. An inconclusive result holds under strict policy. A named release approval permits resubmission, not immediate placement, and may allow inconclusive monitors without making them true. Decision records and placement receipts are distinct.

## Who it is for

Developers operating Vonage voice flows who need to inspect what their callbacks serve and compare it with their declaration. The reference application deliberately contains a timeout defect. It is not a customer deployment, a real clinic or a surprise discovery from the Atlanta workshop.

## Proposed lens

Real-World Use, subject to the organizer's confirmed form and eligibility requirements.

## What has actually been observed

These are separate September 8 checks, not one continuous personal-phone demonstration:

- The builder confirmed audible speech through the iPhone Client SDK softphone. The screenshot and matching ledger record support an already placed call with answer-time intervention. Exact spoken wording was not verified.
- The actual iPhone screenshot shows a native test notification. It proves that test push, not a newly generated held-call notification or delivery while the app was closed.
- A controlled gateway check between account-owned numbers recorded a refusal without a UUID and an unchanged signed-event count over the observation window. Its fixed-flow positive control recorded platform acceptance, a UUID and subsequent passing decisions. That does not prove the personal iPhone rang or stayed silent.

Use the dated records in the fact sheet. Do not present browser-test fixtures as telemetry or these historical checks as a fresh run of an unverified deployment.

## Vonage use and verification boundaries

- Voice API: call-control objects, signed answer/event/fallback callbacks and branch handling; outbound creation through the gateway. The fact sheet records real gateway and callback runs. Not every parsed action has been exercised live.
- Users API and Client SDK: session-token routes and the browser softphone are implemented; the iPhone audio check is the physical-device evidence described above.
- Numbers: the gateway check uses account-owned caller and destination numbers, separately from the personal-device evidence.
- Reports API: reconciliation is implemented and dated pulls are recorded in the fact sheet. A scheduled workflow is not proof of continuous successful reconciliation or carrier-wide absence.
- Verify v2 voice: implemented but personal-number verification was excluded from this demonstration. Do not claim that path was proven by the iPhone softphone test.
- Identity Insights: an optional asynchronous lookup is implemented, disabled unless configured. No production lookup result is claimed here.
- Application API: install and rollback handlers are implemented with read-back. Revalidate before demonstrating them; they do not redirect outbound creation requests into the gateway by themselves.
- Web Push: the test notification is separately evidenced. This is the service worker/Web Push path, not another Vonage API.

## How it works

1. Obtain the inline object or pre-fetch the configured origin for a gateway request. Verify platform signatures on answer and branch callbacks.
2. Evaluate structural monitors over the available flow and number facts. Matching a declared phrase or handler is narrower than proving truth, consent or legal applicability.
3. Block, hold or forward at the gateway. Inspect the platform receipt before claiming placement. Answer and branch decisions happen on an already placed call.
4. Append decision records to a hash-linked log. Inspect dated seals and reconciliation reports separately; their schedules do not establish their success.

## Inspect it without an account

- Public summary: `https://preflight-api-rc34.onrender.com/api/summary`.
- Browser checker: `https://preflight-web-nine.vercel.app/#sandbox`. It checks a pasted object locally, not all of a server's possible branches.
- Current-source checks and prerequisites: README Quickstart and `docs/judges.md`.
- Published `preflight-interlock@0.2.1` includes the September 8 engine and ledger-verification fixes. The fact sheet records a clean-directory, empty-cache check reproducing all 48 corpus labels and verifying the live ledger. Older 0.2.0 predates those fixes.

Availability must be checked before publication. Operator controls require a token; they are not part of the credential-free path.

## Honest limits

Coverage is relative to observed traffic and declared endpoints. A prefix-derived timezone is a proxy for the called party's location. The monitors do not verify consent, exemptions, business relationships or the truth of spoken words. The reference opt-out handler does not persist suppression records.

The implemented consent gate is for a demonstration call, not campaign consent. The private consent store retains the phone number; its public consent ledger entry uses a keyed hash. No personal-number Verify or ringing proof is claimed.

Hash-chain verification checks internal consistency. An independently verified external commitment can expose changes to sealed history, not prevent a database owner from modifying storage. This is a structural checking tool, not legal advice.

## Challenges

The answer webhook runs after answer, so the pre-dial path needed a create-call gateway. The fact sheet records the timing experiment behind that choice. Corpus tests exposed mistakes in the first identification and calling-hours formulas.

Reconciliation also needed to distinguish a gateway placement from an answer-time observation. Matching an already placed call is not proof it passed through the gateway. Older clean reports are not promoted into stronger claims than their recorded inputs support.

## What we learned

Separate a decision from placement, a test push from a real hold alert, and an audible SDK call from pre-dial enforcement. A live UI must preserve those distinctions. Local tests show behavior under their inputs; deployed evidence must identify its revision and observation window.

## Submission handoff, not public copy

Wait for the organizer's actual eligibility and workshop-code answer. Do not invent a fallback, claim an exception was approved or assert a deadline from the old plan. The parent owns external submission, count refresh and release verification. This file has not been sent to Devpost.
