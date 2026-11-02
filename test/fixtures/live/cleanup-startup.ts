import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { mock } from "bun:test";
import { stopOwnedProcessGroup } from "../../../scripts/live/process-group";
import type { Session } from "../../../scripts/live/core";
import * as processProvider from "../../../src/update/desktop/process-identity";
const actual = { ...processProvider };

function table() {
  const result = Bun.spawnSync(
    ["/bin/ps", "-A", "-o", "pid=,ppid=,pgid=,stat="],
    { stdout: "pipe" },
  );
  if (result.exitCode) throw Error("Cannot observe owned fixture children");
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, group, state] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        parent: Number(parent),
        group: Number(group),
        state: state!,
      };
    });
}
function active(pid: number) {
  const member = table().find((member) => member.pid === pid);
  return member && !/^[ZX]/.test(member.state);
}
const base = process.argv[2]!,
  mode = process.argv[3] ?? "capture",
  role = process.argv[4] ?? "service";
const root = join(base, "capture-failure"),
  checkout = join(base, "checkout");
const source = resolve(import.meta.dir, "../../..");
cpSync(join(source, "scripts"), join(checkout, "scripts"), { recursive: true });
mkdirSync(join(checkout, "src"));
for (const entry of readdirSync(join(source, "src"))) {
  if (entry !== "cli.ts")
    symlinkSync(join(source, "src", entry), join(checkout, "src", entry));
}
const controlled = join(import.meta.dir, "cleanup-capture-process.ts");
symlinkSync(controlled, join(checkout, "src/cli.ts"));
unlinkSync(join(checkout, "scripts/live/proxy.ts"));
symlinkSync(controlled, join(checkout, "scripts/live/proxy.ts"));
let persistedAtIdentity: number | undefined,
  observedIdentityPid: number | undefined;
if (mode === "identity") {
  let failed = false;
  mock.module(
    realpathSync(join(checkout, "src/update/desktop/process-identity.ts")),
    () => ({
      ...actual,
      processIdentity(pid: number) {
        const saved = JSON.parse(
          readFileSync(join(root, "session.json"), "utf8"),
        ) as Session;
        if (!failed && (role === "service" || pid !== saved.pid)) {
          failed = true;
          persistedAtIdentity = role === "service" ? saved.pid : saved.proxyPid;
          observedIdentityPid = pid;
          return null;
        }
        return actual.processIdentity(pid);
      },
    }),
  );
}
const { up, down } = (await import(
  `${checkout}/scripts/live/core.ts`
)) as typeof import("../../../scripts/live/core");
const prior = new Set(
  table()
    .filter((member) => member.parent === process.pid)
    .map((member) => member.pid),
);
try {
  let startupError: string | null = null,
    downError: string | null = null,
    aggregate = false,
    errors: string[] = [];
  try {
    await up("capture-failure", undefined, base);
  } catch (error) {
    startupError = String(error);
    aggregate = error instanceof AggregateError;
    if (error instanceof AggregateError) errors = error.errors.map(String);
  }
  const session = JSON.parse(
    readFileSync(join(root, "session.json"), "utf8"),
  ) as Session;
  let leaderStopped: boolean | undefined,
    descendantAlive: boolean | undefined,
    descendantGroup: number | undefined;
  if (mode === "capture") {
    const ready = JSON.parse(
      readFileSync(join(root, `${role}-ready.json`), "utf8"),
    );
    const end = Date.now() + 2000;
    while (active(ready.leader.pid) && Date.now() < end) await Bun.sleep(10);
    leaderStopped = !active(ready.leader.pid);
    descendantAlive =
      !!active(ready.descendant.pid) &&
      actual.sameProcess(
        actual.processIdentity(ready.descendant.pid),
        ready.descendant,
      );
    descendantGroup = table().find(
      (member) => member.pid === ready.descendant.pid,
    )?.group;
  }
  const log = join(root, "evidence/log.jsonl"),
    evidence = existsSync(log) ? readFileSync(log, "utf8") : "";
  try {
    await down(session);
  } catch (error) {
    downError = String(error);
  }
  console.log(
    JSON.stringify({
      startupError,
      downError,
      aggregate,
      errors,
      session,
      evidence,
      rootExists: existsSync(root),
      leaderStopped,
      descendantAlive,
      descendantGroup,
      persistedAtIdentity,
      observedIdentityPid,
    }),
  );
} finally {
  // The controlled child publishes its own birth identity. Never infer ownership from a recycled PID.
  const end = Date.now() + 3000;
  while (
    table().some(
      (member) => member.parent === process.pid && !prior.has(member.pid),
    ) &&
    !existsSync(join(root, "service-ready.json")) &&
    Date.now() < end
  )
    await Bun.sleep(10);
  for (const name of ["service", "proxy"]) {
    const childPath = join(root, `${name}-descendant.json`);
    if (existsSync(childPath))
      actual.signalSameProcess(
        JSON.parse(readFileSync(childPath, "utf8")),
        "SIGKILL",
      );
    const readyPath = join(root, `${name}-ready.json`);
    if (existsSync(readyPath))
      actual.signalSameProcess(
        JSON.parse(readFileSync(readyPath, "utf8")).leader,
        "SIGKILL",
      );
  }
  if (existsSync(join(root, "session.json"))) {
    const session = JSON.parse(
      readFileSync(join(root, "session.json"), "utf8"),
    ) as Session;
    for (const group of [session.serviceGroup, session.proxyGroup])
      if (group) await stopOwnedProcessGroup(group);
  }
  for (const member of table().filter(
    (member) => member.parent === process.pid && !prior.has(member.pid),
  )) {
    const identity = actual.processIdentity(member.pid);
    if (identity) actual.signalSameProcess(identity, "SIGKILL");
  }
  await Bun.sleep(50);
}
