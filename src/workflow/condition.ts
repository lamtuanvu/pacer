// The condition language for edge `when` clauses. A tiny hand-written recursive-descent
// parser over a grammar that stays inside what an edge condition needs: and/or/not,
// equality, ordering, membership, literals and paths rooted at `result` or `brief`.
//
// Evaluation never throws: a missing field or a mismatched comparison is false, so a
// malformed result can never break a run's advancing (spec, Review Focus 5).

export type CondValue =
  | { kind: "path"; segments: string[] }
  | { kind: "str"; value: string }
  | { kind: "num"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "list"; items: CondValue[] };

export type CondAst =
  | { kind: "or"; terms: CondAst[] }
  | { kind: "and"; terms: CondAst[] }
  | { kind: "not"; term: CondAst }
  | { kind: "cmp"; op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "in"; left: CondValue; right: CondValue }
  | { kind: "truthy"; value: CondValue };

export type CondScope = { result: unknown; brief: string };

interface Tok {
  t: "path" | "str" | "num" | "kw" | "op";
  value: string; // path: dotted source text; kw/op: the keyword or operator; str: contents; num: digits
  num?: number;
  pos: number;
}

const KEYWORDS = new Set(["and", "or", "not", "in", "true", "false"]);
const ROOTS = new Set(["result", "brief"]);
const OPS2 = ["==", "!=", "<=", ">="];
const OPS1 = ["(", ")", "[", "]", ",", "<", ">"];
const CMP_OPS = ["==", "!=", "<", "<=", ">", ">=", "in"];

class CondParseError extends Error {
  constructor(readonly position: number, message: string) {
    super(message);
  }
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const fail = (pos: number, what: string): never => {
    throw new CondParseError(pos, `${what} at position ${pos}`);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "'" || c === "\"") {
      const end = src.indexOf(c, i + 1);
      if (end === -1) fail(i, "unterminated string");
      toks.push({ t: "str", value: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ t: "num", value: m[0], num: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      const text = m[0];
      if (text.includes(".")) {
        const segments = text.split(".");
        if (!ROOTS.has(segments[0])) fail(i, `unknown path root '${segments[0]}'`);
        toks.push({ t: "path", value: text, pos: i });
      } else if (KEYWORDS.has(text)) {
        toks.push({ t: "kw", value: text, pos: i });
      } else if (ROOTS.has(text)) {
        toks.push({ t: "path", value: text, pos: i });
      } else {
        fail(i, `unknown path root '${text}'`);
      }
      i += text.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      toks.push({ t: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      toks.push({ t: "op", value: c, pos: i });
      i++;
      continue;
    }
    fail(i, `unexpected character '${c}'`);
  }
  return toks;
}

class Parser {
  private i = 0;
  constructor(private readonly src: string, private readonly toks: Tok[]) {}

  parse(): CondAst {
    const ast = this.expr();
    const extra = this.toks[this.i];
    if (extra) throw new CondParseError(extra.pos, `unexpected '${extra.value}' at position ${extra.pos}`);
    return ast;
  }

  private expr(): CondAst {
    const first = this.and();
    if (!this.atKw("or")) return first;
    const terms = [first];
    while (this.atKw("or")) {
      this.i++;
      terms.push(this.and());
    }
    return { kind: "or", terms };
  }

  private and(): CondAst {
    const first = this.unary();
    if (!this.atKw("and")) return first;
    const terms = [first];
    while (this.atKw("and")) {
      this.i++;
      terms.push(this.unary());
    }
    return { kind: "and", terms };
  }

  private unary(): CondAst {
    if (this.atKw("not")) {
      this.i++;
      return { kind: "not", term: this.unary() };
    }
    if (this.atOp("(")) {
      this.i++;
      const e = this.expr();
      if (!this.atOp(")")) {
        const tok = this.toks[this.i];
        throw new CondParseError(tok?.pos ?? this.src.length, `expected ')' at position ${tok?.pos ?? this.src.length}`);
      }
      this.i++;
      return e;
    }
    return this.cmp();
  }

  private cmp(): CondAst {
    const left = this.value();
    const tok = this.toks[this.i];
    const op = tok && ((tok.t === "op" && CMP_OPS.includes(tok.value)) || (tok.t === "kw" && tok.value === "in")) ? tok.value : null;
    if (!op) return { kind: "truthy", value: left };
    this.i++;
    const right = this.value();
    return { kind: "cmp", op: op as "==" | "!=" | "<" | "<=" | ">" | ">=" | "in", left, right };
  }

  private value(): CondValue {
    const tok = this.toks[this.i];
    if (!tok) throw new CondParseError(this.src.length, `expected a value at position ${this.src.length}`);
    this.i++;
    switch (tok.t) {
      case "path":
        return { kind: "path", segments: tok.value.split(".") };
      case "str":
        return { kind: "str", value: tok.value };
      case "num":
        return { kind: "num", value: tok.num! };
      case "kw":
        if (tok.value === "true" || tok.value === "false") return { kind: "bool", value: tok.value === "true" };
        break;
      case "op":
        if (tok.value === "[") {
          const items: CondValue[] = [];
          if (this.atOp("]")) {
            this.i++;
            return { kind: "list", items };
          }
          for (;;) {
            items.push(this.value());
            if (this.atOp(",")) {
              this.i++;
              continue;
            }
            if (this.atOp("]")) {
              this.i++;
              return { kind: "list", items };
            }
            const next = this.toks[this.i];
            throw new CondParseError(next?.pos ?? this.src.length, `expected ',' or ']' at position ${next?.pos ?? this.src.length}`);
          }
        }
        break;
    }
    throw new CondParseError(tok.pos, `expected a value at position ${tok.pos}`);
  }

  private atKw(word: string): boolean {
    const tok = this.toks[this.i];
    return tok?.t === "kw" && tok.value === word;
  }

  private atOp(op: string): boolean {
    const tok = this.toks[this.i];
    return tok?.t === "op" && tok.value === op;
  }
}

export function parseCondition(src: string): { ast?: CondAst; error?: string } {
  try {
    return { ast: new Parser(src, lex(src)).parse() };
  } catch (e) {
    if (e instanceof CondParseError) return { error: e.message };
    return { error: `${e instanceof Error ? e.message : String(e)} at position 0` };
  }
}

type Resolved = { found: boolean; value: unknown };

function resolveValue(v: CondValue, scope: CondScope): Resolved {
  switch (v.kind) {
    case "str":
      return { found: true, value: v.value };
    case "num":
      return { found: true, value: v.value };
    case "bool":
      return { found: true, value: v.value };
    case "list": {
      const items: unknown[] = [];
      for (const item of v.items) {
        const r = resolveValue(item, scope);
        if (!r.found) return { found: false, value: undefined };
        items.push(r.value);
      }
      return { found: true, value: items };
    }
    case "path": {
      const [root, ...rest] = v.segments;
      let cur = root === "result" ? scope.result : scope.brief;
      for (const seg of rest) {
        if (cur === null || cur === undefined || typeof cur !== "object") return { found: false, value: undefined };
        // Own properties only: prototype keys like `constructor` never resolve.
        if (!Object.hasOwn(cur as Record<string, unknown>, seg)) return { found: false, value: undefined };
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (cur === undefined) return { found: false, value: undefined };
      return { found: true, value: cur };
    }
  }
}

function equal(a: unknown, b: unknown): boolean {
  return a === b;
}

function truthy(r: Resolved): boolean {
  if (!r.found) return false;
  const v = r.value;
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (typeof v === "number" && Number.isNaN(v)) return false;
  return true;
}

function evalAst(ast: CondAst, scope: CondScope): boolean {
  switch (ast.kind) {
    case "or":
      return ast.terms.some(t => evalAst(t, scope));
    case "and":
      return ast.terms.every(t => evalAst(t, scope));
    case "not":
      return !evalAst(ast.term, scope);
    case "truthy":
      return truthy(resolveValue(ast.value, scope));
    case "cmp": {
      const l = resolveValue(ast.left, scope);
      const r = resolveValue(ast.right, scope);
      if (!l.found || !r.found) return false;
      switch (ast.op) {
        case "==":
          return equal(l.value, r.value);
        case "!=":
          return !equal(l.value, r.value);
        case "<":
        case "<=":
        case ">":
        case ">=": {
          const a = l.value;
          const b = r.value;
          const bothNumbers = typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b);
          const bothStrings = typeof a === "string" && typeof b === "string";
          if (!bothNumbers && !bothStrings) return false;
          switch (ast.op) {
            case "<":
              return a < b;
            case "<=":
              return a <= b;
            case ">":
              return a > b;
            default:
              return a >= b;
          }
        }
        case "in": {
          if (!Array.isArray(r.value)) return false;
          return (r.value as unknown[]).some(item => equal(l.value, item));
        }
      }
    }
  }
}

export function evalCondition(ast: CondAst, scope: CondScope): boolean {
  try {
    return evalAst(ast, scope);
  } catch {
    return false;
  }
}
