import { expect, test } from "bun:test";
import { createTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("createTask never reuses an id already on disk, even within one second", () => {
  const ctx = fakeCtx();
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i++) ids.add(createTask(ctx, { brief: { goal: "g", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 }).id);
  expect(ids.size).toBe(2000);
});
