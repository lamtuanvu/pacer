// A session host, its hooks and `pacer report` are re-entries of the pacer CLI that inherit the agent's
// environment. A planner turn or a step worker holds a scoped grant there, which must not refuse them.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { readReport } from "../src/session/reports";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const GRANTS: Record<string, Record<string, string>> = {
  "planner turn": { PACER_ROLE: "orchestrator", PACER_RUN_GRANT: "prg_fixture", PACER_RUN_ID: "run_fixture", PACER_TURN_ID: "turn_fixture" },
  "step worker": { PACER_WORK_GRANT: "pwg_fixture", PACER_ENFORCEMENT_MODE: "strict", PACER_ENFORCEMENT_TOKEN: "pet_fixture" },
};

function runningTask(session: "interactive" | "pty") {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const dir = join(ctx.pacerHome, "runs", task.id, "1");
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.run = { dir, attempt: 1, executor: "codex", startedAt: Date.now() / 1000, mode: "current",
      workdir: t.brief.repo, logFile: join(dir, "stdout"), ...(session === "interactive" ? { session } : {}) };
  });
  return { ctx, task, dir };
}

async function exited(dir: string) {
  const until = Date.now() + 20_000;
  for (;;) {
    const state = readRun(dir);
    if (state.exit !== null || (!state.alive && !existsSync(join(dir, "exit"))) || Date.now() > until) return readRun(dir);
    await Bun.sleep(50);
  }
}

const REFUSED: Record<string, string> = { "planner turn": "orchestrator role only allows", "step worker": "work grants only allow" };

for (const [holder, grant] of Object.entries(GRANTS)) {
  for (const session of ["interactive", "pty"] as const) {
    test(`the ${session} session host starts the agent of a ${holder}`, async () => {
      const { ctx, task, dir } = runningTask(session);
      startRun({ dir, argv: ["/bin/sh", "-c", "exit 3"], cwd: task.brief.repo, session,
        env: { PATH: process.env.PATH, ...grant, PACER_TASK_ID: task.id, PACER_HOME: ctx.pacerHome } });
      try {
        expect((await exited(dir)).exit).toBe(3);
      } finally { await stopRun(dir, { graceMs: 500 }); }
    }, 30_000);
  }

  test(`the interactive agent of a ${holder} can run its session hook and report its own attempt`, async () => {
    const { ctx, task, dir } = runningTask("interactive");
    const out = join(tmpDir(), "agent.log");
    const pacer = `"${process.execPath}" "${cli}"`;
    const script = [
      `echo '{"hook_event_name":"PreToolUse","tool_name":"Bash"}' | ${pacer} _session-hook "$PACER_RUN_DIR" >> "$OUT" 2>&1; echo "hook $?" >> "$OUT"`,
      `${pacer} report --task ${task.id} --outcome done --summary finished >> "$OUT" 2>&1; echo "report $?" >> "$OUT"`,
      "sleep 20",
    ].join("\n");
    startRun({ dir, argv: ["/bin/sh", "-c", script], cwd: task.brief.repo, session: "interactive",
      env: { PATH: process.env.PATH, ...grant, PACER_TASK_ID: task.id, PACER_HOME: ctx.pacerHome, PACER_RUN_DIR: dir, OUT: out } });
    try {
      // The host ends the session once the report lands.
      const state = await exited(dir);
      const log = existsSync(out) ? readFileSync(out, "utf8") : "";
      expect(log).toContain("hook 0");
      expect(readReport(dir)).toMatchObject({ status: "done", summary: "finished" });
      expect(state.exit).toBe(143);
    } finally { await stopRun(dir, { graceMs: 500 }); }
  }, 30_000);

  test(`a ${holder} still cannot open another session or report as the user`, async () => {
    const { ctx, task, dir } = runningTask("interactive");
    const holding = { ...ctx, env: { ...ctx.env, ...grant } };
    const refused = REFUSED[holder]!;
    for (const [argv, env] of [
      [["_session", dir], {}],
      [["_session", `socket:${join(dir, "session.sock")}`], {}],
      // The admission pair startRun hands a host names exactly one run directory.
      [["_session", dir], { PACER_ADMISSION_DIR: join(dir, "..", "2"), PACER_ADMISSION_SESSION: "lease" }],
      [["report", "--task", task.id, "--outcome", "done", "--summary", "x"], {}],
      [["report", "--task", task.id, "--outcome", "done", "--summary", "x"], { PACER_RUN_DIR: dir }],
      [["_session-hook", dir], {}],
      [["_session-hook", dir], { PACER_RUN_DIR: dir }],
      [["_session-hook", dir], { PACER_REPORT_TOKEN: "token" }],
    ] as [string[], Record<string, string>][]) {
      const result = await main(argv, { ...holding, env: { ...holding.env, ...env } });
      expect({ argv, code: result.code, err: result.err }).toEqual({ argv, code: 2, err: expect.stringContaining(refused) });
    }
    expect(readReport(dir)).toBeNull();
  });
}

for (const [holder, grant] of Object.entries(GRANTS)) {
  // The gate only reads variables the caller controls; these are the checks that bound what passes it.
  test(`a ${holder} cannot forge a session host, a report token or another task's report`, async () => {
    const mine = runningTask("interactive"), { ctx, task, dir } = mine;
    const other = createTask(ctx, { brief: { goal: "other", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
    const otherDir = join(ctx.pacerHome, "runs", other.id, "1");
    updateTask(ctx, other.id, t => {
      t.state = "running";
      t.run = { dir: otherDir, attempt: 1, executor: "codex", startedAt: Date.now() / 1000, mode: "current",
        workdir: t.brief.repo, logFile: join(otherDir, "stdout"), session: "interactive" };
    });
    for (const [run, token] of [[dir, "mine"], [otherDir, "theirs"]] as const) {
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, "interactive.json"), JSON.stringify({ reportToken: token }));
    }
    writeFileSync(join(dir, "session.json"), JSON.stringify({ interactive: true, argv: ["/bin/sh", "-c", "exit 0"], cwd: task.brief.repo, pacerHome: ctx.pacerHome }));
    const agent = { ...ctx, env: { ...ctx.env, ...grant, PACER_RUN_DIR: dir, PACER_REPORT_TOKEN: "mine" } };
    const report = (id: string) => ["report", "--task", id, "--outcome", "done", "--summary", "x"];
    for (const [argv, env, reason] of [
      [report(task.id), { PACER_REPORT_TOKEN: "wrong" }, "PACER_REPORT_TOKEN mismatch"],
      [report(other.id), {}, "report task id does not match"],
      [report(other.id), { PACER_RUN_DIR: otherDir }, "PACER_REPORT_TOKEN mismatch"],
      [["_session-hook", dir], { PACER_REPORT_TOKEN: "wrong" }, "PACER_REPORT_TOKEN mismatch"],
      [["_session-hook", otherDir], {}, "invalid hook destination"],
      [["_session-hook", otherDir], { PACER_RUN_DIR: otherDir }, "PACER_REPORT_TOKEN mismatch"],
    ] as [string[], Record<string, string>, string][]) {
      const result = await main(argv, { ...agent, env: { ...agent.env, ...env } });
      expect({ argv, code: result.code, err: result.err }).toEqual({ argv, code: 2, err: expect.stringContaining(reason) });
    }
    expect([readReport(dir), readReport(otherDir)]).toEqual([null, null]);
    // A made-up admission pair passes the gate and fails on the lease claim, before any run file is written.
    const forged = spawnSync(process.execPath, [cli, "_session", dir], { encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: ctx.home, PACER_HOME: ctx.pacerHome, ...grant,
        PACER_ADMISSION_DIR: dir, PACER_ADMISSION_SESSION: "made-up" } });
    expect(forged.status).toBe(2);
    expect(forged.stderr).toContain("lease");
    expect(["pid", "started", "exit"].filter(name => existsSync(join(dir, name)))).toEqual([]);
  }, 30_000);

  test(`the agent of a ${holder} gets no admission variables`, async () => {
    const { ctx, task, dir } = runningTask("interactive");
    const out = join(tmpDir(), "agent.env");
    startRun({ dir, argv: ["/bin/sh", "-c", 'env > "$OUT"'], cwd: task.brief.repo, session: "interactive",
      env: { PATH: process.env.PATH, ...grant, PACER_TASK_ID: task.id, PACER_HOME: ctx.pacerHome, PACER_RUN_DIR: dir,
        PACER_COMPLETION_NONCE: "nonce", OUT: out } });
    try {
      expect((await exited(dir)).exit).toBe(0);
      const names = readFileSync(out, "utf8").split("\n").map(line => line.split("=")[0]);
      expect(names).toContain("PACER_REPORT_TOKEN");
      expect(names.filter(name => name!.startsWith("PACER_ADMISSION_") || name === "PACER_COMPLETION_NONCE")).toEqual([]);
    } finally { await stopRun(dir, { graceMs: 500 }); }
  }, 30_000);
}
