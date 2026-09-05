# ADR-004: The declared flow is a set of action sequences per endpoint, matched by position

**Status:** Accepted
**Date:** 2026-09-05
**Author:** Stephen Sookra

## Context

Discovery builds the flow graph from what the application actually serves. The strongest image in
the product is the difference between that graph and what the developer believes their flow does:
"your flow reaches states you did not declare, and one of them speaks". For the diff to mean
anything the declaration has to be something a developer can write by hand on the Setup screen
in a minute, and something the diff can compare against a discovered node without guessing.

A declaration already existed for the atoms (which spoken beat identifies the caller, which input
collects the opt-out) and for the coverage denominator (the callback endpoints the flow has).

## Decision

The declaration gains `flow`: for each endpoint (`answer` for the answer URL, the callback path
otherwise) a list of action-type sequences, one per branch the developer knows of, for example
`{"answer": [["talk", "input"]], "/menu": [["connect"]]}`. A discovered node is declared when its
endpoint is declared and either the endpoint has no list (the developer declared only that it
exists) or one of its sequences has that action type at that position. A declared endpoint or a
declared position that discovery has never seen is reported as missing. Declarations are stored
with who made them, every change is an evidence-log entry carrying the declaration's hash and its
predecessor's, and the next decision uses the new declaration without a restart.

## Alternatives Considered

### Declare the whole graph (nodes and edges)
- **Pros:** The diff would be exact.
- **Cons:** Nobody can write their runtime graph by hand; the platform asks the server for a new
  object on every callback, and that is the reason discovery exists.
- **Rejected because:** a declaration that takes weeks to write is never written.

### Declare only endpoints
- **Pros:** Already existed; the coverage denominator.
- **Cons:** Cannot express the surprise: a timeout branch that speaks synthetically on a declared
  endpoint looks declared.
- **Rejected because:** the reference application's defect lives on a declared endpoint; the diff
  had to see inside it.

### Declare action types as a set per endpoint
- **Pros:** Simpler than sequences.
- **Cons:** A talk declared anywhere would license a talk anywhere; position is the point of the
  identification-first rule.
- **Rejected because:** the diff is positional by design, and a test pins that the same action
  types in another order are undeclared.

## Consequences

### Positive
- The reference application declares its flow with the timeout branch deliberately absent, so the
  live diff shows exactly one undeclared state and it is the one that speaks.
- Changing a declaration is auditable: the ledger names who, when, and the hash before and after.

### Negative
- An endpoint declared without a list accepts whatever it serves; the lenient reading is documented
  and tested, and the Setup screen should nudge toward lists.
- The diff is by action type, not by content: two different talks at the same position are both
  "declared" if a talk is declared there.

### Neutral
- The environment's `FLOW_DECLARATION_JSON` remains the seed a fresh deployment starts from.

## References

- packages/engine/src/graph/diff.ts; apps/api/src/store/declarationStore.ts
- apps/reference/src/index.ts (referenceDeclaration)
