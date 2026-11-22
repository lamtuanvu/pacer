// Round-6 I3: real production opt-in for orchestrate grant (no local lambda).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask } from "../src/tasks/store";
import { planOwnedLaunch } from "../src/plugins/executor-launch-plan";
import { loadStrategy } from "../src/config/strategy";
import { validateExecution } from "../src/config/execution";
import { makeOrcaBackend } from "../src/plugins/executor-orca";

const NOW = 1_700_000_000;

function writePlanner(ctx: { pacerHome: string }): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\nexecution:\n  backend: direct\n");
}

describe("round-6 I3: real orchestrate grant opt-in sites", () => {
  test("planOwnedLaunch opts in role+prg_ only for kind orchestrate", async () => {
    const bin = tmpDir();
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
    const ctx = fakeCtx({ now: NOW, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } });
    writePlanner(ctx);
    const grant = `prg_${"c".repeat(64)}`;
    const repo = tmpDir();
    const strategy = loadStrategy(ctx);
    const cfg = { ...strategy.providers["claude-code"]!, session: "headless" as const };
    const withGrant = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } };

    const orch = createTask(ctx, {
      brief: { goal: "orch", repo }, kind: "orchestrate", requestedExecutor: null, timeoutS: 60,
    });
    const orchPlan = await planOwnedLaunch(withGrant, {
      cfg, task: orch, execution: validateExecution(undefined), placement: "current",
      workdir: repo, dir: tmpDir(), brief: "orch", repoRoots: [repo],
    });
    expect("refused" in orchPlan).toBe(false);
    if ("refused" in orchPlan) throw new Error(orchPlan.refused);
    expect(orchPlan.env.PACER_ROLE).toBe("orchestrator");
    expect(orchPlan.env.PACER_RUN_GRANT).toBe(grant);

    const plain = createTask(ctx, {
      brief: { goal: "plain", repo }, kind: "research", requestedExecutor: null, timeoutS: 60,
    });
    const plainPlan = await planOwnedLaunch(withGrant, {
      cfg, task: plain, execution: validateExecution(undefined), placement: "current",
      workdir: repo, dir: tmpDir(), brief: "plain", repoRoots: [repo],
    });
    expect("refused" in plainPlan).toBe(false);
    if ("refused" in plainPlan) throw new Error(plainPlan.refused);
    expect(plainPlan.env.PACER_ROLE).toBe("executor");
    expect(plainPlan.env.PACER_RUN_GRANT).toBeUndefined();
  });

  test("Orca fallback refuses orchestrate/run-grant without placing prg_ in the call", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const grant = `prg_${"d".repeat(64)}`;
    const calls: unknown[] = [];
    const stubOutcome = {
      exec: { code: 1, stdout: "", stderr: "stub", timedOut: false },
      report: "stub-direct",
      attempt: {
        executor: "claude-code", model: "x", startedAt: NOW, endedAt: NOW,
        exitCode: 1, timedOut: false, limitHit: false, log: "",
      },
    };
    let directCalls = 0;
    const backend = makeOrcaBackend(
      {
        loadExecution: () => ({ localMaxTasks: 2, backend: "orca" } as never),
        sleep: async () => {},
        direct: async () => {
          directCalls++;
          return stubOutcome as never;
        },
      },
      {
        call: async (_c, _p, method, params) => {
          calls.push({ method, params });
          throw new Error("orca must not be called with a run grant");
        },
      },
    );
    const orch = createTask(ctx, {
      brief: { goal: "orch", repo: tmpDir() }, kind: "orchestrate",
      requestedExecutor: "claude-code", timeoutS: 60,
    });
    const outcome = await backend.runAttempt(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } },
      { id: "claude-code", model: "x", via: "cli" } as never,
      orch,
    );
    expect(calls).toEqual([]);
    expect(directCalls).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain(grant);
    const fb = JSON.parse(readFileSync(join(ctx.pacerHome, "orca", "fallback.json"), "utf8")) as { reason: string };
    expect(fb.reason).toMatch(/orchestrator run grant cannot be placed/i);

    // Research without a run grant must not use the orchestrator-grant fallback reason.
    const plainCtx = fakeCtx({ now: NOW });
    writePlanner(plainCtx);
    const plain = createTask(plainCtx, {
      brief: { goal: "plain", repo: tmpDir() }, kind: "research",
      requestedExecutor: "claude-code", timeoutS: 60,
    });
    const plainBackend = makeOrcaBackend(
      {
        loadExecution: () => ({ localMaxTasks: 2, backend: "orca" } as never),
        sleep: async () => {},
        direct: async () => stubOutcome as never,
      },
      {
        call: async () => {
          throw new Error("orca-called-for-plain");
        },
      },
    );
    await plainBackend.runAttempt(
      plainCtx,
      { id: "claude-code", model: "x", via: "cli" } as never,
      plain,
    );
    try {
      const plainFb = JSON.parse(
        readFileSync(join(plainCtx.pacerHome, "orca", "fallback.json"), "utf8"),
      ) as { reason: string };
      expect(plainFb.reason).not.toMatch(/orchestrator run grant/i);
    } catch (e) {
      // No fallback.json: Orca was attempted (or refused differently) — also fine.
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

});
