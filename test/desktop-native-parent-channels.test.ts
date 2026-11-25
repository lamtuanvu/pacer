import { expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { join } from "node:path";
import { closeSync, mkdirSync, readdirSync } from "node:fs";
import { tmpDir } from "./helpers";
import { NativeHelperError } from "../src/update/desktop/native-helper-errors";
import { ParentHelperSpawner } from "../src/update/desktop/native-parent-helper";

test.skipIf(process.platform !== "darwin")("atomic parent channels retain usable rights through delayed receipt and explicit acknowledgement", () => {
  const root = join(tmpDir(), "parent-channels-long-temp-" + "x".repeat(120));
  mkdirSync(root, { mode: 0o700 });
  expect(Buffer.byteLength(root)).toBeGreaterThan(104);
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "fixtures/desktop-update/parent-channels-boundary.py")], {
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    stdout: "pipe", stderr: "pipe", timeout: 25000,
  });
  expect(result.stderr.toString()).toContain("Ran 7 tests");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readdirSync(root), "Python fixture roots and socket files are removed").toEqual([]);
}, 30000);

test.skipIf(process.platform !== "darwin")("a clean E refusal keeps the spawner usable; a transport error retires it", async () => {
  const api = dlopen("/usr/lib/libSystem.B.dylib", {
    socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  const pair = new Int32Array([-1, -1]);
  expect(api.symbols.socketpair(1, 1, 0, ptr(pair))).toBe(0);
  // The peer refuses two requests with a clean E, then drops the socket.
  const peer = `import socket,struct
s=socket.socket(fileno=0)
for _ in range(2):
 h=s.recv(4,socket.MSG_WAITALL)
 if not h: break
 s.recv(struct.unpack('>I',h)[0],socket.MSG_WAITALL)
 s.sendall(b'E'+bytes(4))
s.close()`;
  const child = Bun.spawn(["python3", "-c", peer], { stdin: pair[1], stdout: "pipe", stderr: "pipe" });
  closeSync(pair[1]);
  const spawner = new ParentHelperSpawner(pair[0]);
  const request = {
    schema: 1 as const,
    path: "/tmp/pacer-update-helper",
    sha256: "a".repeat(64),
    version: "0.2.3",
  };
  try {
    expect(() => spawner.spawn(request)).toThrow(NativeHelperError);
    expect(() => spawner.spawn(request)).toThrow(/refused/);
    // EOF is a transport failure: it retires the channel and is reported as a
    // distinct recoverable error on this very check, not a generic close.
    for (let i = 0; i < 2; i++) {
      try {
        spawner.spawn(request);
        throw Error("expected retirement");
      } catch (error) {
        expect(error).toBeInstanceOf(NativeHelperError);
        expect((error as NativeHelperError).kind).toBe("retired");
        if (i === 0) expect((error as NativeHelperError).cause).toBeInstanceOf(Error);
      }
    }
    expect(await child.exited).toBe(0);
  } finally {
    spawner.close();
    child.kill();
    api.close();
  }
});
