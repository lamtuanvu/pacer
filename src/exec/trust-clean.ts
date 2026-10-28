import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "../types";
import { withLockSync } from "../core/lock";

interface TrustEntry { path: string; configFile: string; taskId: string; at: number; before?: Record<string, unknown> | null; written?: Record<string, unknown> }

function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, content);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Remove only trust entries pacer recorded, after their exact worktree is gone. */
export function removeClaudeTrust(ctx: Ctx, taskId: string, gone: (path: string) => boolean): void {
  withLockSync(ctx, "trusted", () => {
    const record = join(ctx.pacerHome, "orca", "trusted.json");
    if (!existsSync(record)) return;
    const entries = JSON.parse(readFileSync(record, "utf8")) as TrustEntry[];
    const remaining: TrustEntry[] = [];
    for (const entry of entries) {
      if (entry.taskId !== taskId || !gone(entry.path)) { remaining.push(entry); continue; }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!existsSync(entry.configFile)) break;
        const before = readFileSync(entry.configFile, "utf8");
        const mode = statSync(entry.configFile).mode & 0o777;
        const data = JSON.parse(before) as Record<string, unknown>;
        const projects = data.projects as Record<string, Record<string, unknown>> | undefined;
        const project = projects?.[entry.path];
        if (!project || !entry.written || JSON.stringify(project) !== JSON.stringify(entry.written)) break;
        if (entry.before) projects![entry.path] = entry.before;
        else delete projects![entry.path];
        if (readFileSync(entry.configFile, "utf8") !== before) {
          if (attempt === 0) continue;
          throw Error("Claude config changed while removing trust");
        }
        writeAtomic(entry.configFile, `${JSON.stringify(data, null, 2)}\n`, mode);
        break;
      }
    }
    writeAtomic(record, `${JSON.stringify(remaining, null, 2)}\n`, 0o600);
  });
}
