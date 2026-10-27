import { expect, test } from "bun:test";
import {
  BACKOFF_BASE_S, BACKOFF_MAX_S, MAX_COST_PCT, MAX_PROBES_PER_DAY, MAX_REPO_SWITCHES,
  decideProbe, recordProbeOutcome, type ProbeInputs, type ScheduleState,
} from "../src/dispatch/certification-schedule";

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

test("stops after repeated repository switches", () => {
  const d = decideProbe(inputs(), state({ repoSwitches: MAX_REPO_SWITCHES }), 1_000);
  expect(d.probe).toBe(false);
});

test("stops when the last probe cost exceeded the ceiling", () => {
  const d = decideProbe(inputs(), state({ lastCostPct: MAX_COST_PCT + 3 }), 1_000);
  expect(d.probe).toBe(false);
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
