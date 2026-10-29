import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { cleanupTestTmp } from "./helpers";
import { setMachineReaders } from "../src/engine/machine";

// Tests must never touch the real ~/.pacer or agent configs. HOME and PACER_HOME point
// at a throwaway folder for the whole run, so a test that forgets to isolate itself (or
// code that falls back to HOME) writes there instead of into the user's setup.
// userInfo ignores HOME overrides, unlike os.homedir(). Canonicalize existing
// ancestors too, so a symlink or a not-yet-created state directory cannot evade it.
function canonical(path: string): string {
  path = resolve(path);
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonical(dirname(path)), basename(path));
  }
}
const realPacerHome = canonical(join(userInfo().homedir, ".pacer"));
(globalThis as typeof globalThis & { pacerHomeGuard?: (path: string) => void }).pacerHomeGuard = path => {
  const target = canonical(path);
  if (target === realPacerHome || target.startsWith(realPacerHome + "/")) {
    throw new Error("bun test refuses real user PACER_HOME");
  }
};
// Compiled release tests must reuse the provisioned Rust toolchain and targets
// after HOME changes. Keep caller overrides; otherwise capture the original defaults.
const toolchainHome = process.env.HOME ?? userInfo().homedir;
process.env.CARGO_HOME ??= join(toolchainHome, ".cargo");
process.env.RUSTUP_HOME ??= join(toolchainHome, ".rustup");
const isolatedHome = mkdtempSync(join(tmpdir(), "pacer-test-home-"));
process.env.HOME = isolatedHome;
process.env.PACER_HOME = join(isolatedHome, ".pacer");
delete process.env.PACER_ROLE;
delete process.env.PACER_TASK_ID;
// A planner shell may point Claude at a real account folder; Claude trust grants follow it.
delete process.env.CLAUDE_CONFIG_DIR;
// Executor launches would otherwise run the developer's real login shell; tests opt in with fakes.
process.env.PACER_LOGIN_ENV = "off";

// Global teardown for the whole `bun test` run (preloaded via bunfig.toml).
// Removing a large run root (release fixtures) can outlast the default 5 s hook limit under disk load.
afterAll(() => {
  cleanupTestTmp();
  if (!process.env.PACER_KEEP_TEST_TMP) rmSync(isolatedHome, { recursive: true, force: true });
}, { timeout: 60_000 });

// Scheduling must not depend on the host's real memory pressure or load. Tests that
// exercise the machine guard inject their own readers.
setMachineReaders({pressure: () => 1, load: () => ({avg1: 0, cores: 1})});
