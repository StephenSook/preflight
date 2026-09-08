# A three-minute itinerary for a stranger

The public checks need no account or key. HTTP commands use curl; CLI commands need Node and npm;
the source checkout also needs Git and pnpm, and the optional seal commands need `rekor-cli`. The
numbers you see are recomputed by the host when you ask; nothing is a screenshot. The web app is
a separate surface, https://preflight-web-nine.vercel.app (the public site; `/app/` is the cockpit,
whose flow graph and evidence log need no token).

Host: `https://preflight-api-rc34.onrender.com`. The first request after a quiet spell can take a
few seconds while the free host wakes; the second is fast.

## 1. Is it alive, and what does it hold? (20 seconds)

```
curl -s https://preflight-api-rc34.onrender.com/health
curl -s https://preflight-api-rc34.onrender.com/api/summary
```

`health` names the store (postgres, never memory), the decision counts and the evidence-log head.
`summary` adds coverage (endpoints observed over endpoints declared), verify and origin latency
percentiles over the last decisions, and the last carrier reconciliation.

## 2. The evidence log, recomputed from genesis (30 seconds)

```
curl -s https://preflight-api-rc34.onrender.com/api/ledger/verify
npx -y preflight-interlock verify-ledger https://preflight-api-rc34.onrender.com
```

The first is the host checking itself. The second is your machine pulling every entry and
independently recomputing every hash and link. Both should print the same head for the same snapshot.
Internal consistency alone does not authenticate a replacement chain; compare it with an external
Rekor commitment as described next.

The chain head is sealed to Sigstore Rekor once a day; the seal entries carry the Rekor uuid and
log index (`/api/ledger/entries` shows them as kind `seal`), and `rekor-cli verify --uuid <uuid>`
confirms one against the public log. To tie that Rekor entry to this ledger rather than take the
seal entry's word for it: the sealed artifact is the line
`printf '{"entry_hash":"%s","seq":%d}\n' <sealed_head> <sealed_seq>` and its SHA-256 is the
`hashedrekord` data hash the Rekor entry carries (`rekor-cli get --uuid <uuid> --format json`, field
`.Body.HashedRekordObj.data.hash.value`). The host refuses a seal whose head is not an entry of its
own ledger.

## 3. Declared versus actual (30 seconds)

```
curl -s https://preflight-api-rc34.onrender.com/api/flow
```

Every state discovery has seen, coloured against what the developer declared. `undeclared` is the
surprise; `missing` is the honest gap (declared, never observed, never verified).

## 4. The engine, offline, on your machine

Install Node 22 and pnpm 10 first (see the README Quickstart). A fresh dependency install can take
longer than the rest of this itinerary. Database integration tests require a disposable Postgres
database as described in CONTRIBUTING; without it the local suite skips those tests.

```
git clone https://github.com/StephenSook/preflight && cd preflight && pnpm install --frozen-lockfile
pnpm replay corpus/ncco
pnpm test
```

Forty-eight labelled call-control objects, each label derived by hand before any run, reproduce
their verdicts. The test suite includes the textbook LTL3 verdicts, the corpus, the statute
quotes checked as byte substrings of their sources, and the browser bundle running in a bare
context. `pnpm mutate` applies every hand-written mutant and requires a failing test for each.

Or, without cloning:

```
printf '[{"action":"talk","text":"Buy now."}]' > flow.json
npx -y preflight-interlock check flow.json
```

It prints every property's verdict with its citation and, on a false, the action path that
reached the prohibited state; the exit code is the decision.

## 5. The rate properties and the carrier's own records (20 seconds)

```
curl -s "https://preflight-api-rc34.onrender.com/api/campaign"
```

P6 (abandonment over calls answered by a person), P7 (ring duration), P8 (the platform's
twelve-second line), each with a verdict, the figure, the count it stands on and a one-sentence
basis. The `reconciliation` object on `/api/summary` is the nightly check of the platform's own
call records against the log. Outbound matches require a recorded gateway placement, not merely
an answer-time decision. Check unmatched calls, possible leaks and `decided_not_in_records`, not
only the matched count. Historical rows without recorded gateway provenance remain unverified.

## 6. Dial it yourself (a phone, a minute)

Call `+1 943 244 5023`. It runs a small notification flow with the defect in it on purpose.
The public site's Verify consent route is implemented, but personal-number verification was
excluded from the recorded demonstration. It is not a proven step in this itinerary. The
physical iPhone softphone and test-push checks are separate evidence, recorded in the fact sheet.

## What you cannot check from here, said plainly

- The deployed web app includes the dashboard and public site. Token-protected operator controls
  are not part of this credential-free itinerary.
- Coverage is bounded by observed traffic: a branch never exercised has never been checked, and
  `/api/summary` says which.
- The engine verifies structure and position, never whether the spoken words are true.
