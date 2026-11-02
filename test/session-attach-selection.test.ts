import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { attachDirectory } from "../src/session/attach";
import { sessionSocket, sessionDirectory } from "../src/session/service";
test("attach selects explicit, active takeover and latest numeric attempts with recording guards", () => {
  const ctx = fakeCtx(),
    task = createTask(ctx, {
      brief: { goal: "fixture", repo: ctx.home },
      kind: null,
      requestedExecutor: null,
      timeoutS: 10,
    });
  const root = join(ctx.pacerHome, "runs", task.id);
  expect(() => attachDirectory(ctx, "unknown")).toThrow("unknown task");
  mkdirSync(root, { recursive: true });
  expect(() => attachDirectory(ctx, task.id)).toThrow(
    "invalid session attempt",
  );
  for (const n of ["1", "2", "03", "ignore", "4-takeover"])
    mkdirSync(join(root, n));
  writeFileSync(join(root, "3"), ""); // numeric name participates even if not a directory
  expect(() => attachDirectory(ctx, task.id)).toThrow("no PTY recording");
  rmSync(join(root, "3"));
  expect(() => attachDirectory(ctx, task.id)).toThrow("no PTY recording"); // 03 converts to 3, not path 03
  writeFileSync(join(root, "1", "session.log"), "");
  expect(attachDirectory(ctx, task.id, 1)).toBe(join(root, "1"));
  for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => attachDirectory(ctx, task.id, attempt)).toThrow(
      "invalid session attempt",
    );
  const dir = join(root, "4-takeover");
  writeFileSync(join(dir, "session.ckpt"), "{}");
  updateTask(ctx, task.id, (t) => {
    t.run = {
      dir,
      attempt: 4,
      executor: "codex",
      startedAt: 1,
      mode: "current",
      workdir: ctx.home,
      logFile: "log",
    };
  });
  expect(attachDirectory(ctx, task.id)).toBe(dir);
  expect(attachDirectory(ctx, task.id, 4)).toBe(dir);
  expect(attachDirectory(ctx, task.id, 1)).toBe(join(root, "1"));
  writeFileSync(
    join(dir, "session.sock.path"),
    " \ufeff/tmp/fixture.sock\u00a0\n",
  );
  expect(sessionSocket(dir)).toBe("/tmp/fixture.sock");
  updateTask(ctx, task.id, (t) => {
    t.run!.host = "remote";
  });
  expect(sessionDirectory(ctx, task.id)).toBeNull();
  writeFileSync(join(dir, "session.remote-full"), "remote");
  expect(sessionDirectory(ctx, task.id)).toBe(dir);
});
