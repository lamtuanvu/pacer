// A session host, its hooks and `pacer report` are re-entries of the pacer CLI that inherit the agent's
// environment. A planner turn or a step worker holds a scoped grant there, which must not refuse them.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
    const refused = holder === "planner turn" ? "orchestrator role only allows" : "work grants only allow";
    for (const [argv, env] of [
      [["_session", dir], {}],
      [["_session", `socket:${join(dir, "session.sock")}`], {}],
      // The admission pair startRun hands a host names exactly one run directory.
      [["_session", dir], { PACER_ADMISSION_DIR: join(dir, "..", "2"), PACER_ADMISSION_SESSION: "lease" }],
      [["report", "--task", task.id, "--outcome", "done", "--summary", "x"], {}],
      [["report", "--task", task.id, "--outcome", "done", "--summary", "x"], { PACER_RUN_DIR: dir }],
    ] as [string[], Record<string, string>][]) {
      const result = await main(argv, { ...holding, env: { ...holding.env, ...env } });
      expect({ argv, code: result.code, err: result.err }).toEqual({ argv, code: 2, err: expect.stringContaining(refused) });
    }
    expect(readReport(dir)).toBeNull();
  });
}
