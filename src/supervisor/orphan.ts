import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processIdentity, sameProcess, signalSameProcess, type ProcessIdentity } from "../update/desktop/process-identity";

// Linux birth identities are clock ticks since boot; Darwin records wall-clock seconds/useconds.
function startedAt(identity: ProcessIdentity): number {
  if (process.platform === "darwin") {
    const [seconds, micros] = identity.birth.split(":").map(Number);
    return seconds! + micros! / 1_000_000;
  }
  const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
  const clock = Bun.spawnSync(["getconf", "CLK_TCK"], { stdout: "pipe", stderr: "ignore" });
  const ticks = Number(clock.stdout.toString().trim());
  if (!boot || clock.exitCode !== 0 || !(ticks > 0)) throw new Error("process birth unavailable");
  return Number(boot[1]) + Number(identity.birth) / ticks;
}

/** Reap a dead wrapper's owned group, including the separate PTY session group.
 * `unverified` means a reused wrapper PID proves we must settle without signalling. */
export async function stopOrphanedRun(dir: string, wrapper: number, graceMs: number,
  guard: () => void): Promise<boolean | "unverified"> {
  if (!Number.isSafeInteger(wrapper) || wrapper <= 1) return false;
  try {
    guard();
    let child: number | undefined;
    let childRecordedAt: number | undefined;
    if (existsSync(join(dir, "child"))) {
      const childStat = lstatSync(join(dir, "child"));
      if (!childStat.isFile()) return false;
      childRecordedAt = childStat.mtimeMs / 1000;
      child = Number(readFileSync(join(dir, "child"), "utf8").trim());
      if (!Number.isSafeInteger(child) || child <= 1) return false;
    }
    const interactive = existsSync(join(dir, "interactive.json"));
    const members = () => {
      const ps = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,stat="], { stdout: "pipe", stderr: "ignore" });
      if (ps.exitCode !== 0) throw new Error("process table unavailable");
      return ps.stdout.toString().trim().split("\n").map(line => {
        const [pid, group, state] = line.trim().split(/\s+/);
        if (!/^\d+$/.test(pid!) || !/^\d+$/.test(group!) || !state) throw new Error("invalid process table");
        return { pid: Number(pid), group: Number(group), state };
      }).filter(row => !row.state.startsWith("Z"));
    };
    let rows = members();
    if (rows.some(row => row.pid === wrapper)) {
      const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(wrapper)], { stdout: "pipe", stderr: "ignore" });
      const command = ps.stdout.toString().trim();
      if (ps.exitCode === 0 && command && !command.includes(join(dir, "run.sh")) &&
        !command.endsWith(`_session ${dir}`)) return "unverified";
      return false;
    }
    const recordedChild = rows.find(row => row.pid === child);
    const group = interactive && child && recordedChild?.group !== wrapper ? child : wrapper;
    if (recordedChild && recordedChild.group !== group) return false;
    let remaining = rows.filter(row => row.group === group);
    if (!remaining.length) return true;
    // A group number alone can outlive a reused PID. Require the recorded child as anchor.
    const start = Number(readFileSync(join(dir, "started"), "utf8").trim());
    if (!Number.isFinite(start) || start <= 0 || !recordedChild) return false;
    const anchor = processIdentity(recordedChild.pid);
    if (!anchor || childRecordedAt === undefined || !Number.isFinite(childRecordedAt)) return false;
    const anchorStartedAt = startedAt(anchor);
    // A reused child PID can be newer than the run, but cannot predate the child
    // record written immediately after spawning the original process.
    if (!Number.isFinite(anchorStartedAt) || anchorStartedAt < start ||
      anchorStartedAt > childRecordedAt) return false;
    const identities = new Map<number, ProcessIdentity>([[anchor.pid, anchor]]);
    for (const [signal, waitMs] of [["SIGTERM", Math.max(0, Math.min(graceMs, 25_000))], ["SIGKILL", 1000]] as const) {
      const end = Date.now() + waitMs;
      do {
        guard();
        const current = new Map<number, ProcessIdentity>();
        for (const row of remaining) {
          const identity = processIdentity(row.pid);
          if (!identity) continue; // It may have exited since the shared table scan.
          if (startedAt(identity) < start) return false;
          const prior = identities.get(row.pid);
          if (prior && !sameProcess(prior, identity)) return false;
          current.set(row.pid, identity);
        }
        // Recheck membership after acquiring identities, once for the whole poll.
        rows = members();
        if (rows.some(row => row.pid === wrapper)) return false;
        remaining = rows.filter(row => row.group === group);
        if (!remaining.length) return true;
        for (const pid of current.keys()) {
          if (!remaining.some(row => row.pid === pid)) current.delete(pid);
        }
        // Keep a continuous birth-identity link to the group we first attributed to the run.
        if (current.size && ![...current].some(([pid, identity]) => sameProcess(identities.get(pid) ?? null, identity))) return false;
        for (const [pid, identity] of current) {
          identities.set(pid, identity);
          guard();
          signalSameProcess(identity, signal); // The next poll confirms exit or retries a survivor.
        }
        await Bun.sleep(100);
      } while (Date.now() < end);
    }
    guard();
    return !members().some(row => row.group === group || row.pid === wrapper);
  } catch { return false; }
}
