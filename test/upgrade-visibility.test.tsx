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
import { runningWorkLines } from "../src/service/running-work";
import { SessionView } from "../app/src/screens/session/SessionView";
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

test("older host notice describes the action and surface", () => {
  const task = renderToString(<ReopenToUpdate host={{ pacer: "0.7.0", supported: false }} onReopen={() => {}} />);
  expect(task).toContain("This session runs an older pacer");
  expect(task).toContain("Create a new task");
  const terminal = renderToString(<ReopenToUpdate host={{ pacer: "0.7.0", supported: false }} surface="terminal" onReopen={() => {}} actionLabel="Open a new terminal" busy />);
  expect(terminal).toContain("This terminal runs an older pacer");
  expect(terminal).toContain("This terminal started on pacer 0.7.0");
  expect(terminal).toContain('aria-busy="true"');
  expect(terminal).toContain("disabled");
  expect(renderToString(<ReopenToUpdate host={{ pacer: "0.13.0", supported: true }} />)).toBe("");
  expect(renderToString(<ReopenToUpdate host={null} />)).toBe("");
});

test("unsupported session notice is compact and its action precedes terminal input", () => {
  const html = renderToString(<SessionView task={{ id: "t-20261029-000000-aaaa", state: "running" } as never}
    session={{ host: "builtin", live: true, hostVersion: { pacer: "0.7.0", older: true, supported: false }, attach: { ws: "ws://localhost" }, capabilities: { control: true, resize: true }, cols: 80, rows: 24 } as never}
    active footer={null} takeRequested={false} onTakeSent={() => {}} onFiles={() => {}} onReopen={() => {}} />);
  expect(html).toContain('class="pc-session-view"');
  expect(html).toContain('pc-alert--compact');
  expect(html).toContain('pc-alert__actions');
  expect(html).toContain('<button');
  expect(html).toContain('Create a new task');
  expect(html.indexOf('Create a new task')).toBeLessThan(html.indexOf('data-linked-terminal'));
});

test("an ended session does not claim it keeps running", () => {
  const html = renderToString(<SessionView task={{ id: "t-20261029-000000-aaaa", state: "done" } as never}
    session={{ host: "builtin", live: false, hostVersion: { pacer: "0.7.0", older: true, supported: false }, attach: { ws: "ws://localhost" }, capabilities: { control: false, resize: false }, cols: 80, rows: 24 } as never}
    active={false} footer={null} takeRequested={false} onTakeSent={() => {}} onFiles={() => {}} />);
  expect(html).not.toContain("This session runs an older pacer");
});

test("Settings lists tasks and sessions still on an older runner or host, by version only", () => {
  const work: ServiceWork = { pacer: "0.13.1",
    tasks: [{ task_id: "t-20261029-000000-aaaa", runner_pacer: "0.13.0", older: true }, { task_id: "t-20261029-000000-bbbb", runner_pacer: "0.13.1", older: false }],
    sessions: [{ kind: "terminal", id: "0123abcd-0000-4000-8000-000000000000", pacer: null, older: true, reopen_to_update: false }, { kind: "task", id: "t-20261029-000000-cccc", pacer: "0.7.0", older: true, reopen_to_update: true }],
    counts: { tasks: 2, sessions: 2, older_runners: 1, older_sessions: 2, reopen_to_update: 1 } };
  const html = renderToString(<RunningWorkList work={work} />);
  expect(html).toContain("Still on an older version");
  expect(html).toContain("<ul");
  expect(html.match(/<li/g)).toHaveLength(3);
  expect(html).toContain('href="#/tasks/t-20261029-000000-aaaa"');
  expect(html).toContain("pacer 0.13.0");
  expect(html).not.toContain("t-20261029-000000-bbbb");
  expect(html).toContain('title="0123abcd-0000-4000-8000-000000000000"');
  expect(html).toContain("pacer 0.7.0");
  expect(renderToString(<RunningWorkList work={{ ...work, tasks: [work.tasks[1]], sessions: [] }} />)).toBe("");
});

test("status never prints control characters from work records", () => {
  const lines = runningWorkLines({ pacer: "0.13.1", tasks: [{ taskId: "t-20261029-000000-aaaa\u001b[2J", runnerPacer: "0.1.0\u001b[2J", older: true }],
    sessions: [{ kind: "terminal", id: "abc\u001b[2J", pacer: "0.2.0\u001b[2J", older: true, reopenToUpdate: false }] });
  for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
});
