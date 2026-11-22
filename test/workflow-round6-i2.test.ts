// Round-6 I2: oversized rendered open orch blocks stay present (header+instruction), ≤32 KiB.
import { describe, expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import {
  addDefinition, insertRun, insertStep, stepsOfRun, updateStep,
} from "../src/workflow/store";
import { buildTurnPrompt } from "../src/workflow/orchestrator";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const PROMPT_CAP = 32 * 1024;

describe("round-6 I2: bound rendered open orch blocks under prompt cap", () => {
  test("16 KiB brief + 16 KiB result keeps ## Orchestrator step, instruction, closed fences, ≤32 KiB", () => {
    const ctx = fakeCtx({ now: NOW });
    const bigBrief = "B".repeat(16 * 1024);
    const bigResult = "R".repeat(16 * 1024);
    const run = insertRun(ctx, {
      workflow: "t/i2-cap", version: 1, repo: tmpDir(), brief: bigBrief, title: "i2",
    });
    const def: WorkflowDef = {
      id: "t/i2-cap", version: 1,
      steps: {
        work: { type: "agent", kind: "research", prompt: "W" },
        orch: {
          type: "agent",
          role: "orchestrator",
          prompt: "Review {{brief}} against {{steps.work.result}}",
        },
        done: { type: "end" },
      },
      edges: [{ from: "work", to: "orch" }, { from: "orch", to: "done" }],
      entry: "work",
    };
    addDefinition(ctx, def, "s");
    insertStep(ctx, { runId: run.id, stepId: "work", attempt: 1, status: "done" });
    updateStep(ctx, { runId: run.id, stepId: "work", attempt: 1 }, { result: { text: bigResult } });
    insertStep(ctx, { runId: run.id, stepId: "orch", attempt: 1, status: "running" });

    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(PROMPT_CAP);
    expect(prompt).toContain("## Orchestrator step");
    expect(prompt).toMatch(/pacer step result/i);
    expect(prompt).toMatch(/--- data [a-f0-9]+ run state ---/);
    const opens = [...prompt.matchAll(/^--- data ([a-f0-9]+) (.+) ---$/gm)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) {
      expect(prompt).toMatch(new RegExp(`^--- end data ${m[1]!} ---$`, "m"));
    }
    // When the trailing brief fence is dropped to keep the open step, name the drop.
    if (!/^--- data [a-f0-9]+ from the brief ---$/m.test(prompt)) {
      expect(prompt).toMatch(/omitted blocks to fit budget/);
    }
  });

  test("two large step results in one orch template still keep header and instruction", () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, {
      workflow: "t/i2-two", version: 1, repo: tmpDir(), brief: "short", title: "i2b",
    });
    const def: WorkflowDef = {
      id: "t/i2-two", version: 1,
      steps: {
        a: { type: "agent", kind: "research", prompt: "A" },
        b: { type: "agent", kind: "research", prompt: "B" },
        orch: {
          type: "agent",
          role: "orchestrator",
          prompt: "Compare {{steps.a.result}} with {{steps.b.result}}",
        },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" }, { from: "b", to: "orch" }, { from: "orch", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, def, "s");
    insertStep(ctx, { runId: run.id, stepId: "a", attempt: 1, status: "done" });
    updateStep(ctx, { runId: run.id, stepId: "a", attempt: 1 }, {
      result: { text: "A".repeat(16 * 1024) },
    });
    insertStep(ctx, { runId: run.id, stepId: "b", attempt: 1, status: "done" });
    updateStep(ctx, { runId: run.id, stepId: "b", attempt: 1 }, {
      result: { text: "B".repeat(16 * 1024) },
    });
    insertStep(ctx, { runId: run.id, stepId: "orch", attempt: 1, status: "running" });

    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(PROMPT_CAP);
    expect(prompt).toContain("## Orchestrator step");
    expect(prompt).toMatch(/pacer step result/i);
    const opens = [...prompt.matchAll(/^--- data ([a-f0-9]+) (.+) ---$/gm)];
    for (const m of opens) {
      expect(prompt).toMatch(new RegExp(`^--- end data ${m[1]!} ---$`, "m"));
    }
  });
});
