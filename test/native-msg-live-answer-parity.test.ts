import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { ask } from "../src/core/tasks";
import { killTree } from "../src/exec/process";
import { readRun } from "../src/supervisor/run";
import { FrameType, wire } from "../src/session/framing";
import { ViewerHub } from "../src/session/viewers";
import * as store from "../src/messaging/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function exercise(forward: boolean, mode: "success" | "retry" | "ambiguous" | "stale" | "legacy" | "legacy-read" = "success") {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: "debug", requestedExecutor: "codex", timeoutS: 600 });
  const dir = tmpDir();
  const script = join(dir, "run.sh");
  writeFileSync(join(dir, "interactive.json"), "{}");
  writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(dir, "pid"), String(proc.pid));
  const sock = join(tmpDir(), "s.sock");
  writeFileSync(join(dir, "session.sock.path"), sock);
  const input: Buffer[] = [];
  const hub = new ViewerHub(() => wire(FrameType.snapshot, {}), () => null, fn => fn(), () => {},
    (viewers, controller) => writeFileSync(join(dir, "session.state"), JSON.stringify({ viewers, controller, cols: 120, rows: 40 })),
    { input: b => input.push(Buffer.from(b)), resize() {}, release() {} },
    mode === "ambiguous" ? { pacer: "0.0.0", versions: [1, 2] } : undefined,
    mode === "ambiguous" ? { quietMs: 30, windowMs: 1000, timeoutMs: 200, maxWindowMs: 60 } : undefined);
  const server = createServer(s => hub.add(s));
  await new Promise<void>(resolve => server.listen(sock, resolve));
  let viewer: ReturnType<typeof createConnection> | undefined;
  try {
    for (let i = 0; i < 100 && !readRun(dir).alive; i++) await Bun.sleep(25);
    expect(readRun(dir).alive).toBe(true);
    updateTask(ctx, task.id, t => {
      t.state = "running"; t.origin = "external:local";
      t.run = { dir, attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: ctx.home, logFile: "/dev/null" };
      t.attempts = [];
    });
    writeFileSync(join(dir, "session-status.json"), JSON.stringify({ status: "needs-input", summary: "s", at: 1000 }));
    await ask(ctx, task.id, "Which branch?");
    const question = store.thread(ctx, task.id).find(m => m.kind === "question")!;
    if (mode === "legacy" || mode === "legacy-read") {
      store.insertMessage(ctx, { taskId: task.id, rootId: `task:${task.id}`, from: "external:local", to: `task:${task.id}`, kind: "answer", body: "main", replyTo: question.id, requestId: "retry-answer" });
      store.messagesDatabase(ctx).query("UPDATE messages SET fingerprint=NULL, status=? WHERE request_id=?").run(mode === "legacy-read" ? "read" : "pending", "retry-answer");
    }
    if (mode === "stale") {
      updateTask(ctx, task.id, t => { t.question!.answer = "old"; t.question!.answeredAt = ctx.now; });
      await ask({ ...ctx, now: ctx.now + 1 }, task.id, "Which retry?");
    }
    if (mode === "retry") {
      viewer = createConnection(sock);
      await new Promise<void>(resolve => viewer!.once("connect", resolve));
      viewer.write(wire(FrameType.hello, { v: 1, label: "Pacer desktop", client: "app" }));
      for (let i = 0; i < 200 && hub.size === 0; i++) await Bun.sleep(5);
      viewer.write(wire(FrameType.take, {}));
      await Bun.sleep(30);
    }
    const send = async () => {
    const child = Bun.spawn([front!, "api", "--stdio"], { cwd: ctx.home, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {
      HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: process.env.PATH!, PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
      ...(forward ? { PACER_FORWARD_OPS: "msg.send" } : {}),
    } });
    await child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "msg.send", params: { to: `task:${task.id}`, kind: mode.startsWith("legacy") ? "message" : "answer", ...(mode.startsWith("legacy") ? {} : { reply_to: question.id }), body: "main", request_id: "retry-answer" } }) + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const reply = JSON.parse(stdout.trim().split("\n").find(line => JSON.parse(line).id === 2)!);
    return { delivery: reply.result?.delivery, error: reply.error?.message, duplicate: reply.result?.duplicate };
    };
    const first = await send();
    let second;
    if (mode === "retry" || mode === "ambiguous") {
      viewer?.destroy();
      await Bun.sleep(50);
      second = await send();
    }
    return { first, second, answer: readTask(ctx, task.id)?.question?.answer,
      typed: Buffer.concat(input).toString().split("main").length - 1, pending: store.pendingFor(ctx, `task:${task.id}`).length };
  } finally { viewer?.destroy(); server.close(); killTree(proc.pid, "SIGKILL"); await proc.exited; }
}

test.skipIf(!front)("native front door delivers an answer to a waiting live question like the forwarded core", async () => {
  const native = await exercise(false);
  const forwarded = await exercise(true);
  expect(forwarded).toEqual({ first: { delivery: "live", error: undefined, duplicate: false }, second: undefined, answer: "main", typed: 1, pending: 0 });
  expect(native).toEqual(forwarded);
}, 30000);

for (const mode of ["retry", "ambiguous", "stale"] as const) {
  test.skipIf(!front)(`native front door matches forwarded ${mode} answer behavior`, async () => {
    const native = await exercise(false, mode);
    const forwarded = await exercise(true, mode);
    expect(native).toEqual(forwarded);
    if (mode === "retry") {
      expect(native.first.error).toContain("controlled from Pacer desktop");
      expect(native.second).toEqual({ delivery: "live", error: undefined, duplicate: true });
      expect(native.typed).toBe(1);
    } else if (mode === "ambiguous") {
      expect(native.first.error).toContain("Interactive input failed");
      expect(native.answer).toBe("main");
      expect(native.typed).toBe(1);
      expect(native.second?.delivery).toBe("queued");
    } else {
      expect(native.answer).toBeUndefined();
      expect(native.typed).toBe(0);
      expect(native.pending).toBe(1);
    }
  }, 60000);
}

for (const mode of ["legacy", "legacy-read"] as const) test.skipIf(!front)(`${mode} duplicate answer redelivery matches Core`, async () => {
  const native = await exercise(false, mode);
  const forwarded = await exercise(true, mode);
  expect(forwarded.first).toEqual({ delivery: "live", error: undefined, duplicate: true });
  expect(forwarded.answer).toBe("main");
  expect(forwarded.typed).toBe(1);
  expect(forwarded.pending).toBe(0);
  expect(native).toEqual(forwarded);
}, 30000);
