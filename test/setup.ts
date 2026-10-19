import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { cleanupTestTmp } from "./helpers";

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
const isolatedHome = mkdtempSync(join(tmpdir(), "pacer-test-home-"));
process.env.HOME = isolatedHome;
process.env.PACER_HOME = join(isolatedHome, ".pacer");

// Global teardown for the whole `bun test` run (preloaded via bunfig.toml).
// Removing a large run root (release fixtures) can outlast the default 5 s hook limit under disk load.
afterAll(() => {
  cleanupTestTmp();
  if (!process.env.PACER_KEEP_TEST_TMP) rmSync(isolatedHome, { recursive: true, force: true });
}, { timeout: 60_000 });
