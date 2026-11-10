import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { NowCard } from "../app/src/screens/trace/Overview";
import type { TaskDetail } from "../src/core/task-detail";
import type { Attempt } from "../src/tasks/types";
const tier: NonNullable<Attempt["tier"]> = { requestedDifficulty: "standard", difficultySource: "explicit", effectiveDifficulty: "standard", targetTier: "medium", selectedTier: "medium", reason: "target-match" };
function render(choice: Attempt["tier"]) {
  const task = { id: "t", state: "done", attempts: [{ executor: "opencode-go", model: "provider/kimi-k2.7-code", tier: choice }], acceptance: { state: "none" }, cost: {}, brief: {}, files: [] } as unknown as TaskDetail;
  return renderToString(<NowCard task={task} compact />);
}
test("NowCard shows the requested tier, target and display model", () => {
  expect(render(tier)).toContain("standard requested · Medium targeted · kimi-k2.7-code on opencode-go");
});
test("NowCard explains each tier fallback", () => {
  expect(render({ ...tier, reason: "executor-fixed-below-target" })).toContain("Ran on the default model: opencode-go has no model rated Medium");
  expect(render({ ...tier, reason: "upward-fallback" })).toContain("Ran a larger model: no usable Medium model");
  expect(render({ ...tier, reason: "unknown-tier-fallback" })).toContain("Ran an unrated model: no rated model was usable");
});
test("legacy tasks have no tier line", () => { expect(render(undefined)).not.toContain("requested ·"); });
