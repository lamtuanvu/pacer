import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXECUTION } from "../src/config/execution";
import { validateStrategy } from "../src/config/strategy";
// Initialise the backend graph first: executor-orca is part of a module cycle that
// otherwise reaches backends-extra before orcaBackend is defined when this file is loaded alone.
import "../src/exec/backend";
import { makeOrcaBackend, type OrcaExecutorCaller } from "../src/plugins/executor-orca";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("a human-held interactive root never takes the Orca owned executor.run route", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-orca-held-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo");
  mkdirSync(pacerHome, { recursive: true, mode: 0o700 });
  mkdirSync(repo, { mode: 0o700 });
  const ctx = fakeCtx({ home, pacerHome });
  const task = createTask(ctx, { brief: { goal: "held", repo }, kind: null,
    requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.origin = "human"; current.source = "ui";
    current.interactive = true; current.interactionMode = "delegated";
  });
  const cfg = validateStrategy({ planner: "claude-code", providers: { codex: {} } }, "/x").providers.codex!;
  let direct = 0, ownedRunCalls = 0;
  const caller: OrcaExecutorCaller = {
    call: async (_ctx, _plugin, method) => {
      if (method === "executor.run") ownedRunCalls++;
      throw new Error("a held root must not call the Orca owned executor.run route");
    },
  };
  const backend = makeOrcaBackend({
    loadExecution: () => ({ ...DEFAULT_EXECUTION, backend: "orca" }),
    // The plain direct fallback is the held-aware supervise path.
    direct: async () => {
      direct++;
      return { exec: { code: 0, stdout: "direct", stderr: "", timedOut: false }, report: "direct",
        backend: "direct", attempt: { executor: "codex", model: null, startedAt: 1, endedAt: 2,
          exitCode: 0, timedOut: false, limitHit: false, log: join(home, "direct.log") } };
    },
  }, caller);
  try {
    const out = await backend.runAttempt(ctx, cfg, readTask(ctx, task.id)!);
    expect(out.backend).toBe("direct");
    expect(direct).toBe(1);
    expect(ownedRunCalls).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
