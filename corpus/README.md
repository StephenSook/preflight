# Corpus

Labelled call-control objects the engine is tested against. Every file is real NCCO shape, hand-written,
with the labels a reviewer can check by reading the object.

- `ncco/*.json`: one object per file with `ncco` (the array exactly as a server would return it), an optional
  `declaration` (what the developer declared about identification and opt-out), `expect.kinds` (the typed
  action names in order), `expect.atoms` (the five action atoms per action), and `expect.errors` (how many
  error-severity parse issues the object raises).

`pnpm verify:engine` runs the whole corpus offline. No Vonage account is needed.
