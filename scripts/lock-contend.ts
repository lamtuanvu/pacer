import { join } from "node:path";
import { makeCtx } from "../src/ctx";
import { withLockSync } from "../src/core/lock";
import { readJson, writeJsonAtomic } from "../src/fsutil";

const [pacerHome, count] = process.argv.slice(2);
const iterations = Number(count);
if (!pacerHome || !Number.isSafeInteger(iterations) || iterations < 0) {
  throw new Error("usage: lock-contend.ts <pacerHome> <iterations>");
}
const ctx = makeCtx({ pacerHome });
const counter = join(pacerHome, "counter.json");
for (let i = 0; i < iterations; i++) {
  withLockSync(ctx, "contend", () => {
    const value = readJson<number>(counter) ?? 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    writeJsonAtomic(counter, value + 1);
  });
}
