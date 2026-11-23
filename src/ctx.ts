import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx, RunFn } from "./types";
import { execProcess } from "./exec/process";

export const defaultRun: RunFn = async (argv, timeoutMs, options) => {
  const { code, stdout, stderr, timedOut, stdoutOverflow } = await execProcess({
    argv, cwd: options?.cwd ?? process.cwd(), env: options?.env ?? process.env,
    timeoutMs, stdin: options?.stdin, stdinUntilResponseId: options?.stdinUntilResponseId,
    ...(options?.maxStdoutBytes !== undefined ? { maxStdoutBytes: options.maxStdoutBytes } : options?.stdinUntilResponseId !== undefined ? { maxStdoutBytes: 64_000 } : {}),
  });
  return { code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}), ...(stdoutOverflow ? { stdoutOverflow: true } : {}) };
};

/** Test preload installs this guard before contexts or stores can touch disk. */
export function assertPacerHomeAllowed(path: string): void {
  const guard = (globalThis as typeof globalThis & { pacerHomeGuard?: (path: string) => void }).pacerHomeGuard;
  guard?.(path);
}

/**
 * Harness-only entry-lease / start-delay knobs. Honored only when an explicit
 * test-mode flag is present (PACER_LIVE_HARNESS=1 or NODE_ENV=test). Values are
 * read once at makeCtx (serve boot) and copied onto Ctx — never from $PACER_HOME files.
 */
export function harnessEntryOverrides(env: Record<string, string | undefined>): {
  entryLeaseS?: number;
  startRunDelayMs?: number;
} {
  const allowed = env.PACER_LIVE_HARNESS === "1" || env.NODE_ENV === "test";
  if (!allowed) return {};
  const out: { entryLeaseS?: number; startRunDelayMs?: number } = {};
  const lease = Number(env.PACER_TEST_ENTRY_LEASE_S);
  if (Number.isFinite(lease) && lease >= 1 && lease <= 120) out.entryLeaseS = lease;
  const delay = Number(env.PACER_TEST_START_DELAY_MS);
  if (Number.isFinite(delay) && delay > 0 && delay <= 120_000) out.startRunDelayMs = Math.floor(delay);
  return out;
}

export function makeCtx(o: Partial<Ctx> = {}): Ctx {
  const env = o.env ?? process.env;
  const home = o.home ?? env.HOME ?? process.env.HOME ?? homedir();
  const pacerHome = o.pacerHome ?? env.PACER_HOME ?? join(home, ".pacer");
  assertPacerHomeAllowed(pacerHome);
  const harness = harnessEntryOverrides(env);
  return {
    home,
    pacerHome,
    now: o.now ?? Date.now() / 1000,
    env,
    run: o.run ?? defaultRun,
    which: o.which ?? ((bin) => Bun.which(bin)),
    // Explicit Partial overrides win; otherwise apply boot-time harness env once.
    ...(o.entryLeaseS !== undefined
      ? { entryLeaseS: o.entryLeaseS }
      : harness.entryLeaseS !== undefined ? { entryLeaseS: harness.entryLeaseS } : {}),
    ...(o.startRunDelayMs !== undefined
      ? { startRunDelayMs: o.startRunDelayMs }
      : harness.startRunDelayMs !== undefined ? { startRunDelayMs: harness.startRunDelayMs } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.setInterval ? { setInterval: o.setInterval } : {}),
    ...(o.clearInterval ? { clearInterval: o.clearInterval } : {}),
  };
}
