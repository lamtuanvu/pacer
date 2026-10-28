import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";

const MAX_FILE_BYTES = 512 * 1024;
const CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
let libc: ReturnType<typeof openLibrary> | undefined;

function openLibrary() {
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
}

/** Walk from an owned directory descriptor to a regular file, never following symlinks, and hand its descriptor to use. */
function withWorkspaceFile<T>(root: string, components: string[], deniedDirectory: { dev: number; ino: number } | undefined, expectedRoot: { dev: number; ino: number } | undefined, use: (fd: number, info: Stats) => T): T {
  if (!components.length || components.some(part => !part || part === "." || part === ".." || part.includes("/") || part.includes("\0")))
    throw Error("Invalid workspace path");
  const expected = expectedRoot ?? statSync(root);
  const owned: number[] = [];
  try {
    let dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOEXEC);
    owned.push(dir);
    const openedRoot = fstatSync(dir);
    if (!openedRoot.isDirectory() || openedRoot.dev !== expected.dev || openedRoot.ino !== expected.ino)
      throw Error("Workspace changed while opening file");
    if (deniedDirectory && openedRoot.dev === deniedDirectory.dev && openedRoot.ino === deniedDirectory.ino)
      throw Error("Private state directory refused");
    const openat = (libc ??= openLibrary()).symbols.openat;
    for (let index = 0; index < components.length; index++) {
      const last = index === components.length - 1;
      const name = Buffer.from(`${components[index]}\0`);
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | CLOEXEC |
        (last ? constants.O_NONBLOCK : constants.O_DIRECTORY);
      const fd = openat(dir, ptr(name), flags);
      if (fd < 0) throw Error("File unavailable or symbolic link refused");
      owned.push(fd);
      const info = fstatSync(fd);
      if (last) {
        if (!info.isFile()) throw Error("Not a regular file");
        return use(fd, info);
      }
      if (!info.isDirectory()) throw Error("Not a directory");
      if (deniedDirectory && info.dev === deniedDirectory.dev && info.ino === deniedDirectory.ino)
        throw Error("Private state directory refused");
      dir = fd;
    }
    throw Error("File unavailable");
  } finally {
    for (const fd of owned.reverse()) closeSync(fd);
  }
}

/** Read a regular file by walking from an owned directory descriptor, never following symlinks. */
export function readWorkspaceFile(root: string, components: string[], deniedDirectory?: { dev: number; ino: number }, expectedRoot?: { dev: number; ino: number }): { bytes: Buffer; size: number; modified: string } {
  return withWorkspaceFile(root, components, deniedDirectory, expectedRoot, (fd, info) => {
    if (info.size > MAX_FILE_BYTES) throw RangeError("File exceeds preview limit");
    const bytes = Buffer.alloc(info.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) throw Error("File changed while reading");
      read += count;
    }
    const after = fstatSync(fd);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw Error("File changed while reading");
    return { bytes, size: info.size, modified: `${info.ino}:${info.size}:${info.mtimeMs}` };
  });
}

/** Confirm a regular file by the same traversal as the read, without reading or size-limiting it. */
export function resolveWorkspaceFile(root: string, components: string[], deniedDirectory?: { dev: number; ino: number }, expectedRoot?: { dev: number; ino: number }): { dev: number; ino: number; size: number } {
  return withWorkspaceFile(root, components, deniedDirectory, expectedRoot, (_fd, info) => ({ dev: info.dev, ino: info.ino, size: info.size }));
}
