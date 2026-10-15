import { afterAll } from "bun:test";
import { cleanupTestTmp } from "./helpers";

// Global teardown for the whole `bun test` run (preloaded via bunfig.toml).
// Removing a large run root (release fixtures) can outlast the default 5 s hook limit under disk load.
afterAll(cleanupTestTmp, { timeout: 60_000 });
