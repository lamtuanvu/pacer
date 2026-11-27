// The hooks `pacer install` writes into an agent's user settings also run inside a planner turn and a delegating
// worker, which hold a scoped grant. A refusal there exits 2, which blocks the agent's prompts, stops and tools.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { main } from "../src/cli";
import { io } from "../src/install/stdin";
import type { Ctx } from "../src/types";
import { claudeCachePaths } from "../src/usage/claude";
import { fakeCtx, withLoginIndicators } from "./helpers";

const ORCHESTRATOR = { PACER_ROLE: "orchestrator", PACER_RUN_GRANT: "prg_fixture", PACER_TASK_ID: "t-20261126-000000-abcd" };
const WORKER = { PACER_ROLE: "executor", PACER_WORK_GRANT: "pwg_fixture", PACER_TASK_ID: "t-20261126-000000-abcd" };
const STRICT = { ...WORKER, PACER_ENFORCEMENT_MODE: "strict", PACER_ENFORCEMENT_TOKEN: `pet_${"0".repeat(64)}`, PACER_PORT: "1" };
const GRANTS: Record<string, Record<string, string>> = {
  "planner turn": ORCHESTRATOR,
  "run grant alone": { PACER_RUN_GRANT: "prg_fixture" },
  "cooperative worker": WORKER,
  "strict worker": STRICT,
};
const REFUSAL = /orchestrator role only allows|work grants only allow/;

/** A measured Claude Code planner with an eligible Codex executor, so the ordinary guard has a reason to deny. */
function plannerCtx(env: Record<string, string> = {}): Ctx {
  const ctx = fakeCtx({ env });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(`${ctx.pacerHome}/strategy.yaml`, "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: { usage: reactive }\n");
  withLoginIndicators(ctx);
  const cache = claudeCachePaths(ctx)[0]!;
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ seven_day: { used_percentage: 50, resets_at: ctx.now + 3 * 86400 }, captured_at: ctx.now }));
  return ctx;
}

async function withStdin<T>(read: () => Promise<string>, work: () => Promise<T>): Promise<T> {
  const original = io.readStdin;
  io.readStdin = read;
  try { return await work(); } finally { io.readStdin = original; }
}

const SILENCED = [
  ...["session", "stop", "prompt"].flatMap(event => ["claude-code", "codex"].map(planner => ["msg", "hook", event, "--planner", planner])),
  ...["claude-code", "codex", "cursor", "opencode"].map(planner => ["status", "--hook", planner]),
  ["statusline"],
];

for (const [holder, grant] of Object.entries(GRANTS)) {
  test(`installed planner hooks do nothing and succeed for a ${holder}`, async () => {
    const ctx = fakeCtx({ env: grant });
    let reads = 0;
    await withStdin(async () => { reads++; return JSON.stringify({ rate_limits: { seven_day: { utilization: 25 } } }); }, async () => {
      for (const argv of SILENCED) expect({ argv, ...await main(argv, ctx) }).toEqual({ argv, code: 0, out: "", err: "" });
    });
    // Nothing was dispatched: no hook input read, no message pulled and no usage or home state written.
    expect(reads).toBe(0);
    expect(existsSync(ctx.pacerHome)).toBe(false);
  });

  test(`only the exact installed hook forms pass the gate for a ${holder}`, async () => {
    const ctx = fakeCtx({ env: grant });
    for (const argv of [
      ["status"], ["status", "--json"], ["status", "--hook"], ["status", "--hook", "other"],
      ["status", "--hook", "claude-code", "--json"], ["statusline", "extra"],
      ["msg", "inbox"], ["msg", "send", "main", "hello"], ["msg", "hook", "stop"],
      ["msg", "hook", "stop", "--planner", "cursor"], ["msg", "hook", "delete", "--planner", "codex"],
      ["msg", "hook", "stop", "--planner", "codex", "extra"], ["session-start", "--planner", "claude-code"],
    ]) {
      const result = await main(argv, ctx);
      expect({ argv, code: result.code, err: result.err }).toEqual({ argv, code: 2, err: expect.stringMatching(REFUSAL) });
    }
  });
}

test("without a grant the same hooks still run", async () => {
  const ctx = plannerCtx();
  const result = await withStdin(async () => "{}", () => main(["status", "--hook", "claude-code"], ctx));
  expect(result.code).toBe(0);
  expect(result.out).toContain("pacer");
});

const call = (tool_name: string, tool_input: object) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input });
const CALLS = {
  Agent: call("Agent", { subagent_type: "general-purpose", prompt: "Implement this" }),
  Task: call("Task", { subagent_type: "general-purpose", prompt: "Implement this" }),
  report: call("Bash", { command: `pacer step result --json '{"answer":"x"}'` }),
  launch: call("Bash", { command: "PACER_ROLE=executor claude -p work" }),
};
const guard = (ctx: Ctx, stdin: string, planner = "claude-code") =>
  withStdin(async () => stdin, () => main(["guard", "--planner", planner], ctx));

test("a planner turn's guard decides exactly what the planner's own session guard decides", async () => {
  for (const [name, stdin] of Object.entries(CALLS)) {
    const ordinary = await guard(plannerCtx(), stdin), turn = await guard(plannerCtx(ORCHESTRATOR), stdin);
    expect({ name, ...turn }).toEqual({ name, code: 0, err: "",
      out: name === "report" ? "" : expect.stringContaining('"permissionDecision":"deny"') });
    // The event id and the top executor come from the same inputs, so the two replies match byte for byte.
    expect(turn.out).toBe(ordinary.out);
  }
});

test("a cooperative worker's guard is the executor exemption; a strict worker's guard still denies native children", async () => {
  for (const stdin of Object.values(CALLS))
    expect(await guard(plannerCtx(WORKER), stdin)).toEqual({ code: 0, out: "", err: "" });
  const native = await guard(plannerCtx(STRICT), CALLS.Agent);
  expect(native.code).toBe(0);
  expect(native.out).toContain("native subagents are blocked");
  expect(await guard(plannerCtx(STRICT), CALLS.report)).toEqual({ code: 0, out: "", err: "" });
});

test("strict mode and other guard forms stay refused under a grant", async () => {
  const refused: [Record<string, string>, string[]][] = [
    [{ ...WORKER, PACER_ENFORCEMENT_MODE: "strict" }, ["guard", "--planner", "claude-code"]],
    [{ ...ORCHESTRATOR, PACER_ENFORCEMENT_MODE: "strict" }, ["guard", "--planner", "claude-code"]],
    [{ ...ORCHESTRATOR, PACER_ENFORCEMENT_MODE: "strict", PACER_ENFORCEMENT_TOKEN: STRICT.PACER_ENFORCEMENT_TOKEN }, ["guard", "--planner", "claude-code"]],
    ...[ORCHESTRATOR, WORKER].flatMap(env => [["guard"], ["guard", "--planner"], ["guard", "--planner", "other"],
      ["guard", "--planner", "claude-code", "extra"]].map(argv => [env, argv] as [Record<string, string>, string[]])),
  ];
  for (const [env, argv] of refused) {
    const result = await withStdin(async () => CALLS.report, () => main(argv, plannerCtx(env)));
    expect({ env, argv, code: result.code, err: result.err }).toEqual({ env, argv, code: 2, err: expect.stringMatching(REFUSAL) });
  }
});
