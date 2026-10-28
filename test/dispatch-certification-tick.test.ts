import { expect, test, describe } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { registerJobDaemon, startJob } from "../src/jobs/registry";
import { createTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import type { Strategy } from "../src/config/strategy";
import type { CertificateStatus } from "../src/dispatch/enforcement";
import type { Status } from "../src/engine/status";

// Import the module under test
import { BACKOFF_MAX_S, MAX_COST_PCT, MAX_REPO_SWITCHES, tick, readScheduleState, writeScheduleState, type TickDeps } from "../src/dispatch/certification-schedule";

/**
 * Set up ctx.which and ctx.run so resolveEnforcementTarget works.
 * Returns a repo path that can be used.
 */
function setupEnforcementContext(ctx: Ctx): string {
  // Create a fake claude binary
  const binary = join(ctx.home, "claude");
  writeFileSync(binary, "#!/usr/bin/env echo fake claude");

  // Make ctx.which find it
  const originalWhich = ctx.which;
  ctx.which = (name: string) => {
    if (name === "claude") return binary;
    return originalWhich(name);
  };

  // Make ctx.run return a plausible version
  const originalRun = ctx.run;
  ctx.run = async (argv: string[], timeoutMs: number, options?: { env?: Record<string, string | undefined>; stdin?: string; stdinUntilResponseId?: number }) => {
    if (argv[0] === binary) {
      return { code: 0, stdout: "2.1.281 (Claude Code)\n", stderr: "" };
    }
    return originalRun(argv, timeoutMs, options);
  };

  // Use a temp dir as repo (no .claude/settings.local.json)
  const repo = tmpDir();
  return repo;
}

function writeStrategyYaml(ctx: Ctx, extra: string = "", probe: "ask" | "auto" | "off" = "auto"): void {
  const strategyPath = join(ctx.pacerHome, "strategy.yaml");
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(strategyPath, `
planner: claude-code
providers:
  claude-code: {}
routing:
  - default: [claude-code]
pacing:
  planner_probe: ${probe}
${extra}
`);
}

interface TestStatusOptions {
  usedPct: number | null;
  stale?: boolean;
  accountMissing?: boolean;
}

function testStatus(options: TestStatusOptions): Status {
  const { usedPct, stale = false, accountMissing = false } = options;
  return {
    generatedAt: Date.now() / 1000,
    strategy: "test",
    planner: "claude-code",
    mode: "normal",
    disabled: false,
    calendarPace: false,
    providers: [],
    executors: { ranked: [], excluded: [] },
    accounts: accountMissing ? [] : [
      {
        name: "claude-code",
        kind: "claude",
        verdict: "OK",
        usedPct,
        pacePct: null,
        resetsAt: null,
        window: null,
        stale,
        source: null,
        capturedAt: null,
        runners: ["claude-code"],
        spendUsd: null,
      },
    ],
  } as Status;
}

function certifiedStatus(): CertificateStatus {
  return { state: "certified", probedAt: Date.now() / 1000, expiresAt: Date.now() / 1000 + 86400 };
}

function uncertifiedStatus(): CertificateStatus {
  return { state: "uncertified", reason: "not verified" };
}

describe("certification tick", () => {
  test("without a repo override the probe receives the second repository where managed work runs", async () => {
    const ctx = fakeCtx();
    const first = realpathSync(setupEnforcementContext(ctx));
    const working = realpathSync(tmpDir());
    mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
    writeFileSync(join(ctx.pacerHome, "state", "repos.json"), JSON.stringify({
      [first]: { path: first, key: "local:first", lastUsed: ctx.now },
      [working]: { path: working, key: "local:working", lastUsed: ctx.now - 1 },
    }));
    createTask(ctx, { brief: { goal: "fixture", repo: working }, kind: null, requestedExecutor: null, timeoutS: 60 });
    writeStrategyYaml(ctx);
    const probedRepos: string[] = [];
    const deps: TickDeps = {
      probe: async (_ctx, _strategy, _runner, repo) => {
        probedRepos.push(repo);
        return certifiedStatus();
      },
      status: async () => testStatus({ usedPct: 40 }),
    };

    await tick(ctx, deps);

    expect(probedRepos).toEqual([working]);
  });

  test("starts a probe job when the decision says to", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let probeCalled = false;

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40 }); // 40% used = 60% headroom > 25% reserve
      },
    };

    await tick(ctx, deps);

    expect(probeCalled).toBe(true);
  });

  test("records cost as the observed usage delta", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let beforeUsed = 40;
    let afterUsed = 43;

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        // Return beforeUsed first call, afterUsed second call
        const used = beforeUsed;
        beforeUsed = afterUsed;
        return testStatus({ usedPct: used });
      },
    };

    await tick(ctx, deps);

    // Check that lastCostPct is 3 (43 - 40)
    const state = readScheduleState(ctx);
    const attempts = Object.values(state.attempts);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0].lastCostPct).toBe(3);
  });

  for (const certified of [true, false]) {
    test(`an over-ceiling tick retries after the pause (certified=${certified})`, async () => {
      const ctx = fakeCtx();
      const repo = setupEnforcementContext(ctx);
      writeStrategyYaml(ctx);
      let probes = 0;
      let readings = 0;
      const deps: TickDeps = {
        repo,
        probe: async () => { probes++; return certified ? certifiedStatus() : uncertifiedStatus(); },
        status: async () => testStatus({ usedPct: readings++ % 2 === 0 ? 40 : 40 + MAX_COST_PCT + 1 }),
      };
      await tick(ctx, deps);
      const record = Object.values(readScheduleState(ctx).attempts)[0];
      expect(record.nextEligibleAt).toBeGreaterThanOrEqual(ctx.now + BACKOFF_MAX_S);
      await tick({ ...ctx, now: record.nextEligibleAt - 1 }, deps);
      expect(probes).toBe(1);
      await tick({ ...ctx, now: record.nextEligibleAt }, deps);
      expect(probes).toBe(2);
    });
  }

  test("repository switching retries after its pause through tick", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let probes = 0;
    const deps: TickDeps = {
      repo,
      probe: async () => { probes++; return uncertifiedStatus(); },
      status: async () => testStatus({ usedPct: 40 }),
    };
    await tick(ctx, deps);
    const state = readScheduleState(ctx);
    const key = Object.keys(state.attempts)[0];
    state.attempts[key].repoSwitches = MAX_REPO_SWITCHES - 1;
    writeScheduleState(ctx, state);
    const switched = { ...deps, repo: tmpDir() };
    const retryAt = state.attempts[key].nextEligibleAt;
    await tick({ ...ctx, now: retryAt }, switched);
    expect(probes).toBe(2);
    expect(readScheduleState(ctx).attempts[key].nextEligibleAt).toBe(retryAt + BACKOFF_MAX_S);
    await tick({ ...ctx, now: retryAt + BACKOFF_MAX_S - 1 }, switched);
    expect(probes).toBe(2);
    await tick({ ...ctx, now: retryAt + BACKOFF_MAX_S }, switched);
    expect(probes).toBe(3);
  });

  test("does nothing when the decision declines", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    // Write strategy with planner_probe: off
    writeStrategyYaml(ctx, `
pacing:
  planner_probe: off
`);
    let probeCalled = false;

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40 });
      },
    };

    await tick(ctx, deps);

    expect(probeCalled).toBe(false);
  });

  test("a failed probe increments backoff", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        return uncertifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40 });
      },
    };

    await tick(ctx, deps);

    const state = readScheduleState(ctx);
    const attempts = Object.values(state.attempts);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0].failures).toBe(1);
  });

  test("returns instead of hanging when the probe throws", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => { throw new Error("launch failed"); },
      status: async (): Promise<Status> => testStatus({ usedPct: 40 }),
    };

    // A thrown probe must still settle the completion the tick awaits, or the
    // service's re-entrancy flag stays set and certification stops for good.
    const stalled = Symbol("stalled");
    const raced = await Promise.race([
      tick(ctx, deps).then(() => "returned"),
      new Promise(resolve => setTimeout(() => resolve(stalled), 2000)),
    ]);
    expect(raced).toBe("returned");
    expect(Object.values(readScheduleState(ctx).attempts)[0]?.failures).toBe(1);
  });

  test("a consent answer given during a probe is not reverted by the probe's own write", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {} });

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        // Stands in for the consent op running while the probe is in flight.
        const live = readScheduleState(ctx);
        writeScheduleState(ctx, { ...live, consent: { ...live.consent, "claude-code": "declined" } });
        return uncertifiedStatus();
      },
      status: async (): Promise<Status> => testStatus({ usedPct: 40 }),
    };

    await tick(ctx, deps);

    const after = readScheduleState(ctx);
    expect(after.consent["claude-code"]).toBe("declined");
    expect(Object.values(after.attempts)[0]?.failures).toBe(1);
  });

  test("charges the probe against the daily ceiling even if everything after it fails", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => certifiedStatus(),
      // Succeeds for the pre-probe headroom read, then fails on the post-probe
      // cost read: a crash, restart or rejection once the quota is already spent.
      status: (() => {
        let calls = 0;
        return async (): Promise<Status> => {
          if (++calls > 1) throw new Error("status unavailable");
          return testStatus({ usedPct: 40 });
        };
      })(),
    };

    await tick(ctx, deps);

    const record = Object.values(readScheduleState(ctx).attempts)[0];
    expect(record?.probesToday).toBe(1);
    expect(record?.nextEligibleAt).toBeGreaterThan(0);
  });

  test("returns instead of stalling when the probe job was started by someone else", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    // A daemon makes startJob return without awaiting, which is the shape the
    // service runs in and the only way to hold a job open here.
    const unregister = registerJobDaemon(ctx);
    // A job already running for this target: startJob returns it and never runs
    // our callback, so nothing would settle the deferred.
    await startJob(ctx, "enforcement.probe", `claude-code:${repo}`, ["Probe native child control"],
      () => new Promise<void>(() => {}));

    let probeCalled = false;
    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => { probeCalled = true; return certifiedStatus(); },
      status: async (): Promise<Status> => testStatus({ usedPct: 40 }),
    };

    const stalled = Symbol("stalled");
    const raced = await Promise.race([
      tick(ctx, deps).then(() => "returned"),
      new Promise(resolve => setTimeout(() => resolve(stalled), 3000)),
    ]);
    expect(raced).toBe("returned");
    expect(probeCalled).toBe(false);
    unregister();
  });

  test("tick works in the shape the service runs: a job daemon is registered", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    const unregister = registerJobDaemon(ctx);
    try {
      const deps: TickDeps = {
        repo,
        probe: async (): Promise<CertificateStatus> => certifiedStatus(),
        status: async (): Promise<Status> => testStatus({ usedPct: 40 }),
      };
      await tick(ctx, deps);
      const record = Object.values(readScheduleState(ctx).attempts)[0];
      expect(record?.probesToday).toBe(1);
      expect(record?.failures).toBe(0);
    } finally { unregister(); }
  });

  test("with probing off, neither the target nor status is resolved", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, "", "off");
    let statusCalled = false;
    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => certifiedStatus(),
      status: async (): Promise<Status> => { statusCalled = true; return testStatus({ usedPct: 40 }); },
    };
    await tick(ctx, deps);
    expect(statusCalled).toBe(false);
  });

  test("never throws when the strategy is missing", async () => {
    const ctx = fakeCtx();
    // Note: no strategy file written
    let probeCalled = false;

    const deps: TickDeps = {
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40 });
      },
    };

    // Should not throw even with no strategy file
    await tick(ctx, deps);

    expect(probeCalled).toBe(false);
  });

  test("an already-running job is not a failure", async () => {
    const { startJob } = await import("../src/jobs/registry");
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let firstProbeStarted = false;
    let secondProbeCalled = false;

    // Start a job first that will be detected as running
    const jobPromise = startJob(
      ctx,
      "enforcement.probe",
      `claude-code:${repo}`,
      ["Test step"],
      async (step) => {
        firstProbeStarted = true;
        // Wait a bit so the second tick can detect this as running
        await Bun.sleep(50);
        step.pass("Test step", "done");
      },
    );

    // Run tick while the job above is still running
    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        secondProbeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40 });
      },
    };

    await tick(ctx, deps);

    // Wait for first job to complete
    await jobPromise;

    // Second probe should NOT have been called (dedupe)
    expect(secondProbeCalled).toBe(false);
    expect(firstProbeStarted).toBe(true);

    // Most importantly: backoff counter should NOT have increased
    const state = readScheduleState(ctx);
    const attempts = Object.values(state.attempts);
    // A probe we did not run leaves no trace: no charge, no backoff.
    expect(attempts.length).toBe(0);
  });

  test("no registered repository means no probe", async () => {
    const ctx = fakeCtx();
    // Stub the agent binary so every later gate would pass: a decline can then
    // only come from there being no registered repository, not from this
    // checkout's own control files or a missing claude binary.
    setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let probeCalled = false;
    let statusCalled = false;

    const deps: TickDeps = {
      // Do NOT provide repo: tick will call scheduledRepo which returns null
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        statusCalled = true;
        return testStatus({ usedPct: 40 });
      },
    };

    await tick(ctx, deps);

    // tick returned before buying a status reading, so it never had a repository.
    expect(statusCalled).toBe(false);
    expect(probeCalled).toBe(false);
  });

  test("a stale planner account reading means no probe", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let probeCalled = false;

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40, stale: true });
      },
    };

    await tick(ctx, deps);

    // Stale reading should be treated as unknown headroom → no probe
    expect(probeCalled).toBe(false);
  });

  test("a fresh planner account reading still probes", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let probeCalled = false;

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40, stale: false });
      },
    };

    await tick(ctx, deps);

    expect(probeCalled).toBe(true);
  });

  test("an unknown account yields no probe", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let probeCalled = false;

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: 40, accountMissing: true });
      },
    };

    await tick(ctx, deps);

    // Unknown account → null usedPct → unknown headroom → no probe
    expect(probeCalled).toBe(false);
  });

  test("a null usedPct yields no probe", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);
    let probeCalled = false;

    const deps: TickDeps = {
      repo,
      probe: async (): Promise<CertificateStatus> => {
        probeCalled = true;
        return certifiedStatus();
      },
      status: async (): Promise<Status> => {
        return testStatus({ usedPct: null });
      },
    };

    await tick(ctx, deps);

    // Null usedPct → unknown headroom → no probe
    expect(probeCalled).toBe(false);
  });
});

// Pin the release note and terminology requested alongside the schedule regressions.
test("scheduled repository repair has an Unreleased Fixed note and current tick terminology", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const unreleased = changelog.split("## [Unreleased]\n")[1]?.split("\n## [")[0];
  const fixed = unreleased?.split("### Fixed\n")[1];
  expect(fixed).toContain("Scheduled certification follows the repository where managed work runs rather than the one most recently viewed");
  expect(fixed).toContain("the Dispatcher row names it by its repository picker label");
  const source = readFileSync(import.meta.path, "utf8");
  expect(source).toMatch(/\/\/ Do NOT provide repo: tick will call scheduledRepo which returns null/);
});
