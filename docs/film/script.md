# Film narration, claim-checked draft for approval

Target running time: five minutes. Timings are editorial allocations, not a verified organizer limit or deadline. Confirm current submission requirements before recording. No recording, rendering, calls or deployment verification were performed for this revision.

Quoted blocks are proposed narration. SCREEN and RECORDING GATE paragraphs are instructions, not evidence that a take exists. Match the narration to the evidence actually shown.

## Evidence boundaries

- Source of recorded measurements: `docs/fact-sheet.md`, especially "September 8 physical-device and gateway rechecks". Older generated totals are dated snapshots, not today's counts.
- The builder confirmed audible speech through the iPhone Client SDK softphone. The screenshot and matching ledger record support an already placed call with answer-time intervention. Exact spoken wording was not verified. Do not invent a transcript or call this pre-dial blocking.
- The user-supplied iPhone screenshot shows a native "Preflight test" notification. This proves that test push, not a newly generated hold notification or delivery while the app was closed. Use the actual screenshot with private details concealed, never a recreation.
- The separate September 8 gateway check used controlled account-owned numbers. It recorded a refusal without a UUID, an unchanged signed-event count during the observation window, and a fixed-flow positive control with a platform receipt and subsequent decisions. It does not prove the builder's personal phone stayed silent or rang.
- No personal-number Verify call, consent-code entry or personal ringing claim belongs in this film. That path was excluded by the user.
- The reference application is a deliberately constructed demonstration flow, not a real clinic, customer deployment or undiscovered workshop incident. Its traffic can be real without its appointment text describing a real appointment.
- Browser-regression fixtures are tests only. Never show their counts, decisions or notifications as product telemetry.

## Before recording: required revalidation

1. Record the frontend and API deployments' source SHAs from their deployment records. Check the served UI and API behavior against those exact revisions. Local HEAD, a green branch run and the health version string are not deployment proof. If either deployed SHA cannot be established, do not call current workspace changes shipped.
2. Re-read the fact sheet and source at those revisions. This draft was checked against the current workspace, including pending changes; it does not certify that those changes are live. Revalidate decision labels, detail links, release approval wording, gateway receipts and CLI behavior before filming them.
3. Capture fresh timestamps, gateway responses and associated ledger records for any beat called live. Keep sensitive source evidence private. Never substitute an older record into a new take.
4. Check coverage and open branches before promising a block. An unobserved continuation can produce a hold under strict policy. Say "held" when that is the result. Separately authorized preparation must use the existing operator path: release approval does not place a call, and resubmission is a separate action. Do not change global policy to manufacture a verdict.
5. Confirm the owned-number target and caller ID before any authorized gateway run. Keep the reference flow fixed long enough to inspect subsequent decisions, then restore and read back its prior mode. Do not place a call as part of this script-editing task.
6. If revalidation fails, cut the live claim or show dated evidence explicitly as a prior check. Never film expected success as observed success. Features absent from the checked deployment stay out of narration.

## 0:00 to 0:25, the reference flow

SCREEN: the actual reference application's call-control object and timeout reply. Label "Deliberate reference application; not a customer call."

> This is the reference application I use to test Preflight. The server returns a call-control
> object to Vonage, then another object when the menu times out. That timeout path ends without
> reaching the declared opt-out handler. The demonstration flow contains this defect deliberately,
> so we can inspect the failure and the change side by side.

## 0:25 to 0:50, what Preflight checks

SCREEN: monitor verdicts, distinguishing the encoded check from its cited source.

> Preflight checks call-flow structure against explicit monitor rules, with citations to selected
> federal and Georgia provisions. It does not decide whether a call is lawful. Through the
> create-call gateway, a block or hold can stop the request before it is forwarded to Vonage.
> The decision comes from encoded monitors, not a language model.

## 0:50 to 1:20, declared versus observed

SCREEN: the deployed graph, declaration and observed callback paths. Describe only the nodes actually present, not a prescribed state count.

> The flow arrives in pieces. Preflight handles the answer webhook and subsequent flow callbacks,
> verifies signed callbacks, and records the paths it observes. The graph compares those paths
> with the developer's declaration. An unseen branch remains a gap in the evidence, not a reason
> to announce that the whole flow passed.

## 1:20 to 1:55, the builder's iPhone and test notification

SCREEN: the actual iPhone softphone evidence and matching ledger entry, followed by the actual test-push screenshot. Label both "Recorded evidence, September 8" unless new evidence is separately captured and verified.

> I heard speech through the Client SDK softphone on my iPhone. The matching ledger entry records
> an answer-time block on that already placed call. That is different from stopping a request
> before dialing. I have not verified the exact words that played.
>
> This other screenshot shows the test notification arriving on the iPhone. It proves the test
> push reached the device. It does not prove a new held-call alert or closed-app delivery.

RECORDING GATE: if original evidence cannot be shown safely, describe the user-reported check instead of substituting staged phone footage. Do not add a Verify prompt or portray the SDK call as the owned-number gateway test.

## 1:55 to 2:55, the separate pre-dial gateway check

SCREEN: an authorized fresh refusal and its ledger record, labelled "Controlled account-owned numbers; not the personal iPhone." Keep elapsed time visible for an uncut observation window. If using the September 8 record instead, label it as a prior check throughout and use past tense.

> This is a separate test between numbers controlled by the account. The request goes through
> Preflight's create-call gateway. The response identifies the decision and its reason. Here the
> request was refused and no call UUID was returned.

RECORDING GATE: speak that last sentence only after inspecting the response. Name block or hold exactly as returned. If the result differs, show it rather than reading this line.

> During this observation window, the signed-event count did not increase. That is a bounded
> check on this run, not proof that a personal phone stayed silent or that no other call could
> bypass the gateway.

RECORDING GATE: keep unrelated traffic out of the controlled window. The existing daily-call script observes 60 seconds; verify the response and both counts before using that figure. An unchanged count alone does not establish carrier-wide absence. The positive control follows as separate evidence.

## 2:55 to 3:30, the changed flow and positive control

SCREEN: the reference flow change, gateway response and subsequent decisions for the returned UUID. Keep the controlled owned-number label visible.

> The changed reference flow adds the opt-out instruction and routes the input to the declared
> handler. A pass decision alone does not mean a call was placed. For the positive control, I
> check the platform's acceptance response and call UUID, then inspect the later interlock
> decisions associated with that call.

RECORDING GATE: only report successful placement after HTTP 201, a UUID and a matching placement receipt. Only report later passes after reading those records. The current proof helper also requires signed events to increase. These checks do not establish what a person heard, that the personal iPhone rang, or that an opt-out was durably recorded.

If a hold is shown, use this line instead:

> This request is held. Approving its release records a human decision; it does not dial. The
> caller must resubmit the request. An override can allow inconclusive monitors, so it is not a
> claim that every monitor became true.

## 3:30 to 4:00, inspectable evidence

SCREEN: ledger and verifier result. Do not type credentials on camera.

> The evidence log links its entries with hashes. The verifier recomputes those hashes and links.
> That checks the chain's internal consistency; it does not prove that every underlying event
> was captured or that the decision was legally correct.

RECORDING GATE: the fact sheet records `preflight-interlock@0.2.0` as published. Re-test that pinned package from a clean directory before showing `npx -y preflight-interlock@0.2.0 verify-ledger https://preflight-api-rc34.onrender.com`. Do not attribute unpublished CLI hardening to that release. Read only the count and outcome the verified command actually prints.

Optional, only if independently checked for this cut: show an actual Rekor seal and verify its relationship to the recorded head. Describe it as a dated anchor, not proof that every scheduled seal ran. Show carrier reconciliation only with its source records, time window and limits; a schedule or zero count does not prove no calls escaped.

## 4:00 to 4:35, who it helps and its limits

SCREEN: declaration, coverage and decision reason, not a liability estimate.

> This is for developers operating voice flows who need to inspect what their callbacks actually
> serve. The useful output is a specific path, a monitor result and a reason to investigate.
> Coverage is relative to declared endpoints, not a certificate of completeness.
>
> Matching an identification phrase does not prove it is truthful. Reaching a declared opt-out
> handler does not prove a suppression record was saved. Consent, exemptions and legal
> applicability require separate assessment. This is a structural checking tool, not legal advice.

## 4:35 to 5:00, close

SCREEN: the public site and repository, after checking they load. Do not show a future feature or unavailable route as shipped.

> You can inspect the reference flow and recorded evidence, and try the local browser checker
> with your own call-control object. The phone check, test notification and pre-dial gateway
> check are separate pieces of evidence. Each shows a specific part of the system, not a
> guarantee of legal compliance.

## Claim audit for the recording handoff

- No invented workshop history, surprise discovery, customer story or exact audio transcript.
- No personal-number Verify demonstration or unsupported ringing/silence claim.
- No liability amounts or blanket claims about clinics, county offices or campus alerts.
- No claim that the reference flow persists opt-out consent or suppression records.
- No decision counts labelled as unique calls, confirmed placements or phones kept silent.
- No unverified deployment, future code, scheduled-job success or complete legal determination.
- Re-read `apps/reference/src/index.ts`, `packages/engine/src/properties.ts`, `apps/api/src/gateway/calls.ts`, `apps/api/src/push/routes.ts`, `apps/web/src/phone/page.ts`, `scripts/vonage/daily-call.mjs`, `scripts/vonage/call-proof.mjs` and CLI source at the recording's verified revisions.
