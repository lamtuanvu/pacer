/** Fixed system libc only; every mutation is relative to an owned directory fd. */
import { dlopen, FFIType as F, ptr, toArrayBuffer } from "bun:ffi";
import { existsSync, constants } from "node:fs";
import { CoreError } from "../core/errors";
const cstr = (value: string | Uint8Array) =>
  Buffer.concat([
    typeof value === "string" ? Buffer.from(value) : Buffer.from(value),
    Buffer.from([0]),
  ]);
export class NativeWriteError extends Error {
  constructor(
    readonly errno: number,
    readonly cleanupFailure = false,
  ) {
    super("descriptor filesystem operation failed");
  }
}
export interface WriteNative {
  openAt(
    fd: number,
    name: string | Uint8Array,
    flags: number,
    mode?: number,
  ): number;
  mkdirAt(fd: number, name: string | Uint8Array, mode: number): void;
  renameAt(from: number, old: string, to: number, name: string): void;
  unlinkAt(fd: number, name: string | Uint8Array, directory: boolean): void;
  entries(fd: number): Iterable<Buffer>;
}
let cached: WriteNative | undefined;
export function writeNative(): WriteNative {
  if (cached) return cached;
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux")
    throw new CoreError(
      "capability_denied",
      "descriptor writes unavailable on this platform",
    );
  const candidates = mac
    ? ["/usr/lib/libSystem.B.dylib"]
    : process.arch === "arm64"
      ? [
          "/lib/aarch64-linux-gnu/libc.so.6",
          "/lib/libc.musl-aarch64.so.1",
          "/lib64/libc.so.6",
          "/usr/lib64/libc.so.6",
          "/usr/lib/libc.so.6",
        ]
      : process.arch === "x64"
        ? [
            "/lib/x86_64-linux-gnu/libc.so.6",
            "/lib/libc.musl-x86_64.so.1",
            "/lib64/libc.so.6",
            "/usr/lib64/libc.so.6",
            "/usr/lib/libc.so.6",
          ]
        : [];
  const path = candidates.find((p) => mac || existsSync(p));
  if (!path)
    throw new CoreError(
      "capability_denied",
      "system descriptor library unavailable",
    );
  const errnoName = mac ? "__error" : "__errno_location";
  const lib = dlopen(path, {
    openat: { args: [F.i32, F.ptr, F.i32, F.u32], returns: F.i32 },
    mkdirat: { args: [F.i32, F.ptr, F.u32], returns: F.i32 },
    renameat: { args: [F.i32, F.ptr, F.i32, F.ptr], returns: F.i32 },
    unlinkat: { args: [F.i32, F.ptr, F.i32], returns: F.i32 },
    dup: { args: [F.i32], returns: F.i32 },
    fdopendir: { args: [F.i32], returns: F.ptr },
    readdir: { args: [F.ptr], returns: F.ptr },
    closedir: { args: [F.ptr], returns: F.i32 },
    close: { args: [F.i32], returns: F.i32 },
    [errnoName]: { args: [], returns: F.ptr },
  });
  const sys = lib.symbols as any;
  const errno = () => new Int32Array(toArrayBuffer(sys[errnoName](), 0, 4));
  const fail = (): never => {
    throw new NativeWriteError(errno()[0]!);
  };
  const checked = (r: number) => {
    if (r < 0) fail();
    return r;
  };
  cached = {
    openAt(fd, name, flags, mode = 0) {
      const bytes = cstr(name);
      return checked(sys.openat(fd, ptr(bytes), flags, mode));
    },
    mkdirAt(fd, name, mode) {
      const bytes = cstr(name);
      checked(sys.mkdirat(fd, ptr(bytes), mode));
    },
    renameAt(from, old, to, name) {
      const a = cstr(old),
        b = cstr(name);
      checked(sys.renameat(from, ptr(a), to, ptr(b)));
    },
    unlinkAt(fd, name, directory) {
      const bytes = cstr(name);
      checked(
        sys.unlinkat(fd, ptr(bytes), directory ? (mac ? 0x80 : 0x200) : 0),
      );
    },
    *entries(fd) {
      const duplicate = checked(sys.dup(fd));
      const directory = sys.fdopendir(duplicate);
      if (!directory) {
        const error = errno()[0];
        if (sys.close(duplicate) < 0)
          throw new NativeWriteError(errno()[0]!, true);
        throw new NativeWriteError(error!);
      }

      try {
        for (;;) {
          errno()[0] = 0;
          const entry = sys.readdir(directory);
          if (!entry) {
            if (errno()[0]) fail();
            break;
          }
          const header = new DataView(toArrayBuffer(entry, 0, 21));
          const length = header.getUint16(16, true),
            offset = mac ? 21 : 19;
          if (length <= offset || length > 65535)
            throw new CoreError("capability_denied", "invalid directory entry");
          const bytes = Buffer.from(
            toArrayBuffer(entry, offset, length - offset),
          );
          const end = bytes.indexOf(0);
          if (end < 0)
            throw new CoreError("capability_denied", "invalid directory name");
          const name = Buffer.from(bytes.subarray(0, end));
          if (!name.equals(Buffer.from(".")) && !name.equals(Buffer.from("..")))
            yield name;
        }
      } finally {
        if (sys.closedir(directory) < 0)
          throw new NativeWriteError(errno()[0]!, true);
      }
    },
  };
  // Hold the dlopen object for the process lifetime; function pointers must not outlive it.
  Object.defineProperty(cached, "library", { value: lib });
  return cached;
}
export const WRITE_CLOEXEC =
  process.platform === "darwin" ? 0x1000000 : 0x80000;
export const WRITE_OPEN =
  constants.O_RDONLY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK |
  WRITE_CLOEXEC;
export const WRITE_DIRECTORY = WRITE_OPEN | constants.O_DIRECTORY;
