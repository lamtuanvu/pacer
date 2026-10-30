import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createTestRoot } from "./temp-roots";
import { join } from "node:path";
import { execProcess } from "../src/exec/process";
import type { Ctx, RunFn } from "../src/types";

// One parent folder per test run, removed after the run (see test/setup.ts), so test homes don't pile up in TMPDIR.
// Set PACER_KEEP_TEST_TMP=1 to keep it for debugging.
let runRoot: string | null = null;
function testRunRoot(): string {
  if (runRoot) return runRoot;
  const root = createTestRoot("pacer-test-");
  runRoot = root;
  return root;
}

/** Called once after all test files (test/setup.ts, preloaded via bunfig.toml). */
export function cleanupTestTmp(): void {
  if (runRoot && !process.env.PACER_KEEP_TEST_TMP) rmSync(runRoot, { recursive: true, force: true });
  runRoot = null;
}

export function tmpDir(): string {
  return mkdtempSync(join(testRunRoot(), "t-"));
}

/** Unix seconds for a local wall-clock time (tests run with TZ=Asia/Ho_Chi_Minh). Month is 1-based. */
export function localTs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0).getTime() / 1000;
}

export function fakeCtx(o: Partial<Ctx> = {}): Ctx {
  const home = o.home ?? tmpDir();
  return {
    home,
    pacerHome: o.pacerHome ?? join(home, ".pacer"),
    now: o.now ?? localTs(2026, 10, 10, 19, 0),
    env: o.env ?? {},
    run: o.run ?? (async () => ({ code: 127, stdout: "", stderr: "not available in tests" })),
    which: o.which ?? (() => "/usr/bin/fake"),
  };
}

/** A RunFn that really runs commands (git in temp repos). */
export const realRun: RunFn = (argv, timeoutMs, o) => execProcess({ argv, cwd: process.cwd(), env: { ...process.env, ...(o?.env ?? {}) }, timeoutMs, stdin: o?.stdin });

/** A temp git repo with one commit on branch main. */
export function gitRepo(): string {
  const repo = tmpDir();
  Bun.spawnSync(["sh", "-c", "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init"], { cwd: repo });
  return repo;
}

/** Environment that puts the fake `ssh` (test/fixtures/bin/ssh) first on PATH, with a temp dir as the host's HOME. */
export const fakeSshEnv = (hostHome: string, log: string, down = "") => {
  const bin = join(import.meta.dir, "fixtures", "bin");
  chmodSync(join(bin, "ssh"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, PACER_FAKE_HOST_HOME: hostHome, PACER_FAKE_SSH_LOG: log, PACER_FAKE_SSH_DOWN: down };
};

/** Fake login indicators for tests that route to installed native executors. */
export function withLoginIndicators(ctx: Ctx): Ctx {
  mkdirSync(join(ctx.home, ".codex"), { recursive: true });
  writeFileSync(join(ctx.home, ".codex/auth.json"), "{}");
  mkdirSync(join(ctx.home, ".cursor"), { recursive: true });
  writeFileSync(join(ctx.home, ".cursor/cli-config.json"), '{"authInfo":{}}');
  writeFileSync(join(ctx.home, ".claude.json"), '{"oauthAccount":{}}');
  return ctx;
}
/** Recreates what `pacer plugin install` left behind before the Orca plugin was removed. */
export async function installLegacyPlugin(ctx: Ctx): Promise<string> {
  const { runInstall } = await import("../src/install/txn");
  const root = join(ctx.pacerHome, "orca-plugin");
  await runInstall({ ctx, pacerArgv: [ctx.env.PACER_BIN ?? "pacer"] }, "orca-plugin", tx => {
    tx.edit(join(root, "orca-plugin.json"), () => '{"publisher":"lamtuanvu","id":"pacer"}\n', []);
    tx.edit(join(root, "worker.mjs"), () => "export default () => {};\n", []);
    tx.edit(join(root, ".pacer-managed"), () => '{"version":"0.1.0"}\n', []);
  });
  mkdirSync(join(root, "panel"), { recursive: true });
  writeFileSync(join(root, "panel", "live.html"), "<p>panel</p>");
  return root;
}

/** A stand-in login shell: a profile that prints noise, exports, then runs pacer's fixed command. */
export function fakeLoginShell(dir: string, profile: string): string {
  const shell = join(dir, "login-shell");
  writeFileSync(shell, `#!/bin/sh\necho "profile says hello"\n${profile}\n[ "$1 $2 $3" = "-l -i -c" ] || exit 64\neval "$4"\n`);
  chmodSync(shell, 0o755);
  return shell;
}
