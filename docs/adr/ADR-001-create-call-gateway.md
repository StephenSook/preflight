# ADR-001: Preflight is also the create-call gateway, not only a webhook proxy

**Status:** Accepted
**Date:** 2026-09-04
**Author:** Stephen Sookra

## Context

The product specification (v1.0) describes an interlock that sits on the answer webhook: the
platform asks the developer's server for a call-control object, Preflight reads it first and
returns a safe object instead if the flow would reach a prohibited state. The demonstration's
central sentence is that a blocked call never rings the phone on the table.

The platform's webhook reference says the answer webhook fires when an incoming or outgoing call
is answered. On the first live outbound call through the deployed host this was measured: on the
outbound leg the platform reported ringing at 0 ms, started at 1 ms, answered at 868 ms, and asked
for the answer object at 1,009 ms. A webhook-only interlock therefore decides after the phone has
rung and been picked up. For inbound calls and for every replacement object (input and notify
callbacks) the webhook path is still where the decision happens, because those objects only exist
once the call is in progress.

## Decision

Preflight exposes `POST /v/calls`, a create-call gateway. The developer's application posts its
create-call request there with its own application token; Preflight verifies the token against the
application's public key, obtains the flow (inline, or by a marked dry-run pre-fetch of the answer
URL, which may only be Preflight's own answer URL or the configured origin host), evaluates it, and
only on a pass forwards the request to the platform with the caller's own Authorization header. A
block or a hold returns 409 and nothing reaches the carrier. The webhook path stays for inbound
calls and replacement objects.

## Alternatives Considered

### Webhook-only interlock, as specified
- **Pros:** No change to how the application places calls; three URLs to repoint and nothing else.
- **Cons:** The phone rings before the decision; the film's silent-phone sentence would be false for
  outbound calls, which are the calls the rules are about.
- **Rejected because:** measured, not assumed: the answer object is requested 1,009 ms after the
  platform started the call and 141 ms after it was answered.

### An SDK wrapper the developer imports instead of a gateway
- **Pros:** No extra network hop; the pre-fetch could be a function call.
- **Cons:** One language, one SDK version, and the decision would run inside the developer's
  process where the evidence log cannot be trusted by a third party.
- **Rejected because:** the interlock's value is that the caller cannot skip it and the log is not
  theirs to rewrite; a gateway keeps both, and the nightly reconciliation against the platform's
  own records proves the negative from outside the developer's process.

## Consequences

### Positive
- "The phone stays silent" is true and is exercised daily by the real-call workflow: the refusal
  carries no call uuid, and no event webhook arrives for sixty seconds after it.
- The developer's bearer token and private key are never stored; the gateway forwards the header
  it was given and keeps nothing.

### Negative
- Outbound placement now depends on Preflight being up; the free host is kept warm by a
  self-ping and a cron, with a dead-man alert behind them, and that dependency is an accepted loss
  recorded in ADR-002.
- A dry-run pre-fetch is an extra request against the developer's origin per outbound call, marked
  with a header so the origin can tell it apart.

### Neutral
- The gateway stamps the pre-fetch with a `preflight-dryrun-` id. Reconciliation treats that id as
  no uuid at all, since a refused request never became a call.

## References

- docs/fact-sheet.md, MEASUREMENTS: "Distinguishing-prediction timing test"
- apps/api/src/gateway/calls.ts; scripts/vonage/daily-call.mjs
