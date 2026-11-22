// Phase 2 Task 10 companion: non-prg_ authorizeWorkOperation matrix.
// Kept under work-grant*.test.ts so the scope regression Done-when glob still runs it.
import { describe, expect, test } from "bun:test";
import {
  authorizeWorkOperation,
  TASK_REVIEW_REFUSAL,
} from "../src/core/work";
import { CoreError } from "../src/core/errors";
import { issueAssistantGrant, issueWorkGrant, registerWork } from "../src/dispatch/work";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

function grantedWork(ctx: Ctx) {
  const parent = createTask(ctx, { brief: { goal: "root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, parent.id, { allowDelegation: true });
  updateTask(ctx, parent.id, t => { t.state = "running"; });
  const child = createTask(ctx, { brief: { goal: "child", repo: parent.brief.repo }, kind: "debug", requestedExecutor: null, timeoutS: 60 });
  registerWork(ctx, child.id, {}, parent.id);
  const plain = createTask(ctx, { brief: { goal: "plain", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 60 });
  const grant = issueWorkGrant(ctx, parent.id, 1);
  const executor = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_WORK_GRANT: grant } };
  return { parent, child, plain, executor };
}

function outcome(fn: () => void): { ok: true } | { ok: false; code: string; message: string } {
  try {
    fn();
    return { ok: true };
  } catch (e) {
    const err = e as CoreError;
    return { ok: false, code: err.code, message: err.message };
  }
}

describe("authorizeWorkOperation for non-prg_ callers", () => {
  test("table-driven: operator, work grant, assistant grant and enforcement match pre-prg_ behaviour", () => {
    const ctx = fakeCtx({ now: NOW });
    const { parent, child, plain, executor } = grantedWork(ctx);
    const assistant = issueAssistantGrant(ctx, {
      turnId: "turn-scope",
      conversationId: "conv-scope",
      expiresAt: NOW + 60,
    });
    const withAssistant = { ...ctx, env: { ...ctx.env, PACER_ASSISTANT_GRANT: assistant } };
    const withEnforcement = { ...ctx, env: { ...ctx.env, PACER_ENFORCEMENT_TOKEN: "pet_x" } };
    const bareExecutor = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } };

    type Case = {
      name: string;
      ctx: Ctx;
      op: string;
      params: unknown;
      expect: { ok: true } | { ok: false; code: string; message: string | RegExp };
    };

    const cases: Case[] = [
      { name: "operator task.get", ctx, op: "task.get", params: { id: plain.id }, expect: { ok: true } },
      { name: "operator task.review", ctx, op: "task.review", params: { id: plain.id, verdict: "accept" }, expect: { ok: true } },
      { name: "operator run.start", ctx, op: "run.start", params: { workflow: "t/x" }, expect: { ok: true } },
      { name: "operator msg.send", ctx, op: "msg.send", params: { to: "human", body: "hi" }, expect: { ok: true } },

      { name: "work grant task.get self", ctx: executor, op: "task.get", params: { id: parent.id }, expect: { ok: true } },
      { name: "work grant task.review child", ctx: executor, op: "task.review", params: { id: child.id, verdict: "accept" }, expect: { ok: true } },
      { name: "work grant task.review self", ctx: executor, op: "task.review", params: { id: parent.id, verdict: "accept" }, expect: { ok: false, code: "not_allowed", message: TASK_REVIEW_REFUSAL } },
      { name: "work grant assistant.tool", ctx: executor, op: "assistant.tool", params: { turnId: "turn-scope" }, expect: { ok: false, code: "not_allowed", message: /not allowed by this work grant|is not allowed/ } },
      { name: "work grant dispatch.child", ctx: executor, op: "dispatch.child", params: {}, expect: { ok: true } },
      { name: "work grant run.start", ctx: executor, op: "run.start", params: { workflow: "t/x" }, expect: { ok: false, code: "not_allowed", message: "Operation is not allowed by this work grant" } },

      { name: "bare executor dispatch.child", ctx: bareExecutor, op: "dispatch.child", params: {}, expect: { ok: false, code: "not_allowed", message: "A scoped work grant is required" } },
      { name: "bare executor task.get", ctx: bareExecutor, op: "task.get", params: { id: plain.id }, expect: { ok: true } },
      { name: "bare executor task.review plain", ctx: bareExecutor, op: "task.review", params: { id: plain.id, verdict: "accept" }, expect: { ok: false, code: "not_allowed", message: TASK_REVIEW_REFUSAL } },

      { name: "assistant.tool own turn", ctx: withAssistant, op: "assistant.tool", params: { turnId: "turn-scope", name: "snapshot" }, expect: { ok: true } },
      { name: "assistant.tool other turn", ctx: withAssistant, op: "assistant.tool", params: { turnId: "other" }, expect: { ok: false, code: "not_allowed", message: /belongs to another turn/ } },
      { name: "assistant task.get", ctx: withAssistant, op: "task.get", params: { id: plain.id }, expect: { ok: false, code: "not_allowed", message: /assistant grant runs assistant\.tool only/ } },

      { name: "enforcement denied", ctx: withEnforcement, op: "dispatch.enforcement.denied", params: {}, expect: { ok: true } },
      { name: "enforcement other op", ctx: withEnforcement, op: "task.get", params: { id: plain.id }, expect: { ok: false, code: "not_allowed", message: /Enforcement identity only reports/ } },
      { name: "no enforcement token", ctx, op: "dispatch.enforcement.denied", params: {}, expect: { ok: false, code: "not_allowed", message: "An enforcement identity is required" } },
    ];

    for (const c of cases) {
      const got = outcome(() => authorizeWorkOperation(c.ctx, c.op, c.params));
      if (c.expect.ok) {
        expect(got, c.name).toEqual({ ok: true });
      } else if (typeof c.expect.message === "string") {
        expect(got, c.name).toEqual({ ok: false, code: c.expect.code, message: c.expect.message });
      } else {
        expect(got.ok, c.name).toBe(false);
        if (!got.ok) {
          expect(got.code, c.name).toBe(c.expect.code);
          expect(got.message, c.name).toMatch(c.expect.message);
        }
      }
    }
  });
});
