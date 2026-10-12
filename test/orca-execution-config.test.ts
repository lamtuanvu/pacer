import { expect, test } from "bun:test";
import { DEFAULT_EXECUTION, ExecutionError, validateExecution } from "../src/config/execution";
import { validateStrategy } from "../src/config/strategy";

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
