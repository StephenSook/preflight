# Preflight HTTP reference

Every route the deployed host serves, with who may call it and what it answers. Bodies are JSON;
every error is `{ "error": "..." }` with a status that says why. Numbers a judge would quote come
from `docs/fact-sheet.md`, not from here.

Base URL of the reference deployment: `https://preflight-api-rc34.onrender.com`.

## Who may call what

| Credential | Header | Routes |
|---|---|---|
| none | | `/health`, `/api/summary`, `/api/coverage`, `/api/flow`, `/api/campaign`, `/api/ledger/*` (read), `/api/push/vapid`, `/api/consent/*`, `/api/demo/call`, `/api/softphone/token` (judge) |
| the platform's signed webhook JWT | `Authorization: Bearer <jwt>` (HS256 with the account's signature secret, `payload_hash` checked) | `/v/answer`, `/v/event`, `/v/fallback`, `/v/hook` |
| the application's own JWT (RS256, its private key) | `Authorization: Bearer <jwt>` | `POST /v/calls` |
| dashboard token (`DASHBOARD_TOKEN`) | `Authorization: Bearer <token>` (`?token=` on the stream) | `/api/held*`, `/api/stream`, `/api/setup*`, `/api/push/subscribe`, `/api/push/test`, `/api/softphone/token` (scheduler) |
| workflow token (`SEAL_TOKEN`) | `Authorization: Bearer <token>` | `POST /api/ledger/seals`, `POST /api/reconcile` |

Cross-origin callers: the web app's origin (`PUBLIC_WEB_URL`) and the local dev server receive CORS
headers (methods GET, POST, PUT, DELETE; headers `authorization` and `content-type`); any other
origin receives none. Same-origin and non-browser callers are unaffected.

A route whose feature is not configured on a deployment answers 404 with a sentence saying which
setting is absent, never a pretend success; the create-call gateway alone answers 503, because it
refuses everyone until it can verify callers.

## Call-control path

### `GET|POST /v/answer`
The platform's answer webhook. Verified, forwarded to the configured origin, the returned object
parsed, discovered into the graph, evaluated. Answers the origin's bytes on pass (with input and
notify callbacks rewritten to `/v/hook`), a safe object naming the rule on block, a hold object on
hold. Headers: `x-preflight-decision` (`pass|block|hold`), `x-preflight-origin-ms`,
`x-preflight-verify-ms`. 403 on a missing or forged signature, before any state is touched.

### `POST /v/event`
The platform's event webhook. Verified and stored with its received time; 204. The rate
properties read these.

### `GET|POST /v/fallback`
The platform's fallback answer webhook. Verified; answers the safe object.

### `GET|POST /v/hook?n=<node>&m=<method>`
Where a rewritten input or notify callback lands. Verified, forwarded to the origin's real callback
recorded on the graph node (never from the query), the replacement object observed as a
continuation and decided; the safe object stops the call mid-flow on a block.

### `POST /v/calls`
The create-call gateway (ADR-001). Body: the platform's own create-call request (`to`, `from` or
`random_from_number`, `answer_url` or `ncco`, `event_url`, ...). The bearer must be a JWT signed by
this application's private key. The flow is obtained (inline, or a marked dry-run pre-fetch of the
answer URL, which may only be this host's answer URL or the configured origin host) and evaluated.
On pass the platform's own status and body are passed through (201 when it created the call; a 401
or 402 from the platform comes back as such, and the evidence-log entry then carries `placed: false`
and `platform_status`); 409 `{ "decision": "block"|"hold", "reason", "verdicts",
"holdId"? , "placed": false }` on refusal, nothing reaching the carrier; 400 on a malformed
request; 401 on a token this application did not sign. `X-Preflight-Override: <holdId>` places a
held request a named person has approved, for that destination only. The entry's `ncco_hash` is
the SHA-256 of the object's bytes as the origin served them; for an inline object it is over the
object's compact JSON re-serialisation (`JSON.stringify`), not the request's raw bytes, so a
stranger reproduces it from the object, not from the wire.

### `GET|POST /v/rtc`
The RTC event sink for the browser softphone; 204, nothing stored.

## Public recompute endpoints

### `GET /health`
`{ ok, service, version, policy, store, events, decisions: {pass, block, hold}, ledger: {seq, entry_hash}, numfacts: {nanpaFileUpdated, prefixes} }`. Touches the database.

### `GET /api/summary`
Decision counts, the evidence-log head, coverage (declared and observed endpoints, states, edges,
branch points, open branches), verify and origin latency p50 and p95 over the last 500 decisions,
the last carrier reconciliation, the policy.

### `GET /api/coverage`
The coverage object alone.

### `GET /api/flow`
The declared-versus-actual diff (ADR-004): `nodes` (id, endpoint, index, action, label, status
`declared|undeclared`, `speaksSynthetic`, atoms, observations, first and last seen, a talk's text),
`edges`, `roots`, `missing` (declared and never observed), `openBranches`, `declared`, `counts`.
No phone numbers.

### `GET /api/campaign?since=<iso>&until=<iso>`
The rate properties P6 to P8 over the window (default the last thirty days; times compare as
instants, so an offset spelling equals its Z spelling): counts, including `inProgress` for outbound
dials not yet ended, and, per property, `verdict`, `figure`, `unit` (`fraction` for P6 and P7,
`seconds` for P8, whose figure is the median talk time), `n` and a one-sentence `basis`. Only ended
outbound dials count; the far end of a connect (the representative's leg, which shares the
conversation) is not a dial, and a person counts as connected only when another leg of the same
conversation was answered. 400 on a malformed window; 422 when the window holds more event
webhooks than the store returns whole (narrow it).

### `GET /api/ledger/head`
`{ seq, entry_hash }`.

### `GET /api/ledger/entries?after=<seq>&limit=<n>`
Entries with seq greater than `after`, ascending, at most 1,000.

### `GET /api/ledger/verify`
Recomputes every hash and link from genesis: `{ ok, entries, head, brokenAt? }`.

## Consent gate and the demonstration call

### `POST /api/consent/start`
Body `{ "number": "+1 404 555 0100" }`. Places a verification call that speaks a code (Verify v2,
voice channel). 202 `{ request_id, channel, number (masked), next }`; 200 when a consent is already
granted for that number; 429 when the daily allowance is spent or the number was called less than
ten minutes ago; 404 when the deployment holds no application private key.

### `POST /api/consent/check`
Body `{ "request_id", "code" }`. 200 `{ granted: true, request_id, expires_at, ledger }` and an
evidence-log entry carrying a keyed hash of the number (`hmac-sha256:` under the application's
private key, never its digits); 400 on a wrong code; 404 unknown request; 409
already recorded.

### `POST /api/demo/call`
Body `{ "request_id" }` of a checked consent. Places one call to the verified number through the
create-call gateway with a token the process mints from its own key, so the interlock decides it
like any other call. Answers the gateway's status: 201 placed (the consent is spent), 409 refused
(the consent is not spent), 403 expired or used, 429 daily allowance spent.

## Dashboard (token)

### `GET /api/stream?replay=<n>&token=<token>`
Server-sent events of decisions, with a replay of the last `n` (up to 100) on connect.

### `GET /api/held?status=open|placed|cancelled|all&limit=<n>`
`{ status, lookups: "on"|"off", holds: [...] }`; each hold carries `lookup: { state: pending|ok|error|none|off, record? }` for the Identity Insights lookup on its line.

### `POST /api/held/:id/decide`
Body `{ "action": "place"|"cancel", "by": "<name>" }`. Writes an `override` evidence-log entry;
404 when no open hold has that id.

### `GET /api/setup`
The three URLs to point an application at, the origin, the policy, and the declaration in force
with its source (`environment` or `stored`), hash, author and time.

### `PUT /api/setup/declaration`
Body `{ "declaration": {...}, "by": "<name>" }` (`identification.phrases`, `identification.streamUrls`,
`optOut.eventUrlPatterns`, `endpoints`, `flow`). 200 with the new Setup view and the `declaration`
evidence-log entry; 400 with the validation issues.

### `POST /api/setup/install`
Body `{ "application_id", "api_key", "api_secret", "by" }`. Reads the application through the
Application API, records its hooks, points all three at this host with signed callbacks on, reads
it back. 200 `{ action, application, previous, current, signed_callbacks, ledger }`; 502 with the
platform's status when the read-back does not match what was written; 409 when this deployment has
no public base URL. The credentials are kept nowhere.

### `POST /api/setup/rollback`
Body `{ "application_id", "api_key", "api_secret", "by", "previous": {answer, event, fallback} }` as
the install returned them. Writes them back the same way.

### `GET /api/push/vapid`
`{ publicKey }` for `PushManager.subscribe`. Public; 404 when the VAPID keys are not configured.

### `POST /api/push/subscribe`
Body: a `PushSubscription` as `JSON.stringify` renders it, optionally wrapped as
`{ "subscription": ..., "label": "..." }`. 201 `{ subscribed, endpoint, subscriptions }`. 409 when
the table already holds `PUSH_SUBSCRIPTIONS_MAX` endpoints (default 50) and this one is new; renewing
a stored endpoint always succeeds.

### `DELETE /api/push/subscribe`
Body `{ "endpoint" }`. `{ removed: true|false }`.

### `POST /api/push/test`
Sends a test notification to every subscription: `{ attempted, delivered, retired, failed }`.

### `POST /api/softphone/token`
Body `{ "role": "judge" }` (public, capped per day) or `{ "role": "scheduler" }` (dashboard
token). 201 `{ role, user, token, expires_at, application_id, created }`: a Client SDK user token
signed by the application key. 429 when the day's judge tokens are spent (the count is durable, in
`softphone_tokens`, and the day's slot is taken under a database lock before the platform is asked, released if
the platform refuses, so overlapping requests, in one process or several, cannot exceed the
allowance and a spent day creates no platform user); 404 when the deployment
holds no application private key; 502 when the platform refused to create the user.

## Workflow token

### `POST /api/ledger/seals`
Body `{ rekor_uuid, rekor_log_index, sealed: {seq, entry_hash}, signature_b64 }` from the daily
seal workflow after Rekor verified the entry. 201 with the `seal` entry.

### `POST /api/reconcile`
Body `{ window: {start, end}, records: [{call_id, direction, from, to, date_start, status?, duration?}] }`
from the nightly reconciliation workflow (the platform's Reports API records for the window, at
most 5,000, the window at most 31 days). 201 `{ report, ledger }` where the report counts records
inside the window, matched, unmatched, leaks, refusals in the window, and carries a hash over the
canonical records; 422 when the window holds more decisions than one request may span.

## Reference application (`REFERENCE_APP=on`)

`GET|POST /reference/answer`, `POST /reference/menu`, `POST /reference/optout`,
`GET|POST /reference/event` (204), `GET /reference/state`, `POST /reference/mode` (body
`{ "mode": "broken"|"fixed" }`, bearer `REFERENCE_ADMIN_TOKEN`). The deliberately small
notification flow behind the public number; Preflight fetches its answer object over loopback and
its branch callbacks through the public host, and treats it like any developer's server.
