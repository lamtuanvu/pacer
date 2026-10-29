import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

const labelsFile = (ctx: Ctx) => join(ctx.pacerHome, "labels.jsonl");

// Serialize appends across processes (CLI, hooks, service) like the activity log, so a line is never interleaved.
function withLabelsLock<T>(ctx: Ctx, action: () => T): T {
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
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
 * in a 0700 directory (SEC-7). */
export function appendLabel(ctx: Ctx, label: Record<string, unknown>): void {
  const line = Buffer.from(`${JSON.stringify({ ts: ctx.now, ...label })}\n`);
  withLabelsLock(ctx, () => {
    const fd = openSync(labelsFile(ctx), "a", 0o600);
    try {
      fchmodSync(fd, 0o600);
      for (let written = 0; written < line.length;) written += writeSync(fd, line, written);
    } finally { closeSync(fd); }
  });
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
