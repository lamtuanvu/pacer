/** Same stable kernel flock as native FixturePolicy ledger updates. Scripts only. */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
let native: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== "darwin" && process.platform !== "linux") throw Error("Unsupported fixture ledger platform");
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
}
export function withOtaLedgerLock<T>(root: string, callback: () => T): T {
  const uid = process.getuid?.(), locks = join(root, "locks"), file = join(locks, "ledger-lock");
  for (const directory of [root, locks]) {
    if (directory === locks) try { mkdirSync(locks, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = lstatSync(directory);
    if (realpathSync(directory) !== directory || !info.isDirectory() || info.uid !== uid || info.mode & 0o077) throw Error("Invalid fixture ledger directory");
  }
  const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let locked = false;
  const verify = () => {
    const info = fstatSync(fd), path = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== 0o600 || !path.isFile() || path.isSymbolicLink() || path.dev !== info.dev || path.ino !== info.ino) throw Error("Invalid stable fixture ledger lock");
  };
  try {
    verify(); native ??= load();
    if (native.symbols.flock(fd, 6) !== 0) throw Error("Fixture ledger busy; retry after native operation settles");
    locked = true; verify();
    const result = callback();
    if (result && typeof (result as { then?: unknown }).then === "function") throw Error("Fixture ledger callbacks must be synchronous");
    verify(); return result;
  } finally { if (locked) native!.symbols.flock(fd, 8); closeSync(fd); }
}
