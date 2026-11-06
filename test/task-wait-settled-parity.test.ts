import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { TERMINAL_STATES, type TaskRecord } from "../src/tasks/types";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");

function rustSettled(state: string, agentChecks: boolean, agentSession: boolean) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--bin", "wait_settled_probe"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  });
  const probe = join(TARGET, "debug", "wait_settled_probe");
  const out = execFileSync(probe, [state, agentChecks ? "1" : "0", agentSession ? "1" : "0"], {
    encoding: "utf8",
  });
  return out.trim() === "true";
}

function tsSettled(task: TaskRecord, agentChecks: boolean, agentSession: boolean) {
  const terminal = TERMINAL_STATES.includes(task.state);
  return terminal && !agentChecks && !agentSession;
}

test("task_wait_settled matches taskWait poll exit predicate", () => {
  for (const state of ["running", "queued", "done", "stopped", "needs_input"] as const) {
    for (const agentChecks of [false, true]) {
      for (const agentSession of [false, true]) {
        const task = { state } as TaskRecord;
        expect(rustSettled(state, agentChecks, agentSession)).toBe(
          tsSettled(task, agentChecks, agentSession),
        );
      }
    }
  }
});
