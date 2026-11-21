// UI/accessibility fixes for workflow attention copy and actions (PR #1172 review).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import {
  getRun, insertRun, updateRun, type RunRow,
} from "../src/workflow/store";
import {
  countMessageTurn, countOrchestratorTurn, parseBudget, parseSpent, serializeBudget, serializeSpent,
} from "../src/workflow/budget";
import { deriveWorkflowAttention, switchPlannerTarget } from "../src/workflow/attention";
import { attentionStatus } from "../src/view-model/words";

const NOW = 1_700_000_000;

function titledRun(overrides: Partial<Parameters<typeof insertRun>[1]> = {}): { ctx: ReturnType<typeof fakeCtx>; run: RunRow } {
  const ctx = fakeCtx({ now: NOW });
  const run = insertRun(ctx, {
    workflow: "t/ui-attn",
    version: 1,
    repo: tmpDir(),
    brief: "brief",
    title: "Ship the feature",
    budget: serializeBudget({ orchestratorTurns: 5, messageTurns: 5 }),
    spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    ...overrides,
  });
  return { ctx, run };
}

describe("workflow attention plain wording", () => {
  test("failed / unresolved / spent titles and details use the run title and no internals", () => {
    const { ctx, run } = titledRun();
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    expect(failed.title).toBe('Workflow "Ship the feature" stopped');
    expect(failed.detail).toBe(
      "The planner failed several times in a row. Retry it, switch planner, or stop the run.",
    );
    expect(failed.title + failed.detail).not.toMatch(/orchestrator|wake|\bturn\b/i);
    expect(failed.title).not.toContain(run.id);

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      orchestratorState: "blocked",
      reason: "unresolved wake after 2 done turns",
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0, blockedBy: "unresolved" }),
    });
    const unresolved = deriveWorkflowAttention(ctx).find(i => i.id === `unresolved_wake:${run.id}`)!;
    expect(unresolved.title).toBe('Workflow "Ship the feature" is waiting for a restart');
    expect(unresolved.detail).toBe(
      "Nothing it did resolved what it was waiting for. Retry it, switch planner, or stop the run.",
    );
    expect(unresolved.title + unresolved.detail).not.toMatch(/orchestrator|wake|\bturn\b/i);

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      orchestratorState: "idle",
      reason: null,
      spent: serializeSpent({ orchestratorTurns: 5, messageTurns: 0 }),
    });
    const spent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_spent:${run.id}`)!;
    expect(spent.title).toBe('Workflow "Ship the feature" used its planning budget');
    expect(spent.detail).toBe("Add more planning, or stop the run.");
    expect(spent.title + spent.detail).not.toMatch(/orchestrator|wake|\bturn\b/i);

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 5 }),
    });
    const msgSpent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_msg_spent:${run.id}`)!;
    expect(msgSpent.title).toBe('Workflow "Ship the feature" used its message budget');
    expect(msgSpent.detail).toBe("Add more messages, or stop the run.");
    expect(msgSpent.title + msgSpent.detail).not.toMatch(/orchestrator|wake|\bturn\b/i);
  });

  test("80% warnings use plain planning/message budget wording and the run title", () => {
    const { ctx, run } = titledRun();
    for (let i = 0; i < 4; i++) countOrchestratorTurn(ctx, run.id);
    const warn = deriveWorkflowAttention(ctx).find(i => i.id === `budget_warn:${run.id}`)!;
    expect(warn.title).toBe('Workflow "Ship the feature" has used most of its planning budget');
    expect(warn.detail).toBe("Used 4 of 5 planning steps.");
    expect(warn.title).not.toContain(run.id);

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    for (let i = 0; i < 4; i++) countMessageTurn(ctx, run.id);
    const msgWarn = deriveWorkflowAttention(ctx).find(i => i.id === `budget_msg_warn:${run.id}`)!;
    expect(msgWarn.title).toBe('Workflow "Ship the feature" has used most of its message budget');
    expect(msgWarn.detail).toBe("Used 4 of 5 messages.");
  });

  test("titles, details and action labels avoid orchestrator/wake/turn and raw run ids", () => {
    const { ctx, run } = titledRun();
    // Cover spent + warn + failed surfaces by forcing each kind in turn.
    const samples: Array<{ patch: Parameters<typeof updateRun>[3]; id: string }> = [
      {
        patch: { orchestratorState: "blocked", reason: "planner failed", spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }) },
        id: `orchestrator_failed:${run.id}`,
      },
      {
        patch: {
          orchestratorState: "blocked",
          reason: "unresolved",
          spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0, blockedBy: "unresolved" }),
        },
        id: `unresolved_wake:${run.id}`,
      },
      {
        patch: { orchestratorState: "idle", reason: null, spent: serializeSpent({ orchestratorTurns: 5, messageTurns: 0 }) },
        id: `budget_spent:${run.id}`,
      },
      {
        patch: { spent: serializeSpent({ orchestratorTurns: 4, messageTurns: 0 }) },
        id: `budget_warn:${run.id}`,
      },
      {
        patch: { spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 5 }) },
        id: `budget_msg_spent:${run.id}`,
      },
      {
        patch: { spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 4 }) },
        id: `budget_msg_warn:${run.id}`,
      },
    ];
    for (const { patch, id } of samples) {
      updateRun(ctx, run.id, getRev(ctx, run.id), patch);
      const item = deriveWorkflowAttention(ctx).find(i => i.id === id)!;
      const surfaces = [
        item.title,
        item.detail,
        ...item.actions.flatMap(a => [a.label, a.confirm ?? ""]),
      ].join("\n");
      expect(surfaces).not.toMatch(/orchestrator|wake|turn/i);
      expect(surfaces).not.toMatch(/run_[a-z0-9]+/i);
      expect(surfaces).not.toContain(run.id);
    }
  });

  test("untitled runs use 'A workflow run' as the subject", () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, {
      workflow: "t/no-title",
      version: 1,
      repo: tmpDir(),
      brief: "b",
      title: "",
      budget: serializeBudget({ orchestratorTurns: 5, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 5, messageTurns: 0 }),
    });
    // Empty title may be replaced by workflow id at insert; force blank for the fallback path.
    updateRun(ctx, run.id, run.rev, {
      title: "",
      orchestratorState: "blocked",
      reason: "planner failed",
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    expect(failed.title).toBe("A workflow run stopped");
    expect(failed.title).not.toContain(run.id);
    expect(failed.title).not.toMatch(/Workflow "/);

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      spent: serializeSpent({ orchestratorTurns: 5, messageTurns: 0 }),
      orchestratorState: "idle",
      reason: null,
    });
    const spent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_spent:${run.id}`)!;
    expect(spent.title).toBe("A workflow run used its planning budget");
  });

  test("long and multi-line titles are clipped to the first line at 60 characters", () => {
    const long = "X".repeat(61);
    expect(long.length).toBe(61);
    const { ctx, run } = titledRun({
      title: `${long}\nSecond line ignored`,
    });
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed",
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    expect(failed.title).toBe(
      `Workflow "${long.slice(0, 60)}…" stopped`,
    );
    expect(failed.title).not.toContain("Second line");
  });

  test("a lone CR also starts a new title line", () => {
    const { ctx, run } = titledRun({
      title: "First line\rSecond line ignored",
    });
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed",
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    expect(failed.title).toBe('Workflow "First line" stopped');
    expect(failed.title).not.toContain("Second line");
  });

  test("title clip counts code points so an emoji on the 60-boundary is kept whole", () => {
    // 59 ASCII + one emoji (U+1F525, a surrogate pair in UTF-16) → 60 code points.
    // UTF-16 length is 61; a unit slice(0,60) would leave a lone high surrogate.
    const title = `${"a".repeat(59)}\u{1F525}extra`;
    expect([...title].length).toBeGreaterThan(60);
    expect(title.length).toBeGreaterThan(60); // UTF-16 units
    const { ctx, run } = titledRun({ title });
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed",
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    const expected = `Workflow "${"a".repeat(59)}\u{1F525}…" stopped`;
    expect(failed.title).toBe(expected);
    expect(failed.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(failed.title).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test("title clip keeps a ZWJ emoji sequence as whole code points (no mid-sequence UTF-16 cut)", () => {
    // Family emoji is several code points joined by ZWJ; clip by code point at 60.
    const zwj = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // man+ZWJ+woman+ZWJ+girl
    const title = `${"b".repeat(58)}${zwj}tail`;
    const points = Array.from(title);
    expect(points.length).toBeGreaterThan(60);
    const { ctx, run } = titledRun({ title });
    updateRun(ctx, run.id, run.rev, {
      spent: serializeSpent({ orchestratorTurns: 5, messageTurns: 0 }),
    });
    const spent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_spent:${run.id}`)!;
    const clipped = points.slice(0, 60).join("");
    expect(spent.title).toBe(`Workflow "${clipped}…" used its planning budget`);
    expect(spent.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(spent.title).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("workflow attention 80% warn severity mapping", () => {
  test("warn items are not Out of quota / bad; failed stays bad-or-blocked", () => {
    const { ctx, run } = titledRun();
    for (let i = 0; i < 4; i++) countOrchestratorTurn(ctx, run.id);
    const warn = deriveWorkflowAttention(ctx).find(i => i.id === `budget_warn:${run.id}`)!;
    const warnStatus = attentionStatus(warn);
    expect(warnStatus.tone).not.toBe("bad");
    expect(warnStatus.label).not.toBe("Out of quota");

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    for (let i = 0; i < 4; i++) countMessageTurn(ctx, run.id);
    const msgWarn = deriveWorkflowAttention(ctx).find(i => i.id === `budget_msg_warn:${run.id}`)!;
    const msgStatus = attentionStatus(msgWarn);
    expect(msgStatus.tone).not.toBe("bad");
    expect(msgStatus.label).not.toBe("Out of quota");

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    const failedStatus = attentionStatus(failed);
    expect(failed.severity === "blocked" || failedStatus.tone === "bad").toBe(true);
  });
});

describe("workflow attention action consistency", () => {
  test("every Stop run action uses the same label and confirm", () => {
    const { ctx, run } = titledRun();
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    const stop = failed.actions.find(a => a.op === "run.stop")!;
    expect(stop.label).toBe("Stop run");
    expect(stop.confirm).toBe("Stop this run?");
    expect(stop.style).toBe("danger");
  });

  test("Switch planner names a different target; omit when the injected list has no alternative", () => {
    const { ctx, run } = titledRun();
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
      planner: "claude-code",
    });
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`)!;
    const switchAction = failed.actions.find(a => a.op === "run.set_planner")!;
    expect(switchAction.label).toMatch(/^Switch to /);
    expect(switchAction.label).not.toBe("Switch planner");
    expect(switchAction.params).toEqual(expect.objectContaining({
      id: run.id,
      expect_rev: expect.any(Number),
      planner: expect.any(String),
    }));
    expect(switchAction.params.planner).not.toBe("claude-code");
    expect(switchAction.label).toContain("Codex");

    expect(switchPlannerTarget("claude-code", ["claude-code"])).toBeNull();
    expect(switchPlannerTarget("codex", ["claude-code", "codex"])).toBe("claude-code");
  });

  test("Raise budget labels say how much is added", () => {
    const { ctx, run } = titledRun();
    for (let i = 0; i < 5; i++) countOrchestratorTurn(ctx, run.id);
    const spent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_spent:${run.id}`)!;
    expect(spent.actions.find(a => a.op === "run.set_budget")!.label).toBe("Add 20 planning steps");

    updateRun(ctx, run.id, getRev(ctx, run.id), {
      orchestratorState: "idle",
      reason: null,
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 5 }),
    });
    const msgSpent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_msg_spent:${run.id}`)!;
    expect(msgSpent.actions.find(a => a.op === "run.set_budget")!.label).toBe("Add 20 messages");
  });

  test("Add 20 raises the current budget by exactly 20, not up to the default", async () => {
    const cases: Array<{ budget: number; expected: number }> = [
      { budget: 5, expected: 25 },
      { budget: 60, expected: 80 },
    ];
    for (const { budget, expected } of cases) {
      const ctx = fakeCtx({ now: NOW });
      mkdirSync(ctx.pacerHome, { recursive: true });
      writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
      let run = insertRun(ctx, {
        workflow: "t/raise-exact",
        version: 1,
        repo: tmpDir(),
        brief: "b",
        title: "Raise exact",
        budget: serializeBudget({ orchestratorTurns: budget, messageTurns: budget }),
        spent: serializeSpent({ orchestratorTurns: budget, messageTurns: 0 }),
      });
      const spent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_spent:${run.id}`)!;
      const raise = spent.actions.find(a => a.op === "run.set_budget")!;
      expect(raise.params).toEqual({
        id: run.id,
        expect_rev: run.rev,
        orchestrator_turns: expected,
      });
      run = await callOp(ctx, raise.op, raise.params) as RunRow;
      expect(parseBudget(run.budget).orchestratorTurns).toBe(budget + 20);

      updateRun(ctx, run.id, run.rev, {
        spent: serializeSpent({ orchestratorTurns: 0, messageTurns: budget }),
      });
      run = getRun(ctx, run.id)!;
      const msgSpent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_msg_spent:${run.id}`)!;
      const raiseMsg = msgSpent.actions.find(a => a.op === "run.set_budget")!;
      expect(raiseMsg.params).toEqual({
        id: run.id,
        expect_rev: run.rev,
        message_turns: expected,
      });
      run = await callOp(ctx, raiseMsg.op, raiseMsg.params) as RunRow;
      expect(parseBudget(run.budget).messageTurns).toBe(budget + 20);
    }
  });
});

function getRev(ctx: ReturnType<typeof fakeCtx>, id: string): number {
  return getRun(ctx, id)!.rev;
}
