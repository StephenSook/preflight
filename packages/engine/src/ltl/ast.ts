/**
 * LTL over a finite set of atoms. The surface syntax the properties are written in (spec section 08):
 *   G φ (always), F φ (eventually), X φ (next), φ U ψ (until), φ R ψ (release), φ W ψ (weak until),
 *   ! φ, φ & ψ, φ | ψ, φ -> ψ, φ <-> ψ, true, false, identifiers.
 *
 * Internally every formula is kept in negation normal form: negation only on atoms, and only the
 * operators X, U, R, and, or. F φ is true U φ; G φ is false R φ; φ W ψ is ψ R (φ | ψ).
 */
export type Formula =
  | { kind: "true" }
  | { kind: "false" }
  | { kind: "atom"; name: string }
  | { kind: "not"; of: Formula }
  | { kind: "and"; left: Formula; right: Formula }
  | { kind: "or"; left: Formula; right: Formula }
  | { kind: "next"; of: Formula }
  | { kind: "until"; left: Formula; right: Formula }
  | { kind: "release"; left: Formula; right: Formula };

export const TRUE: Formula = { kind: "true" };
export const FALSE: Formula = { kind: "false" };
export const atom = (name: string): Formula => ({ kind: "atom", name });
export const not = (of: Formula): Formula => ({ kind: "not", of });
export const and = (left: Formula, right: Formula): Formula => ({ kind: "and", left, right });
export const or = (left: Formula, right: Formula): Formula => ({ kind: "or", left, right });
export const next = (of: Formula): Formula => ({ kind: "next", of });
export const until = (left: Formula, right: Formula): Formula => ({ kind: "until", left, right });
export const release = (left: Formula, right: Formula): Formula => ({ kind: "release", left, right });
export const eventually = (of: Formula): Formula => until(TRUE, of);
export const always = (of: Formula): Formula => release(FALSE, of);
export const implies = (left: Formula, right: Formula): Formula => or(negate(left), right);
export const weakUntil = (left: Formula, right: Formula): Formula => release(right, or(left, right));

/** Pushes negation to the atoms, producing negation normal form. Idempotent on NNF input. */
export function negate(f: Formula): Formula {
  switch (f.kind) {
    case "true":
      return FALSE;
    case "false":
      return TRUE;
    case "atom":
      return not(f);
    case "not":
      return f.of;
    case "and":
      return or(negate(f.left), negate(f.right));
    case "or":
      return and(negate(f.left), negate(f.right));
    case "next":
      return next(negate(f.of));
    case "until":
      return release(negate(f.left), negate(f.right));
    case "release":
      return until(negate(f.left), negate(f.right));
  }
}

/** Normalises a formula that may carry negations over compound subformulas into NNF. */
export function toNnf(f: Formula): Formula {
  switch (f.kind) {
    case "true":
    case "false":
    case "atom":
      return f;
    case "not":
      return f.of.kind === "atom" ? f : toNnf(negate(f.of));
    case "and":
      return and(toNnf(f.left), toNnf(f.right));
    case "or":
      return or(toNnf(f.left), toNnf(f.right));
    case "next":
      return next(toNnf(f.of));
    case "until":
      return until(toNnf(f.left), toNnf(f.right));
    case "release":
      return release(toNnf(f.left), toNnf(f.right));
  }
}

/** Canonical text, used as a structural key. Fully parenthesised so keys never collide. */
export function show(f: Formula): string {
  switch (f.kind) {
    case "true":
      return "true";
    case "false":
      return "false";
    case "atom":
      return f.name;
    case "not":
      return `!${show(f.of)}`;
    case "and":
      return `(${show(f.left)} & ${show(f.right)})`;
    case "or":
      return `(${show(f.left)} | ${show(f.right)})`;
    case "next":
      return `X${show(f.of)}`;
    case "until":
      return `(${show(f.left)} U ${show(f.right)})`;
    case "release":
      return `(${show(f.left)} R ${show(f.right)})`;
  }
}

/** Atom names in first-seen order. */
export function atomsOf(f: Formula, out: string[] = []): string[] {
  switch (f.kind) {
    case "atom":
      if (!out.includes(f.name)) out.push(f.name);
      return out;
    case "not":
    case "next":
      return atomsOf(f.of, out);
    case "and":
    case "or":
    case "until":
    case "release":
      atomsOf(f.left, out);
      return atomsOf(f.right, out);
    default:
      return out;
  }
}
