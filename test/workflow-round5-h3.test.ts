// Round-5 H3: prompt overflow must keep fences closed, keep run-state, and stay ≤32 KiB.
import { describe, expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import {
  addDefinition, insertRun, insertStep, stepsOfRun,
} from "../src/workflow/store";
import { buildTurnPrompt } from "../src/workflow/orchestrator";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const PROMPT_CAP = 32 * 1024;

describe("round-5 H3: prompt overflow fences and summary", () => {
  test("large brief plus several open blocks keeps summary, closed fences, ≤32 KiB", () => {
    const ctx = fakeCtx({ now: NOW });
    const bigBrief = "B".repeat(12 * 1024);
    const bigPrompt = "P".repeat(10 * 1024);
    const run = insertRun(ctx, {
      workflow: "t/h3-cap", version: 1, repo: tmpDir(), brief: bigBrief, title: "h3",
    });
    const def: WorkflowDef = {
      id: "t/h3-cap", version: 1,
      steps: {
        a: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        b: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        c: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        d: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" }, { from: "b", to: "c" },
        { from: "c", to: "d" }, { from: "d", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, def, "s");
    for (const id of ["a", "b", "c", "d"]) {
      insertStep(ctx, { runId: run.id, stepId: id, attempt: 1, status: "running" });
    }
    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(PROMPT_CAP);
    // Run-state summary must survive (error=/task=/run= live there).
    expect(prompt).toMatch(/--- data [a-f0-9]+ run state ---/);
    expect(prompt).toContain(`run: ${run.id}`);
    expect(prompt).toContain("steps:");
    // Every real fence open line must have a matching close (ignore preamble examples).
    const opens = [...prompt.matchAll(/^--- data ([a-f0-9]+) (.+) ---$/gm)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) {
      const nonce = m[1]!;
      expect(prompt).toMatch(new RegExp(`^--- end data ${nonce} ---$`, "m"));
    }
    // Dropping whole low-priority blocks leaves a visible truncation marker (A-M3).
    expect(prompt).toMatch(/omitted blocks to fit budget/);
  });
});
