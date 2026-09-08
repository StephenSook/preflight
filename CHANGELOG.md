# Changelog

## Unreleased: September 8, 2026

These changes address defects found during the September 8 repository review.
Source changes do not establish parity with a deployed service or an npm release.

### Engine and CLI

- Bind graph nodes to the complete call-control object so a changed object cannot inherit another version's observed continuation. Regression tests cover shared prefixes and old persisted paths.
- Refuse malformed objects and unsupported synchronous connect callbacks under both policies. Update the labelled corpus and test browser-engine parity.
- Verify remote ledgers against a captured head, validating page structure, sequence, hashes and completeness with per-request timeouts. Tests cover truncated pages, invalid responses and concurrent appends.

### API

- Separate application credentials from Client SDK user tokens and constrain gateway answer URLs. Regression tests exercise credential and origin failures.
- Reserve each approved release before placement and bind the signed answer to that reservation with an expiring, single-use capability stored only as a digest. Tests cover callbacks before and after the placement response, conflicting identifiers, replay and concurrent binding.
- Bind branch callbacks to the pending branch and call context; claim answer and branch deliveries before forwarding. Postgres and route tests cover duplicate deliveries and ambiguous conversations.
- Record gateway provenance and platform status separately from webhook decisions so reconciliation cannot treat a bypassed call as gateway-approved.
- Add migrations 0013 through 0017 for reservations, callback authorization, decision provenance, replay claims and placement correlation.

### Browser and operations

- Clear stale sandbox results after invalid edits; keep decision rows distinct and preserve unknown calling-hours state.
- Query open holds separately from recent history and label release approval without implying that a call was placed.
- Add isolated Chromium and WebKit regressions covering fetch, event streams, navigation and operator controls. Fixtures are test inputs, not production evidence.
- Correlate call-proof checks with the placed call and its evidence window. Guard tests reject unrelated decisions and unsupported claims.
- Repair the documented development startup command and add browser and call-proof checks to CI.

### Documentation

- Distinguish structural checks from a legal determination, gateway refusal from answer-time intervention, and release approval from placement.
- Record physical iPhone call and test-push evidence without claiming verified audio wording, real-hold notification delivery or background delivery.
- Identify the published CLI's divergence from current source and keep the published-artifact replay check strict.
- Correct README, API documentation and demo copy against the implemented behavior. Validation counts and dated measurements live in `docs/fact-sheet.md`.
