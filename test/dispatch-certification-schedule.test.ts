import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BACKOFF_BASE_S, BACKOFF_MAX_S, MAX_COST_PCT, MAX_PROBES_PER_DAY, MAX_REPO_SWITCHES,
  attemptHold, decideProbe, readScheduleState, recordProbeOutcome, settleProbe, writeScheduleState, type ProbeInputs, type ScheduleState,
} from "../src/dispatch/certification-schedule";
import { fakeCtx } from "./helpers";

const DAY = 86_400;

function inputs(over: Partial<ProbeInputs> = {}): ProbeInputs {
  return {
    key: "planner-key", account: "claude-code", runner: "claude-code", repo: "/repo",
    certificate: { state: "uncertified", reason: "not verified" }, unsupportedReason: null,
    headroomPct: 60, reserveHeadroomPct: 25,
    mode: "auto", plannerExecutes: true, listedForRouting: true,
    ...over,
  };
}

function state(over: Partial<ScheduleState["attempts"][string]> = {}, consent: ScheduleState["consent"] = {}): ScheduleState {
  return { consent, attempts: { "planner-key": {
    failures: 0, nextEligibleAt: 0, lastRepo: "/repo", repoSwitches: 0,
    dayStartedAt: 0, probesToday: 0, lastCostPct: null, ...over,
  } } };
}

test("probes when every condition is met", () => {
  expect(decideProbe(inputs(), { consent: {}, attempts: {} }, 1_000)).toEqual({ probe: true });
});

test("declines when the planner does not execute", () => {
  const d = decideProbe(inputs({ plannerExecutes: false }), state(), 1_000);
  expect(d.probe).toBe(false);
});

test("declines when the runner is not listed for routing", () => {
  const d = decideProbe(inputs({ listedForRouting: false }), state(), 1_000);
  expect(d.probe).toBe(false);
});

test("never probes below the reserve", () => {
  const d = decideProbe(inputs({ headroomPct: 20, reserveHeadroomPct: 25 }), state(), 1_000);
  expect(d).toEqual({ probe: false, reason: "planner reserve: 20% headroom is at or below the 25% reserve" });
});

test("declines exactly at the reserve boundary", () => {
  const d = decideProbe(inputs({ headroomPct: 25, reserveHeadroomPct: 25 }), state(), 1_000);
  expect(d.probe).toBe(false);
});

test("unknown headroom does not satisfy the reserve", () => {
  const d = decideProbe(inputs({ headroomPct: null }), state(), 1_000);
  expect(d).toEqual({ probe: false, reason: "planner headroom is unknown" });
});

test("passes an unsupported reason through verbatim", () => {
  const reason = "Project-level native control overrides need an exact-environment canary";
  expect(decideProbe(inputs({ unsupportedReason: reason }), state(), 1_000)).toEqual({ probe: false, reason });
});

test("does not probe when the certificate is already current", () => {
  const d = decideProbe(inputs({ certificate: { state: "certified", probedAt: 0, expiresAt: 9_999 } }), state(), 1_000);
  expect(d.probe).toBe(false);
});

test("re-probes a stale certificate", () => {
  const d = decideProbe(inputs({ certificate: { state: "stale", reason: "configuration changed" } }), state(), 1_000);
  expect(d).toEqual({ probe: true });
});

test("asks for consent once per account", () => {
  const asked = decideProbe(inputs({ mode: "ask" }), state(), 1_000);
  expect(asked).toEqual({ probe: false, reason: "certification probing needs your consent for claude-code", needsConsent: true });
  const granted = decideProbe(inputs({ mode: "ask" }), state({}, { "claude-code": "granted" }), 1_000);
  expect(granted).toEqual({ probe: true });
});

test("a declined account is not probed even in auto mode", () => {
  const d = decideProbe(inputs({ mode: "auto" }), state({}, { "claude-code": "declined" }), 1_000);
  expect(d.probe).toBe(false);
  expect((d as { needsConsent?: true }).needsConsent).toBeUndefined();
});

test("mode off never probes and says so distinctly from needing consent", () => {
  const off = decideProbe(inputs({ mode: "off" }), state(), 1_000);
  expect(off).toEqual({ probe: false, reason: "certification probing is turned off" });
  const ask = decideProbe(inputs({ mode: "ask" }), state(), 1_000);
  expect(ask.probe).toBe(false);
  expect((ask as { reason: string }).reason).not.toBe((off as { reason: string }).reason);
});

test("repository switching pauses for the maximum backoff, then retries", () => {
  const now = 1_000;
  const charged = recordProbeOutcome(state({ repoSwitches: MAX_REPO_SWITCHES - 1 }),
    "planner-key", "/other", { certified: false, costPct: null }, now);
  // A successful certification must not erase the repository-switch pause.
  const paused = settleProbe(charged, "planner-key", { certified: true, costPct: 0 }, now);
  expect(paused.attempts["planner-key"].nextEligibleAt).toBe(now + BACKOFF_MAX_S);
  expect(decideProbe(inputs(), paused, now + BACKOFF_MAX_S - 1).probe).toBe(false);
  expect(decideProbe(inputs(), paused, now + BACKOFF_MAX_S)).toEqual({ probe: true });
});

test("a certified repository-switch pause keeps its cause after the counters reset", () => {
  const now = 1_000;
  const charged = recordProbeOutcome(state({ repoSwitches: MAX_REPO_SWITCHES - 1 }),
    "planner-key", "/other", { certified: false, costPct: null }, now);
  const settled = settleProbe(charged, "planner-key", { certified: true, costPct: 0 }, now);
  // The reset is correct; the cause has to survive it.
  expect(settled.attempts["planner-key"].repoSwitches).toBe(0);
  expect(attemptHold(settled.attempts["planner-key"], now + 10)).toEqual({
    reason: "the certificate keeps being invalidated by switching repositories", paused: true,
  });
});

test("a certified cost pause keeps its cause", () => {
  const now = 1_000;
  const charged = recordProbeOutcome(state(), "planner-key", "/repo", { certified: false, costPct: null }, now);
  const settled = settleProbe(charged, "planner-key", { certified: true, costPct: MAX_COST_PCT + 3 }, now);
  expect(attemptHold(settled.attempts["planner-key"], now + 10)).toEqual({
    reason: `the last probe cost ${MAX_COST_PCT + 3}% of the account window`, paused: true,
  });
});

test("a record stored before the cause was kept still reads its pause from its counters", () => {
  const legacy = { failures: 0, nextEligibleAt: 2_000, lastRepo: "/repo", repoSwitches: MAX_REPO_SWITCHES,
    dayStartedAt: 0, probesToday: 1, lastCostPct: null };
  expect(attemptHold(legacy, 1_000)?.paused).toBe(true);
});

test("an over-ceiling settlement pauses for the maximum backoff, then retries", () => {
  const now = 1_000;
  const charged = recordProbeOutcome(state(), "planner-key", "/repo",
    { certified: false, costPct: null }, now);
  const paused = settleProbe(charged, "planner-key", { certified: true, costPct: MAX_COST_PCT + 3 }, now);
  expect(paused.attempts["planner-key"].lastCostPct).toBe(MAX_COST_PCT + 3);
  expect(paused.attempts["planner-key"].nextEligibleAt).toBe(now + BACKOFF_MAX_S);
  expect(decideProbe(inputs(), paused, now + BACKOFF_MAX_S - 1)).toEqual({
    probe: false, reason: `the last probe cost ${MAX_COST_PCT + 3}% of the account window`,
  });
  expect(decideProbe(inputs(), paused, now + BACKOFF_MAX_S)).toEqual({ probe: true });
});

test("the daily cap survives a pause", () => {
  const now = 1_000;
  const charged = recordProbeOutcome(state({ probesToday: MAX_PROBES_PER_DAY - 1, dayStartedAt: now }),
    "planner-key", "/repo", { certified: false, costPct: null }, now);
  const paused = settleProbe(charged, "planner-key", { certified: true, costPct: MAX_COST_PCT + 3 }, now);
  expect(paused.attempts["planner-key"].probesToday).toBe(MAX_PROBES_PER_DAY);
  expect(decideProbe(inputs(), paused, now + BACKOFF_MAX_S - 1).probe).toBe(false);
  expect(decideProbe(inputs(), paused, now + BACKOFF_MAX_S)).toEqual({ probe: true });
  // Exhaust the new day's allowance after recovery, without altering the brake.
  let resumed = paused;
  for (let n = 0; n < MAX_PROBES_PER_DAY; n++) {
    resumed = recordProbeOutcome(resumed, "planner-key", "/repo", { certified: true, costPct: 0 }, now + BACKOFF_MAX_S);
  }
  expect(decideProbe(inputs(), resumed, now + BACKOFF_MAX_S)).toEqual({
    probe: false, reason: `already probed ${MAX_PROBES_PER_DAY} times today`,
  });
});

test("allows a probe whose last cost was at the ceiling", () => {
  expect(decideProbe(inputs(), state({ lastCostPct: MAX_COST_PCT }), 1_000)).toEqual({ probe: true });
});

test("backs off exponentially after failures", () => {
  let s: ScheduleState = { consent: {}, attempts: {} };
  s = recordProbeOutcome(s, "planner-key", "/repo", { certified: false, costPct: 1 }, 1_000);
  expect(s.attempts["planner-key"].nextEligibleAt).toBe(1_000 + BACKOFF_BASE_S);
  s = recordProbeOutcome(s, "planner-key", "/repo", { certified: false, costPct: 1 }, 2_000);
  expect(s.attempts["planner-key"].nextEligibleAt).toBe(2_000 + BACKOFF_BASE_S * 2);
});

test("caps the backoff", () => {
  let s = state({ failures: 20 });
  s = recordProbeOutcome(s, "planner-key", "/repo", { certified: false, costPct: null }, 1_000);
  expect(s.attempts["planner-key"].nextEligibleAt).toBe(1_000 + BACKOFF_MAX_S);
});

test("a success clears the backoff", () => {
  let s = state({ failures: 3, nextEligibleAt: 50_000 });
  s = recordProbeOutcome(s, "planner-key", "/repo", { certified: true, costPct: 0.5 }, 1_000);
  expect(s.attempts["planner-key"].failures).toBe(0);
  expect(s.attempts["planner-key"].nextEligibleAt).toBe(0);
  expect(s.attempts["planner-key"].lastCostPct).toBe(0.5);
});

test("a backward clock does not retry immediately", () => {
  const d = decideProbe(inputs(), state({ nextEligibleAt: 10_000 }), 5_000);
  expect(d.probe).toBe(false);
});

test("a backward clock restarts the day window instead of leaving a stale ceiling", () => {
  const d = decideProbe(inputs(), state({ dayStartedAt: 900_000, probesToday: MAX_PROBES_PER_DAY }), 1_000);
  expect(d).toEqual({ probe: true });
});

test("honors the daily ceiling and resets after a day", () => {
  const blocked = decideProbe(inputs(), state({ dayStartedAt: 1_000, probesToday: MAX_PROBES_PER_DAY }), 2_000);
  expect(blocked.probe).toBe(false);
  const rolled = decideProbe(inputs(), state({ dayStartedAt: 1_000, probesToday: MAX_PROBES_PER_DAY }), 1_000 + DAY);
  expect(rolled).toEqual({ probe: true });
});

test("counts probes within the day window and rolls it", () => {
  let s: ScheduleState = { consent: {}, attempts: {} };
  s = recordProbeOutcome(s, "planner-key", "/repo", { certified: true, costPct: 1 }, 1_000);
  expect(s.attempts["planner-key"].probesToday).toBe(1);
  s = recordProbeOutcome(s, "planner-key", "/repo", { certified: true, costPct: 1 }, 1_000 + DAY);
  expect(s.attempts["planner-key"].probesToday).toBe(1);
  expect(s.attempts["planner-key"].dayStartedAt).toBe(1_000 + DAY);
});

test("counts a repository switch", () => {
  let s = state();
  s = recordProbeOutcome(s, "planner-key", "/other", { certified: true, costPct: null }, 1_000);
  expect(s.attempts["planner-key"].repoSwitches).toBe(1);
  expect(s.attempts["planner-key"].lastRepo).toBe("/other");
  s = recordProbeOutcome(s, "planner-key", "/other", { certified: true, costPct: null }, 2_000);
  expect(s.attempts["planner-key"].repoSwitches).toBe(1);
});

test("a first probe for a key is not a repository switch", () => {
  const s = recordProbeOutcome({ consent: {}, attempts: {} }, "planner-key", "/repo", { certified: true, costPct: null }, 1_000);
  expect(s.attempts["planner-key"].repoSwitches).toBe(0);
});

test("recordProbeOutcome does not mutate the state it is given", () => {
  const before = state();
  const after = recordProbeOutcome(before, "planner-key", "/other", { certified: false, costPct: 9 }, 1_000);
  expect(before.attempts["planner-key"].failures).toBe(0);
  expect(before.attempts["planner-key"].lastRepo).toBe("/repo");
  expect(after).not.toBe(before);
});

// SEC-7: the schedule file records consent and the probe brakes. A torn read
// parses as "no consent, no probe recorded" and spends quota again, so the write
// must be private and atomic.
const stateDir = (pacerHome: string) => join(pacerHome, "state");
const stateFile = (pacerHome: string) => join(stateDir(pacerHome), "certification-schedule.json");
const granted: ScheduleState = { consent: { "claude-code": "granted" }, attempts: {} };

test("writes the schedule file 0600 inside a newly created 0700 directory", () => {
  const ctx = fakeCtx();
  expect(existsSync(stateDir(ctx.pacerHome))).toBe(false);
  writeScheduleState(ctx, granted);
  expect(statSync(stateFile(ctx.pacerHome)).mode & 0o777).toBe(0o600);
  expect(statSync(stateDir(ctx.pacerHome)).mode & 0o777).toBe(0o700);
  expect(readScheduleState(ctx)).toEqual(granted);
});

test("one write tightens a pre-existing loose schedule file to 0600", () => {
  const ctx = fakeCtx();
  mkdirSync(stateDir(ctx.pacerHome), { recursive: true });
  writeFileSync(stateFile(ctx.pacerHome), JSON.stringify({ consent: {}, attempts: {} }));
  chmodSync(stateFile(ctx.pacerHome), 0o644);
  writeScheduleState(ctx, granted);
  expect(statSync(stateFile(ctx.pacerHome)).mode & 0o777).toBe(0o600);
});

test("leaves no temporary file behind", () => {
  const ctx = fakeCtx();
  writeScheduleState(ctx, granted);
  writeScheduleState(ctx, { consent: { "claude-code": "declined" }, attempts: {} });
  expect(readdirSync(stateDir(ctx.pacerHome))).toEqual(["certification-schedule.json"]);
});

// Pinned: the target is never opened for writing; the bytes go to a sibling
// temporary file that is renamed over it, and a write that dies halfway leaves
// the previous complete file readable. Not pinned: rename(2) atomicity itself
// and durability across power loss (no fsync), which this suite cannot observe.
test("a write that dies halfway leaves the previous file whole", () => {
  const ctx = fakeCtx();
  writeScheduleState(ctx, granted);
  const before = readFileSync(stateFile(ctx.pacerHome), "utf8");
  const realWrite = fs.writeFileSync;
  const written: string[] = [];
  const write = spyOn(fs, "writeFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
    written.push(String(path));
    realWrite(path, data.slice(0, data.length >> 1), options);
    throw new Error("disk full");
  }) as typeof realWrite);
  const rename = spyOn(fs, "renameSync");
  let renamed: number;
  try {
    expect(() => writeScheduleState(ctx, { consent: { "claude-code": "declined" }, attempts: {} })).toThrow("disk full");
    renamed = rename.mock.calls.length;
  } finally { write.mockRestore(); rename.mockRestore(); }
  expect(renamed).toBe(0);
  expect(written).toHaveLength(1);
  expect(written[0]).not.toBe(stateFile(ctx.pacerHome));
  expect(written[0].startsWith(`${stateFile(ctx.pacerHome)}.`)).toBe(true);
  expect(readFileSync(stateFile(ctx.pacerHome), "utf8")).toBe(before);
  expect(readScheduleState(ctx)).toEqual(granted);
  expect(readdirSync(stateDir(ctx.pacerHome))).toEqual(["certification-schedule.json"]);
});

test("a completed write renames its temporary file over the target", () => {
  const ctx = fakeCtx();
  const rename = spyOn(fs, "renameSync");
  let calls: unknown[][];
  try { writeScheduleState(ctx, granted); calls = [...rename.mock.calls]; }
  finally { rename.mockRestore(); }
  expect(calls).toHaveLength(1);
  const [from, to] = calls[0] as [string, string];
  expect(to).toBe(stateFile(ctx.pacerHome));
  expect(from).not.toBe(to);
  expect(from.startsWith(`${stateFile(ctx.pacerHome)}.`)).toBe(true);
});

test("charged records preserve the exact pause cause before settlement", () => {
  const now = 1_000;
  const cases = [
    { before: state({ repoSwitches: MAX_REPO_SWITCHES - 1 }), repo: "/other", costPct: null,
      cause: "repo-switches", hold: { reason: "the certificate keeps being invalidated by switching repositories", paused: true } },
    { before: state(), repo: "/repo", costPct: MAX_COST_PCT + 3,
      cause: "cost", hold: { reason: `the last probe cost ${MAX_COST_PCT + 3}% of the account window`, paused: true } },
    { before: state(), repo: "/repo", costPct: null,
      cause: null, hold: { reason: "waiting out the backoff from an earlier failed probe", paused: false } },
  ] as const;
  for (const c of cases) {
    const ctx = fakeCtx({ now });
    const charged = recordProbeOutcome(c.before, "planner-key", c.repo, { certified: false, costPct: c.costPct }, now);
    writeScheduleState(ctx, charged);
    const record = readScheduleState(ctx).attempts["planner-key"];
    expect(record.pauseCause).toBe(c.cause);
    expect(attemptHold(record, now + 1)).toEqual(c.hold);
  }
});
