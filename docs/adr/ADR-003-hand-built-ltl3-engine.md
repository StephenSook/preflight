# ADR-003: A hand-built three-valued runtime-verification engine with no dependencies

**Status:** Accepted
**Date:** 2026-09-04
**Author:** Stephen Sookra

## Context

A call flow is a finite sequence of actions, extended at runtime by replacement objects the
developer's server returns on input and notify callbacks. The rules Preflight enforces are
statements about order and reachability over that sequence: nothing spoken before the
identification beat, an opt-out reachable after it, a calling-hours fact about the whole call. A
monitor has to decide on a prefix, before the call is placed, and it must say when it cannot
decide, because a branch nobody has observed is not a branch that is known to be safe.

The engine also has to run in a browser for the sandbox on the public site, so a person with no
account can paste an object and get the same verdicts.

## Decision

Properties are written as linear temporal logic over a small atom vocabulary and compiled once per
process into three-valued monitors by the construction in Bauer, Leucker and Schallhart (2011):
the formula and its negation to Büchi automata by the Gerth, Peled, Vardi, Wolper tableau,
per-state emptiness, subset construction, product, three-valued labelling, Moore minimisation.
Running a monitor is one table lookup per action. The verdict is true, false, or inconclusive; the
decision layer blocks on any false, and under strict policy holds on any inconclusive. The engine
has no runtime dependencies, carries its own SHA-256, and a test bundles it for the browser and
runs it in a bare context.

## Alternatives Considered

### Hand-written checks per rule
- **Pros:** Direct, no theory, fast to write.
- **Cons:** Each rule reinvents "before", "after" and "eventually"; the identification-first rule
  and the opt-out rule were both mis-stated in the specification and only the formal encoding,
  tested against the labelled corpus, showed it (the until had to be a weak until; the calling-hours
  rule is a fact about the call, not about spoken actions).
- **Rejected because:** the corpus and mutation harness catch encoding mistakes in formulas; they
  cannot catch a mistake that only exists as an ad hoc loop.

### An existing runtime-verification or model-checking library
- **Pros:** Someone else's correctness work.
- **Cons:** The candidates are JVM or Python tools, or JavaScript packages with dependencies and
  without a three-valued semantics; none runs in the browser without a build of their own.
- **Rejected because:** the engine is the thesis of the product and has to be readable by a
  reviewer in an afternoon; the construction is about a thousand lines and its guarantees are
  tests (textbook verdicts, finality of verdicts, complementarity of a formula and its negation,
  a 48-object corpus labelled by hand before any run, 48 mutants).

### A language model deciding compliance
- **Pros:** Could read the spoken words, which the structural engine deliberately does not.
- **Cons:** Not deterministic, not citable, not verifiable by a stranger, and it would decide
  differently on the same object twice.
- **Rejected because:** no model decides; the product's promise to a judge and to a regulator is
  that the same object always gets the same verdict with the same citation.

## Consequences

### Positive
- Every verdict carries a citation, and every quoted clause is a byte-for-byte substring of the
  fetched statute text, enforced by a test in both directions.
- A false verdict carries the exact action path that reached the prohibited state, which is what
  the Block Detail screen shows and what the fix in the film is made to.
- Identical behaviour in Node, in the CLI, and in the browser.

### Negative
- The spoken content is out of scope: identification and opt-out are matched by declared phrase,
  stream URL or event URL, and the interface says so.
- An always-property is never true on an open prefix, so a flow whose branches have not all been
  observed is held under strict policy until they have; coverage is shown in the header for that
  reason.

### Neutral
- The Tier 2 rate properties (P6 to P8) are computed from event telemetry, not by monitors; they
  raise campaign figures and never block a call.

## References

- packages/engine/src/ltl/, properties.ts, evaluate.ts, rates.ts
- docs/fact-sheet.md, SPEC CORRECTIONS (P1, P2, P3, P4, P5 encodings)
