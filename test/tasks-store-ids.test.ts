import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { createTask, readTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("createTask never reuses an id already on disk, even within one second", () => {
  const ctx = fakeCtx();
  // All creates use ctx.now: collide with both earlier tasks before succeeding.
  const suffixes = ["0001", "0001", "0002", "0001", "0002", "0003"];
  const random = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => {
    expect(size).toBe(2);
    const hex = suffixes.shift();
    if (!hex) throw new Error("unexpected extra ID attempt");
    return Buffer.from(hex, "hex");
  }) as typeof crypto.randomBytes);
  try {
    const tasks = ["first", "second", "third"].map((goal) => createTask(ctx, {
      brief: { goal, repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60,
    }));
    expect(random).toHaveBeenCalledTimes(6);
    expect(tasks.map((task) => task.id.slice(-4))).toEqual(["0001", "0002", "0003"]);
    for (const task of tasks) expect(readTask(ctx, task.id)).toEqual(task);
  } finally {
    random.mockRestore();
  }
});
