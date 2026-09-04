import { always, and, atom, eventually, FALSE, implies, next, not, or, release, toNnf, TRUE, until, weakUntil, type Formula } from "./ast.js";

/**
 * Recursive-descent parser for the surface syntax. Precedence, loosest first:
 *   <->  ->  |  &  (U R W, left-assoc)  (prefix: ! G F X)  atoms, true, false, parentheses.
 * Returns the formula in negation normal form.
 */
export class LtlSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} at position ${position}`);
    this.name = "LtlSyntaxError";
  }
}

type Token = { type: "ident" | "op" | "lparen" | "rparen" | "end"; text: string; pos: number };

const OPS = ["<->", "->", "|", "&", "!", "U", "R", "W", "G", "F", "X"] as const;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", text: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", text: ch, pos: i });
      i += 1;
      continue;
    }
    if (src.startsWith("<->", i)) {
      tokens.push({ type: "op", text: "<->", pos: i });
      i += 3;
      continue;
    }
    if (src.startsWith("->", i)) {
      tokens.push({ type: "op", text: "->", pos: i });
      i += 2;
      continue;
    }
    if (ch === "|" || ch === "&" || ch === "!") {
      tokens.push({ type: "op", text: ch, pos: i });
      i += 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (m) {
      const word = m[0];
      const isOp = (OPS as readonly string[]).includes(word);
      tokens.push({ type: isOp ? "op" : "ident", text: word, pos: i });
      i += word.length;
      continue;
    }
    throw new LtlSyntaxError(`unexpected character "${ch}"`, i);
  }
  tokens.push({ type: "end", text: "", pos: src.length });
  return tokens;
}

export function parseLtl(src: string): Formula {
  const tokens = tokenize(src);
  let k = 0;
  const peek = (): Token => tokens[k] ?? { type: "end", text: "", pos: src.length };
  const take = (): Token => {
    const t = peek();
    k += 1;
    return t;
  };
  const isOp = (text: string): boolean => peek().type === "op" && peek().text === text;

  function iff(): Formula {
    let left = imp();
    while (isOp("<->")) {
      take();
      const right = imp();
      left = and(implies(left, right), implies(right, left));
    }
    return left;
  }
  function imp(): Formula {
    const left = disj();
    if (isOp("->")) {
      take();
      return implies(left, imp()); // right-associative
    }
    return left;
  }
  function disj(): Formula {
    let left = conj();
    while (isOp("|")) {
      take();
      left = or(left, conj());
    }
    return left;
  }
  function conj(): Formula {
    let left = temporal();
    while (isOp("&")) {
      take();
      left = and(left, temporal());
    }
    return left;
  }
  function temporal(): Formula {
    let left = unary();
    for (;;) {
      if (isOp("U")) {
        take();
        left = until(left, unary());
      } else if (isOp("R")) {
        take();
        left = release(left, unary());
      } else if (isOp("W")) {
        take();
        left = weakUntil(left, unary());
      } else return left;
    }
  }
  function unary(): Formula {
    const t = peek();
    if (t.type === "op") {
      switch (t.text) {
        case "!":
          take();
          return not(unary());
        case "G":
          take();
          return always(unary());
        case "F":
          take();
          return eventually(unary());
        case "X":
          take();
          return next(unary());
        default:
          throw new LtlSyntaxError(`unexpected operator "${t.text}"`, t.pos);
      }
    }
    return primary();
  }
  function primary(): Formula {
    const t = take();
    if (t.type === "lparen") {
      const inner = iff();
      const close = take();
      if (close.type !== "rparen") throw new LtlSyntaxError("expected )", close.pos);
      return inner;
    }
    if (t.type === "ident") {
      if (t.text === "true") return TRUE;
      if (t.text === "false") return FALSE;
      return atom(t.text);
    }
    throw new LtlSyntaxError(t.type === "end" ? "unexpected end of formula" : `unexpected "${t.text}"`, t.pos);
  }

  const f = iff();
  const last = take();
  if (last.type !== "end") throw new LtlSyntaxError(`unexpected "${last.text}" after formula`, last.pos);
  return toNnf(f);
}
