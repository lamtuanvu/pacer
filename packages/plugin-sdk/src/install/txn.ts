import { shellCommand } from "./helpers";
import { InstallError, InstallPlan, type PlanEnv, type PlanIO, type PendingFile } from "./plan";
import type { PlannerRecord } from "./undo";

/**
 * Internal admitted backend, never plugin authority. The host holds its install
 * lock for recovery, planning and settlement, validates argv/paths and binds the
 * planner identity. It merges only this record into its manifest and commits
 * files with the journal protocol. Rejection means backend settlement finished
 * (or retained a recoverable journal). These callbacks must not abandon admitted
 * effects on caller cancellation. run merges configEnv with host-owned base env.
 */
export interface TransactionIO extends PlanIO {
  recover(): Promise<void>;
  readRecord(planner: string): Promise<PlannerRecord | undefined>;
  run(argv: string[], timeout: number, configEnv?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>;
  commit(planner: string, record: PlannerRecord, files: PendingFile[]): Promise<void>;
}
export interface InstallReport { record: PlannerRecord; touched: string[]; notes: string[] }
type RunOptions = { quiet?: boolean; successNote?: string };

/** Internal command orchestration around staging; no filesystem/process authority. */
export class Txn extends InstallPlan {
  private readonly planner: string;
  private readonly configEnv: Record<string, string> | undefined;
  private readonly reconcile: boolean;
  private commandUndos: string[][] = [];
  private commands: Promise<void> = Promise.resolve();
  private commandFailure: { error: unknown } | undefined;
  private state: "planning" | "committing" | "committed" | "rolling-back" | "rolled-back" = "planning";
  private rollbackWork: Promise<void> | undefined;
  private commitWork: Promise<void> | undefined;
  constructor(private readonly backend: TransactionIO, env: PlanEnv, planner: string, prior?: PlannerRecord) {
    super(backend, env, planner, prior);
    this.planner = env.plannerKey ?? planner;
    if (this.record.planner !== this.planner) throw new InstallError("installation planner identity mismatch");
    this.configEnv = env.configEnv ? { ...env.configEnv } : undefined;
    this.reconcile = env.mode === "reconcile";
  }
  private planningActive(): void {
    if (this.backend.signal?.aborted) throw new InstallError("installation planning cancelled");
  }
  run(argv: string[], undo?: string[], options: RunOptions = {}): Promise<void> {
    if (this.state !== "planning") return Promise.reject(new InstallError("installation transaction settled"));
    // Caller-owned metadata must not change while a command or earlier command awaits.
    const args = [...argv], reverse = undo ? [...undo] : undefined, settings = { ...options };
    const operation = this.commands.then(async () => {
      if (this.reconcile) throw new InstallError("automatic refresh cannot execute agent commands");
      this.planningActive();
      try {
        const result = await this.backend.run(args, 30000, this.configEnv ? { ...this.configEnv } : undefined);
        if (result.code === 0 && settings.successNote) this.notes.push(settings.successNote);
        if (!settings.quiet && result.code !== 0) this.notes.push(`\`${shellCommand(args)}\` failed (exit ${result.code}): ${(result.stderr || result.stdout).split(/\r?\n/)[0]}`);
      } catch (error) {
        if (!settings.quiet) this.notes.push(`\`${shellCommand(args)}\` failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // An admitted command may have taken effect even when it failed or threw.
      if (reverse) {
        const same = (item: string[]) => JSON.stringify(item) === JSON.stringify(reverse);
        if (!this.record.commands.some(command => same(command.undo))) this.record.commands.push({ undo: [...reverse] });
        if (!this.commandUndos.some(same)) this.commandUndos.push([...reverse]);
      }
    });
    this.commands = operation.then(() => undefined, error => { this.commandFailure ??= { error }; });
    return operation;
  }
  private async drain(): Promise<void> {
    // Finish both queues even if one fails, before rollback can discard staging.
    const staging = this.finishPlanning().then(() => undefined, error => ({ error }));
    await this.commands;
    const failure = await staging;
    if (failure) throw failure.error;
    if (this.commandFailure) throw this.commandFailure.error;
    this.planningActive();
  }
  commit(): Promise<void> {
    if (this.state !== "planning") return Promise.reject(new InstallError("installation transaction settled"));
    this.state = "committing";
    this.commitWork = (async () => {
      await this.drain();
      if (this.record.planner !== this.planner) throw new InstallError("installation planner identity mismatch");
      this.record.notes = [...this.notes];
      const record = structuredClone(this.record);
      const files = structuredClone([...this.pending.values()].filter(file => file.before !== file.after));
      // No cancellation checks after admission: the backend must finish settlement.
      await this.backend.commit(this.planner, record, files);
      this.state = "committed";
      this.commandUndos = [];
    })();
    return this.commitWork;
  }
  rollback(): Promise<void> {
    if (this.state === "committed" || this.state === "rolled-back") return Promise.resolve();
    if (this.rollbackWork) return this.rollbackWork;
    this.rollbackWork = (async () => {
      // Concurrent settlement has one owner. A successful admitted commit wins;
      // on failure, wait for its backend recovery before undoing commands.
      if (this.commitWork) {
        try { await this.commitWork; return; } catch { /* failed commit needs command undo */ }
      }
      this.state = "rolling-back";
      // Planning errors are already surfaced by the caller; rollback still drains.
      try { await this.drain(); } catch { /* undo admitted effects despite planning failure/cancellation */ }
      for (const undo of [...this.commandUndos].reverse()) {
        try { await this.backend.run([...undo], 30000, this.configEnv ? { ...this.configEnv } : undefined); }
        catch (error) { this.notes.push(`rollback command failed: ${String(error)}`); }
      }
      this.pending.clear();
      this.commandUndos = [];
      this.state = "rolled-back";
    })();
    return this.rollbackWork;
  }
}

/** Host has already admitted the operation and holds the lock for this lifetime. */
export async function planInstall(io: TransactionIO, env: PlanEnv, planner: string, fn: (tx: Txn) => void | Promise<void>): Promise<Txn> {
  const captured = structuredClone(env), bound = captured.plannerKey ?? planner;
  const prior = await io.readRecord(bound);
  const tx = new Txn(io, captured, bound, prior);
  if (captured.pacerArgv.length > 1) tx.notes.push(`WARNING: development install bakes this command into integrations: ${shellCommand(captured.pacerArgv)}`);
  try { await fn(tx); }
  catch (error) { await tx.rollback(); throw error; }
  return tx;
}
export async function runInstall(io: TransactionIO, env: PlanEnv, planner: string, fn: (tx: Txn) => void | Promise<void>): Promise<InstallReport> {
  const captured = structuredClone(env);
  await io.recover();
  const tx = await planInstall(io, captured, planner, fn);
  try { await tx.commit(); }
  catch (error) { await tx.rollback(); throw error; }
  return { record: structuredClone(tx.record), touched: [...tx.touched], notes: [...tx.notes] };
}
