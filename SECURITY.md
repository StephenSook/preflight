# Security

Preflight sits in the call-control path of a Vonage application, which is a position of real power:
whoever controls it can rewrite call flows, strip the opt-out action, or forge the evidence log. The
design answers that in three ways, and each is a surface worth reporting against.

- **Self-hosted only.** The operator and the account holder are the same party. Preflight never holds
  a Vonage private key; it needs the per-application signature secret and nothing else.
- **Signature verification before state.** Every webhook is verified (HS256, `api_key`-selected secret,
  payload hash) before anything is stored or forwarded. An unverified request cannot inject a phantom
  state into the discovered flow.
- **An externally anchored ledger.** The evidence log is a hash chain whose head is sealed to Sigstore
  Rekor, so the operator cannot quietly rewrite history, even against themselves.

## Reporting

The highest-risk surface is the ingress (`apps/api/src/vonage/verifyWebhook.ts`) and the decision
layer behind it. If you find a way to get an unsigned or forged webhook past it, a way to make a
false verdict pass, or a way to alter a ledger entry without breaking the chain, report it privately
through GitHub's "Report a vulnerability" on this repository rather than in a public issue. You will
get a reply within three days, and credit in the fix if you want it.

Please do not run tests against anyone else's Vonage application.
