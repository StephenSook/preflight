# Security

Preflight sits in the call-control path of a Vonage application, which is a position of real power:
whoever controls it can rewrite call flows, strip the opt-out action, or forge the evidence log. The
design answers that in three ways, and each is a surface worth reporting against.

- **Self-hosted only.** The operator and the account holder are the same party. The host holds the
  per-application signature secret (to verify webhooks) and, when the consent gate, the softphone or
  the Identity Insights lookup are switched on, the application's own private key (to mint its own
  tokens). It never holds the account's API secret: one-click install and rollback use the
  credentials a person enters for two or three requests and keep them nowhere, and the tests assert
  they appear in no output, log or ledger entry.
- **Signature verification before state.** Every webhook is verified (HS256, `api_key`-selected secret,
  payload hash) before anything is stored or forwarded. An unverified request cannot inject a phantom
  state into the discovered flow.
- **Fetches go to one place.** The create-call gateway verifies the caller's application JWT against
  the application's public key before it fetches anything, and its pre-dial check reaches only the
  configured origin host. The branch hook reads the origin callback back from the graph node the
  operator's own object created, never from the query string, and no fetch follows a redirect.
- **An externally anchored ledger.** The evidence log is a hash chain whose head is sealed to Sigstore
  Rekor, so the operator cannot quietly rewrite history, even against themselves; the host refuses a
  seal whose head is not an entry of its own log.
- **Bounded public surfaces.** What a public page can spend is capped per day: consent calls, the
  demonstration call, judge softphone tokens (a durable slot taken under a database lock before the
  platform is asked). The number a visitor enters is kept as a keyed hash, never as digits. Screens
  that carry phone numbers or decisions (the held queue, the decision stream, setup) need the
  dashboard token; the stream's token is redacted from the host's request log.

## Reporting

The highest-risk surfaces are the ingress (`apps/api/src/vonage/verifyWebhook.ts`), the create-call
gateway (`apps/api/src/gateway/calls.ts`) and the decision layer behind them. If you find a way to get
an unsigned or forged webhook past the ingress, a way to make a false verdict pass, a way to place a
call the interlock refused, a way past a daily allowance, or a way to alter a ledger entry without
breaking the chain, report it privately
through GitHub's "Report a vulnerability" on this repository rather than in a public issue. You will
get a reply within three days, and credit in the fix if you want it.

Please do not run tests against anyone else's Vonage application.
