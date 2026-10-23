import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

/** Never steal from a live installer, regardless of how long its CLI commands take. */
export async function withInstallLock<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  if (ctx.readOnly) throw Error("integration writes are disabled in read-only context");
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  const file = join(ctx.pacerHome, "install.lock"), owner = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { writeFileSync(file, owner, { flag: "wx", mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const reaper = `${file}.reap`;
        let claimed = false;
        try {
          writeFileSync(reaper, owner, { flag: "wx", mode: 0o600 }); claimed = true;
          const old = readFileSync(file, "utf8"), pid = Number(old.split(":")[0]);
          let dead = false;
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
          }
          if (dead) { rmSync(file); continue; }
        } catch (error) {
          if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        } finally { if (claimed) rmSync(reaper, { force: true }); }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      if (Date.now() >= deadline) throw Error("integration installation is busy; retry shortly");
      await Bun.sleep(25);
    }
  }
  try { return await fn(); }
  finally { if (readFileSync(file, "utf8") === owner) rmSync(file); }
}
