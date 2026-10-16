import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestTmp } from "./helpers";

// Tests must never touch the real ~/.pacer or agent configs. HOME and PACER_HOME point
// at a throwaway folder for the whole run, so a test that forgets to isolate itself (or
// code that falls back to HOME) writes there instead of into the user's setup.
const isolatedHome = mkdtempSync(join(tmpdir(), "pacer-test-home-"));
process.env.HOME = isolatedHome;
process.env.PACER_HOME = join(isolatedHome, ".pacer");

// Global teardown for the whole `bun test` run (preloaded via bunfig.toml).
// Removing a large run root (release fixtures) can outlast the default 5 s hook limit under disk load.
afterAll(() => {
  cleanupTestTmp();
  if (!process.env.PACER_KEEP_TEST_TMP) rmSync(isolatedHome, { recursive: true, force: true });
}, { timeout: 60_000 });
