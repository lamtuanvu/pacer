import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { hasBlock, removeBlock, type BlockStyle } from "./blocks";
import { readText } from "./fsx";
import { removeHooks, restoreHooks, type HookFormat, type RemovedHook } from "./hookjson";
import { getMember, isEmptyObject, parseJsonc, removeMember } from "./jsonc";

export type UndoOp = { kind: "block"; style: BlockStyle }
  | { kind: "toml-table"; table: string }
  | { kind: "json-member"; path: string[]; dropEmpty?: string[] }
  | { kind: "hooks"; format: HookFormat; commands: string[]; restore: RemovedHook[] }
  | { kind: "json-key"; key: string };
export interface FileChange {
  path: string; action: "created" | "edited" | "moved";
  backup?: string; afterHash?: string; exact?: boolean; undo: UndoOp[];
}
export interface PlannerRecord {
  planner: string; installedAt: number; pacerArgv: string[]; files: FileChange[];
  commands: { undo: string[] }[]; notes: string[];
}
export interface Manifest { version: 1; planners: Record<string, PlannerRecord> }
export function readManifest(ctx: Pick<Ctx, "pacerHome">): Manifest {
  const text = readText(join(ctx.pacerHome, "install-manifest.json"));
  return text === null ? { version: 1, planners: {} } : JSON.parse(text);
}
export function writeManifest(ctx: Pick<Ctx, "pacerHome">, manifest: Manifest): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "install-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
export function removeTomlTable(text: string, table: string): string {
  const lines = text.split(/(?<=\n)/);
  const header = `[${table}]`;
  const start = lines.findIndex(line => line.startsWith(header)
    && /^[\t ]*(?:#[^\r\n]*)?(?:\r?\n)?$/.test(line.slice(header.length)));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("[")) end++;
  return lines.slice(0, start).join("") + lines.slice(end).join("");
}
export function applyUndo(text: string, ops: UndoOp[]): string {
  for (const op of ops) {
    switch (op.kind) {
      case "block": text = removeBlock(text, op.style); break;
      case "toml-table": text = removeTomlTable(text, op.table); break;
      case "json-member":
        text = removeMember(text, op.path);
        if (op.dropEmpty && isEmptyObject(text, op.dropEmpty)) text = removeMember(text, op.dropEmpty);
        break;
      case "hooks": {
        const doc = removeHooks(parseJsonc(text), op.format, command => op.commands.includes(command)).doc;
        text = JSON.stringify(restoreHooks(doc, op.format, op.restore), null, 2) + "\n";
        break;
      }
      case "json-key": {
        const doc = parseJsonc(text);
        delete doc[op.key];
        text = JSON.stringify(doc, null, 2) + "\n";
        break;
      }
    }
  }
  return text;
}
function key(op: UndoOp): string {
  switch (op.kind) {
    case "block": return JSON.stringify([op.kind, op.style]);
    case "toml-table": return JSON.stringify([op.kind, op.table]);
    case "json-member": return JSON.stringify([op.kind, op.path]);
    case "json-key": return JSON.stringify([op.kind, op.key]);
    case "hooks": return JSON.stringify([op.kind, op.format]);
  }
}
export function mergeUndo(old: UndoOp[], added: UndoOp[]): UndoOp[] {
  const result: UndoOp[] = structuredClone(old);
  for (const op of added) {
    const prior = result.find(item => key(item) === key(op));
    if (!prior) result.push(structuredClone(op));
    else if (prior.kind === "hooks" && op.kind === "hooks") {
      prior.commands = [...new Set([...prior.commands, ...op.commands])];
      prior.restore.push(...structuredClone(op.restore));
    }
  }
  return result;
}
export function piecesPresent(text: string, ops: UndoOp[]): boolean {
  try {
    return ops.every(op => {
      switch (op.kind) {
        case "block": return hasBlock(text, op.style);
        case "toml-table": return removeTomlTable(text, op.table) !== text;
        case "json-member": return getMember(text, op.path) !== undefined;
        case "json-key": return Object.hasOwn(parseJsonc(text), op.key);
        case "hooks": {
          const removed = removeHooks(parseJsonc(text), op.format, command => op.commands.includes(command)).removed;
          return op.commands.every(command => removed.some(item => item.hook.command === command));
        }
      }
    });
  } catch { return false; }
}
