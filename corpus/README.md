# Corpus

Labelled call-control objects the engine is tested against. Every file is real NCCO shape, hand-written,
with the labels a reviewer can check by reading the object.

- `ncco/*.json`: one object per file with `ncco` (the array exactly as a server would return it), an optional
  `declaration` (what the developer declared about identification and opt-out), `expect.kinds` (the typed
  action names in order), `expect.atoms` (the five action atoms per action), and `expect.errors` (how many
  error-severity parse issues the object raises), and `expect.terminal` (the call facts the evaluator is given,
  the verdict of every property at the end of the flow, the decision, and the witness path for a false verdict).
- Objects whose label depends on the destination carry a top-level `call` block: the number, the instant, the
  resolver's output for that number, and why the number was chosen. Nothing reads it; it is the reviewer's
  receipt that `expect.terminal.facts` came from the resolver and not from a guess.

`pnpm verify:engine` runs the whole corpus offline. No Vonage account is needed.
