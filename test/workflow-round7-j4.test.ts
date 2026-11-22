// Round-7 J4: placeholder-heavy orch templates stay under budget with header+instruction.
import { describe, expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import {
  addDefinition, insertRun, insertStep, stepsOfRun,
} from "../src/workflow/store";
import { buildTurnPrompt } from "../src/workflow/orchestrator";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const PROMPT_CAP = 32 * 1024;

describe("round-7 J4: placeholder-heavy orch block size guard", () => {
  test("200-placeholder template keeps header, instruction, closed fences, ≤32 KiB", () => {
    const ctx = fakeCtx({ now: NOW });
    const parts = Array.from({ length: 200 }, () => "{{brief}}");
    const tpl = `Review:\n${parts.join("\n")}`;
    const run = insertRun(ctx, {
      workflow: "t/j4-ph", version: 1, repo: tmpDir(),
      brief: "B".repeat(4 * 1024), title: "j4",
    });
    const def: WorkflowDef = {
      id: "t/j4-ph", version: 1,
      steps: {
        orch: { type: "agent", role: "orchestrator", prompt: tpl },
        done: { type: "end" },
      },
      edges: [{ from: "orch", to: "done" }],
      entry: "orch",
    };
    addDefinition(ctx, def, "s");
    insertStep(ctx, { runId: run.id, stepId: "orch", attempt: 1, status: "running" });

    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(PROMPT_CAP);
    expect(prompt).toContain("## Orchestrator step");
    expect(prompt).toMatch(/pacer step result/i);
    const opens = [...prompt.matchAll(/^--- data ([a-f0-9]+) (.+) ---$/gm)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) {
      expect(prompt).toMatch(new RegExp(`^--- end data ${m[1]!} ---$`, "m"));
    }
  });
});
