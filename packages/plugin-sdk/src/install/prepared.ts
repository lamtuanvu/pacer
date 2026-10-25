import { shellCommand } from "./helpers";
import { InstallError, InstallPlan, type PendingFile, type PlanEnv, type PlanIO } from "./plan";
import type { PlannerRecord } from "./undo";

export interface PlannerCommandIntent { argv: string[]; undo?: string[]; timeoutMs: number }
export interface PlannerCommandResult { code: number; stdout: string; stderr: string }
/** Parent captures undo before spawning; parent alone owns compensation and settlement. */
export interface PreparedPlannerIO extends PlanIO {
  run(intent: PlannerCommandIntent): Promise<PlannerCommandResult>;
}
export interface PreparedPlannerPlan {
  schema: 1;
  record: PlannerRecord;
  files: PendingFile[];
  touched: string[];
  notes: string[];
}
export interface RunOptions { quiet?: boolean; successNote?: string }

/** Preparation can execute real commands, but never commits files or settles effects. */
export class PreparedPlannerBuilder extends InstallPlan {
  private commands: Promise<void> = Promise.resolve();
  private commandFailure: { error: unknown } | undefined;
  private preparedClosed = false;
  private preparation: Promise<PreparedPlannerPlan> | undefined;
  private readonly reconcile: boolean;
  private readonly planner: string;
  constructor(private readonly backend: PreparedPlannerIO, env: PlanEnv, prior?: PlannerRecord) {
    const planner = env.plannerKey ?? prior?.planner;
    if (!planner) throw new InstallError("installation planner identity missing");
    super(backend, env, planner, prior);
    this.planner = planner;
    this.reconcile = env.mode === "reconcile";
    if (this.record.planner !== planner) throw new InstallError("installation planner identity mismatch");
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.preparedClosed) return Promise.reject(new InstallError("installation planning closed"));
    const operation = this.commands.then(async () => {
      if (this.reconcile) throw new InstallError("automatic refresh cannot execute agent commands");
      if (this.backend.signal?.aborted) throw new InstallError("installation planning cancelled");
      return await action();
    });
    this.commands = operation.then(() => undefined, error => { this.commandFailure ??= { error }; });
    return operation;
  }
  private intent(argv: string[], undo?: string[]): PlannerCommandIntent {
    return { argv: [...argv], ...(undo ? { undo: [...undo] } : {}), timeoutMs: 30000 };
  }
  /** Real result/throw semantics for result-dependent probes; no generated notes. */
  runRaw(argv: string[], undo?: string[]): Promise<PlannerCommandResult> {
    const intent = this.intent(argv, undo), reverse = undo ? [...undo] : undefined;
    const operation = this.enqueue(async () => {
      try { return { result: await this.backend.run(intent) }; }
      catch (error) { return { error }; }
      finally { this.recordUndo(reverse); }
    });
    return operation.then(outcome => {
      if ("error" in outcome) throw outcome.error;
      return outcome.result;
    });
  }
  run(argv: string[], undo?: string[], options: RunOptions = {}): Promise<void> {
    const intent = this.intent(argv, undo), settings = { ...options };
    // Keep record/note metadata separate from the object handed to the backend.
    const args = [...intent.argv], reverse = intent.undo ? [...intent.undo] : undefined;
    return this.enqueue(async () => {
      try {
        const result = await this.backend.run(intent);
        if (result.code === 0 && settings.successNote) this.notes.push(settings.successNote);
        if (!settings.quiet && result.code !== 0) this.notes.push(`\`${shellCommand(args)}\` failed (exit ${result.code}): ${(result.stderr || result.stdout).split(/\r?\n/)[0]}`);
      } catch (error) {
        if (!settings.quiet) this.notes.push(`\`${shellCommand(args)}\` failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.recordUndo(reverse);
    });
  }
  private recordUndo(reverse: string[] | undefined): void {
    if (reverse && !this.record.commands.some(command => JSON.stringify(command.undo) === JSON.stringify(reverse))) {
      this.record.commands.push({ undo: [...reverse] });
    }
  }
  /** Close both queues before awaiting; retained staging errors cannot be swallowed. */
  async prepare(): Promise<PreparedPlannerPlan> {
    if (!this.preparation) {
      this.preparedClosed = true;
      this.preparation = this.drainPreparation();
    }
    return structuredClone(await this.preparation);
  }
  private async drainPreparation(): Promise<PreparedPlannerPlan> {
    const staging = this.finishPlanning().then(() => undefined, error => ({ error }));
    await this.commands;
    const failure = await staging;
    if (failure) throw failure.error;
    if (this.commandFailure) throw this.commandFailure.error;
    if (this.backend.signal?.aborted) throw new InstallError("installation planning cancelled");
    if (this.record.planner !== this.planner) throw new InstallError("installation planner identity mismatch");
    this.record.notes = [...this.notes];
    return structuredClone({ schema: 1 as const, record: this.record,
      files: [...this.pending.values()].filter(file => file.before !== file.after), touched: this.touched, notes: this.notes });
  }
}

export async function preparePlannerInstall(io: PreparedPlannerIO, env: PlanEnv, prior: PlannerRecord | undefined,
  fn: (builder: PreparedPlannerBuilder) => void | Promise<void>): Promise<PreparedPlannerPlan> {
  const captured = structuredClone(env), builder = new PreparedPlannerBuilder(io, captured, prior);
  if (captured.pacerArgv.length > 1) builder.notes.push(`WARNING: development install bakes this command into integrations: ${shellCommand(captured.pacerArgv)}`);
  try { await fn(builder); }
  catch (error) {
    // Drain admitted work before handing failure to the parent's compensation owner.
    try { await builder.prepare(); } catch { /* preserve callback failure precedence */ }
    throw error;
  }
  return await builder.prepare();
}
