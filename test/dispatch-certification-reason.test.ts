import { expect, test, describe } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { OPS } from "../src/api/ops";
import { enforcementProbeScheduleCheck } from "../src/install/doctor-hooks";
import { BACKOFF_MAX_S, writeScheduleState, type AttemptRecord } from "../src/dispatch/certification-schedule";

// No probe runs here: the agent binary is a stub and its only command is --version.
function setupEnforcementContext(ctx: Ctx): string {
  const binary = join(ctx.home, "claude");
  writeFileSync(binary, "#!/usr/bin/env echo fake claude");
  ctx.which = (name: string) => name === "claude" ? binary : null;
  ctx.run = async (argv: string[]) => argv[0] === binary
    ? { code: 0, stdout: "2.1.281 (Claude Code)\n", stderr: "" }
    : { code: 127, stdout: "", stderr: "not available in tests" };
  return tmpDir();
}

function writeStrategyYaml(ctx: Ctx, probe: "ask" | "auto" | "off"): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `
planner: claude-code
providers:
  claude-code: {}
routing:
  - default: [claude-code]
pacing:
  planner_probe: ${probe}
`);
}

const plannerKey = JSON.stringify(["claude-code", "claude-code", "headless"]);
/** A cost pause a minute after it was written, not at the instant it was written. */
const costPause = (now: number): AttemptRecord => ({
  failures: 0, nextEligibleAt: now + BACKOFF_MAX_S - 60, lastRepo: "/repo", repoSwitches: 0,
  dayStartedAt: now - 3600, probesToday: 1, lastCostPct: 12,
});

async function plannerRow(ctx: Ctx, repo: string): Promise<{ scheduleReason: string | null }> {
  const result = await OPS["dispatch.enforcement"].handler(ctx, { repo }, {}) as { runners: { runner: string; scheduleReason: string | null }[] };
  return result.runners.find(row => row.runner === "claude-code")!;
}

describe("diagnostics row carries the schedule's reason", () => {
  test("a schedule paused for an over-ceiling cost reports that cause", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: { [plannerKey]: costPause(ctx.now) } });
    expect((await plannerRow(ctx, repo)).scheduleReason).toBe("the last probe cost 12% of the account window");
  });

  test("with only live headroom left to check, it says so rather than guess", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {} });
    expect((await plannerRow(ctx, repo)).scheduleReason).toBe("waiting for a planner headroom reading");
  });

  test("probing turned off and a declined consent each report their own reason", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, "off");
    writeScheduleState(ctx, { consent: { "claude-code": "declined" }, attempts: { [plannerKey]: costPause(ctx.now) } });
    expect((await plannerRow(ctx, repo)).scheduleReason).toBe("certification probing is turned off");
    writeStrategyYaml(ctx, "ask");
    expect((await plannerRow(ctx, repo)).scheduleReason).toBe("certification probing was declined for claude-code");
  });
});

describe("doctor reports the planner's schedule", () => {
  test("a cost pause in effect reads warn with its cause", () => {
    const ctx = fakeCtx();
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: { [plannerKey]: costPause(ctx.now) } });
    const check = enforcementProbeScheduleCheck(ctx);
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("probing paused: the last probe cost 12% of the account window");
  });

  test("a repository-switching pause in effect reads warn with its cause", () => {
    const ctx = fakeCtx();
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {
      [plannerKey]: { ...costPause(ctx.now), lastCostPct: 1, repoSwitches: 3 } } });
    const check = enforcementProbeScheduleCheck(ctx);
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("probing paused: the certificate keeps being invalidated by switching repositories");
  });

  test("probing turned off stays plain state, even over a pause", () => {
    const ctx = fakeCtx();
    writeStrategyYaml(ctx, "off");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: { [plannerKey]: costPause(ctx.now) } });
    const check = enforcementProbeScheduleCheck(ctx);
    expect(check.level).toBe("info");
    expect(check.detail).not.toContain("probing paused");
  });

  test("a declined consent still reads warn", () => {
    const ctx = fakeCtx();
    writeStrategyYaml(ctx, "ask");
    writeScheduleState(ctx, { consent: { "claude-code": "declined" }, attempts: {} });
    const check = enforcementProbeScheduleCheck(ctx);
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("consent: declined");
  });

  test("it reports the planner's own attempt, not another repository's", () => {
    const ctx = fakeCtx();
    writeStrategyYaml(ctx, "auto");
    const other = JSON.stringify(["codex", "personal", "headless"]);
    // The other attempt comes first, so "whichever key is first" picks it.
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {
      [other]: { ...costPause(ctx.now), probesToday: 7, lastCostPct: 9.5 },
      [plannerKey]: { failures: 1, nextEligibleAt: ctx.now + 900, lastRepo: "/repo", repoSwitches: 0,
        dayStartedAt: ctx.now - 3600, probesToday: 2, lastCostPct: 0.5 },
    } });
    const check = enforcementProbeScheduleCheck(ctx);
    expect(check.detail).toContain("probes today: 2");
    expect(check.detail).not.toContain("probes today: 7");
    expect(check.level).toBe("info");
  });
});
