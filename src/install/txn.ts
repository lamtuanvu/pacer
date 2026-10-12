import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ctx } from "../types";
import { backupPath, readText, sha256, shellCommand } from "./fsx";
import { mergeUndo, readManifest, writeManifest, type PlannerRecord, type UndoOp } from "./manifest";

export class InstallError extends Error {
  constructor(message: string) { super(message); this.name = "InstallError"; }
}
export interface InstallEnv { ctx: Ctx; pacerArgv: string[] }
export class Txn {
  readonly record: PlannerRecord;
  readonly touched: string[] = [];
  readonly notes: string[] = [];
  private changes: (() => void)[] = [];
  private commandUndos: string[][] = [];
  constructor(readonly env: InstallEnv, planner: string, prior?: PlannerRecord) {
    this.record = prior ? structuredClone(prior) : {
      planner, installedAt: env.ctx.now, pacerArgv: [...env.pacerArgv], files: [], commands: [], notes: [],
    };
    this.record.pacerArgv = [...env.pacerArgv];
  }
  edit(path: string, fn: (old: string | null) => string, undo: UndoOp[]): boolean {
    const old = readText(path);
    let next: string;
    try { next = fn(old); }
    catch (error) { throw new InstallError(`cannot update ${path}: ${error instanceof Error ? error.message : String(error)}`); }
    if (next === old) return false;
    let change = this.record.files.find(file => file.path === path);
    if (change?.action === "moved") throw new InstallError(`cannot update ${path}: already moved aside`);
    if (!change) {
      const backup = old === null ? undefined : backupPath(path, this.env.ctx.now);
      if (backup) {
        copyFileSync(path, backup);
        this.changes.push(() => rmSync(backup, { force: true }));
      }
      change = { path, action: old === null ? "created" : "edited", backup, exact: true, undo: [] };
      this.record.files.push(change);
    } else if (old === null || sha256(old) !== change.afterHash) change.exact = false;
    this.changes.push(() => {
      if (old === null) rmSync(path, { force: true });
      else writeFileSync(path, old);
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    change.afterHash = sha256(next);
    change.undo = mergeUndo(change.undo, undo);
    if (!this.touched.includes(path)) this.touched.push(path);
    return true;
  }
  moveAside(path: string): void {
    if (this.record.files.some(file => file.path === path)) {
      this.notes.push(`${path} already recorded; skipping move`); return;
    }
    if (!existsSync(path)) return;
    const backup = backupPath(path, this.env.ctx.now);
    renameSync(path, backup);
    this.changes.push(() => renameSync(backup, path));
    this.record.files.push({ path, action: "moved", backup, undo: [] });
    this.touched.push(path);
  }
  async run(argv: string[], undo?: string[], options: { quiet?: boolean } = {}): Promise<void> {
    try {
      const result = await this.env.ctx.run(argv, 30000);
      if (result.code !== 0) this.notes.push(`\`${shellCommand(argv)}\` failed (exit ${result.code}): ${(result.stderr || result.stdout).split(/\r?\n/)[0]}`);
    } catch (error) {
      this.notes.push(`\`${shellCommand(argv)}\` failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (undo) {
      const same = (item: string[]) => JSON.stringify(item) === JSON.stringify(undo);
      if (!this.record.commands.some(command => same(command.undo))) this.record.commands.push({ undo: [...undo] });
      if (!this.commandUndos.some(same)) this.commandUndos.push([...undo]);
    }
  }
  async rollback(): Promise<void> {
    for (const change of this.changes.reverse()) {
      try { change(); } catch (error) { this.notes.push(`rollback failed: ${String(error)}`); }
    }
    for (const undo of this.commandUndos.reverse()) {
      try { await this.env.ctx.run(undo, 30000); } catch (error) { this.notes.push(`rollback command failed: ${String(error)}`); }
    }
    this.changes = []; this.commandUndos = [];
  }
  commit(): void {
    const manifest = readManifest(this.env.ctx);
    this.record.notes.push(...this.notes);
    manifest.planners[this.record.planner] = this.record;
    writeManifest(this.env.ctx, manifest);
  }
}
export async function runInstall(env: InstallEnv, planner: string, fn: (tx: Txn) => void | Promise<void>): Promise<{ record: PlannerRecord; touched: string[]; notes: string[] }> {
  const tx = new Txn(env, planner, readManifest(env.ctx).planners[planner]);
  try { await fn(tx); tx.commit(); }
  catch (error) { await tx.rollback(); throw error; }
  return { record: tx.record, touched: tx.touched, notes: tx.notes };
}
