import { expect, test, describe } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { OPS } from "../src/api/ops";
import { enforcementProbeScheduleCheck } from "../src/install/doctor-hooks";
import { BACKOFF_MAX_S, MAX_REPO_SWITCHES, recordProbeOutcome, settleProbe, writeScheduleState, type AttemptRecord } from "../src/dispatch/certification-schedule";

/** Registers repositories the way the registry stores them; the first is the one tick certifies. */
function registerRepos(ctx: Ctx, ...repos: string[]): void {
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "state", "repos.json"), JSON.stringify(Object.fromEntries(
    repos.map((path, n) => [path, { path, key: `local:${n}`, lastUsed: ctx.now - n }]))));
}

// No probe runs here: the agent binary is a stub and its only command is --version.
function setupEnforcementContext(ctx: Ctx, register = true): string {
  const binary = join(ctx.home, "claude");
  writeFileSync(binary, "#!/usr/bin/env echo fake claude");
  ctx.which = (name: string) => name === "claude" ? binary : null;
  ctx.run = async (argv: string[]) => argv[0] === binary
    ? { code: 0, stdout: "2.1.281 (Claude Code)\n", stderr: "" }
    : { code: 127, stdout: "", stderr: "not available in tests" };
  const repo = realpathSync(tmpDir());
  if (register) registerRepos(ctx, repo);
  return repo;
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

type Row = { runner: string; scheduleReason: string | null; schedulePaused: boolean };
async function plannerRow(ctx: Ctx, repo: string): Promise<Row> {
  const result = await OPS["dispatch.enforcement"].handler(ctx, { repo }, {}) as { runners: Row[] };
  return result.runners.find(row => row.runner === "claude-code")!;
}

describe("diagnostics row carries the schedule's reason", () => {
  test("a schedule paused for an over-ceiling cost reports that cause", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: { [plannerKey]: costPause(ctx.now) } });
    expect(await plannerRow(ctx, repo)).toMatchObject({
      scheduleReason: "the last probe cost 12% of the account window", schedulePaused: true });
  });

  test("a short backoff is carried as not paused", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: { [plannerKey]: {
      ...costPause(ctx.now), lastCostPct: 0.5, failures: 1, nextEligibleAt: ctx.now + 900 } } });
    expect(await plannerRow(ctx, repo)).toMatchObject({
      scheduleReason: "waiting out the backoff from an earlier failed probe", schedulePaused: false });
  });

  test("with only live headroom left to check, it states no reason, because a probe may be imminent", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx);
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {} });
    expect(await plannerRow(ctx, repo)).toMatchObject({ scheduleReason: null, schedulePaused: false });
  });

  test("a row for another repository is evaluated where the schedule certifies, and names it", async () => {
    const ctx = fakeCtx();
    const shown = setupEnforcementContext(ctx, false);
    const certified = realpathSync(tmpDir());
    // Only the certified repository carries a project-level override, which the schedule cannot probe.
    mkdirSync(join(certified, ".claude"), { recursive: true });
    writeFileSync(join(certified, ".claude", "settings.json"), "{}");
    registerRepos(ctx, certified, shown);
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {} });
    expect((await plannerRow(ctx, shown)).scheduleReason).toBe(
      `scheduled probing certifies ${certified}, not this repository; there: Project-level native control overrides need an exact-environment canary`);
  });

  test("with no registered repository it says the schedule has nothing to certify", async () => {
    const ctx = fakeCtx();
    const repo = setupEnforcementContext(ctx, false);
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {} });
    expect((await plannerRow(ctx, repo)).scheduleReason).toBe("no repository is registered, so there is nothing to certify");
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

  test("a repository-switching pause whose last probe certified still reads warn with its cause", () => {
    const ctx = fakeCtx();
    writeStrategyYaml(ctx, "auto");
    const before = { consent: { "claude-code": "granted" as const }, attempts: { [plannerKey]: {
      ...costPause(ctx.now), lastCostPct: null, nextEligibleAt: 0, repoSwitches: MAX_REPO_SWITCHES - 1 } } };
    const charged = recordProbeOutcome(before, plannerKey, "/other", { certified: false, costPct: null }, ctx.now);
    writeScheduleState(ctx, settleProbe(charged, plannerKey, { certified: true, costPct: 0 }, ctx.now));
    ctx.now += 10;
    const check = enforcementProbeScheduleCheck(ctx);
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("probing paused: the certificate keeps being invalidated by switching repositories");
    expect(check.detail).not.toContain("failed probe");
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
