import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appendJsonLine } from "../fsutil";
import type { Ctx } from "../types";

const labelsFile = (ctx: Ctx) => join(ctx.pacerHome, "labels.jsonl");

// mkdirSync's mode applies only to a directory it creates, so an existing wider pacer home is narrowed (SEC-7).
function narrowHome(dir: string): void {
  const st = statSync(dir);
  if ((st.mode & 0o077) === 0) return;
  if (process.getuid && st.uid !== process.getuid()) {
    throw new Error(`pacer home ${dir} is mode ${(st.mode & 0o777).toString(8)} and owned by another user; make it 0700 and owned by you`);
  }
  chmodSync(dir, 0o700);
}

// Serialize appends across processes (CLI, hooks, service) like the activity log, so a line is never interleaved.
function withLabelsLock<T>(ctx: Ctx, action: () => T): T {
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  narrowHome(ctx.pacerHome);
  const lock = join(ctx.pacerHome, "labels.lock"), deadline = Date.now() + 10_000;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) { unlinkSync(lock); continue; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (Date.now() >= deadline) throw new Error("timed out waiting for labels lock");
      Atomics.wait(sleep, 0, 0, 10);
    }
  }
  try { return action(); } finally { unlinkSync(lock); }
}

/** Ground-truth labels for the classifier benchmark (spec §3.10). One locked append per label, to a 0600 file
 * in a 0700 directory, under the scoped SEC-7 append exception. */
export function appendLabel(ctx: Ctx, label: Record<string, unknown>): void {
  const record = JSON.stringify({ ts: ctx.now, ...label });
  withLabelsLock(ctx, () => appendJsonLine(labelsFile(ctx), record));
}

export function readLabels(ctx: Ctx): Record<string, unknown>[] {
  if (!existsSync(labelsFile(ctx))) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(labelsFile(ctx), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a corrupt line
    }
  }
  return out;
}
