import { activeHoursLeft, pacePct } from "../src/pace/clock";
import { evaluateWindow, bindingWindow } from "../src/engine/verdict";
import { evaluateEligibility } from "../src/engine/eligibility";
import { machineGuard } from "../src/engine/machine";
import { rankExecutors } from "../src/engine/rank";
import type { Strategy } from "../src/config/strategy";
import type { EligibilityInput } from "../src/evidence/types";
import type { ProviderStatus } from "../src/engine/rank";

const now = 1_798_000_000;
const window = (usedPct: number | null, stale = false, resetsAt: number | null = now + 18_000) =>
  ({ name: "weekly", usedPct, stale, resetsAt, lengthS: 7 * 86_400, paced: true });
const scope = { account: "quota", identity: "user", runner: "codex#quota@local" };
const availability = (value: "ready" | "unavailable", validUntil: number | null = now + 3600) =>
  ({ id: `availability-${value}`, scope, source: "provider-cli" as const, observedAt: now - 100, validUntil, reason: "subscription_failed", value });
const budget = (usedPct: number | null, observedAt = now - 100) =>
  ({ id: `budget-${usedPct}`, scope, source: "provider-cli" as const, observedAt, validUntil: null, reason: "quota_observed", value: window(usedPct) });
const evidence = (availabilityFacts: ReturnType<typeof availability>[], budgetFacts: ReturnType<typeof budget>[]) =>
  ({ facts: { availability: availabilityFacts, budget: budgetFacts, spending: [] }, conflicts: [] });
const runner = (id: string, account: string, agent = "codex", enabled = true) => ({ id, account, agent, enabled });
const strategy = {
  planner: { agent: "claude-code", account: "planner" },
  accounts: { planner: { kind: "subscription" }, quota: { kind: "subscription" }, other: { kind: "subscription" }, endpoint: { kind: "endpoint" } },
  runners: { alpha: runner("alpha", "quota"), beta: runner("beta", "other"), gamma: runner("gamma", "endpoint", "opencode"), disabled: runner("disabled", "quota", "codex", false) },
  runnerAliases: {}, routing: [{ kinds: null, executors: ["alpha", "beta", "gamma", "disabled"] }],
  pacing: { policy: "even", order: ["beta", "alpha", "gamma"], accounts: "spread", fillThreshold: 90 },
} as unknown as Strategy;
const status = (id: string, usedPct: number | null, verdict: ProviderStatus["verdict"], eligibility?: ProviderStatus["eligibility"]): ProviderStatus => ({
  id, usage: id === "gamma" ? "metered" : "quota", windows: [],
  binding: { ...window(usedPct), verdict, ...(usedPct === null ? {} : { delta: usedPct - 50, pace: 50, activeHoursLeft: 5 }) },
  verdict, installed: true, stale: false, eligibility,
});

export function engineGoldens() {
  const originalZone = process.env.TZ;
  const zones = [
    "UTC", "America/Los_Angeles", "Europe/London", "Asia/Kolkata",
    "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham",
    "America/St_Johns", "Australia/Sydney", "Pacific/Kiritimati",
  ];
  const pace = zones.flatMap(zone => {
    process.env.TZ = zone;
    const profile = { builtAt: now, days: 10, bins: Array(168).fill(0), active: Array.from({ length: 168 }, (_, i) => i % 24 >= 9 && i % 24 < 18) };
    const cases = ([
      { name: "active", profile, usage: window(33) },
      { name: "missing", profile: null, usage: window(null) },
      { name: "stale", profile, usage: window(80, true) },
      { name: "limited", profile, usage: window(98) },
      { name: "rolled", profile, usage: window(40, false, now - 1) },
    ]) as { name: string; profile: typeof profile | null; usage: ReturnType<typeof window>; caseNow?: number }[];
    const hourProfile = { ...profile, active: Array.from({ length: 168 }, (_, i) => i % 24 === 9) };
    const addWindow = (name: string, start: number, end: number, caseNow: number, selected = hourProfile) => {
      cases.push({ name, profile: selected, usage: { ...window(40, false, end), lengthS: end - start }, caseNow });
    };
    const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month, day, hour, minute).getTime() / 1000;
    const localNine = local(0, 1, 9);
    addWindow("fractional-offset", localNine, localNine + 3600, localNine + 1800);
    const dayStart = local(0, 1, 23, 30);
    const dayProfile = { ...profile, active: Array.from({ length: 168 }, (_, i) => i === 4 * 24 + 23 || i === 5 * 24) };
    addWindow("day-boundary", dayStart, dayStart + 7200, dayStart + 3600, dayProfile);
    const weekStart = local(0, 4, 23, 30);
    const weekProfile = { ...profile, active: Array.from({ length: 168 }, (_, i) => i === 23 || i === 24) };
    addWindow("week-boundary", weekStart, weekStart + 7200, weekStart + 3600, weekProfile);
    const windowStart = local(0, 2, 8, 45);
    addWindow("window-boundary", windowStart, windowStart + 5400, windowStart + 2700);
    let previousOffset = new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset();
    let transitionCount = 0;
    for (let t = Date.UTC(2026, 0, 1) + 3600_000; t < Date.UTC(2027, 0, 1); t += 3600_000) {
      const offset = new Date(t).getTimezoneOffset();
      if (offset !== previousOffset) {
        const center = t / 1000;
        addWindow(`dst-transition-${++transitionCount}`, center - 86400, center + 86400, center + 9 * 3600, profile);
      }
      previousOffset = offset;
    }
    return cases.map(({ name, profile, usage, caseNow = now }) => {
      const start = usage.resetsAt === null ? caseNow - 86_400 : usage.resetsAt - usage.lengthS;
      const output = { pacePct: pacePct(start, usage.resetsAt ?? caseNow, caseNow, profile), activeHoursLeft: activeHoursLeft(caseNow, usage.resetsAt ?? caseNow, profile), window: evaluateWindow(usage, caseNow, profile, { ahead: 10, behind: -10, paceScale: 1 }) };
      return { zone, name, input: { now: caseNow, profile, usage, thresholds: { ahead: 10, behind: -10, paceScale: 1 } }, output };
    });
  });
  const eligibilityInputs: { name: string; input: EligibilityInput }[] = [
    { name: "ready", input: { now, scope, usage: "quota", allowPaid: false, evidence: evidence([availability("ready")], [budget(30)]), restrictions: [] } },
    { name: "missing", input: { now, scope, usage: "quota", allowPaid: false, evidence: evidence([], []), restrictions: [] } },
    { name: "stale", input: { now, scope, usage: "quota", allowPaid: false, evidence: evidence([availability("ready", now - 1)], [budget(30, now - 90_000)]), restrictions: [] } },
    { name: "limited", input: { now, scope, usage: "quota", allowPaid: false, evidence: evidence([availability("ready")], [budget(98)]), restrictions: [] } },
    { name: "paid", input: { now, scope, usage: "quota", allowPaid: true, evidence: evidence([availability("ready")], [budget(98)]), restrictions: [] } },
    { name: "machine", input: { now, scope, usage: "quota", allowPaid: false, evidence: evidence([availability("ready")], [budget(30)]), restrictions: [{ code: "machine_load", evidenceIds: [] }] } },
  ];
  const eligibility = eligibilityInputs.map(({ name, input }) => ({ name, input, output: evaluateEligibility(input) }));
  const machines = [
    { name: "clear", config: { localMemoryPressureLimit: "critical", localLoadLimit: 1 }, signals: { memoryPressure: "normal", loadPerCore: 0.5, sampledAt: now } },
    { name: "load", config: { localMemoryPressureLimit: "critical", localLoadLimit: 1 }, signals: { memoryPressure: "normal", loadPerCore: 1.25, sampledAt: now } },
    { name: "pressure", config: { localMemoryPressureLimit: "warning", localLoadLimit: 1 }, signals: { memoryPressure: "warning", loadPerCore: 2, sampledAt: now } },
    { name: "unknown", config: { localMemoryPressureLimit: "critical", localLoadLimit: 1 }, signals: { memoryPressure: null, loadPerCore: null, sampledAt: now } },
  ] as const;
  const machine = machines.map(({ name, config, signals }) => ({ name, input: { config, signals }, output: machineGuard(config, signals) }));
  const statuses = { alpha: status("alpha", 40, "BEHIND", eligibility[0].output), beta: status("beta", null, "UNKNOWN", eligibility[1].output), gamma: status("gamma", 70, "AHEAD", eligibility[0].output), disabled: status("disabled", 10, "OK", eligibility[0].output) };
  const rank = [
    { name: "even", strategy, statuses },
    { name: "project", strategy, statuses, selection: { executors: ["gamma", "beta", "alpha"], order: "configured" as const } },
    { name: "machine", strategy, statuses: { ...statuses, alpha: { ...statuses.alpha, eligibility: eligibility[5].output } } },
    { name: "priority", strategy: { ...strategy, pacing: { ...strategy.pacing, policy: "priority" } } as Strategy, statuses },
    { name: "priority-alias", strategy: { ...strategy, runnerAliases: { first: "beta" }, pacing: { ...strategy.pacing, policy: "priority", order: ["first", "alpha", "gamma"] } } as Strategy, statuses: { ...statuses, beta: { ...statuses.beta, eligibility: eligibility[0].output } } },
    { name: "cheapest", strategy: { ...strategy, pacing: { ...strategy.pacing, policy: "cheapest-first" } } as Strategy, statuses },
    { name: "burn", strategy: { ...strategy, pacing: { ...strategy.pacing, policy: "burn-before-reset" } } as Strategy, statuses },
    { name: "fill", strategy: { ...strategy, pacing: { ...strategy.pacing, accounts: "fill" } } as Strategy, statuses },
    { name: "missing-status", strategy, statuses: { alpha: statuses.alpha, beta: statuses.beta } },
    { name: "aliases", strategy: { ...strategy, runnerAliases: { first: "alpha" }, routing: [{ kinds: null, executors: ["first", "beta", "gamma"] }] } as Strategy, statuses: { first: statuses.alpha, beta: statuses.beta, gamma: statuses.gamma } },
  ].map(({ name, strategy, statuses, selection }) => ({ name, input: { kind: null, strategy, statuses, ...(selection ? { selection } : {}) }, output: rankExecutors(null, strategy, statuses as Record<string, ProviderStatus>, selection) }));
  if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone;
  return { pace, eligibility, machine, rank, binding: { input: pace.map(p => p.output.window), output: bindingWindow(pace.map(p => p.output.window)) } };
}
