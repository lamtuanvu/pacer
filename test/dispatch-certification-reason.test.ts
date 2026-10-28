import { expect, test, describe, spyOn } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { createTask, updateTask } from "../src/tasks/store";
import { resolveRepoInput } from "../src/core/repos";
import { loadStrategy } from "../src/config/strategy";
import * as launch from "../src/exec/launch";
import { enforcementDiagnostics, resolveEnforcementTarget } from "../src/dispatch/enforcement";
import { plannerScheduleKey, scheduledRepo } from "../src/dispatch/certification-schedule";
import { OPS } from "../src/api/ops";
import { enforcementProbeScheduleCheck } from "../src/install/doctor-hooks";
import { BACKOFF_MAX_S, MAX_REPO_SWITCHES, recordProbeOutcome, settleProbe, writeScheduleState, type AttemptRecord } from "../src/dispatch/certification-schedule";

/** Registry insertion order is distinct from its mutable lastUsed order. */
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

type Row = { runner: string; scheduleReason: string | null; schedulePaused: boolean; scheduleRepo?: string | null; scheduleUnsupportedReason?: string | null };
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
    const registryFile = join(ctx.pacerHome, "state", "repos.json");
    const registry = JSON.parse(readFileSync(registryFile, "utf8"));
    registry[certified].key = "github.com/team/project";
    writeFileSync(registryFile, JSON.stringify(registry));
    writeStrategyYaml(ctx, "auto");
    writeScheduleState(ctx, { consent: { "claude-code": "granted" }, attempts: {} });
    expect(await plannerRow(ctx, shown)).toMatchObject({
      scheduleRepo: "team/project", schedulePaused: false,
      scheduleUnsupportedReason: "Project-level native control overrides need an exact-environment canary",
      scheduleReason: null,
    });
  });

  test("the scheduled repository also carries unsupported reasons structurally on its own row", async () => {
    const ctx = fakeCtx(), repo = setupEnforcementContext(ctx);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), "{}");
    writeStrategyYaml(ctx, "auto");
    expect(await plannerRow(ctx, repo)).toMatchObject({
      scheduleRepo: null, scheduleReason: null, schedulePaused: false,
      scheduleUnsupportedReason: "Project-level native control overrides need an exact-environment canary",
    });
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

function taskIn(ctx: Ctx, repo: string) {
  return createTask(ctx, { brief: { goal: "fixture", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
}

describe("schedule repository follows managed work", () => {
  test("running work older than 24 hours still determines the scheduled repository", () => {
    const ctx = fakeCtx();
    const first = realpathSync(tmpDir()), working = realpathSync(tmpDir());
    registerRepos(ctx, first, working);
    const startedAt = ctx.now - 2 * 86_400;
    const task = taskIn({ ...ctx, now: startedAt }, working);
    updateTask(ctx, task.id, t => {
      t.state = "running";
      t.attemptStartedAt = startedAt;
    });

    expect(scheduledRepo(ctx)).toBe(working);
  });

  test("real diagnostics names the most recently active task repository despite viewing another", async () => {
    const ctx = fakeCtx();
    const shown = setupEnforcementContext(ctx, false), working = realpathSync(tmpDir());
    registerRepos(ctx, shown, working);
    writeStrategyYaml(ctx, "auto");
    const old = taskIn({ ...ctx, now: ctx.now - 500 }, working);
    taskIn({ ...ctx, now: ctx.now - 100 }, shown);
    updateTask(ctx, old.id, t => { t.state = "running"; t.attemptStartedAt = ctx.now; });
    const strategy = loadStrategy(ctx);
    expect((await enforcementDiagnostics(ctx, strategy, shown)).runners[0]).toMatchObject({ scheduleRepo: basename(working) });
    // Viewing uses the real writing resolver; fake only its bounded Git reads.
    ctx.run = async argv => argv.includes("--show-toplevel")
      ? { code: 0, stdout: `${shown}\n${shown}/.git\n`, stderr: "" }
      : argv.includes("remote") ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: "2.1.281", stderr: "" };
    await resolveRepoInput({ ...ctx, now: ctx.now + 10 }, shown);
    expect(scheduledRepo(ctx)).toBe(working);
    expect((await enforcementDiagnostics(ctx, strategy, working)).runners[0]).toMatchObject({ scheduleRepo: null });
    expect((await enforcementDiagnostics(ctx, strategy, shown)).runners[0]).toMatchObject({ scheduleRepo: basename(working) });
  });

  test("without task activity the first registered repository wins over lastUsed", async () => {
    const ctx = fakeCtx();
    const shown = setupEnforcementContext(ctx, false), first = realpathSync(tmpDir());
    registerRepos(ctx, first, shown);
    // A real resolver write changes lastUsed without changing registration order.
    ctx.run = async argv => argv.includes("--show-toplevel")
      ? { code: 0, stdout: `${shown}\n${shown}/.git\n`, stderr: "" }
      : argv.includes("remote") ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: "2.1.281", stderr: "" };
    await resolveRepoInput({ ...ctx, now: ctx.now + 10 }, shown);
    writeStrategyYaml(ctx, "auto");
    expect(scheduledRepo(ctx)).toBe(first);
    expect(await plannerRow(ctx, shown)).toMatchObject({ scheduleRepo: basename(first) });
  });

  test("no registered repository yields null even with an old task reference", () => {
    const ctx = fakeCtx();
    expect(scheduledRepo(ctx)).toBeNull();
    taskIn(ctx, realpathSync(tmpDir()));
    expect(scheduledRepo(ctx)).toBeNull();
  });

  test("recent completed work counts, expired and dismissed completed work do not", () => {
    const ctx = fakeCtx(), first = realpathSync(tmpDir()), recent = realpathSync(tmpDir());
    registerRepos(ctx, first, recent);
    const t = taskIn({ ...ctx, now: ctx.now - 100 }, recent);
    updateTask(ctx, t.id, task => { task.state = "done"; });
    expect(scheduledRepo(ctx)).toBe(recent);
    expect(scheduledRepo({ ...ctx, now: ctx.now + 86401 })).toBe(first);
    updateTask(ctx, t.id, task => { task.dismissed = true; });
    expect(scheduledRepo(ctx)).toBe(first);
  });

  test("cross-repository pauses survive and non-planner rows stay outside the schedule", async () => {
    const ctx = fakeCtx(), shown = setupEnforcementContext(ctx, false), working = realpathSync(tmpDir());
    registerRepos(ctx, working, shown);
    writeStrategyYaml(ctx, "auto");
    const strategy = loadStrategy(ctx);
    strategy.runners["claude-code#other-account"] = { ...strategy.runners["claude-code"], id: "claude-code#other-account", account: "other-account" };
    strategy.providers["claude-code#other-account"] = { ...strategy.providers["claude-code"], id: "claude-code#other-account" };
    strategy.accounts["other-account"] = { ...strategy.accounts["claude-code"], name: "other-account" };
    writeScheduleState(ctx, { consent: {}, attempts: { [plannerKey]: costPause(ctx.now) } });
    const rows = (await enforcementDiagnostics(ctx, strategy, shown)).runners;
    expect(rows.find(r => r.runner === "claude-code")).toMatchObject({
      scheduleRepo: basename(working), schedulePaused: true, scheduleReason: "the last probe cost 12% of the account window",
    });
    expect(rows.find(r => r.runner === "claude-code#other-account")).toMatchObject({
      scheduleRepo: null, scheduleUnsupportedReason: null, schedulePaused: false,
      scheduleReason: "scheduled probing covers only the planner's own executor",
    });
  });
});

test("planner schedule key shares managed launch-mode resolution with enforcement", async () => {
  const ctx = fakeCtx(), repo = setupEnforcementContext(ctx);
  writeStrategyYaml(ctx, "auto");
  const strategy = loadStrategy(ctx);
  // Simulate managed work gaining interactive support: both callers must follow it.
  const mode = spyOn(launch, "launchModeFor").mockReturnValue({ mode: "interactive", explicit: false });
  try {
    const target = await resolveEnforcementTarget(ctx, strategy, "claude-code", repo);
    expect(plannerScheduleKey(strategy)).toBe(JSON.stringify([target.runner, target.account, target.launchMode]));
    expect(mode).toHaveBeenCalledTimes(2);
    expect(mode.mock.calls.every(call => call[2]?.managed === true)).toBe(true);
  } finally { mode.mockRestore(); }
});
