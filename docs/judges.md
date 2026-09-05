# A three-minute itinerary for a stranger

Everything below works with no account, no key and nothing installed except a terminal. The
numbers you see are recomputed by the host when you ask; nothing is a screenshot. The web app is
a separate surface, https://preflight-web-nine.vercel.app (the public site; `/app/` is the cockpit,
whose flow graph and evidence log need no token); this page is the one that needs nothing.

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
recomputing every hash and link with no trust in the host. Both print the same head.

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

## 4. The engine, offline, on your machine (40 seconds)

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
call records against the log: every record matched to a decided call, and no record lining up
with a request the gateway refused.

## 6. Dial it yourself (a phone, a minute)

Call `+1 943 244 5023`. It runs a small notification flow with the defect in it on purpose. To
have the interlock call you instead, the public site's consent gate places a verification call
that speaks a code first; only that code lets one demonstration call through, and the interlock
decides it like any other.

## What you cannot check from here, said plainly

- The dashboard and the public site are the web app; until it is deployed, the routes above are
  the product's surface.
- Coverage is bounded by observed traffic: a branch never exercised has never been checked, and
  `/api/summary` says which.
- The engine verifies structure and position, never whether the spoken words are true.
