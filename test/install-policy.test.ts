import { expect, test } from "bun:test";
import { policyText } from "../src/install/policy";
import { isDevArgv, pacerArgv, validateInstallArgv } from "../src/install/self";

const planners = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
] as const;

for (const [planner, name] of planners) {
  test(`${planner} policy explains planner responsibilities, modes and task lifecycle`, () => {
    const text = policyText(planner);
    expect(text.split("\n")[0]).toBe("This applies only when you are the planner pacer is configured for; if pacer started you as an executor (PACER_ROLE=executor), ignore it.");
    expect(text).toContain(`# pacer delegation policy (${name} is the planner)\n`);
    expect(text).toContain("plan, decide and review; delegate execution");
    expect(text).toContain("## Modes\n");
    for (const mode of ["strict/emergency", "normal", "relaxed"]) {
      expect(text).toMatch(new RegExp(`\\| ${mode} \\|`));
    }
    for (const tool of ["route", "delegate", "task_wait", "task_status", "task_stop", "report_limit"]) {
      expect(text).toContain(`\`${tool}\``);
    }
    for (const field of ["goal", "repo", "scope", "acceptance", "constraints/context", "kind"]) {
      expect(text).toContain(field);
    }
    expect(text).toContain("verify before reporting done");
    expect(text).toContain("call `task_review(task_id, accepted, kind?)`");
    expect(text).toContain("PACER=off");
    expect(text).not.toMatch(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u20E3/u);
  });

  test(`${planner} policy gives its budget and subagent guard instructions`, () => {
    const text = policyText(planner);
    if (planner === "claude-code" || planner === "codex") {
      expect(text).toContain("block arrives at session start");
    } else {
      expect(text).toContain("At the start of every session, call the pacer MCP tool `budget_status`");
    }
    const subagents = planner === "claude-code"
      ? "Claude-model subagents (general-purpose, Sonnet, Haiku, …)"
      : `${name} subagents`;
    expect(text).toContain(`**${subagents} count as you doing the work**`);
    const enforcement = planner === "opencode"
      ? "Do not use them for execution work unless"
      : "A hook blocks them for execution work unless";
    expect(text).toContain(`${enforcement} the mode is \`relaxed\`, no executor is available, or \`PACER=off\`.`);
    expect(text).toContain("Read-only helpers and reviewers stay allowed.");
  });
}

test("PACER_BIN overrides development and compiled command resolution as one argument", () => {
  expect(pacerArgv({ PACER_BIN: "/opt/pacer tools/pacer" }, ["/bun", "/repo/src/cli.ts"], "/bun"))
    .toEqual(["/opt/pacer tools/pacer"]);
  expect(pacerArgv({ PACER_BIN: "/opt/pacer" }, ["/old/pacer", "status"], "/old/pacer"))
    .toEqual(["/opt/pacer"]);
});

test("without a nonempty PACER_BIN, scripts run with their runtime and binaries run alone", () => {
  for (const extension of ["ts", "js", "mjs"]) {
    expect(pacerArgv({}, ["/bun", `/repo/src/cli.${extension}`, "install"], "/bun"))
      .toEqual(["/bun", `/repo/src/cli.${extension}`]);
  }
  expect(pacerArgv({}, ["/opt/pacer", "install"], "/opt/pacer")).toEqual(["/opt/pacer"]);
  expect(pacerArgv({ PACER_BIN: "" }, ["/bun", "/repo/src/cli.ts"], "/bun"))
    .toEqual(["/bun", "/repo/src/cli.ts"]);
  expect(pacerArgv({}, [], "/opt/pacer")).toEqual(["/opt/pacer"]);
});

test("pacerArgv defaults to the current process arguments and executable", () => {
  expect(pacerArgv({ PACER_BIN: "/opt/pacer" })).toEqual(["/opt/pacer"]);
  const script = process.argv[1] ?? "";
  expect(pacerArgv({})).toEqual(/\.(ts|js|mjs)$/.test(script)
    ? [process.execPath, script] : [process.execPath]);
});

test("only commands with more than one argument point at a development checkout", () => {
  expect(isDevArgv(["/bun", "/repo/src/cli.ts"])).toBe(true);
  expect(isDevArgv(["/opt/pacer"])).toBe(false);
  expect(isDevArgv([])).toBe(false);
  expect(isDevArgv(["/bun", "/repo/src/cli.ts", "extra"])).toBe(true);
});

test("transient worktree commands are refused unless PACER_BIN overrides them", () => {
  expect(() => validateInstallArgv({}, pacerArgv({}, ["/bun", "/repo/.worktrees/fix/src/cli.ts"], "/bun"))).toThrow("PACER_BIN");
  expect(() => validateInstallArgv({}, pacerArgv({}, ["/repo/.worktrees/fix/pacer"], "/repo/.worktrees/fix/pacer"))).toThrow("PACER_BIN");
  const pinned = { PACER_BIN: "/opt/pacer" };
  expect(() => validateInstallArgv(pinned, pacerArgv(pinned, ["/bun", "/repo/.worktrees/fix/src/cli.ts"], "/bun"))).not.toThrow();
});

test("placement guidance covers current, new and automatic decisions",()=>{
 const text=policyText("codex");
 for(const hint of ["worktree: current","uncommitted work","research/review","installed dependencies/build output","small follow-up","worktree: new","the user is editing","parallel tasks","exploratory/risky","worktree_reason","auto"])expect(text).toContain(hint);
});
