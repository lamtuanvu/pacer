import { createTestRoot, sweepTestRoots } from "./temp-roots";
import { afterAll, afterEach } from "bun:test";
import { rmSync, realpathSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { cleanupTestTmp } from "./helpers";
import { setMachineReaders } from "../src/engine/machine";
import { cleanupFixtureResources } from "./fixture-cleanup";

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
sweepTestRoots();
const isolatedHome = createTestRoot("pacer-test-home-");
// Contain raw os.tmpdir()/mkdtemp allocations as well as helper-managed fixtures.
const isolatedTmp = join(isolatedHome, "tmp");
mkdirSync(isolatedTmp, { mode: 0o700 });
for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = isolatedTmp;
process.env.HOME = isolatedHome;
process.env.PACER_HOME = join(isolatedHome, ".pacer");
delete process.env.PACER_ROLE;
delete process.env.PACER_TASK_ID;
// Bundled plugin children must run this source tree, never an installed pacer the shell points at.
delete process.env.PACER_BIN;
delete process.env.PACER_CORE_ARGV;
// A planner shell may point Claude at a real account folder; Claude trust grants follow it.
delete process.env.CLAUDE_CONFIG_DIR;
// Executor launches would otherwise run the developer's real login shell; tests opt in with fakes.
process.env.PACER_LOGIN_ENV = "off";
// Nothing a test runs or spawns may reach the login Keychain through PATH: `security` resolves to a file-backed stub.
const { installKeychainStub } = await import("../scripts/live/keychain");
installKeychainStub(join(isolatedHome, "bin"), join(isolatedHome, "keychain"));
process.env.PATH = `${join(isolatedHome, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`;

// Preload hooks apply across files; hooks in cached imported helpers do not.
afterEach(cleanupFixtureResources);

// Global teardown for the whole `bun test` run (preloaded via bunfig.toml).
// Removing a large run root (release fixtures) can outlast the default 5 s hook limit under disk load.
function cleanup() {
  cleanupTestTmp();
  if (!process.env.PACER_KEEP_TEST_TMP) rmSync(isolatedHome, { recursive: true, force: true });
}
afterAll(cleanup, { timeout: 60_000 });
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => { cleanup(); process.exit(code); });
}

// Scheduling must not depend on the host's real memory pressure or load. Tests that
// exercise the machine guard inject their own readers.
setMachineReaders({pressure: () => 1, load: () => ({avg1: 0, cores: 1})});
