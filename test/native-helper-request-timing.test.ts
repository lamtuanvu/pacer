import { expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { requestParentHelper } from "../src/update/desktop/native-socket";

test.skipIf(process.platform !== "darwin")("real Bun C request carries bounded start stamp and unchanged authority fields", async () => {
  const api = dlopen("/usr/lib/libSystem.B.dylib", { socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
  const pair = new Int32Array([-1, -1]);
  expect(api.symbols.socketpair(1, 1, 0, ptr(pair))).toBe(0);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/native-helper-timing-peer.ts")], { stdin: pair[1], stdout: "pipe", stderr: "pipe" });
  closeSync(pair[1]);
  try {
    const before = Date.now();
    expect(() => requestParentHelper(pair[0], { schema: 1, path: "/disposable/pacer-update-helper", sha256: "a".repeat(64), version: "0.2.3" })).toThrow();
    const after = Date.now();
    expect(await child.exited).toBe(0);
    const value = JSON.parse(await new Response(child.stdout).text());
    expect(value.authority).toEqual({schema:1,path:"/disposable/pacer-update-helper",sha256:"a".repeat(64),version:"0.2.3"});
    expect(value.keys).toEqual(["path", "schema", "sha256", "startedAtMs", "version"]);
    expect(Number.isSafeInteger(value.startedAtMs)).toBe(true);
    expect(value.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(value.startedAtMs).toBeLessThanOrEqual(after);
    expect(value.startedAtMs).toBeLessThanOrEqual(value.receivedAtMs);
  } finally { closeSync(pair[0]); api.close(); }
});
