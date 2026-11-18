import { readFileSync } from "node:fs";

/**
 * Another process's argv and initial environment, read the way any same-user process can
 * (#918): `sysctl(KERN_PROCARGS2)` on macOS, `/proc/<pid>/environ` on Linux, `ps eww` otherwise.
 */
export type ProcessArgs = { argv: string[]; env: string[]; source: "procargs2" | "proc" | "ps" };

export async function processArgs(pid: number): Promise<ProcessArgs> {
  if (process.platform === "darwin") return procargs2(pid);
  if (process.platform === "linux") {
    const split = (path: string) => readFileSync(path, "latin1").split("\0").filter(Boolean);
    return { argv: split(`/proc/${pid}/cmdline`), env: split(`/proc/${pid}/environ`), source: "proc" };
  }
  // The fallback mixes argv and environment in one line; report it as both.
  const text = Bun.spawnSync(["ps", "eww", "-o", "command=", "-p", String(pid)]).stdout.toString();
  const words = text.trim().split(/\s+/);
  return { argv: words, env: words, source: "ps" };
}

async function procargs2(pid: number): Promise<ProcessArgs> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  try {
    const CTL_KERN = 1, KERN_ARGMAX = 8, KERN_PROCARGS2 = 49;
    const max = new Int32Array(1), maxSize = new BigUint64Array([4n]);
    if (libc.symbols.sysctl(ptr(new Int32Array([CTL_KERN, KERN_ARGMAX])), 2, ptr(max), ptr(maxSize), null, 0) !== 0)
      throw Error("sysctl(KERN_ARGMAX) failed");
    const buffer = new Uint8Array(max[0]!), size = new BigUint64Array([BigInt(buffer.length)]);
    if (libc.symbols.sysctl(ptr(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid])), 3, ptr(buffer), ptr(size), null, 0) !== 0)
      throw Error(`sysctl(KERN_PROCARGS2) failed for pid ${pid}`);
    const bytes = Buffer.from(buffer.subarray(0, Number(size[0])));
    // int argc, the executable path, NUL padding, argc strings, then environment strings.
    const argc = bytes.readInt32LE(0);
    let at = bytes.indexOf(0, 4);
    while (at < bytes.length && bytes[at] === 0) at++;
    const strings: string[] = [];
    while (at < bytes.length) {
      const end = bytes.indexOf(0, at);
      if (end <= at) break;
      strings.push(bytes.toString("latin1", at, end));
      at = end + 1;
    }
    return { argv: strings.slice(0, argc), env: strings.slice(argc), source: "procargs2" };
  } finally { libc.close(); }
}

/** Direct children of `pid`. */
export function childPids(pid: number): number[] {
  const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString();
  return out.split("\n").filter(Boolean).map(Number);
}
