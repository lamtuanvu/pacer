import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx, RunFn } from "./types";

export const defaultRun: RunFn = async (argv, timeoutMs) => {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: String(e) };
  }
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
