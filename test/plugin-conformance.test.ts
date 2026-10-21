// test/plugin-conformance.test.ts
import { test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES, runCase } from "../conformance/run";

const host = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts")];
const root = join(tmpdir(), "pacer-conformance", "suite");
for (const c of CASES) test(`conformance: ${c.name}`, () => runCase(c, host, root), 25000);
