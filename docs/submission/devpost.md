# Devpost write-up, draft 1 (submit Tue 2026-09-08, 18:00 to 21:00 EDT)

Fields per the live submission form: city (Atlanta), the workshop code (see the fallback rule),
repository, video (five minutes maximum), write-up. Short text fields stay under 255 characters and
every field is verified by a full reload after saving. Every number is from `docs/fact-sheet.md`.

## Tagline

Watch a call that would break federal law stop before the network ever hears it, then ring the
moment the flow is fixed. No model decides; a monitor compiled from the statute does.

## What it does

Preflight is a pre-dial compliance interlock inside your own Vonage account. It reads the call flow
your server is about to serve, runs monitors compiled from the federal and Georgia telemarketing
rules over it, and refuses the call before the carrier is asked to place it when the flow would
reach a prohibited state. A refused call names the rule, the citation and the exact sequence of
actions that would have reached it. The fix is made, the same phone rings. Every decision is an
entry in a hash-chained evidence log sealed daily to a public transparency log, and every night the
platform's own call records are reconciled against it.

## Who it is for

A small team running outbound notification calls on Vonage (a clinic, a county office, a campus
alert system) that cannot read every branch of the flow its own server serves, because the platform
asks the server for a new object on every keypress and every silence. Georgia removed the knowledge
requirement from its telemarketing statute on July 1, 2024 and extended liability to whoever the
call is made on behalf of, so such a team is exposed for a vendor's flow it has never seen. The
builder is the first user: the reference flow behind the public number is the one written at the
Atlanta workshop, defect included.

## Lens

Real-World Use.

## Vonage APIs and features, exactly as the code calls them

- Voice API: call-control objects (talk, input, connect, notify, stream, record, conversation, pay
  parsed and evaluated), the answer, event and fallback webhooks, signed callbacks verified with
  `@vonage/jwt` (HS256 with the payload hash checked), `POST /v1/calls` through the create-call
  gateway with the caller's own token.
- Verify v2, voice channel: the consent gate speaks a code to the visitor's phone before the
  interlock will dial it.
- Identity Insights: the paid lookup that resolves a hold the free prefix tables could not, after
  the response and never inside a decision.
- Application API: one-click install and rollback of the three webhooks with signed callbacks on,
  verified by read-back.
- Reports API: the nightly carrier-side reconciliation of the account's call records against the
  evidence log.
- Users API and Client SDK user tokens: the browser softphone's sessions (judge tokens capped per
  day; the scheduler's behind the dashboard token). The application carries the RTC capability.
- Numbers: the public Atlanta-overlay number and the outbound caller id.

## How it works, in four steps

1. Read the flow: the platform calls Preflight instead of your server; Preflight verifies the
   signature, forwards the request unchanged, reads the object that comes back.
2. Compile the statute: five properties as formulas over what the object does, each with its
   citation, each quoted clause a byte-for-byte substring of the fetched text, enforced by a test.
3. Decide before the dial: true passes the bytes through, false refuses with a safe object naming
   the rule, undecided holds for a person. Outbound calls go through the gateway because the
   platform asks for the flow only once a call is answered (measured: answered at 868 ms, the flow
   asked for at 1,009 ms).
4. Write the receipt: a hash-chained log, sealed to Sigstore Rekor daily, reconciled nightly
   against the platform's own records.

## Try it without an account

- `curl -s https://preflight-api-rc34.onrender.com/api/summary`
- `npx -y preflight-interlock verify-ledger https://preflight-api-rc34.onrender.com`
- `docs/judges.md` in the repository walks the rest in three minutes.
- Dial +1 943 244 5023.

## Honest limits

Preflight verifies the structure and position of a call flow, never whether the spoken words are
true. Coverage is bounded by observed traffic and the header says how much has been seen. A rate
center is a proxy for where the called party is. The consent gate records consent to one
demonstration call, not campaign-level consent. It is a compliance tool, not legal advice.

## Challenges

The specification had a hole: the answer webhook fires only once a call is answered, so a
webhook-only interlock cannot keep a phone silent. Measuring it on a real call (two written
predictions, one confirmed) turned the design into a create-call gateway. Two of the five
formulas were wrong as first written (the identification rules needed a weak until; calling hours
are a fact about the call, not about spoken actions) and only the hand-labelled corpus and the
mutation harness showed it. A second-model review found that the reconciliation had never counted
a single gateway refusal, because the gateway's dry-run ids looked like call uuids; the first live
reconciliation's clean result was vacuous until that was fixed, and the fact sheet says so.

## What we learned

That the phone staying silent is a claim about timing, and timing has to be measured, not read
from the documentation. That a claim in a README rots faster than code, so the numbers are
generated from the repository and the live host, and CI fails when the two drift. That the most
convincing negative is one checked against the sponsor's own records, not against our own log.

## Workshop code field

The code if received; else the organizer-confirmed alternative; else the sanctioned fallback text:
"Attended Atlanta Aug 11 (Luma confirmation emailed to info@createherfest.com on Sep 3; code
requested in Discord #support)". The fact sheet logs which of the three was used.

## Not printed anywhere until sourced

The national registry size and any settlement figure: no fact-sheet row with a primary source yet.
