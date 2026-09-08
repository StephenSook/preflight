# Frontend regression harness

Run from the repository root with Node 22 and workspace dependencies installed:

```sh
pnpm --filter @preflight/web test:browser
```

On a fresh CI runner, install both browser runtimes first:

```sh
pnpm --filter @preflight/web exec playwright install --with-deps chromium webkit
```

The CI workflow installs both runtimes and runs this command after the unit and call-proof tests.

`frontend-regressions.mjs` starts the actual Vite UI and a test-only HTTP fixture server on loopback, using ephemeral ports. It exercises real fetch requests, EventSource frames, hash navigation, form edits and a held-call cancellation followed by refreshed queries. It runs in Chromium and WebKit and exits nonzero on assertion failures or page errors.

All generated decisions, holds, counts, tokens and citations are test fixtures defined inside this harness. They are not product telemetry, production evidence or legal findings. The harness blocks browser requests outside its local origin, proxies API requests only to the local fixture server, and asserts no unexpected requests occurred. It does not load production credentials or place calls.

Covered regressions:

- Invalid declaration JSON and shapes, invalid wrapper declarations, empty edits, stale verdict clearing and valid-input recovery.
- Public counters labelled as decisions rather than calls or placements, including unavailable counts.
- Multiple decisions sharing a call UUID and timestamp but differing in NCCO hash; each row opens its own detail.
- Gateway refusals without a call UUID sharing a timestamp and NCCO hash but naming different destinations remain separate rows and details.
- Inconclusive pass verdicts retain their decision reason without claiming every monitor is true.
- Missing or malformed explicit detail routes never select a different decision.
- Calling hours retain true, false, null and absent states.
- An older open hold remains visible when the recent history contains 50 closed holds; query caps and request failures remain explicit.
- Release approval retains the existing API action but reports approval, not placement, after refresh and in history; resubmission remains the caller's responsibility.

Other scripts in this directory are separate live-site checks or capture tools. Their results must not be confused with this fixture-only regression command.
