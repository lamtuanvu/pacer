import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Document, isMap, isScalar, isSeq, parseDocument, stringify, type Node } from "yaml";
import { validateStrategy } from "./strategy";

type Path = readonly (string | number)[];

/** Source-range edits keep every untouched byte, including comments and flow spacing. */
export class StrategyDoc {
  constructor(private text: string) {}
  toString(): string { return this.text; }
  private parse() {
    const doc = parseDocument(this.text);
    if (doc.errors.length) throw doc.errors[0];
    return doc;
  }
  getIn(path: Path): unknown { return this.parse().getIn(path); }
  private replace(start: number, end: number, text: string): void {
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
  }
  private column(offset: number): number { return offset - (this.text.lastIndexOf("\n", offset - 1) + 1); }
  private newline(): string { return this.text.includes("\r\n") ? "\r\n" : "\n"; }
  /** Replace an existing node; migration uses this to retain comments on moved nodes. */
  replaceNode(path: Path, node: Node): void {
    const sourceDoc = this.parse();
    const old = sourceDoc.getIn(path, true) as Node | undefined;
    if (!old?.range) throw Error(`missing strategy key: ${path.join(".")}`);
    node = node.clone() as Node;
    const parent = sourceDoc.getIn(path.slice(0, -1), true);
    if ((isMap(parent) || isSeq(parent)) && parent.flow && (isMap(node) || isSeq(node))) node.flow = true;
    node.commentBefore = undefined; // already present before the source range
    if (old.range[2] > old.range[1]) node.comment = undefined; // inline comment is outside the range
    const doc = new Document(); doc.contents = node;
    let value = doc.toString({ lineWidth: 0 }).replace(/\n$/, "");
    const block = (isMap(node) || isSeq(node)) && !node.flow;
    const wasBlock = (isMap(old) || isSeq(old)) && !old.flow;
    const lineStart = this.text.lastIndexOf("\n", old.range[0] - 1) + 1;
    const keyIndent = /^ */.exec(this.text.slice(lineStart))![0].length;
    const indent = " ".repeat(block && !wasBlock ? keyIndent + 2 : this.column(old.range[0]));
    value = value.replace(/\n/g, `${this.newline()}${indent}`);
    if (block && !wasBlock) value = `${this.newline()}${indent}${value}`;
    if (this.text[old.range[1] - 1] === "\n") value += this.newline();
    this.replace(old.range[0], old.range[1], value);
  }
  setIn(path: Path, value: unknown): void {
    if (!path.length) throw Error("a strategy key is required");
    const doc = this.parse(); const old = doc.getIn(path, true) as Node | undefined;
    if (old?.range) {
      const node = doc.createNode(value);
      if ((isMap(node) || isSeq(node))) node.flow = (isMap(old) || isSeq(old)) ? old.flow : true;
      if (isScalar(old) && isScalar(node) && typeof value === "string") node.type = old.type;
      this.replaceNode(path, node);
      return;
    }
    const parentPath = path.slice(0, -1); const key = path.at(-1)!;
    const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
    if (!isMap(parent)) {
      if (parent === undefined && parentPath.length) {
        this.setIn(parentPath, { [key]: value }); return;
      }
      throw Error(`strategy key is not a mapping: ${parentPath.join(".")}`);
    }
    const entry = stringify({ [key]: value }, { collectionStyle: "flow", lineWidth: 0 }).trim();
    // Strip only the outer braces: nested mappings and lists keep their flow form.
    const line = entry.slice(1, -1).trim();
    if (parent.flow) {
      const last = parent.items.at(-1)?.value as Node | undefined;
      const at = last?.range?.[1] ?? (parent.range![0] + 1);
      this.replace(at, at, `${parent.items.length ? ", " : ""}${line}`); return;
    }
    const firstKey = parent.items[0]?.key as Node | undefined;
    const indent = firstKey?.range ? this.column(firstKey.range[0]) : 0;
    const end = parent.range?.[1] ?? this.text.length;
    this.replace(end, end, `${end && this.text[end - 1] !== "\n" ? this.newline() : ""}${" ".repeat(indent)}${line}${this.newline()}`);
  }
  deleteIn(path: Path): void {
    const doc = this.parse(); const parentPath = path.slice(0, -1);
    const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
    if (!isMap(parent)) throw Error("strategy key is not a mapping");
    const pair = parent.items.find(p => isScalar(p.key) && p.key.value === path.at(-1));
    if (!pair) return;
    if (parent.flow) {
      const index = parent.items.indexOf(pair);
      const key = pair.key as Node; const value = pair.value as Node;
      let start = key.range![0], end = value?.range?.[1] ?? key.range![1];
      if (index < parent.items.length - 1) end = (parent.items[index + 1].key as Node).range![0];
      else if (index > 0) start = (parent.items[index - 1].value as Node).range![1];
      this.replace(start, end, ""); return;
    }
    if (parent.items.length === 1) {
      const updated = parent.clone(); updated.delete(path.at(-1));
      this.replaceNode(parentPath, updated as Node); return;
    }
    const key = pair.key as Node; const value = pair.value as Node | null;
    if (!key.range) throw Error("strategy key has no source range");
    const start = key.range[0] - this.column(key.range[0]);
    const end = value?.range?.[2] ?? key.range[2];
    this.replace(start, end, "");
  }
  addMappingEntry(section: "accounts" | "runners", name: string, value: unknown): void {
    if (this.parse().hasIn([section, name])) throw Error(`${section}.${name} already exists`);
    this.setIn([section, name], value);
  }
  removeMappingEntry(section: "accounts" | "runners", name: string): void { this.deleteIn([section, name]); }
  setScalar(path: Path, value: string | number | boolean | null): void { this.setIn(path, value); }
  setList(path: Path, values: unknown[]): void {
    const doc = this.parse(); const old = doc.getIn(path, true);
    if (!isSeq(old)) { this.setIn(path, values); return; }
    const updated = old.clone(); const remaining = [...old.items];
    updated.items = values.map(value => {
      const i = remaining.findIndex(item => isScalar(item) && item.value === value);
      return i === -1 ? doc.createNode(value) : (remaining.splice(i, 1)[0] as Node).clone();
    });
    this.replaceNode(path, updated as Node);
  }
  renameKey(path: Path, name: string): void {
    const doc = this.parse(); const parentPath = path.slice(0, -1);
    const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
    if (!isMap(parent) || parent.has(name)) throw Error("cannot rename strategy key");
    const pair = parent.items.find(p => isScalar(p.key) && p.key.value === path.at(-1));
    const key = pair?.key as Node | undefined;
    if (!key?.range) throw Error("missing strategy key");
    this.replace(key.range[0], key.range[1], stringify(name).trim());
  }
}

/** Same-directory rename prevents readers observing a partial strategy. */
export function atomicStrategyWrite(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: statSync(path).mode & 0o777 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function editStrategy(path: string, change: (doc: StrategyDoc) => void): { ok: true; diff: string } | { ok: false; error: string } {
  try {
    const before = readFileSync(path, "utf8"); const doc = new StrategyDoc(before);
    change(doc); const after = doc.toString();
    validateStrategy(Bun.YAML.parse(after), path);
    if (after === before) return { ok: true, diff: "" };
    if (readFileSync(path, "utf8") !== before) throw Error("strategy changed during edit; retry");
    atomicStrategyWrite(path, after);
    const a = before.split("\n"), b = after.split("\n");
    let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const diff = [`--- ${path}`, `+++ ${path}`, `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`,
      ...a.slice(start, endA).map(l => `-${l}`), ...b.slice(start, endB).map(l => `+${l}`)].join("\n");
    return { ok: true, diff };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
