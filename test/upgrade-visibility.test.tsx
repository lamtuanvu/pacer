// test/upgrade-visibility.test.tsx
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "preact-render-to-string";
import { sessionInfo } from "../src/session/service";
import { createTerminal, getTerminal } from "../src/terminal/workspace";
import { createTask, updateTask } from "../src/tasks/store";
import { ReopenToUpdate } from "../app/src/screens/session/ReopenToUpdate";
import { RunningWorkList, type ServiceWork } from "../app/src/screens/settings/RunningWork";
import { fakeCtx, tmpDir } from "./helpers";

const old = JSON.stringify({ pacer: "0.7.0", versions: [1, 1] });

test("a task session reports its host version and whether it needs Reopen to update", async () => {
  const ctx = fakeCtx(), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const dir = join(ctx.pacerHome, "runs", t.id, "1"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.log"), ""); writeFileSync(join(dir, "session.version"), old);
  updateTask(ctx, t.id, x => { x.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: repo, logFile: join(dir, "log") }; });
  expect((await sessionInfo(ctx, t.id, false, false)).hostVersion).toEqual({ pacer: "0.7.0", older: true, supported: false });
});

test("a terminal reports its host version", async () => {
  const ctx = fakeCtx();
  const created = await createTerminal(ctx, { requestId: "visibility-1", kind: "shell", title: "Shell" }, { start: spec => { writeFileSync(join(spec.dir, "session.version"), old); return { pid: 4194302 }; } });
  expect((await getTerminal(ctx, created.id)).hostVersion).toEqual({ pacer: "0.7.0", older: true, supported: false });
});

test("Reopen to update appears only outside the support window", () => {
  expect(renderToString(<ReopenToUpdate host={{ pacer: "0.7.0", supported: false }} />)).toContain("Reopen to update");
  expect(renderToString(<ReopenToUpdate host={{ pacer: "0.13.0", supported: true }} />)).toBe("");
  expect(renderToString(<ReopenToUpdate host={null} />)).toBe("");
});

test("Settings lists tasks and sessions still on an older runner or host, by version only", () => {
  const work: ServiceWork = { pacer: "0.13.1",
    tasks: [{ task_id: "t-20261029-000000-aaaa", runner_pacer: "0.13.0", older: true }, { task_id: "t-20261029-000000-bbbb", runner_pacer: "0.13.1", older: false }],
    sessions: [{ kind: "terminal", id: "0123abcd-0000-4000-8000-000000000000", pacer: null, older: true, reopen_to_update: false }, { kind: "task", id: "t-20261029-000000-cccc", pacer: "0.7.0", older: true, reopen_to_update: true }],
    counts: { tasks: 2, sessions: 2, older_runners: 1, older_sessions: 2, reopen_to_update: 1 } };
  const html = renderToString(<RunningWorkList work={work} />);
  expect(html).toContain("Still on an older version");
  expect(html).toContain("Task t-20261029-000000-aaaa on runner 0.13.0");
  expect(html).not.toContain("t-20261029-000000-bbbb");
  expect(html).toContain("Terminal 0123abcd on a host from an older release");
  expect(html).toContain("Session t-20261029-000000-cccc on host 0.7.0 (Reopen to update)");
  expect(renderToString(<RunningWorkList work={{ ...work, tasks: [work.tasks[1]], sessions: [] }} />)).toBe("");
});
