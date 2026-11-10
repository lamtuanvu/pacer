import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processIdentity, signalSameProcess } from "../update/desktop/process-identity";

/** Reap a dead pipe wrapper's remaining group. Unknown ownership stays pending. */
export async function stopOrphanedRun(dir: string, wrapper: number, graceMs: number,
  guard: () => void): Promise<boolean> {
  if (!Number.isSafeInteger(wrapper) || wrapper <= 1) return false;
  let child: number | undefined;
  try {
    if (!lstatSync(join(dir, "child")).isFile()) return false;
    child = Number(readFileSync(join(dir, "child"), "utf8").trim());
    if (!Number.isSafeInteger(child) || child <= 1) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const members = () => {
    // A failed probe is not proof of death. Zombies cannot write or spawn.
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,stat="], { stdout: "pipe", stderr: "ignore" });
    if (ps.exitCode !== 0) throw new Error("process table unavailable");
    const rows = ps.stdout.toString().trim().split("\n").map(line => {
      const [pid, group, state] = line.trim().split(/\s+/);
      if (!/^\d+$/.test(pid!) || !/^\d+$/.test(group!) || !state) throw new Error("invalid process table");
      return { pid: Number(pid), group: Number(group), state };
    }).filter(row => !row.state.startsWith("Z"));
    // A reused wrapper PID or a child in a separate session cannot be attributed
    // to this dead wrapper from group membership. Never signal either blindly.
    if (rows.some(row => row.pid === wrapper || row.pid === child && row.group !== wrapper))
      throw new Error("orphan ownership is uncertain");
    return rows.filter(row => row.group === wrapper);
  };
  try {
    for (const [signal, waitMs] of [["SIGTERM", Math.min(graceMs, 25_000)], ["SIGKILL", 1000]] as const) {
      guard();
      const remaining = members();
      if (!remaining.length) return true;
      for (const row of remaining) {
        const identity = processIdentity(row.pid);
        if (!identity) {
          if (!members().some(member => member.pid === row.pid)) continue;
          return false;
        }
        guard();
        // Recheck membership after acquiring the birth identity and before signalling.
        if (!members().some(member => member.pid === row.pid)) continue;
        if (!signalSameProcess(identity, signal) && members().some(member => member.pid === row.pid)) return false;
      }
      const end = Date.now() + waitMs;
      do {
        guard();
        if (!members().length) return true;
        await Bun.sleep(25);
      } while (Date.now() < end);
    }
    return false;
  } catch { return false; }
}
