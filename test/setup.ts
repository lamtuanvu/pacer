import { afterAll } from "bun:test";
import { cleanupTestRoot } from "./helpers";

// Loaded by bunfig.toml for every test run: one global afterAll removes all tmpDir() folders.
afterAll(cleanupTestRoot);
