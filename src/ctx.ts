import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx, RunFn } from "./types";
import { execProcess } from "./exec/process";

export const defaultRun: RunFn = async (argv, timeoutMs, options) => {
  const { code, stdout, stderr, timedOut } = await execProcess({
    argv, cwd: process.cwd(), env: options?.env ?? process.env,
    timeoutMs, stdin: options?.stdin,
  });
  return { code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) };
};

export function makeCtx(o: Partial<Ctx> = {}): Ctx {
  const env = o.env ?? process.env;
  const home = o.home ?? env.HOME ?? homedir();
  return {
    home,
    pacerHome: o.pacerHome ?? env.PACER_HOME ?? join(home, ".pacer"),
    now: o.now ?? Date.now() / 1000,
    env,
    run: o.run ?? defaultRun,
    which: o.which ?? ((bin) => Bun.which(bin)),
  };
}
