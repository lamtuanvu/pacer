/** Disposable interactive hosts for live messaging checks; no executor is started. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { makeCtx } from "../../src/ctx";
import { ask } from "../../src/core/tasks";
import { createTask, updateTask } from "../../src/tasks/store";
import { thread } from "../../src/messaging/store";
import { FrameType, wire } from "../../src/session/framing";
import { ViewerHub } from "../../src/session/viewers";

async function main() {
  const ctx = makeCtx();
  const fixtures = [];
  for (const name of ["cli", "http", "retry", "stale", "message"]) {
    const dir = join(ctx.pacerHome, `waiting-${name}`);
    mkdirSync(dir, { mode: 0o700 });
    const script = join(dir, "run.sh");
    writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    const proc = Bun.spawn(["/bin/sh", script, dir], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(dir, "pid"), String(proc.pid));
    writeFileSync(join(dir, "interactive.json"), "{}");
    // Relative to the sandbox repo, keeping Unix socket names below macOS's limit.
    const socket = `../home/waiting-${name}.sock`;
    writeFileSync(join(dir, "session.sock.path"), socket);
    writeFileSync(join(dir, "session-status.json"), JSON.stringify({ status: "needs-input", summary: "waiting", at: 1000 }));
    const hub = new ViewerHub(() => wire(FrameType.snapshot, {}), () => null, fn => fn(), () => {},
      (viewers, controller) => writeFileSync(join(dir, "session.state"), JSON.stringify({ viewers, controller, cols: 120, rows: 40 })),
      { input: bytes => appendFileSync(join(dir, "input"), bytes, { mode: 0o600 }), resize() {}, release() {} });
    const server = createServer(socket => hub.add(socket));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    const task = createTask(ctx, { brief: { goal: `Live waiting fixture: ${name}`, repo: ctx.home }, kind: "debug", requestedExecutor: "codex", timeoutS: 600 });
    updateTask(ctx, task.id, t => {
      t.state = "running"; t.origin = "external:local";
      t.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: ctx.home, logFile: "/dev/null" };
      t.attempts = [];
    });
    await ask(ctx, task.id, "Which branch?");
    const question = thread(ctx, task.id).find(m => m.kind === "question")!;
    if (name === "stale") {
      updateTask(ctx, task.id, t => { t.question!.answer = "old"; t.question!.answeredAt = ctx.now; });
      await ask({ ...ctx, now: ctx.now + 1 }, task.id, "Which retry?");
    }
    fixtures.push({ name, task: task.id, question: question.id, dir });
  }
  writeFileSync(join(ctx.pacerHome, "waiting-fixtures.json"), JSON.stringify(fixtures, null, 2) + "\n", { mode: 0o600 });
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
