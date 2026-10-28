import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "../../types";
import { withLockSync } from "../../core/lock";

export interface TrustEntry { path: string; configFile: string; taskId: string; at: number; before?: Record<string, unknown> | null; written?: Record<string, unknown> }
const recordPath = (ctx: Ctx) => join(ctx.pacerHome, "orca", "trusted.json");

function entries(ctx: Ctx): TrustEntry[] {
  try {
    const value: unknown = JSON.parse(readFileSync(recordPath(ctx), "utf8"));
    if (!Array.isArray(value)) throw Error("Invalid Orca trust record");
    return value as TrustEntry[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

class ConcurrentEditError extends Error {}

function atomic(path: string, contents: string, mode: number, expected?: string | null): void {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", mode);
    writeFileSync(fd, contents);
    closeSync(fd);
    fd = undefined;
    if (expected !== undefined && (existsSync(path) ? readFileSync(path, "utf8") : null) !== expected) throw new ConcurrentEditError();
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function edit(path: string, change: (data: Record<string, unknown>) => boolean, beforeReplace?: () => void): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const mode = before === null ? 0o600 : statSync(path).mode & 0o777;
    const data = before === null ? {} : JSON.parse(before) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Claude config is not an object");
    if (!change(data)) return false;
    beforeReplace?.();
    try { atomic(path, `${JSON.stringify(data, null, 2)}\n`, mode, before); }
    catch (e) { if (e instanceof ConcurrentEditError) continue; throw e; }
    return true;
  }
  throw Error("Claude config changed while editing trust");
}

export function trustClaudeWorktree(ctx: Ctx, path: string, configFile: string, taskId: string, beforeReplace?: () => void): void {
  withLockSync(ctx, "trusted", () => {
    let before: Record<string, unknown> | null = null;
    let written: Record<string, unknown> | undefined;
    const added = edit(configFile, data => {
      const projects = (data.projects ??= {}) as Record<string, Record<string, unknown>>;
      if (!projects || typeof projects !== "object" || Array.isArray(projects)) throw Error("Claude projects is not an object");
      const project = projects[path] ?? {};
      if (project.hasTrustDialogAccepted === true) return false;
      before = projects[path] ? {...project} : null;
      projects[path] = {...project, hasTrustDialogAccepted: true};
      written = {...projects[path]};
      return true;
    }, beforeReplace);
    if (added) {
      try {
        atomic(recordPath(ctx), `${JSON.stringify([...entries(ctx), {path, configFile, taskId, at: ctx.now, before, written}], null, 2)}\n`, 0o600);
      } catch (e) {
        edit(configFile, data => {
          const projects = data.projects as Record<string, Record<string, unknown>> | undefined;
          if (JSON.stringify(projects?.[path]) !== JSON.stringify(written)) return false;
          if (before) projects![path] = before;
          else delete projects![path];
          return true;
        });
        throw e;
      }
    }
  });
}

