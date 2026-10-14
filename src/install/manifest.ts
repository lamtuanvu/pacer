import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { hasBlock, removeBlock, type BlockStyle } from "./blocks";
import { readText } from "./fsx";
import { removeHooks, restoreHooks, type HookFormat, type RemovedHook } from "./hookjson";
import { getMember, isEmptyObject, parseJsonc, removeMember } from "./jsonc";

export type UndoOp = { kind: "block"; style: BlockStyle; restore?: { text: string; anchor: string | null; spacing?: string; atMarker?: boolean }[] }
  | { kind: "toml-table"; table: string }
  | { kind: "json-member"; path: string[]; dropEmpty?: string[] }
  | { kind: "hooks"; format: HookFormat; commands: string[]; restore: RemovedHook[] }
  | { kind: "json-key"; key: string };
export interface FileChange {
  path: string; action: "created" | "edited" | "moved";
  backup?: string; afterHash?: string; exact?: boolean; undo: UndoOp[];
}
export interface PlannerRecord {
  planner: string; account?: string; folder?: string; configEnv?: Record<string, string>; installedAt: number; pacerArgv: string[]; files: FileChange[];
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
export function applyUndo(text: string, ops: UndoOp[], notes: string[] = []): string {
  for (const op of ops) {
    switch (op.kind) {
      case "block": {
        let marker = op.style === "hash" && hasBlock(text, op.style) ? text.indexOf("# >>> pacer >>>") : -1;
        const prefix = marker >= 0 ? text.slice(0, marker) : "";
        text = removeBlock(text, op.style);
        // Removing an appended block trims its separator; a replacement needs it back.
        if (text.length < marker && op.restore?.some(item => item.atMarker)) text = prefix;
        let position = 0;
        for (const removed of op.restore ?? []) {
          if (text.includes(removed.text)) continue;
          let at = -1;
          if (removed.atMarker && marker >= 0) at = marker;
          else if (removed.anchor === null) at = position;
          else {
            // Match whole lines, searching forward so repeated anchors retain order.
            let offset = 0;
            for (const line of text.split(/(?<=\n)/)) {
              if (offset >= position && line === removed.anchor) {
                at = offset + line.length;
                if (removed.spacing && text.startsWith(removed.spacing, at)) at += removed.spacing.length;
                break;
              }
              offset += line.length;
            }
          }
          if (at < 0) {
            if (text && !text.endsWith("\n")) text += "\n";
            at = text.length;
            notes.push("Legacy statusline block anchor missing; appended restored block.");
          }
          text = text.slice(0, at) + removed.text + text.slice(at);
          if (marker >= at) marker += removed.text.length;
          position = at;
        }
        break;
      }
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
    else if (prior.kind === "block" && op.kind === "block" && op.restore?.length) {
      prior.restore ??= [];
      for (const removed of op.restore) {
        if (!prior.restore.some(item => item.text === removed.text)) prior.restore.push(structuredClone(removed));
      }
    }
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
