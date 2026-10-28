import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runAttempt } from "../src/exec/direct";
import { validateStrategy } from "../src/config/strategy";
import { sendMessage } from "../src/messaging/send";
import { claimTurnMessages, onRunEnded, renderTurnPrompt } from "../src/messaging/turns";
import * as store from "../src/messaging/store";

function finished() {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => {
    x.origin = "external:claude-code"; x.state = "done";
    x.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null", agentSession: { id: "sid-1", source: "header" } };
    x.attempts = [{ executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
    x.result = { status: "done", executor: "codex", model: null, files: "", report: "first report", backend: "direct" };
  });
  return { ctx, id: t.id };
}

test("a message to a finished task starts a resume turn on the same executor", async () => {
  const { ctx, id } = finished();
  const spawned: string[] = [];
  const r = await sendMessage(ctx, { to: `task:${id}`, body: "also handle X", requestId: "q1" }, { spawnRunner: (_c, tid) => { spawned.push(tid); return 1; } });
  expect(r.delivery).toBe("turn_started");
  expect(spawned).toEqual([id]);
  const t = readTask(ctx, id)!;
  expect(t.state).toBe("queued");
  expect(t.pendingTurn?.executor).toBe("codex");
  expect(t.requestedExecutor).toBe("codex");
  expect(t.run?.agentSession?.id).toBe("sid-1");
});

test("messages to a running task queue; closed tasks refuse", async () => {
  const { ctx, id } = finished();
  updateTask(ctx, id, t => { t.state = "running"; });
  expect((await sendMessage(ctx, { to: `task:${id}`, body: "x" }, { spawnRunner: () => 1 })).delivery).toBe("queued");
  updateTask(ctx, id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: 1 }; });
  await expect(sendMessage(ctx, { to: `task:${id}`, body: "y" }, { spawnRunner: () => 1 })).rejects.toThrow(/closed/);
});

test("claiming renders a prompt; run end reports to the parent once", async () => {
  const { ctx, id } = finished();
  await sendMessage(ctx, { to: `task:${id}`, body: "also handle X" }, { spawnRunner: () => 1 });
  const claim = claimTurnMessages(ctx, readTask(ctx, id)!)!;
  expect(claim.messages.length).toBe(1);
  expect(renderTurnPrompt(ctx, readTask(ctx, id)!, claim.messages)).toContain("also handle X");
  updateTask(ctx, id, t => { t.state = "done"; t.attempts.push({ ...t.attempts[0]!, startedAt: 3, endedAt: 4 }); t.result = { ...t.result!, report: "second report" }; });
  onRunEnded(ctx, id);
  onRunEnded(ctx, id);
  const inbox = store.inbox(ctx, "external:claude-code");
  expect(inbox.map(m => [m.kind, m.body])).toEqual([["report", "[done] second report"]]);
  expect(readTask(ctx, id)!.pendingTurn).toBeUndefined();
});

test("a turn that hit a limit puts its messages back", async () => {
  const { ctx, id } = finished();
  await sendMessage(ctx, { to: `task:${id}`, body: "x" }, { spawnRunner: () => 1 });
  claimTurnMessages(ctx, readTask(ctx, id)!);
  updateTask(ctx, id, t => { t.state = "limit"; t.result = { ...t.result!, status: "limit" }; t.attempts.push({ ...t.attempts[0]!, limitHit: true }); });
  onRunEnded(ctx, id);
  expect(store.pendingFor(ctx, `task:${id}`).length).toBe(1);
});


test("runAttempt resumes the stored codex session with only the new messages", async () => {
  const bin = tmpDir();
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "$@" > "${bin}/argv"\ncat > "${bin}/stdin"\nout=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\necho "TURN REPORT" > "$out"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  const { ctx: base, id } = finished();
  const ctx = { ...base, env: { ...base.env, PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } };
  await sendMessage(ctx, { to: `task:${id}`, body: "also handle X" }, { spawnRunner: () => 1 });
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
  const out = await runAttempt(ctx, s.providers.codex!, readTask(ctx, id)!);
  const argv = await Bun.file(join(bin, "argv")).text();
  expect(argv).toContain("exec resume");
  expect(argv).toContain("sid-1");
  expect(await Bun.file(join(bin, "stdin")).text()).toContain("also handle X");
  expect(out.report).toContain("TURN REPORT");
});
