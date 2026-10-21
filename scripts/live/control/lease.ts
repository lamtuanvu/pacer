import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../core";
import { ControlError } from "./contract";

export interface ProcessIdentity { pid: number; start_identity: string }
export interface LeaseOwner { run_id: string }
export interface LeaseHandle { heartbeat(): Promise<void>; release(): Promise<void> }
const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const libproc = process.platform === "darwin" ? dlopen("/usr/lib/libproc.dylib", {
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
}) : undefined;
/** Kernel flock releases on crash; a late heartbeat never permits stealing. */
export async function acquireLease(scope: string, owner: LeaseOwner, base = join(homedir(), ".pacer-live", "leases")): Promise<LeaseHandle> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope)) throw new ControlError("invalid_input", "invalid lease scope");
  const directory = join(base, scope);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The lock inode is permanent: unlinking it allows two independent locks.
  const fd = openSync(join(directory, "lock"), "a+", 0o600);
  if (libc.symbols.flock(fd, 2 | 4) !== 0) { closeSync(fd); throw new ControlError("busy", `target owned; inspect ${scope} owner metadata`); }
  const file = join(directory, "owner.json");
  const nonce = randomUUID();
  const identity = await processIdentity(process.pid);
  if (!identity) { closeSync(fd); throw new ControlError("observer_unavailable", "cannot establish owner process identity"); }
  let released = false;
  const metadata = { ...owner, ...identity, nonce, heartbeat_at: Date.now() };
  const owns = () => {
    try { return JSON.parse(readFileSync(file, "utf8")).nonce === nonce; } catch { return false; }
  };
  const heartbeat = async () => { if (!released && owns()) atomicWrite(file, JSON.stringify({ ...metadata, heartbeat_at: Date.now() })); };
  try { atomicWrite(file, JSON.stringify(metadata)); } catch (error) { closeSync(fd); throw error; }
  const timer = setInterval(() => { void heartbeat().catch(() => {}); }, 5000);
  timer.unref();
  return {
    heartbeat,
    release: async () => {
      if (released) return;
      released = true; clearInterval(timer);
      try { if (owns()) rmSync(file, { force: true }); }
      finally { libc.symbols.flock(fd, 8); closeSync(fd); }
    },
  };
}
/** proc_bsdinfo ABI measured against SDK headers: size 136, start timeval at 120/128. */
export function processIdentitySync(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return null;
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return { pid, start_identity: `${boot}:${fields[19]}` };
    }
    if (!libproc) return null;
    const info = Buffer.alloc(136);
    if (libproc.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.length) !== info.length || info.readUInt32LE(12) !== pid || info.readUInt32LE(4) === 5) return null;
    return { pid, start_identity: `${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}` };
  } catch { return null; }
}
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  return processIdentitySync(pid);
}
export async function sameProcess(identity: ProcessIdentity): Promise<boolean> {
  return (await processIdentity(identity.pid))?.start_identity === identity.start_identity;
}
