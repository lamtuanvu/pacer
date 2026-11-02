import { processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";

/** launch() creates a dedicated session/group; the leader's birth proves its owner. */
export interface OwnedProcessGroup {
  leader: ProcessIdentity;
  stopped?: true;
}

type Member = { pid: number; group: number; state: string };
function processTable(): Member[] {
  const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,stat="], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw Error("Cannot inspect sandbox process groups; keeping sandbox");
  return result.stdout.toString().trim().split("\n").filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw Error("Invalid sandbox process-group observation; keeping sandbox");
    return { pid: Number(match[1]), group: Number(match[2]), state: match[3] };
  });
}
function liveMembers(table: Member[], group: number): Member[] {
  // Zombies have no code or filesystem activity; their parent owns reaping them.
  return table.filter(member => member.group === group && !/^[ZX]/.test(member.state));
}
export function validOwnedProcessGroup(value: unknown, pid: number): value is OwnedProcessGroup {
  const group = value as OwnedProcessGroup | null;
  return !!group && typeof group === "object" && !!group.leader && typeof group.leader === "object"
    && Number.isSafeInteger(pid) && pid > 1 && group.leader.pid === pid
    && typeof group.leader.bootId === "string" && !!group.leader.bootId
    && typeof group.leader.birth === "string" && !!group.leader.birth
    && (group.stopped === undefined || group.stopped === true);
}
export function captureOwnedProcessGroup(pid: number, leader = processIdentity(pid)): OwnedProcessGroup {
  const member = processTable().find(member => member.pid === pid);
  if (pid <= 1 || !leader || member?.group !== pid || !sameProcess(leader, processIdentity(pid))) {
    throw Error("Cannot prove sandbox detached process-group identity; keeping sandbox");
  }
  return { leader };
}

/** Never signal an unverified/reused leader, or a group after its leader is gone. */
export async function stopOwnedProcessGroup(group: OwnedProcessGroup, timeoutMs = 3000): Promise<void> {
  if (!validOwnedProcessGroup(group, group.leader?.pid)) throw Error("Invalid sandbox process-group identity; keeping sandbox");
  if (group.stopped) return;
  const pid = group.leader.pid;
  const table = processTable();
  const leader = processIdentity(pid);
  if (leader && (!sameProcess(group.leader, leader) || table.find(member => member.pid === pid)?.group !== pid)) {
    throw Error("Sandbox process-group leader identity changed; refusing to signal or remove sandbox");
  }
  if (!liveMembers(table, pid).length) {
    group.stopped = true;
    return;
  }
  if (!leader || !sameProcess(group.leader, processIdentity(pid))) {
    throw Error("Sandbox process-group leader is gone with live descendants; refusing to signal or remove sandbox");
  }
  try { process.kill(-pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const end = Date.now() + timeoutMs;
  while (liveMembers(processTable(), pid).length) {
    if (Date.now() >= end) throw Error("Sandbox process group did not stop; keeping sandbox for inspection");
    await Bun.sleep(25);
  }
  group.stopped = true;
}
