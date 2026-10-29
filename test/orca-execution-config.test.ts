import { expect, test } from "bun:test";
import { DEFAULT_EXECUTION, ExecutionError, validateExecution } from "../src/config/execution";
import { validateStrategy } from "../src/config/strategy";

test("idle minutes: optional integers, fail after idle", () => {
  expect(validateExecution({ idle_after_min: 5, idle_fail_min: 20 })).toMatchObject({ idleAfterS: 300, idleFailS: 1200 });
  expect(validateExecution(undefined)).toEqual({ localMaxTasks: null, localMemoryPressureLimit: "critical", localLoadLimit: null, backend: "auto", worktree: "child-of-current", baseBranch: null });
  for (const bad of [{ idle_after_min: 0 }, { idle_fail_min: 1.5 }, { idle_after_min: 30, idle_fail_min: 10 }, { idle_after_min: "5" }]) {
    expect(() => validateExecution(bad)).toThrow(ExecutionError);
  }
});

test("a missing or empty execution section uses the defaults", () => {
  expect(validateExecution(undefined)).toEqual({ localMaxTasks: null, localMemoryPressureLimit: "critical", localLoadLimit: null, backend: "auto", worktree: "child-of-current", baseBranch: null });
  expect(validateExecution(null)).toEqual(DEFAULT_EXECUTION);
  expect(validateExecution({})).toEqual(DEFAULT_EXECUTION);
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} } }, "/x");
  expect(validateExecution(s.execution)).toEqual(DEFAULT_EXECUTION);
});

test("valid values are read", () => {
  expect(validateExecution({ backend: "orca", worktree: "current", base_branch: "origin/main" }))
    .toEqual({ localMaxTasks: null, localMemoryPressureLimit: "critical", localLoadLimit: null, backend: "orca", worktree: "current", baseBranch: "origin/main" });
  expect(validateExecution({ backend: "direct" }).backend).toBe("direct");
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} }, execution: { worktree: "current" } }, "/x");
  expect(validateExecution(s.execution).worktree).toBe("current");
});

test("every problem is reported at once", () => {
  let err: unknown;
  try {
    validateExecution({ backend: "cloud", worktree: "tmp", base_branch: "--force", colour: "red" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ExecutionError);
  const problems = (err as ExecutionError).problems;
  expect(problems).toHaveLength(4);
  const all = problems.join("\n");
  expect(all).toContain('unknown key "colour"');
  expect(all).toContain('execution.backend must be one of auto, orca, direct (got "cloud")');
  expect(all).toContain('execution.worktree must be one of child-of-current, new-child, current (got "tmp")');
  expect(all).toContain("execution.base_branch");
  expect((err as Error).message).toContain("invalid execution section");
});

test("base_branch must be a plain ref", () => {
  for (const bad of ["", "has space", "-x", 7]) {
    expect(() => validateExecution({ base_branch: bad })).toThrow(ExecutionError);
  }
  expect(validateExecution({ base_branch: "release/2026.10" }).baseBranch).toBe("release/2026.10");
});

test("a non-mapping section is rejected", () => {
  expect(() => validateExecution(["orca"])).toThrow("execution must be a mapping");
});

test("repository registration is opt-in and child-of-current is supported",()=>{expect(validateExecution({worktree:"child-of-current",registerRepos:true})).toMatchObject({worktree:"child-of-current",registerRepos:true});expect(()=>validateExecution({registerRepos:"yes"})).toThrow("must be a boolean");});

test("explicit base_branch preserves new-child default unless worktree is explicit",()=>{
 expect(validateExecution({base_branch:"release"})).toMatchObject({worktree:"new-child",baseBranch:"release"});
 expect(validateExecution({base_branch:"release",worktree:"child-of-current"}).worktree).toBe("child-of-current");
});

test("local capacity: unlimited by default, explicit caps kept, guard settings validated", () => {
  expect(validateExecution({}).localMaxTasks).toBeNull();
  expect(validateExecution({ local_max_tasks: "unlimited" }).localMaxTasks).toBeNull();
  // Existing strategies with a numeric cap keep it, including caps above the old 16 ceiling.
  expect(validateExecution({ local_max_tasks: 3 }).localMaxTasks).toBe(3);
  expect(validateExecution({ local_max_tasks: 40 }).localMaxTasks).toBe(40);
  for (const bad of [0, -1, 1.5, "4", "none", true]) expect(() => validateExecution({ local_max_tasks: bad })).toThrow("execution.local_max_tasks must be a whole number");
  for (const limit of ["critical", "warning", "off"] as const) expect(validateExecution({ local_memory_pressure_limit: limit }).localMemoryPressureLimit).toBe(limit);
  expect(() => validateExecution({ local_memory_pressure_limit: "high" })).toThrow("execution.local_memory_pressure_limit must be critical, warning or off");
  expect(validateExecution({ local_load_limit: "off" }).localLoadLimit).toBeNull();
  expect(validateExecution({ local_load_limit: 2.5 }).localLoadLimit).toBe(2.5);
  for (const bad of [0, -1, "3", Number.NaN]) expect(() => validateExecution({ local_load_limit: bad })).toThrow("execution.local_load_limit must be a positive number");
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} }, execution: { local_max_tasks: "unlimited", local_memory_pressure_limit: "warning", local_load_limit: 3 } }, "/x");
  expect(validateExecution(s.execution)).toMatchObject({ localMaxTasks: null, localMemoryPressureLimit: "warning", localLoadLimit: 3 });
  expect(() => validateStrategy({ planner: "claude-code", providers: { "claude-code": {} }, execution: { local_max_tasks: 0 } }, "/x")).toThrow("execution.local_max_tasks must be a whole number");
});
