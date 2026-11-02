import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import {
  captureOwnedProcessGroup,
  stopOwnedProcessGroup,
} from "../scripts/live/process-group";
import { down, launch, type Session } from "../scripts/live/core";
import {
  processIdentity,
  signalSameProcess,
} from "../src/update/desktop/process-identity";

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error("Fixture readiness timed out");
    await Bun.sleep(10);
  }
}
async function fixture(delay = 150) {
  const root = tmpDir(),
    receipt = join(tmpDir(), "stopped");
  for (const dir of ["repo", "logs", "evidence"]) mkdirSync(join(root, dir));
  const session: Session = {
    id: "owned-cleanup",
    root,
    port: 1,
    pid: 1,
    createdAt: "fixture",
  };
  session.pid = launch(
    session,
    [
      process.execPath,
      join(import.meta.dir, "fixtures/live/cleanup-process-tree.ts"),
      "service",
      root,
      receipt,
      String(delay),
    ],
    "fixture.log",
  );
  await until(
    () =>
      existsSync(join(root, "ready.json")) && existsSync(receipt + ".ready"),
  );
  const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));
  session.port = ready.port;
  session.serviceIdentity = processIdentity(session.pid)!;
  session.serviceGroup = captureOwnedProcessGroup(
    session.pid,
    session.serviceIdentity,
  );
  const child = processIdentity(ready.child)!;
  return { session, receipt, child };
}

test("down waits for the owned history-like descendant before removing its writable tree", async () => {
  const f = await fixture();
  try {
    await down(f.session);
    expect(existsSync(f.receipt)).toBe(true);
    expect(existsSync(f.session.root)).toBe(false);
    await Bun.sleep(200);
    expect(existsSync(f.session.root)).toBe(false);
    await down(f.session); // Completed removal is idempotent without signaling reused PIDs.
  } finally {
    signalSameProcess(f.child, "SIGKILL");
    if (f.session.serviceIdentity)
      signalSameProcess(f.session.serviceIdentity, "SIGKILL");
  }
}, 10000);

test("keep then repeated down preserves evidence and removes only after descendants stop", async () => {
  const f = await fixture();
  try {
    await down(f.session, true);
    expect(existsSync(f.receipt)).toBe(true);
    expect(existsSync(f.session.root)).toBe(true);
    const retained = JSON.parse(
      readFileSync(join(f.session.root, "session.json"), "utf8"),
    ) as Session;
    expect(retained.serviceGroup?.stopped).toBe(true);
    await down(retained, true);
    await down(retained);
    expect(existsSync(f.session.root)).toBe(false);
  } finally {
    signalSameProcess(f.child, "SIGKILL");
  }
}, 10000);

test("changed birth identity and a nonleader PID cannot authorize any group signal", async () => {
  const f = await fixture();
  try {
    const group = f.session.serviceGroup!;
    await expect(
      stopOwnedProcessGroup({ leader: { ...group.leader, birth: "reused" } }),
    ).rejects.toThrow("identity changed");
    expect(() => captureOwnedProcessGroup(f.child.pid, f.child)).toThrow(
      "detached process-group identity",
    );
    await expect(stopOwnedProcessGroup({ leader: f.child })).rejects.toThrow(
      "identity changed",
    );
    expect(existsSync(f.receipt)).toBe(false);
    expect(processIdentity(f.session.pid)).toEqual(group.leader);
    expect(existsSync(f.session.root)).toBe(true);
    await down(f.session);
  } finally {
    signalSameProcess(f.child, "SIGKILL");
    signalSameProcess(f.session.serviceIdentity!, "SIGKILL");
  }
}, 10000);

test("an already gone leader with live descendants preserves the sandbox without signaling them", async () => {
  const f = await fixture();
  try {
    signalSameProcess(f.session.serviceIdentity!, "SIGTERM");
    await until(() => !processIdentity(f.session.pid));
    await expect(down(f.session)).rejects.toThrow("leader is gone");
    expect(existsSync(f.receipt)).toBe(false);
    expect(processIdentity(f.child.pid)).toEqual(f.child);
    expect(existsSync(f.session.root)).toBe(true);
    signalSameProcess(f.child, "SIGTERM");
    await until(() => existsSync(f.receipt));
    await down(f.session); // A gone, now-quiescent group is safe without another signal.
    expect(existsSync(f.session.root)).toBe(false);
  } finally {
    signalSameProcess(f.child, "SIGKILL");
  }
}, 10000);

test("a descendant that exceeds the teardown deadline keeps its tree for inspection", async () => {
  const f = await fixture(10000);
  try {
    await expect(down(f.session)).rejects.toThrow("did not stop");
    expect(existsSync(f.session.root)).toBe(true);
    expect(processIdentity(f.child.pid)).toEqual(f.child);
    expect(f.session.serviceGroup!.stopped).toBeUndefined();
  } finally {
    signalSameProcess(f.child, "SIGKILL");
  }
}, 10000);

test("missing ownership metadata refuses teardown and leaves unrelated groups untouched", async () => {
  const f = await fixture(),
    sentinel = await fixture();
  try {
    const group = f.session.serviceGroup;
    delete f.session.serviceGroup;
    await expect(down(f.session)).rejects.toThrow(
      "no verified process-group identity",
    );
    expect(existsSync(f.session.root)).toBe(true);
    f.session.serviceGroup = group;
    await down(f.session);
    expect(existsSync(sentinel.receipt)).toBe(false);
    expect(processIdentity(sentinel.session.pid)).toEqual(
      sentinel.session.serviceIdentity!,
    );
    await down(sentinel.session);
  } finally {
    for (const value of [f, sentinel]) {
      signalSameProcess(value.child, "SIGKILL");
      signalSameProcess(value.session.serviceIdentity!, "SIGKILL");
    }
  }
}, 10000);

for (const failedCapture of [1, 2]) {
  test(`startup capture failure ${failedCapture} retains every launched PID and refuses later deletion`, async () => {
    const base = tmpDir(),
      bin = tmpDir(),
      count = join(bin, "count");
    const countFile = "'" + count.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/sh
if [ "$*" = '-A -o pid=,pgid=,stat=' ]; then
  count=0
  [ ! -f ${countFile} ] || read -r count < ${countFile}
  count=$((count+1))
  echo "$count" > ${countFile}
  if [ "$count" = "${failedCapture}" ]${failedCapture === 2 ? ' || [ "$count" = "3" ]' : ""}; then
    tries=0
    while [ ! -f ${"'" + join(base, "capture-failure", `${failedCapture === 1 ? "service" : "proxy"}-ready.json`).replaceAll("'", "'\"'\"'") + "'"} ]; do
      tries=$((tries+1))
      [ "$tries" -lt 500 ] || exit 8
      sleep 0.01
    done
    exit 9
  fi
fi
exec /bin/ps "$@"
`,
      { mode: 0o700 },
    );
    // Fresh Bun process: executable resolution uses its startup PATH.
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/live/cleanup-startup.ts"),
        base,
        "capture",
        failedCapture === 1 ? "service" : "proxy",
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const observed = JSON.parse(stdout);
    expect(observed.startupError).toContain("process groups");
    expect(observed.session.pid).toBeGreaterThan(1);
    if (failedCapture === 2)
      expect(observed.session.proxyPid).toBeGreaterThan(1);
    expect(observed.evidence).toContain("verified leader only");
    expect(observed.leaderStopped).toBe(true);
    expect(observed.descendantAlive).toBe(true);
    expect(observed.descendantGroup).toBe(
      failedCapture === 1 ? observed.session.pid : observed.session.proxyPid,
    );
    expect(observed.downError).toContain("no verified process-group identity");
    expect(observed.rootExists).toBe(true);
    if (failedCapture === 2) {
      expect(observed.evidence).toContain("service startup cleanup failed");
      expect(observed.aggregate).toBe(true);
      expect(observed.startupError).toContain("cleanup incomplete");
      expect(observed.errors.length).toBeGreaterThanOrEqual(2);
      expect(
        observed.errors.some((error: string) =>
          error.includes("process groups"),
        ),
      ).toBe(true);
    }
  }, 15000);
}

for (const role of ["service", "proxy"]) {
  test(`the ${role} PID is persisted before a failed birth-identity read`, async () => {
    const base = tmpDir();
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/live/cleanup-startup.ts"),
        base,
        "identity",
        role,
      ],
      {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const observed = JSON.parse(stdout);
    expect(observed.observedIdentityPid).toBeGreaterThan(1);
    expect(observed.persistedAtIdentity).toBe(observed.observedIdentityPid);
    expect(observed.aggregate).toBe(true);
    expect(observed.startupError).toContain("cleanup incomplete");
    expect(observed.rootExists).toBe(true);
  }, 15000);
}
