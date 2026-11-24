import { describe, expect, test } from "bun:test";
import {
  CONFLICT_QUESTION,
  displayRunLetter,
  nextRunPriority,
  orchestratorBlock,
  runLetter,
  runPriorityLabel,
  runStatus,
  RUNS_EMPTY,
  stepMarkerFor,
  stepMarkerGlyph,
  waitsOnLabel,
} from "../src/view-model/runs";
import { runAttentionLetter } from "../src/workflow/attention";

describe("run letter", () => {
  test("deterministic fallback matches workflow attention letter", () => {
    for (const id of ["r-aaaaaaaaaa", "r-bbbbbbbbbb", "r-zzzzzzzzzz", "run-1"]) {
      expect(runLetter(id)).toBe(runAttentionLetter(id));
    }
  });
  test("stored letter wins over the Phase 6 fallback", () => {
    expect(displayRunLetter({ id: "r-aaaaaaaaaa", letter: "Q" })).toBe("Q");
    expect(displayRunLetter({ id: "r-aaaaaaaaaa", letter: "q" })).toBe("Q");
    expect(displayRunLetter({ id: "r-aaaaaaaaaa" })).toBe(runLetter("r-aaaaaaaaaa"));
  });
});

describe("run labels", () => {
  test("status, priority, waits-on and empty copy", () => {
    expect(runStatus("waiting").label).toBe("Waiting");
    expect(runPriorityLabel(undefined)).toBe("Normal");
    expect(runPriorityLabel("background")).toBe("Background");
    expect(nextRunPriority("urgent")).toBe("normal");
    expect(nextRunPriority("background")).toBe("urgent");
    expect(waitsOnLabel("you")).toBe("You");
    expect(waitsOnLabel(null)).toBe("—");
    expect(RUNS_EMPTY).toContain("pacer run start");
    expect(CONFLICT_QUESTION).toContain("changed");
  });
  test("orchestrator block formats planner-at-limit with a wake time", () => {
    const at = Date.UTC(2026, 10, 23, 11, 0, 0) / 1000; // 18:00 Asia/Ho_Chi_Minh
    expect(orchestratorBlock(
      { state: "blocked", reason: "planner at limit", next_wake_at: at },
      at - 60,
      "Asia/Ho_Chi_Minh",
    )).toBe("planner at limit until 18:00");
    expect(orchestratorBlock({ state: "idle" }, at)).toBe("Orchestrator idle");
  });
  test("step markers", () => {
    expect(stepMarkerGlyph(stepMarkerFor({ status: "running" }))).toBe("▶");
    expect(stepMarkerGlyph(stepMarkerFor({ status: "done" }))).toBe("✓");
    expect(stepMarkerGlyph(stepMarkerFor({ status: "failed" }))).toBe("✕");
    expect(stepMarkerGlyph(stepMarkerFor({ status: "waiting", waitsOnYou: true }))).toBe("?");
    expect(stepMarkerGlyph(stepMarkerFor({ status: "waiting" }))).toBe("…");
  });
});
