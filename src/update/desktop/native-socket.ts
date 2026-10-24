/// <reference path="./native-socket-c.d.ts" />
/** Owned nonblocking Unix descriptors; no undocumented Node/Bun native handles. */
import source from "./native-socket.c" with { type: "file" };
import { cc, dlopen, FFIType as F, ptr, toArrayBuffer } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { FrameDecoder, encodeFrame } from "./adapter";
import { loadNativeShim, NATIVE_SHIM_SYMBOLS } from "./native-shim";
import { compiledSignerPins } from "./native-os";
import { compiledNativeFixture } from "./native-fixture";
import {
  ownProcessIdentity,
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from "./process-identity";
let library: ReturnType<typeof system> | undefined;
const system = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
    socket: { args: [F.i32, F.i32, F.i32], returns: F.i32 },
    bind: { args: [F.i32, F.ptr, F.u32], returns: F.i32 },
    listen: { args: [F.i32, F.i32], returns: F.i32 },
    accept: { args: [F.i32, F.ptr, F.ptr], returns: F.i32 },
    close: { args: [F.i32], returns: F.i32 },
    read: { args: [F.i32, F.ptr, F.u64], returns: F.i64 },
    write: { args: [F.i32, F.ptr, F.u64], returns: F.i64 },
    getsockopt: { args: [F.i32, F.i32, F.i32, F.ptr, F.ptr], returns: F.i32 },
    getsockname: { args: [F.i32, F.ptr, F.ptr], returns: F.i32 },
    setsockopt: { args: [F.i32, F.i32, F.i32, F.ptr, F.u32], returns: F.i32 },
    __error: { args: [], returns: F.ptr },
  });
function os() {
  if (process.platform !== "darwin")
    throw Error("Native local transport unavailable");
  return (library ??= system()).symbols;
}
function errno() {
  const p = os().__error();
  return p ? new Int32Array(toArrayBuffer(p, 0, 4))[0] : 0;
}
let shim: ReturnType<typeof descriptorShim> | undefined;
function descriptorShim() {
  if (Bun.isStandaloneExecutable || compiledSignerPins() || compiledNativeFixture()) return loadNativeShim();
  return developmentDescriptorShim();
}
function developmentDescriptorShim() {
  // TinyCC reads native paths, while compiled Bun assets live in a virtual FS.
  // Compile only the packaged bytes through an unlinked, privately held FD.
  // The C wrapper preserves Darwin arm64's variadic fcntl calling convention.
  const bytes = readFileSync(source);
  const parent = lstatSync("/private/tmp");
  if (!parent.isDirectory() || parent.uid !== 0 || !(parent.mode & 0o1000))
    throw Error("Native runtime root unavailable");
  const directory = mkdtempSync("/private/tmp/pacer-native-shim-");
  const identity = privateDirectory(directory);
  const path = directory + "/socket.c";
  let fd = -1;
  let linked = false;
  let directoryPresent = true;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    linked = true;
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || file.mode & 0o077)
      throw Error("Native descriptor source unavailable");
    unlinkSync(path);
    linked = false;
    rmdirSync(directory);
    directoryPresent = false;
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error("Native descriptor source unavailable");
      offset += count;
    }
    return cc({
      source: `/dev/fd/${fd}`,
      symbols: NATIVE_SHIM_SYMBOLS,
    });
  } finally {
    try {
      if (directoryPresent && privateDirectory(directory).ino === identity.ino) {
        if (linked && fd >= 0 && lstatSync(path).ino === fstatSync(fd).ino)
          unlinkSync(path);
        rmdirSync(directory);
      }
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }
}
function nonblocking(fd: number) {
  const s = os();
  if ((shim ??= descriptorShim()).symbols.pacer_descriptor_flags(fd) < 0)
    throw Error("Native descriptor unavailable");
  const yes = new Int32Array([1]);
  if (s.setsockopt(fd, 0xffff, 0x1022, ptr(yes), 4) < 0)
    throw Error("Native descriptor unavailable");
}
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw Error("Native socket directory must be private");
  return stat;
}
/** Internal bootstrap only: callers authenticate the fixed parent channel first. */
export function receiveParentListener(): number {
  const fd = (shim ??= descriptorShim()).symbols.pacer_receive_listener(0);
  if (fd < 0) throw Error("Native parent listener unavailable");
  try {
    const stat = fstatSync(fd);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw Error("Native parent listener unavailable");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
/** Private startup only, after authenticating fd0 and receiving the listener. */
export function receiveParentHelperChannel(): number {
  const fd = (shim ??= descriptorShim()).symbols.pacer_receive_helper_channel(0);
  if (fd < 0) throw Error("Native parent helper channel unavailable");
  return fd;
}
/** Private paired startup only, after authenticating the fixed parent. */
export function receiveParentChannels(): { listener: number; helper: number } {
  const descriptors = new Int32Array([-1, -1]);
  if ((shim ??= descriptorShim()).symbols.pacer_receive_parent_channels(0, ptr(descriptors)) < 0)
    throw Error("Native parent channels unavailable");
  return { listener: descriptors[0], helper: descriptors[1] };
}
/** Receipt does not acknowledge authority: the caller rechecks ownership first. */
export function acknowledgeParentChannels(): void {
  if ((shim ??= descriptorShim()).symbols.pacer_acknowledge_parent(0) < 0)
    throw Error("Native parent acknowledgement unavailable");
}
/** The channel owner closes it exactly once on failure; successful rights transfer
 * ownership to the caller. No process signals or caller-selected argv are used. */
export function requestParentHelper(channel: number, request: {
  schema: 1; path: string; sha256: string; version: string;
}): { pid: number; stdin: number; stdout: number; control: number } {
  // Resolve/verify the shim before stamping: its synchronous initialization is
  // outside the C request's existing deadline. The stamp grants no authority.
  const helperShim = shim ??= descriptorShim();
  const bytes = Buffer.from(JSON.stringify({ ...request, startedAtMs: Date.now() }));
  if (!bytes.length || bytes.length > 8192) throw Error("Native helper request unavailable");
  const descriptors = new Int32Array([-1, -1, -1, -1]);
  const pid = helperShim.symbols.pacer_request_helper(
    channel, ptr(bytes), bytes.length, ptr(descriptors),
  );
  if (pid <= 1) throw Error("Native parent helper spawn unavailable");
  return { pid, stdin: descriptors[0], stdout: descriptors[1], control: descriptors[2] };
}
function readOwner(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 4096
    )
      throw Error("Invalid native owner");
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 4096) throw Error("Invalid native owner");
    const owner = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (
      !Number.isSafeInteger(owner.inode) ||
      !Number.isSafeInteger(owner.process?.pid) ||
      typeof owner.process.bootId !== "string" ||
      typeof owner.process.birth !== "string"
    )
      throw Error("Invalid native owner");
    return owner;
  } finally {
    closeSync(fd);
  }
}
export class LocalNativePeer {
  readonly auditToken = new Uint8Array(32);
  readonly closed: Promise<void>;
  onFrame: (frame: unknown) => void = () => {};
  private resolveClosed!: () => void;
  private decoder = new FrameDecoder();
  private dead = false;
  private lastActivity = Date.now();
  private queue: {
    bytes: Uint8Array;
    offset: number;
    resolve: () => void;
    reject: () => void;
  }[] = [];
  constructor(private fd: number) {
    const n = new Uint32Array([32]);
    if (
      os().getsockopt(fd, 0, 6, ptr(this.auditToken), ptr(n)) !== 0 ||
      n[0] !== 32
    )
      throw Error("Native peer credentials unavailable");
    nonblocking(fd);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }
  send(value: unknown): Promise<void> {
    if (this.dead || this.queue.length >= 8)
      return Promise.reject(Error("Native channel unavailable"));
    const bytes = encodeFrame(value);
    return new Promise((resolve, reject) => {
      this.queue.push({
        bytes,
        offset: 0,
        resolve,
        reject: () => reject(Error("Native channel closed")),
      });
      this.flush();
    });
  }
  private flush() {
    while (this.queue.length && !this.dead) {
      const first = this.queue[0],
        remaining = first.bytes.subarray(first.offset);
      const n = Number(os().write(this.fd, ptr(remaining), remaining.length));
      if (n < 0) {
        if (errno() === 35) return;
        this.close();
        return;
      }
      if (n === 0) return;
      this.lastActivity = Date.now();
      first.offset += n;
      if (first.offset === first.bytes.length) {
        this.queue.shift();
        first.resolve();
      }
    }
  }
  poll() {
    if (this.dead) return;
    this.flush();
    const bytes = new Uint8Array(65536);
    try {
      for (let i = 0; i < 4; i++) {
        const n = Number(os().read(this.fd, ptr(bytes), bytes.length));
        if (n < 0) {
          if (errno() === 35) break;
          throw Error("read");
        }
        if (n === 0) {
          this.close();
          return;
        }
        this.lastActivity = Date.now();
        for (const frame of this.decoder.push(bytes.subarray(0, n)))
          this.onFrame(frame);
      }
    } catch {
      this.close();
    }
    if (Date.now() - this.lastActivity > 30_000) this.close();
  }
  close() {
    if (this.dead) return;
    this.dead = true;
    os().close(this.fd);
    for (const item of this.queue.splice(0)) item.reject();
    this.resolveClosed();
  }
}
/** Private startup descriptor; composition must authenticate its parent first. */
export type ParentNativeListener = { fd: number; owner: ProcessIdentity };
export class LocalNativeServer {
  private fd = -1;
  private directoryFd = -1;
  private inode = 0;
  private ownerCreated = false;
  private peers = new Set<LocalNativePeer>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly path: string,
    accept: (peer: LocalNativePeer) => void,
    inherited?: ParentNativeListener,
  ) {
    this.fd = inherited?.fd ?? -1;
    try { this.initialize(accept, inherited); }
    catch (error) { this.close(); throw error; }
  }
  private initialize(
    accept: (peer: LocalNativePeer) => void,
    inherited?: ParentNativeListener,
  ) {
    const path = this.path;
    if (
      !/^\/private\/tmp\/pacer-native-\d+\/[a-f0-9]{32}\.sock$/.test(path) ||
      Buffer.byteLength(path) >= 104
    )
      throw Error("Invalid native socket path");
    const dir = dirname(path),
      parent = lstatSync("/private/tmp");
    if (!parent.isDirectory() || parent.uid !== 0 || !(parent.mode & 0o1000))
      throw Error("Native runtime root unavailable");
    if (!inherited) {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const identity = privateDirectory(dir);
    this.directoryFd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (fstatSync(this.directoryFd).ino !== identity.ino)
        throw Error("Native runtime directory changed");
      if (inherited) this.adopt(inherited);
      else this.bindOwned();
      this.timer = setInterval(() => {
        try {
          if (privateDirectory(dir).ino !== identity.ino) {
            this.close();
            return;
          }
          for (let i = 0; i < 8; i++) {
            const fd = os().accept(this.fd, null, null);
            if (fd < 0) break;
            if (this.peers.size >= 8) {
              os().close(fd);
              continue;
            }
            try {
              const peer = new LocalNativePeer(fd);
              this.peers.add(peer);
              void peer.closed.then(() => this.peers.delete(peer));
              accept(peer);
            } catch {
              os().close(fd);
            }
          }
          for (const peer of this.peers) peer.poll();
        } catch {
          this.close();
        }
      }, 8);
      this.timer.unref();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private adopt(inherited: ParentNativeListener): void {
    const socket = fstatSync(inherited.fd), path = lstatSync(this.path), owner = readOwner(this.path + ".owner");
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || !path.isSocket()
      || path.uid !== process.getuid?.() || path.mode & 0o077 || path.ino !== owner.inode
      || inherited.owner.pid !== process.ppid || !sameProcess(owner.process, inherited.owner)
      || !sameProcess(inherited.owner, processIdentity(inherited.owner.pid))) {
      throw Error("Native parent listener ownership unavailable");
    }
    const address = new Uint8Array(106), size = new Uint32Array([address.length]);
    const expected = Buffer.concat([Buffer.from(this.path), Buffer.from([0])]);
    if (os().getsockname(inherited.fd, ptr(address), ptr(size)) !== 0
      || size[0] !== expected.length + 2 || address[0] !== size[0] || address[1] !== 1
      || !Buffer.from(address.subarray(2, size[0])).equals(expected)) {
      throw Error("Native parent listener path unavailable");
    }
    nonblocking(this.fd);
    // Root retains ownership of the path and owner record. Closing this child
    // only closes its duplicate descriptor and accepted channels.
  }
  private bindOwned(): void {
    const path = this.path;
    const own = ownProcessIdentity();
    if (!own) throw Error("Native process incarnation unavailable");
    try {
      const old = lstatSync(path),
        owner = readOwner(path + ".owner");
      if (
        !old.isSocket() ||
        old.uid !== process.getuid?.() ||
        old.ino !== owner.inode ||
        sameProcess(owner.process, processIdentity(owner.process.pid))
      )
        throw Error("Native socket already owned");
      try {
        process.kill(owner.process.pid, 0);
        if (!processIdentity(owner.process.pid))
          throw Error("Native owner is ambiguous");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      unlinkSync(path);
      unlinkSync(path + ".owner");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.fd = os().socket(1, 1, 0);
    if (this.fd < 0) throw Error("Native socket unavailable");
    nonblocking(this.fd);
    const name = Buffer.from(path),
      address = new Uint8Array(106);
    address[0] = name.length + 3;
    address[1] = 1;
    address.set(name, 2);
    const oldMask = process.umask(0o077);
    try {
      if (
        os().bind(this.fd, ptr(address), name.length + 3) !== 0 ||
        os().listen(this.fd, 8) !== 0
      )
        throw Error("Native socket bind failed");
    } finally {
      process.umask(oldMask);
    }
    this.inode = lstatSync(path).ino;
    writeFileSync(
      path + ".owner",
      JSON.stringify({ process: own, inode: this.inode }),
      { mode: 0o600, flag: "wx" },
    );
    this.ownerCreated = true;
  }
  close() {
    clearInterval(this.timer);
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    if (this.fd >= 0) {
      os().close(this.fd);
      this.fd = -1;
    }
    if (this.inode) {
      try {
        if (lstatSync(this.path).ino === this.inode) {
          unlinkSync(this.path);
          if (this.ownerCreated) unlinkSync(this.path + ".owner");
        }
      } catch {}
      this.inode = 0;
    }
    if (this.directoryFd >= 0) {
      closeSync(this.directoryFd);
      this.directoryFd = -1;
    }
  }
}
