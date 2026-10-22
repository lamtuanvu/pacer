/** Deterministic TypeScript byte oracle for M2's future YAML editor port.
 * Run: bun scripts/golden/strategy-doc.ts [--check]
 * This records StrategyDoc, not editStrategy validation/locking or Rust parity.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, isMap, isNode, isSeq, parseDocument, type Node } from "yaml";
import { StrategyDoc } from "../../src/config/edit";

type Path = (string | number)[];
type Operation = "getIn" | "setIn" | "deleteIn" | "replaceNode" | "addMappingEntry" | "removeMappingEntry" | "setScalar" | "setList" | "renameKey";
interface Case {
  id: string;
  classes: string[];
  before: string;
  op: Operation;
  path: Path;
  value?: unknown;
}
export interface StrategyDocGolden extends Case {
  after: string;
  result?: { found: boolean; value?: unknown };
  error?: string;
}
const fixtureDir = join(import.meta.dir, "../../test/fixtures/strategy-doc");
export const strategyDocGoldenPath = join(fixtureDir, "goldens.json");

/** Clone and modify parsed nodes the way migration/routing callers do. */
function replacement(doc: StrategyDoc, path: Path, value: unknown): Node {
  const edit = value as { kind: string; yaml?: string; entries?: Record<string, unknown>; value?: unknown; index?: number };
  if (edit.kind === "yaml") {
    const parsed = parseDocument(edit.yaml!);
    if (parsed.errors.length) throw parsed.errors[0];
    if (!parsed.contents) throw Error("replacement YAML has no node");
    return parsed.contents as Node;
  }
  const original = doc.getIn(path);
  if (!isNode(original)) throw Error("replacement source is not a node");
  const updated = original.clone();
  if (edit.kind === "append" && isSeq(updated)) updated.add(edit.value);
  else if (edit.kind === "insertAt" && isSeq(updated)) updated.items.splice(edit.index!, 0, new Document().createNode(edit.value));
  else if (edit.kind === "removeAt" && isSeq(updated)) updated.delete(edit.index!);
  else if (edit.kind === "setEntries" && isMap(updated)) {
    for (const [key, entry] of Object.entries(edit.entries!)) updated.set(key, entry);
  } else throw Error(`unsupported replacement transform: ${edit.kind}`);
  return updated;
}

export function recordStrategyDocs(): StrategyDocGolden[] {
  const cases = JSON.parse(readFileSync(join(fixtureDir, "cases.json"), "utf8")) as Case[];
  return cases.map(input => {
    const doc = new StrategyDoc(input.before);
    const output: StrategyDocGolden = { ...input, after: input.before };
    try {
      switch (input.op) {
        case "getIn": {
          const result = doc.getIn(input.path);
          output.result = result === undefined ? { found: false } : { found: true, value: isNode(result) ? result.toJSON() : result };
          break;
        }
        case "setIn": doc.setIn(input.path, input.value); break;
        case "deleteIn": doc.deleteIn(input.path); break;
        case "replaceNode": doc.replaceNode(input.path, replacement(doc, input.path, input.value)); break;
        case "addMappingEntry": doc.addMappingEntry(input.path[0] as "accounts" | "runners", String(input.path[1]), input.value); break;
        case "removeMappingEntry": doc.removeMappingEntry(input.path[0] as "accounts" | "runners", String(input.path[1])); break;
        case "setScalar": doc.setScalar(input.path, input.value as string | number | boolean | null); break;
        case "setList": doc.setList(input.path, input.value as unknown[]); break;
        case "renameKey": doc.renameKey(input.path, String(input.value)); break;
        default: throw Error(`unknown StrategyDoc operation: ${String(input.op)}`);
      }
    } catch (error) {
      output.error = error instanceof Error ? error.message : String(error);
    }
    output.after = doc.toString();
    return output;
  });
}

/** Deliberately compare text, comments and errors without YAML normalization. */
export function compareStrategyDocGoldens(expected: StrategyDocGolden[], actual: StrategyDocGolden[]): string[] {
  const mismatches: string[] = [];
  const expectedById = new Map(expected.map(item => [item.id, item]));
  const actualById = new Map(actual.map(item => [item.id, item]));
  for (const id of new Set([...expectedById.keys(), ...actualById.keys()])) {
    if (JSON.stringify(expectedById.get(id)) !== JSON.stringify(actualById.get(id))) mismatches.push(id);
  }
  // Order and duplicates are part of the deterministic corpus contract too.
  if (JSON.stringify(expected.map(item => item.id)) !== JSON.stringify(actual.map(item => item.id)) && !mismatches.length) mismatches.push("case-order");
  return mismatches;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/strategy-doc.ts [--check]");
    process.exit(2);
  }
  const actual = recordStrategyDocs();
  const serialized = JSON.stringify(actual, null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(strategyDocGoldenPath, "utf8") !== serialized) {
      console.error("StrategyDoc goldens are stale; regenerate and inspect the byte changes");
      process.exit(1);
    }
    console.log(`checked ${actual.length} TypeScript StrategyDoc cases (Rust parity unverified)`);
  } else {
    writeFileSync(strategyDocGoldenPath, serialized);
    console.log(`recorded ${actual.length} TypeScript StrategyDoc cases`);
  }
}
