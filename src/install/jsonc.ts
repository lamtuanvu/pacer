export class JsoncError extends Error {
  constructor(message: string) { super(message); this.name = "JsoncError"; }
}

interface Member { key: string; keyStart: number; value: Node }
interface Node { start: number; end: number; kind: "object" | "array" | "string" | "literal"; members: Member[] }

class Parser {
  pos = 0;
  constructor(readonly text: string) {
    // Skip only the leading BOM so all spans still index the original text.
    if (text.startsWith("\uFEFF")) this.pos = 1;
  }

  fail(message: string): never { throw new JsoncError(`${message} at offset ${this.pos}`); }

  skip(): void {
    while (this.pos < this.text.length) {
      if (/[ \t\r\n]/.test(this.text[this.pos])) { this.pos++; continue; }
      if (this.text.startsWith("//", this.pos)) {
        while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos++;
      } else if (this.text.startsWith("/*", this.pos)) {
        const end = this.text.indexOf("*/", this.pos + 2);
        if (end < 0) this.fail("unterminated comment");
        this.pos = end + 2;
      } else break;
    }
  }

  readString(): string {
    const start = this.pos++;
    while (this.pos < this.text.length) {
      const char = this.text[this.pos++];
      if (char === "\\") this.pos++;
      else if (char === '"') {
        try { return JSON.parse(this.text.slice(start, this.pos)); }
        catch { this.fail("invalid string"); }
      }
    }
    return this.fail("unterminated string");
  }

  value(): Node {
    this.skip();
    const start = this.pos;
    const char = this.text[this.pos];
    const members: Member[] = [];
    let kind: Node["kind"];
    if (char === "{" || char === "[") {
      kind = char === "{" ? "object" : "array";
      const close = char === "{" ? "}" : "]";
      this.pos++;
      this.skip();
      while (this.text[this.pos] !== close) {
        if (kind === "object") {
          const keyStart = this.pos;
          if (this.text[this.pos] !== '"') this.fail("expected object key");
          const key = this.readString();
          this.skip();
          if (this.text[this.pos++] !== ":") this.fail("expected colon");
          members.push({ key, keyStart, value: this.value() });
        } else this.value();
        this.skip();
        if (this.text[this.pos] === close) break;
        if (this.text[this.pos++] !== ",") this.fail("expected comma");
        this.skip();
      }
      this.pos++;
    } else if (char === '"') {
      kind = "string";
      this.readString();
    } else {
      kind = "literal";
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.pos));
      if (!match) this.fail("expected value");
      this.pos += match[0].length;
    }
    return { start, end: this.pos, kind, members };
  }
}

function parseRoot(text: string): Node {
  const parser = new Parser(text);
  parser.skip();
  if (text[parser.pos] !== "{") parser.fail("top level must be an object");
  const root = parser.value();
  parser.skip();
  if (parser.pos !== text.length) parser.fail("unexpected text after root");
  return root;
}

export function stripJsonc(text: string): string {
  const parser = new Parser(text);
  let result = "";
  while (parser.pos < text.length) {
    const start = parser.pos;
    if (text[start] === '"') {
      parser.readString();
      result += text.slice(start, parser.pos);
    } else if (text.startsWith("//", start) || text.startsWith("/*", start)) {
      parser.skip();
      // Keep a token boundary when a comment separates two literals.
      result += " ";
    } else if (text[start] === ",") {
      parser.pos++;
      parser.skip();
      if (text[parser.pos] !== "}" && text[parser.pos] !== "]") result += ",";
      parser.pos = start + 1;
    } else result += text[parser.pos++];
  }
  return result;
}

export function parseJsonc(text: string): Record<string, unknown> {
  parseRoot(text);
  try { return JSON.parse(stripJsonc(text)); }
  catch (error) { throw new JsoncError(String(error)); }
}

function member(obj: Node, key: string): Member | undefined {
  // JSON.parse uses the last occurrence of a duplicate key.
  return obj.members.findLast(m => m.key === key);
}

function lookup(root: Node, path: readonly string[]): Node | undefined {
  let node: Node | undefined = root;
  for (const key of path) {
    if (node?.kind !== "object") return undefined;
    node = member(node, key)?.value;
  }
  return node;
}

export function getMember(text: string, path: readonly string[]): unknown {
  const node = lookup(parseRoot(text), path);
  return node ? JSON.parse(stripJsonc(text.slice(node.start, node.end))) : undefined;
}

export function isEmptyObject(text: string, path: readonly string[]): boolean {
  const node = lookup(parseRoot(text), path);
  return node?.kind === "object" && node.members.length === 0;
}

function lineIndent(text: string, pos: number): string {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[\t ]*/.exec(text.slice(start, pos))![0];
}

function render(value: unknown, indent: string): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new JsoncError("value must be JSON serializable");
  return json.split("\n").join("\n" + indent);
}

export function setMember(text: string, path: readonly string[], value: unknown): string {
  let obj = parseRoot(text);
  if (!path.length) throw new JsoncError("member path must not be empty");
  for (let i = 0; i < path.length; i++) {
    if (obj.kind !== "object") throw new JsoncError("parent must be an object");
    const existing = member(obj, path[i]);
    if (existing && i < path.length - 1) { obj = existing.value; continue; }
    if (existing) {
      return text.slice(0, existing.value.start) + render(value, lineIndent(text, existing.keyStart)) + text.slice(existing.value.end);
    }
    let nested = value;
    for (let j = path.length - 1; j > i; j--) nested = { [path[j]]: nested };
    const first = obj.members[0];
    const lineStart = first ? text.lastIndexOf("\n", first.keyStart - 1) + 1 : 0;
    const indent = first && /^[\t ]*$/.test(text.slice(lineStart, first.keyStart))
      ? text.slice(lineStart, first.keyStart) : lineIndent(text, obj.start) + "  ";
    const entry = `${JSON.stringify(path[i])}: ${render(nested, indent)}`;
    if (!first) {
      return text.slice(0, obj.start) + `{\n${indent}${entry}\n${lineIndent(text, obj.start)}}` + text.slice(obj.end);
    }
    return text.slice(0, obj.start + 1) + `\n${indent}${entry},` + text.slice(obj.start + 1);
  }
  throw new JsoncError("invalid member path");
}

export function removeMember(text: string, path: readonly string[]): string {
  const root = parseRoot(text);
  if (!path.length) throw new JsoncError("member path must not be empty");
  const parent = lookup(root, path.slice(0, -1));
  if (parent?.kind !== "object") return text;
  const target = member(parent, path[path.length - 1]);
  if (!target) return text;
  if (parent.members.length === 1) return text.slice(0, parent.start) + "{}" + text.slice(parent.end);
  const parser = new Parser(text);
  parser.pos = target.value.end;
  parser.skip();
  let start: number;
  let end: number;
  if (text[parser.pos] === ",") {
    const newline = text.lastIndexOf("\n", target.keyStart - 1);
    start = newline >= 0 && /^[\t ]*$/.test(text.slice(newline + 1, target.keyStart)) ? newline : target.keyStart;
    end = parser.pos + 1;
    const lineEnd = text.indexOf("\n", end);
    const remainder = text.slice(end, lineEnd < 0 ? text.length : lineEnd);
    if (/^[\t ]*\/\//.test(remainder)) end = lineEnd < 0 ? text.length : lineEnd;
  } else {
    start = parent.members[parent.members.indexOf(target) - 1].value.end;
    end = target.value.end;
  }
  return text.slice(0, start) + text.slice(end);
}
