import { expect, test } from "bun:test";
import { validateStrategy, POLICIES } from "../src/config/strategy";
import { rankExecutors, type ProviderStatus } from "../src/engine/rank";
const strategy = (policy = "priority") => validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {}, agy: {} }, pacing: { policy, order: ["agy", "codex", "cursor"] }, routing: [{ default: ["agy"] }] }, "/test");
const statuses = (): Record<string, ProviderStatus> => Object.fromEntries(["claude-code", "codex", "cursor", "agy"].map(id => [id, { id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false }]));
const project = { executors: ["cursor", "codex"], order: "configured" as const };
for (const policy of POLICIES) test(`project order replaces global ${policy} ranking without changing global results`, () => {
  const s = strategy(policy), st = statuses();
  st.cursor.verdict = "AHEAD"; st.codex.verdict = "EXPIRING";
  expect(rankExecutors(null, s, st).ranked.map(e => e.id)).toEqual(["agy"]);
  expect(rankExecutors(null, s, st, project).ranked.map(e => [e.id, e.score])).toEqual([["cursor", 2], ["codex", 1]]);
  st.cursor.verdict = "UNKNOWN";
  expect(rankExecutors(null, s, st, project).ranked[0].id).toBe("cursor");
});
test("project hard exclusions never append healthy global runners", () => {
  const s = strategy(), st = statuses(); st.cursor.verdict = "EXHAUSTED";
  expect(rankExecutors(null, s, st, project).ranked.map(e => e.id)).toEqual(["codex"]);
  st.codex.blockedReason = "manual";
  const result = rankExecutors(null, s, st, project);
  expect(result.ranked).toEqual([]);
  expect(result.excluded.map(e => e.reason)).toEqual(["exhausted", "Blocked by you"]);
  expect(rankExecutors(null, s, st, { ...project, executors: ["codex#removed@local"] }).reason).toBe("no executor configured");
});
test("project eligibility retains planner, disabled, installation and paid overflow checks", () => {
  const s = strategy(), st = statuses(); s.runners.cursor.enabled = false; st.codex.installed = false;
  expect(rankExecutors(null, s, st, { ...project, executors: ["claude-code", ...project.executors] }).excluded.map(e => e.reason)).toEqual(["planner", "disabled", "not installed"]);
  s.runners.cursor.enabled = true; st.cursor.verdict = "EXHAUSTED"; s.accounts.cursor.allowPaid = true;
  expect(rankExecutors(null, s, st, project).ranked.map(e => e.id)).toEqual([]);
});
