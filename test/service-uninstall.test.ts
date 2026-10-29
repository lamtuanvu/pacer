import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serviceCli } from "../src/service/cli";
import { plist, servicePath, type ServiceDeps } from "../src/service";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { processIdentity } from "../src/update/desktop/process-identity";
import { fakeCtx, tmpDir } from "./helpers";

function installed() {
  const calls: string[][] = [];
  const ctx = fakeCtx({ now: Date.now() / 1000, env: { PATH: "/bin:/usr/bin", PACER_BIN: "/opt/pacer" }, which: () => null, run: async argv => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; } });
  const path = servicePath(ctx, "darwin"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, plist(ctx, ["/opt/pacer"]));
  const d: ServiceDeps = { platform: "darwin", uid: 501, argv: ["/opt/pacer"], tty: false };
  return { ctx, calls, path, d };
}
async function runningTask(ctx: ReturnType<typeof fakeCtx>, identity: "match" | "mismatch") {
  const child = Bun.spawn(["sleep", "30"]);
  for (let i = 0; i < 100 && !processIdentity(child.pid); i++) await Bun.sleep(20);
  const real = processIdentity(child.pid)!;
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => { x.state = "running"; x.attemptStartedAt = ctx.now; x.childPid = child.pid; x.childIdentity = identity === "match" ? real : { ...real, birth: `${real.birth}3` }; });
  return { id: t.id, child };
}

test("without a terminal, uninstall refuses while work is running and changes nothing", async () => {
  const { ctx, calls, path, d } = installed();
  const { child } = await runningTask(ctx, "match");
  try {
    expect(await serviceCli(["uninstall"], ctx, d)).toEqual({ code: 2, out: "", err: "pacer service: 1 task and 0 sessions are running. Rerun with --yes to leave them running, or --stop-work --yes to stop them." });
    expect(existsSync(path)).toBe(true);
    expect(calls).toEqual([]);
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("--yes removes the service and leaves running work alone", async () => {
  const { ctx, path, d } = installed();
  const { id, child } = await runningTask(ctx, "match");
  try {
    expect(await serviceCli(["uninstall", "--yes"], ctx, d)).toEqual({ code: 0, out: "uninstalled pacer serve", err: "" });
    expect(existsSync(path)).toBe(false);
    expect(readTask(ctx, id)?.state).toBe("running");
    expect(child.exitCode).toBeNull();
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("--stop-work stops only processes whose identity still matches", async () => {
  const { ctx, d } = installed();
  const good = await runningTask(ctx, "match"), stale = await runningTask(ctx, "mismatch");
  try {
    const r = await serviceCli(["uninstall", "--stop-work", "--yes"], ctx, d);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`uninstalled pacer serve\nstopped 1 of 2\nnot stopped ${stale.id}: its process identity could not be confirmed and no runner supervises it`);
    await good.child.exited;
    expect(good.child.signalCode).toBe("SIGTERM");
    expect(readTask(ctx, good.id)?.state).toBe("stopped");
    expect(stale.child.exitCode).toBeNull();
    expect(readTask(ctx, stale.id)?.state).toBe("running");
  } finally { good.child.kill("SIGKILL"); stale.child.kill("SIGKILL"); await Promise.all([good.child.exited, stale.child.exited]); }
});

test("in a terminal, uninstall asks and can be cancelled", async () => {
  const { ctx, path, d } = installed();
  const { child } = await runningTask(ctx, "match");
  const questions: string[] = [];
  try {
    expect(await serviceCli(["uninstall"], ctx, { ...d, tty: true, confirm: async q => { questions.push(q); return false; } })).toEqual({ code: 0, out: "uninstall cancelled", err: "" });
    expect(questions).toEqual(["1 task and 0 sessions are running. They keep running after the service is removed. Remove it? [y/N] "]);
    expect(existsSync(path)).toBe(true);
    expect((await serviceCli(["uninstall", "--bogus"], ctx, d)).code).toBe(2);
  } finally { child.kill("SIGKILL"); await child.exited; }
});
