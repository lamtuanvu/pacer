import { expect, test, describe } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { OPS } from "../src/api/ops";
import {
  readScheduleState,
  writeScheduleState,
  BACKOFF_MAX_S,
  type ScheduleState,
} from "../src/dispatch/certification-schedule";

function setupEnforcementContext(ctx: Ctx): string {
  const binary = join(ctx.home, "claude");
  writeFileSync(binary, "#!/usr/bin/env echo fake claude");

  const originalWhich = ctx.which;
  ctx.which = (name: string) => {
    if (name === "claude") return binary;
    return originalWhich(name);
  };

  const originalRun = ctx.run;
  ctx.run = async (argv: string[], timeoutMs: number, options?: { env?: Record<string, string | undefined>; stdin?: string; stdinUntilResponseId?: number }) => {
    if (argv[0] === binary) {
      return { code: 0, stdout: "2.1.281 (Claude Code)\n", stderr: "" };
    }
    return originalRun(argv, timeoutMs, options);
  };

  const repo = tmpDir();
  return repo;
}

function writeStrategyYaml(ctx: Ctx, pacing: string = ""): void {
  const strategyPath = join(ctx.pacerHome, "strategy.yaml");
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(strategyPath, `
planner: claude-code
providers:
  claude-code: {}
routing:
  - default: [claude-code]
${pacing}
`);
}

interface DiagnosticsRunnerRow {
  runner: string;
  account: string;
  agent: string;
  version: string | null;
  probeSupported: boolean;
  unsupportedReason: string | null;
  state: string;
  reason?: string;
  probedAt?: number;
  expiresAt?: number;
  lastProbedAt: number | null;
  nextEligibleAt: number;
  probesToday: number;
  lastCostPct: number | null;
  consent: string;
}

interface DiagnosticsResult {
  repo: string;
  scope: string;
  runners: DiagnosticsRunnerRow[];
}

interface DoctorCheck {
  name: string;
  level: string;
  detail: string;
}

describe("consent op", () => {
  test("consent op records an answer per account", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);

    // Initially no consent
    const before = readScheduleState(ctx);
    expect(before.consent["claude-code"]).toBeUndefined();

    // Record granted consent for claude-code
    const consentOp = OPS["dispatch.enforcement.consent"];
    expect(consentOp).toBeDefined();

    await consentOp.handler(ctx, { account: "claude-code", granted: true }, {});

    const afterGrant = readScheduleState(ctx);
    expect(afterGrant.consent["claude-code"]).toBe("granted");

    // Record declined consent for another account
    await consentOp.handler(ctx, { account: "codex-account", granted: false }, {});

    const afterDecline = readScheduleState(ctx);
    expect(afterDecline.consent["claude-code"]).toBe("granted");
    expect(afterDecline.consent["codex-account"]).toBe("declined");

    // Overwrite consent: granted -> declined
    await consentOp.handler(ctx, { account: "claude-code", granted: false }, {});

    const afterOverwrite = readScheduleState(ctx);
    expect(afterOverwrite.consent["claude-code"]).toBe("declined");
  });
});

describe("enforcement diagnostics schedule fields", () => {
  test("diagnostics report the next scheduled probe and measured cost", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, `
pacing:
  planner_probe: auto
`);

    // Seed state with schedule data
    const now = ctx.now;
    const state: ScheduleState = {
      consent: { "claude-code": "granted" },
      attempts: {},
    };

    // Create an attempt record with all the schedule fields
    // The key is JSON.stringify([runner, account, launchMode])
    const key = JSON.stringify(["claude-code", "claude-code", "headless"]);
    state.attempts[key] = {
      failures: 0,
      nextEligibleAt: now + 1000,
      lastRepo: repo,
      repoSwitches: 0,
      dayStartedAt: now - 3600,
      probesToday: 1,
      lastCostPct: 2.3,
    };
    writeScheduleState(ctx, state);

    const diagnosticsOp = OPS["dispatch.enforcement"];
    const result = await diagnosticsOp.handler(ctx, { repo }, {}) as DiagnosticsResult;

    // Check that the runner row has schedule fields
    expect(result).toHaveProperty("runners");
    expect(Array.isArray(result.runners)).toBe(true);

    const runnerRow = result.runners.find((r) => r.runner === "claude-code");
    expect(runnerRow).toBeDefined();

    // These fields should be added by Task 4
    expect(runnerRow).toHaveProperty("nextEligibleAt");
    expect(runnerRow!.nextEligibleAt).toBe(now + 1000);
    expect(runnerRow).toHaveProperty("probesToday");
    expect(runnerRow!.probesToday).toBe(1);
    expect(runnerRow).toHaveProperty("lastCostPct");
    expect(runnerRow!.lastCostPct).toBe(2.3);
    expect(runnerRow).toHaveProperty("consent");
    expect(runnerRow!.consent).toBe("granted");
  });

  test("diagnostics distinguish declined consent from not yet asked", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);

    // Test 1: No consent recorded yet
    writeStrategyYaml(ctx, `
pacing:
  planner_probe: ask
`);

    const diagnosticsOp = OPS["dispatch.enforcement"];
    let result = await diagnosticsOp.handler(ctx, { repo }, {}) as DiagnosticsResult;
    let runnerRow = result.runners.find((r) => r.runner === "claude-code");

    // "not yet asked" should be a distinct value from both "granted" and "declined"
    expect(runnerRow!.consent).toBe("unasked");

    // Test 2: Declined consent
    writeScheduleState(ctx, {
      consent: { "claude-code": "declined" },
      attempts: {},
    });

    result = await diagnosticsOp.handler(ctx, { repo }, {}) as DiagnosticsResult;
    runnerRow = result.runners.find((r) => r.runner === "claude-code");

    expect(runnerRow!.consent).toBe("declined");

    // Test 3: Granted consent
    writeScheduleState(ctx, {
      consent: { "claude-code": "granted" },
      attempts: {},
    });

    result = await diagnosticsOp.handler(ctx, { repo }, {}) as DiagnosticsResult;
    runnerRow = result.runners.find((r) => r.runner === "claude-code");

    expect(runnerRow!.consent).toBe("granted");
  });

  test("diagnostics include unsupportedReason when present", async () => {
    // Create a repo with a project-level control file to trigger unsupportedReason
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx);

    // Add a project-level control file that triggers probeSupportReason
    const claudeDir = join(repo, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{}");

    const diagnosticsOp = OPS["dispatch.enforcement"];
    const result = await diagnosticsOp.handler(ctx, { repo }, {}) as DiagnosticsResult;
    const runnerRow = result.runners.find((r) => r.runner === "claude-code");

    expect(runnerRow).toBeDefined();
    expect(runnerRow!.unsupportedReason).toBeDefined();
    expect(typeof runnerRow!.unsupportedReason).toBe("string");
    expect(runnerRow!.unsupportedReason).toContain("Project");
    expect(runnerRow!.probeSupported).toBe(false);
  });
});

describe("doctor check - enforcement probe schedule", () => {
  async function runDoctorWithStrategy(ctx: Ctx): Promise<DoctorCheck[]> {
    const { runDoctor } = await import("../src/install/doctor");
    return runDoctor(ctx, {
      status: async () => ({
        generatedAt: ctx.now,
        strategy: "test",
        planner: "claude-code",
        mode: "normal",
        disabled: false,
        calendarPace: false,
        providers: [],
        executors: { ranked: [], excluded: [] },
      }),
    }) as Promise<DoctorCheck[]>;
  }

  test("doctor reports probe mode off with its reason (info level, not warn)", async () => {
    const ctx = fakeCtx();
    setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, `
pacing:
  planner_probe: off
`);

    const checks = await runDoctorWithStrategy(ctx);
    const scheduleCheck = checks.find(c => c.name === "Enforcement probe schedule");

    expect(scheduleCheck).toBeDefined();
    // mode:off is a choice, not a fault - should be info, not warn
    expect(scheduleCheck!.level).toBe("info");
    expect(scheduleCheck!.detail).toContain("off");
  });

  test("doctor warns when consent was declined", async () => {
    const ctx = fakeCtx();
    setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, `
pacing:
  planner_probe: ask
`);

    writeScheduleState(ctx, {
      consent: { "claude-code": "declined" },
      attempts: {},
    });

    const checks = await runDoctorWithStrategy(ctx);
    const scheduleCheck = checks.find(c => c.name === "Enforcement probe schedule");

    expect(scheduleCheck).toBeDefined();
    expect(scheduleCheck!.level).toBe("warn");
    expect(scheduleCheck!.detail).toContain("declined");
  });

  test("doctor warns when backoff has reached BACKOFF_MAX_S", async () => {
    const ctx = fakeCtx();
    setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, `
pacing:
  planner_probe: auto
`);

    // Key matches enforcementKey: JSON.stringify([runner, account, launchMode])
    const key = JSON.stringify(["claude-code", "claude-code", "headless"]);

    // Manually construct a state where nextEligibleAt = now + BACKOFF_MAX_S
    // The check should detect that we're at max backoff
    const state: ScheduleState = {
      consent: { "claude-code": "granted" },
      attempts: {
        [key]: {
          failures: 10,
          nextEligibleAt: ctx.now + BACKOFF_MAX_S,
          lastRepo: "/repo",
          repoSwitches: 0,
          dayStartedAt: ctx.now - 3600,
          probesToday: 0,
          lastCostPct: null,
        },
      },
    };
    writeScheduleState(ctx, state);

    const checks = await runDoctorWithStrategy(ctx);
    const scheduleCheck = checks.find(c => c.name === "Enforcement probe schedule");

    expect(scheduleCheck).toBeDefined();
    expect(scheduleCheck!.level).toBe("warn");
  });

  test("doctor uses info level when scheduling is healthy", async () => {
    const ctx = fakeCtx();
    setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, `
pacing:
  planner_probe: auto
`);

    // Healthy state: granted consent, no max backoff
    const key = JSON.stringify(["claude-code", "claude-code", "headless"]);
    writeScheduleState(ctx, {
      consent: { "claude-code": "granted" },
      attempts: {
        [key]: {
          failures: 1,
          nextEligibleAt: ctx.now + 900, // Small backoff, not max
          lastRepo: "/repo",
          repoSwitches: 0,
          dayStartedAt: ctx.now - 3600,
          probesToday: 1,
          lastCostPct: 0.5,
        },
      },
    });

    const checks = await runDoctorWithStrategy(ctx);
    const scheduleCheck = checks.find(c => c.name === "Enforcement probe schedule");

    expect(scheduleCheck).toBeDefined();
    expect(scheduleCheck!.level).toBe("info");
  });
});
