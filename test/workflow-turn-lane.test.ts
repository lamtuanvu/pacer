// The lane of an orchestrator turn: headless unless its step is interactive, in
// every launch path, and never held open for the person (it must settle).
import { expect, test } from "bun:test";
import { taskLaunchChoice } from "../src/exec/launch";
import { heldOpenForHuman } from "../src/messaging/participants";
import { createTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

test("a task's lane overrides the runner's launch mode only where it asks to", () => {
  expect(taskLaunchChoice({ kind: "orchestrate", interactive: true })).toEqual({ mode: "interactive", explicit: true });
  expect(taskLaunchChoice({ kind: "orchestrate", interactive: false })).toEqual({ mode: "headless", explicit: true });
  expect(taskLaunchChoice({ kind: "feature", interactive: false })).toEqual({ mode: "headless", explicit: true });
  // A delegated interactive lane and an unmarked task keep the runner's configuration.
  expect(taskLaunchChoice({ kind: "feature", interactive: true })).toBeUndefined();
  expect(taskLaunchChoice({ kind: "orchestrate" })).toBeUndefined();
});

test("an interactive orchestrator turn is not held open for the person", () => {
  const ctx = fakeCtx();
  const make = (kind: string) => createTask(ctx, {
    brief: { goal: "g", repo: tmpDir() }, kind, requestedExecutor: null, timeoutS: 60, interactive: true,
  });
  expect(heldOpenForHuman(ctx, make("orchestrate"), "human")).toBe(false);
  expect(heldOpenForHuman(ctx, make("feature"), "human")).toBe(true);
});
