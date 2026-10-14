import { afterAll } from "bun:test";
import { cleanupTestTmp } from "./helpers";

// Global teardown for the whole `bun test` run (preloaded via bunfig.toml).
afterAll(cleanupTestTmp);
