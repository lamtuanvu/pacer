import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { dlopen, FFIType, ptr } from "bun:ffi";

export type ProcessIdentity = { pid: number; bootId: string; birth: string };
const procSymbols = {
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;
let procLibrary: ReturnType<typeof dlopen<typeof procSymbols>> | undefined;

/** Read only public process metadata, never process environments or credentials. */
export function processIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return birth && /^\d+$/.test(birth) && bootId ? { pid, bootId, birth } : null;
    }
    if (process.platform === "darwin") {
      // Public Darwin ABI: proc_bsdinfo is 136 bytes on supported 64-bit
      // architectures; pbi_start_tvsec/usec are uint64 at offsets 120/128.
      // Verified against SDK sys/proc_info.h using sizeof/offsetof.
      procLibrary ??= dlopen("/usr/lib/libproc.dylib", procSymbols);
      const data = new Uint8Array(136);
      if (procLibrary.symbols.proc_pidinfo!(pid, 3, 0, ptr(data), data.length) !== data.length) return null;
      const view = new DataView(data.buffer);
      const seconds = view.getBigUint64(120, true), micros = view.getBigUint64(128, true);
      if (seconds === 0n || micros >= 1_000_000n) return null;
      const boot = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], { stdout: "pipe", stderr: "ignore" });
      const bootId = boot.stdout.toString().trim();
      return boot.exitCode === 0 && /^[A-Fa-f0-9-]{36}$/.test(bootId) ? { pid, bootId, birth: `${seconds}:${micros}` } : null;
    }
  } catch { /* Unsupported or denied identity remains ambiguous and blocks recovery. */ }
  return null;
}

export function sameProcess(a: ProcessIdentity | null, b: ProcessIdentity | null): boolean {
  return !!a && !!b && a.pid === b.pid && a.bootId === b.bootId && a.birth === b.birth;
}

let ownIdentity: ProcessIdentity | undefined;
/** A successful birth query is immutable for this process lifetime. */
export function ownProcessIdentity(): ProcessIdentity | null {
  if (ownIdentity) return ownIdentity;
  const identity = processIdentity(process.pid);
  if (identity) ownIdentity = identity;
  return identity;
}

const libcSymbols = {
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
} as const;
let libc: ReturnType<typeof dlopen<typeof libcSymbols>> | null | undefined;
// Generic syscall numbers, identical on x86_64 and arm64 Linux.
const SYS_PIDFD_SEND_SIGNAL = 424, SYS_PIDFD_OPEN = 434;
function linuxLibc() {
  if (libc !== undefined) return libc;
  try { libc = dlopen("libc.so.6", libcSymbols); } catch { libc = null; }
  return libc;
}

/** Signal only while the live process is still the recorded one. */
export function signalSameProcess(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
  const number = constants.signals[signal];
  if (!number || !Number.isSafeInteger(identity.pid) || identity.pid <= 1) return false;
  if (process.platform === "linux") {
    const lib = linuxLibc();
    if (lib) {
      const fd = Number(lib.symbols.syscall(SYS_PIDFD_OPEN, identity.pid, 0, 0, 0));
      if (fd >= 0) {
        try {
          if (!sameProcess(processIdentity(identity.pid), identity)) return false;
          return Number(lib.symbols.syscall(SYS_PIDFD_SEND_SIGNAL, fd, number, 0, 0)) === 0;
        } finally { lib.symbols.close(fd); }
      }
    }
  }
  if (!sameProcess(processIdentity(identity.pid), identity)) return false;
  try { process.kill(identity.pid, signal); return true; } catch { return false; }
}
