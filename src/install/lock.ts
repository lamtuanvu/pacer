import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { readInstallFile, writeInstallFile } from "./atomic";

interface Contender { pid: number; ticket: number | null }
const active = new Set<string>();
/** Bakery lock: unique contender files need no shared reaper lock or stale-age takeover. */
export async function withInstallLock<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  if (ctx.readOnly) throw Error("integration writes are disabled in read-only context");
  const dir = join(ctx.pacerHome, "install-locks"), name = `${process.pid}-${crypto.randomUUID()}.json`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw Error("unsafe installation lock directory");
  const file = join(dir, name);
  const contenders = (): [string, Contender][] => {
    const rows: [string, Contender][] = [];
    for (const other of readdirSync(dir)) {
      if (!/^\d+-[a-zA-Z0-9-]+\.json$/.test(other)) continue;
      const path = join(dir, other), pid = Number(other.split("-")[0]);
      let dead = pid === process.pid && !active.has(other);
      if (!dead) {
        try { process.kill(pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      // Every name is unique and is never reused, so a dead contender can be
      // removed without racing a new owner of the same lock path. Check its
      // filename identity first so incomplete abandoned records are recoverable.
      if (dead) { rmSync(path, { force: true }); continue; }
      const text = readInstallFile(path);
      if (text === null) continue;
      const value = JSON.parse(text) as Contender;
      if (value.pid !== pid || !Number.isInteger(pid) || pid <= 0 || (value.ticket !== null && (!Number.isSafeInteger(value.ticket) || value.ticket < 1))) throw Error("invalid installation lock; run pacer doctor");
      rows.push([other, value]);
    }
    return rows;
  };
  active.add(name);
  try {
    writeInstallFile(file, JSON.stringify({ pid: process.pid, ticket: null } satisfies Contender));
    const ticket = Math.max(0, ...contenders().map(([, value]) => value.ticket ?? 0)) + 1;
    if (!Number.isSafeInteger(ticket)) throw Error("installation lock ticket exhausted");
    writeInstallFile(file, JSON.stringify({ pid: process.pid, ticket } satisfies Contender));
    const deadline = Date.now() + 30000;
    while (contenders().some(([other, value]) => other !== name && (value.ticket === null || value.ticket < ticket || value.ticket === ticket && other < name))) {
      if (Date.now() >= deadline) throw Error("integration installation is busy; retry shortly");
      await Bun.sleep(25);
    }
    return await fn();
  } finally { active.delete(name); rmSync(file, { force: true }); }
}
