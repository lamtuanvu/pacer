import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processIdentity, sameProcess, signalSameProcess, type ProcessIdentity } from "../update/desktop/process-identity";

type BirthClock = "darwin" | { bootTime: number; ticksPerSecond: number };

function birthClock(): BirthClock {
  if (process.platform === "darwin") return "darwin";
  const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
  const clock = Bun.spawnSync(["getconf", "CLK_TCK"], { stdout: "pipe", stderr: "ignore" });
  const ticks = Number(clock.stdout.toString().trim());
  if (!boot || clock.exitCode !== 0 || !(ticks > 0)) throw new Error("process birth unavailable");
  return { bootTime: Number(boot[1]), ticksPerSecond: ticks };
}

/** Check wall-clock run bounds using the precision of the process birth clock. */
export function birthMatchesRun(identity: ProcessIdentity, start: number, recordedAt = Infinity,
  clock: BirthClock = birthClock()): boolean {
  let birth: number;
  let precision = 0;
  if (clock === "darwin") {
    const [seconds, micros] = identity.birth.split(":").map(Number);
    birth = seconds! + micros! / 1_000_000;
  } else {
    if (!Number.isFinite(clock.bootTime) || !Number.isFinite(clock.ticksPerSecond) ||
      clock.ticksPerSecond <= 0) return false;
    birth = clock.bootTime + Number(identity.birth) / clock.ticksPerSecond;
    // /proc/stat btime has whole-second precision; /proc/<pid>/stat starttime
    // has CLK_TCK precision. Bound wall-clock comparisons by one second plus
    // one tick, including the child-record upper bound used to reject PID reuse.
    // Exact birth identities are still rechecked before every signal.
    precision = 1 + 1 / clock.ticksPerSecond;
  }
  return Number.isFinite(birth) && Number.isFinite(start) &&
    birth >= start - precision && birth <= recordedAt + precision;
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
    // A reused child PID can be newer than the run, but cannot predate the child
    // record written immediately after spawning the original process.
    if (!birthMatchesRun(anchor, start, childRecordedAt)) return false;
    const identities = new Map<number, ProcessIdentity>([[anchor.pid, anchor]]);
    for (const [signal, waitMs] of [["SIGTERM", Math.max(0, Math.min(graceMs, 25_000))], ["SIGKILL", 1000]] as const) {
      const end = Date.now() + waitMs;
      do {
        guard();
        const current = new Map<number, ProcessIdentity>();
        for (const row of remaining) {
          const identity = processIdentity(row.pid);
          if (!identity) continue; // It may have exited since the shared table scan.
          if (!birthMatchesRun(identity, start)) return false;
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
