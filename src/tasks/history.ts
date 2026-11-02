import { fileURLToPath } from "node:url";
import { SQLiteError } from "bun:sqlite";
import { backfillFirstSettled } from "../insights/summary";
import { backfillAttemptUsage } from "../tokens/store";
import { retentionScheduler } from "./retention";
import type { Ctx } from "../types";

/** Only retry lock contention; malformed data and filesystem errors stay visible. */
export async function backfillTaskHistory(ctx: Ctx): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      backfillFirstSettled(ctx);
      await backfillAttemptUsage(ctx);
      return;
    } catch (error) {
      if (!(error instanceof SQLiteError) || !error.code?.startsWith("SQLITE_BUSY") || attempt === 3) throw error;
      await Bun.sleep(100 * 2 ** attempt);
    }
  }
}

/** The service owns one worker. SQLite waits and historical log parsing never
 * occupy its request thread. Use this core, not an ambient PACER_BIN override. */
export function startTaskHistory(ctx: Ctx): { stop: () => Promise<void> } {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || child) return;
    const source = /(^|\/)bun(?:\.exe)?$/.test(process.execPath);
    const argv = source
      ? [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url)), "_task-history"]
      : [process.execPath, "_task-history"];
    const env = { ...ctx.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_HISTORY_PARENT_PIPE: "1" };
    for (const key of ["PACER_INTERNAL_TOKEN", "PACER_INTERNAL_NATIVE_BOOTSTRAP", "PACER_WORK_GRANT", "PACER_ENFORCEMENT_TOKEN", "NODE_OPTIONS", "BUN_OPTIONS"]) {
      delete (env as NodeJS.ProcessEnv)[key];
    }
    try {
      const running = Bun.spawn(argv, { env, stdin: "pipe", stdout: "ignore", stderr: "inherit" });
      child = running;
      void running.exited.then(code => {
        if (child === running) child = undefined;
        if (!stopped && code !== 0) console.error(`pacer: task history maintenance failed (exit ${code}); it will retry on the next scheduled run`);
      });
    } catch (error) {
      console.error(`pacer: task history maintenance could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setTimeout(run, 250);
  const daily = setInterval(run, 86400_000);
  return { stop: async () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(daily);
    const running = child;
    if (running) {
      running.kill();
      await running.exited;
    }
  } };
}

/** Retention also opens/mutates SQLite; keep its daily sweep in this worker. */
export async function maintainTaskHistory(ctx: Ctx): Promise<void> {
  let historyFailure: unknown;
  try { await backfillTaskHistory(ctx); }
  catch (error) { historyFailure = error; }
  try { await retentionScheduler().tick(ctx); }
  catch (error) {
    if (historyFailure) {
      const message = (value: unknown) => value instanceof Error ? value.message : String(value);
      throw new AggregateError([historyFailure, error], `Historical indexing failed: ${message(historyFailure)}; retention failed: ${message(error)}`);
    }
    throw error;
  }
  if (historyFailure) throw historyFailure;
}
