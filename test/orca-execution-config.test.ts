import { expect, test } from "bun:test";
import { DEFAULT_EXECUTION, ExecutionError, validateExecution } from "../src/config/execution";
import { validateStrategy } from "../src/config/strategy";

test("idle minutes: optional integers, fail after idle", () => {
  expect(validateExecution({ idle_after_min: 5, idle_fail_min: 20 })).toMatchObject({ idleAfterS: 300, idleFailS: 1200 });
  expect(validateExecution(undefined)).toEqual({ backend: "auto", worktree: "child-of-current", baseBranch: null });
  for (const bad of [{ idle_after_min: 0 }, { idle_fail_min: 1.5 }, { idle_after_min: 30, idle_fail_min: 10 }, { idle_after_min: "5" }]) {
    expect(() => validateExecution(bad)).toThrow(ExecutionError);
  }
});

test("a missing or empty execution section uses the defaults", () => {
  expect(validateExecution(undefined)).toEqual({ backend: "auto", worktree: "child-of-current", baseBranch: null });
  expect(validateExecution(null)).toEqual(DEFAULT_EXECUTION);
  expect(validateExecution({})).toEqual(DEFAULT_EXECUTION);
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} } }, "/x");
  expect(validateExecution(s.execution)).toEqual(DEFAULT_EXECUTION);
});

test("valid values are read", () => {
  expect(validateExecution({ backend: "orca", worktree: "current", base_branch: "origin/main" }))
    .toEqual({ backend: "orca", worktree: "current", baseBranch: "origin/main" });
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
