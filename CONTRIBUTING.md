# Contributing

Preflight is a safety device, so the bar is the same for every change: it must not make the interlock
guess. A change that turns an inconclusive verdict into a pass needs a citation and a test.

## Before you open a pull request

Run exactly what CI runs, each on its own exit code:

```bash
pnpm lint
pnpm typecheck
pnpm --filter @preflight/web build
pnpm test                        # needs DATABASE_URL for the Postgres integration suites; they skip locally without it and fail in CI
bash scripts/ai-tone-gate.sh     # prose surfaces: no em-dashes, no curly quotes, no marketing words
pnpm fact-sheet:check            # the README's counts and the recorded mutation run must match the tree
```

After any change to `scripts/mutation/mutants.json` or to a source file it mutates, run `pnpm mutate`
and commit `scripts/mutation/last-run.json`; the fact-sheet check refuses a stale record. After a
change to tests, workflows or migrations, run `pnpm fact-sheet` and commit the regenerated sheet.

## What a good change looks like

- One logical change per commit, with a message that says why.
- A property change comes with the statute text it encodes and a corpus object under `corpus/ncco/`
  that shows the verdict and the witness path.
- An engine change keeps the invariants in `packages/engine/src/ltl/monitor.test.ts` green: verdicts
  are final, and a formula and its negation are complementary on every prefix.
- Numbers on any surface (README, docs, interface) come from `docs/fact-sheet.md` or from a test, never
  from memory.
- Nothing is claimed that the code does not do. If you add a source or a vendor, grep for the import.

## Data refresh

`pnpm --filter @preflight/numfacts fetch` re-derives the number-facts tables from their public sources
and rewrites `packages/numfacts/data/SOURCES.json` with new hashes and dates. Commit the derived
tables with the manifest.
