import { expect, test } from "bun:test";
import { createConversation } from "../src/session/create";
import {
  createDraft,
  storeAttachment,
  resolveAttachments,
} from "../src/attachments/store";
import { fakeCtx, gitRepo, realRun, withLoginIndicators } from "./helpers";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readTask, createTask, updateTask } from "../src/tasks/store";
import { callOp } from "../src/api/ops";

test("resume refuses an ended session while its previous runner is still settling", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {
    brief: { goal: "Explain", repo: ctx.home },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 0,
    interactionMode: "conversation",
  });
  const stopped = updateTask(ctx, task.id, (t) => {
    t.state = "stopped";
    t.runnerPid = process.pid;
    t.conversation = { activity: "ended", agentSessionId: "native-id" };
  });
  await expect(
    callOp(ctx, "session.resume", { id: task.id, expect_rev: stopped.rev }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(readTask(ctx, task.id)?.runnerPid).toBe(process.pid);
});

test("a failed resume launch preserves native recovery identity and output", async () => {
  const repo = gitRepo();
  const ctx = withLoginIndicators(
    fakeCtx({
      run: async (args, timeout, options) =>
        args[0] === "codex" && args[1] === "--version"
          ? { code: 0, stdout: "codex-cli 0.163.0", stderr: "" }
          : realRun(args, timeout, options),
    }),
  );
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  codex: {}\n",
  );
  const task = createTask(ctx, {
    brief: { goal: "Explain", repo },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 0,
    interactionMode: "conversation",
  });
  const stopped = updateTask(ctx, task.id, (t) => {
    t.state = "stopped";
    t.conversation = { activity: "ended", agentSessionId: "native-id" };
    t.result = {
      status: "stopped",
      executor: "codex",
      model: null,
      files: "",
      report: "Retained output",
      backend: "direct",
    };
  });
  await expect(
    callOp(
      ctx,
      "session.resume",
      { id: task.id, expect_rev: stopped.rev },
      {
        spawnRunner: () => {
          throw Error("spawn failed");
        },
      },
    ),
  ).rejects.toMatchObject({ code: "not_allowed" });
  expect(readTask(ctx, task.id)).toMatchObject({
    state: "failed",
    conversation: { activity: "ended", agentSessionId: "native-id" },
    result: { report: "Retained output" },
  });
});

test("conversation creation atomically claims files and retries the same request without spawning twice", async () => {
  const repo = gitRepo(),
    ctx = fakeCtx({ run: realRun }),
    draft = createDraft(ctx);
  const file = await storeAttachment(ctx, {
    draftId: draft.id,
    batchId: "one",
    name: "context.txt",
    mime: "text/plain",
    body: new Blob(["hello"]).stream(),
  });
  let spawns = 0;
  const deps = {
    prepare: async () => ({
      repo: { key: "local:test", path: repo, label: "repo" },
      branches: ["main"],
      base: "main",
      checkouts: [{ path: repo, branch: "main", dirty: false }],
      executors: [
        {
          id: "codex",
          agent: "codex",
          account: "default",
          version: "0.163.0",
          available: true,
          capabilities: {
            interactive: true,
            resume: true,
            launchImages: true,
            liveImages: false,
            files: true,
          },
        },
      ],
    }),
    spawnRunner: () => {
      spawns++;
      return process.pid;
    },
  };
  const input = {
    request_id: "first",
    draftId: draft.id,
    request: "Explain the code",
    repo,
    executor: "codex",
    workspace: { mode: "new" as const, base: "main" },
    attachments: [file.id],
  };
  const first = await createConversation(ctx, input, deps),
    again = await createConversation(ctx, input, deps);
  expect(again.task_id).toBe(first.task_id);
  expect(spawns).toBe(1);
  expect(readTask(ctx, first.task_id)).toMatchObject({
    interactionMode: "conversation",
    requestedExecutor: "codex",
    placement: { requested: "new" },
  });
  expect(resolveAttachments(ctx, first.task_id).map((f) => f.name)).toEqual([
    "context.txt",
  ]);
  await expect(
    createConversation(ctx, { ...input, request: "different" }, deps),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("existing checkout is reserved at creation, including queued sessions", async () => {
  const repo = gitRepo(),
    ctx = fakeCtx({ run: realRun });
  const deps = {
    prepare: async () => ({
      repo: { key: "local:test", path: repo, label: "repo" },
      branches: ["main"],
      base: "main",
      checkouts: [{ path: repo, branch: "main", dirty: false }],
      executors: [
        {
          id: "codex",
          agent: "codex",
          account: "default",
          version: "0.163.0",
          available: true,
          capabilities: {
            interactive: true,
            resume: true,
            launchImages: true,
            liveImages: false,
            files: true,
          },
        },
      ],
    }),
    spawnRunner: () => process.pid,
  };
  const input = {
    request_id: "first",
    draftId: createDraft(ctx).id,
    request: "Explain",
    repo,
    executor: "codex",
    workspace: { mode: "current" as const, path: repo },
    attachments: [],
  };
  await createConversation(ctx, input, deps);
  await expect(
    createConversation(
      ctx,
      { ...input, request_id: "second", draftId: createDraft(ctx).id },
      deps,
    ),
  ).rejects.toMatchObject({ code: "conflict" });
});
