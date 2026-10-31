import { expect, test } from "bun:test";
import { rulesClassifier as pluginRules } from "../plugins/pacer-classify/rules";
const rulesClassifier = { ...pluginRules, ask: (state: string, question: Parameters<typeof pluginRules.ask>[1]) => pluginRules.ask(state, question, 3000) };
import { QUESTIONS } from "../src/classify/state";
import type { DecisionName } from "../src/classify/types";

const ask = (decision: DecisionName, state: Record<string, unknown>) =>
  rulesClassifier.ask(JSON.stringify(state), QUESTIONS[decision]);

test("rules adapter identifies itself and reports zero latency and cost", async () => {
  expect(rulesClassifier.id).toBe("rules");
  expect(rulesClassifier.external).toBe(false);
  for (const decision of ["task_kind", "difficulty", "guard", "result_check"] as const) {
    expect(await ask(decision, {})).toMatchObject({ latencyMs: 0, costUsd: 0 });
  }
});

for (const kind of ["boilerplate", "tests", "docs", "rename", "migration", "feature", "debug", "refactor", "performance", "unfamiliar-code", "research"]) {
  test(`planner kind ${kind} wins over conflicting keywords`, async () => {
    expect(await ask("task_kind", { planner_kind: kind, goal: "tests docs" })).toMatchObject({ value: kind, confidence: 1 });
  });
}

for (const [goal, kind] of [
  ["Write tests", "tests"], ["Update documentation", "docs"], ["Rename a symbol", "rename"],
  ["Migrate the database", "migration"], ["Debug the bug", "debug"], ["Refactor the module", "refactor"],
  ["Improve performance", "performance"], ["Generate boilerplate", "boilerplate"], ["Research the protocol", "research"],
]) {
  test(`one keyword match selects ${kind}`, async () => {
    expect(await ask("task_kind", { goal, planner_kind: "invalid" })).toMatchObject({ value: kind, confidence: 0.7 });
  });
}

test("two keyword matches gives default even with a feature verb", async () => {
  expect(await ask("task_kind", { goal: "Add tests and docs" })).toMatchObject({ value: "default", confidence: 0.5 });
});

test("keywords consider scope, context and constraints", async () => {
  for (const field of ["scope", "context", "constraints"]) {
    expect(await ask("task_kind", { goal: "Work on the module", [field]: "tests" })).toMatchObject({ value: "tests", confidence: 0.7 });
  }
});

for (const verb of ["add", "implement", "build", "create", "support"]) {
  test(`feature verb ${verb} selects feature only without a keyword match`, async () => {
    expect(await ask("task_kind", { goal: `${verb.toUpperCase()} pagination` })).toMatchObject({ value: "feature", confidence: 0.6 });
    expect(await ask("task_kind", { goal: `${verb} tests` })).toMatchObject({ value: "tests", confidence: 0.7 });
  });
}

test("no keyword or standalone feature verb gives default", async () => {
  for (const goal of ["Inspect the module", "address the issue", "rebuild the widget", "creative layout"]) {
    expect(await ask("task_kind", { goal })).toMatchObject({ value: "default", confidence: 0.5 });
  }
});

for (const [kind, value] of [
  ["boilerplate", 0.9], ["docs", 0.9], ["rename", 0.9], ["tests", 0.8],
  ["migration", 0.7], ["feature", 0.7], [null, 0.7], ["refactor", 0.6],
  ["debug", 0.5], ["research", 0.5], ["performance", 0.45], ["unfamiliar-code", 0.4],
] as const) {
  test(`difficulty base for ${kind} is ${value}`, async () => {
    expect(await ask("difficulty", { kind })).toMatchObject({ value, confidence: 0.6 });
  });
}

test("difficulty penalizes text only above 2000 characters", async () => {
  expect(await ask("difficulty", { kind: "feature", goal: "x".repeat(2000) })).toMatchObject({ value: 0.7, confidence: 0.6 });
  expect(await ask("difficulty", { kind: "feature", goal: "x".repeat(2001) })).toMatchObject({ value: 0.6, confidence: 0.6 });
  expect(await ask("difficulty", { kind: "feature", goal: "x".repeat(1000), context: "x".repeat(1001) })).toMatchObject({ value: 0.6 });
});

test("difficulty penalizes more than five scope items", async () => {
  for (const separator of [",", "\n"]) {
    expect(await ask("difficulty", { kind: "tests", scope: ["a", "b", "c", "d", "e"].join(separator) })).toMatchObject({ value: 0.8 });
    expect(await ask("difficulty", { kind: "tests", scope: ["a", "b", "c", "d", "e", "f"].join(separator) })).toMatchObject({ value: 0.7 });
  }
});

test("difficulty penalizes repo_files only above 5000", async () => {
  expect(await ask("difficulty", { kind: "feature", repo_files: 5000 })).toMatchObject({ value: 0.7 });
  expect(await ask("difficulty", { kind: "feature", repo_files: 5001 })).toMatchObject({ value: 0.6 });
});

test("difficulty combines penalties, rounds and stays within the clamped range", async () => {
  const penalties = { goal: "x".repeat(2001), scope: "a,b,c,d,e,f", repo_files: 5001 };
  expect(await ask("difficulty", { kind: "performance", ...penalties })).toMatchObject({ value: 0.15, confidence: 0.6 });
  expect(await ask("difficulty", { kind: "unfamiliar-code", ...penalties })).toMatchObject({ value: 0.1 });
  for (const kind of ["boilerplate", "unfamiliar-code"]) {
    for (const state of [{ kind }, { kind, ...penalties }]) {
      const answer = await ask("difficulty", state);
      expect(answer.value as number).toBeGreaterThanOrEqual(0);
      expect(answer.value as number).toBeLessThanOrEqual(1);
    }
  }
});

for (const subagent_type of ["Explore", "Plan", "claude-code-guide", "statusline-setup", "code-reviewer", "SECURITY-REVIEWER", "analyzer", "Data-Analyzer", "pr-review-toolkit:code", "pacer-worker", "pacer:worker", "codex-executor"]) {
  test(`guard allows ${subagent_type}`, async () => {
    expect(await ask("guard", { subagent_type, prompt: "Write code and run builds" })).toMatchObject({ value: false, confidence: 0.9, probabilities: { yes: 0.1, no: 0.9 } });
  });
}

test("guard classifies general-purpose and near misses as execution", async () => {
  for (const subagent_type of ["general-purpose", "explore", "plan", "xpr-review-toolkit:code", "xpacer:worker", "pacer", "codex-executor-extra", "executor", ""]) {
    expect(await ask("guard", { subagent_type, prompt: "Read-only research" })).toMatchObject({ value: true, confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } });
  }
});

test("result_check uses acceptance when present even if status disagrees", async () => {
  expect(await ask("result_check", { status: "failed", acceptance: { passed: true, tail: "ok" } })).toMatchObject({ value: true, confidence: 0.95 });
  expect(await ask("result_check", { status: "done", acceptance: { passed: false, tail: "2 failed" } })).toMatchObject({ value: false, confidence: 0.95 });
});

test("result_check lowers confidence when acceptance has no output to show for its exit code", async () => {
  // A SIGPIPE-killed `| grep -q` (issue #450) or an exit-code-only check both leave an empty tail.
  expect(await ask("result_check", { status: "partial", acceptance: { passed: false, tail: "" } })).toMatchObject({ value: false, confidence: 0.6 });
  expect(await ask("result_check", { status: "done", acceptance: { passed: true, tail: "" } })).toMatchObject({ value: true, confidence: 0.6 });
  expect(await ask("result_check", { status: "partial", acceptance: { passed: false } })).toMatchObject({ value: false, confidence: 0.6 });
});

test("result_check without acceptance passes only done", async () => {
  for (const status of ["done", "partial", "failed", "limit", "stopped"]) {
    expect(await ask("result_check", { status })).toMatchObject({ value: status === "done", confidence: 0.5 });
  }
  expect(await ask("result_check", { status: "done", acceptance: { cmd: "bun test" } })).toMatchObject({ value: true, confidence: 0.5 });
});

test("an unknown question id throws", async () => {
  await expect(rulesClassifier.ask("{}", { type: "yesno", id: "unknown", instructions: "?" })).rejects.toThrow("unknown");
});
