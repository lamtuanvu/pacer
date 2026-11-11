import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerWork, workEvents } from "../src/dispatch/work";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { fakeCtx, gitRepo, pinnedPort } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const EXECUTORS = ["codex", "claude", "cursor", "cursor-agent", "opencode", "gemini", "orca", "ssh"];

/** Managed work in the state each lifecycle op needs, written with Core's own store calls. */
function seed(ctx: ReturnType<typeof fakeCtx>, repo: string, title: string, apply: (record: TaskRecord) => void) {
  const { id } = createTask(ctx, { title, brief: { goal: title, repo }, kind: "feature", requestedExecutor: null, timeoutS: 3600 });
  registerWork(ctx, id, {});
  updateTask(ctx, id, record => {
    record.executor = "codex#personal";
    record.attempts = [{ executor: "codex#personal", model: null, startedAt: ctx.now - 600, endedAt: ctx.now - 120, exitCode: 0, timedOut: false, limitHit: false, log: join(ctx.pacerHome, "logs", `${id}.log`) }];
    apply(record);
  });
  return readTask(ctx, id)!;
}

/** Kills the detached runners Core launches after a restart; they only ever see refusing executor stubs. */
function killRunners(ids: string[]) {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString();
  for (const line of ps.split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    if (pid && ids.some(id => command.join(" ").includes(`_run ${id}`))) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  }
}

test.skipIf(!front)("valid review, retry and answer reach Core over stdio and persist their effects", async () => {
  const ctx = fakeCtx({ now: Math.floor(Date.now() / 1000) });
  const repo = gitRepo();
  const stubs = join(ctx.home, "bin");
  mkdirSync(stubs, { recursive: true });
  for (const bin of EXECUTORS) writeFileSync(join(stubs, bin), "#!/bin/sh\necho 'executor stub refuses to run' >&2\nexit 3\n", { mode: 0o700 });
  // Every Bun process below the front door (Core and its detached runners) logs the port it inherited.
  const spawned = join(ctx.home, "bun-processes");
  const probe = join(ctx.home, "port-probe.cjs");
  writeFileSync(probe, `require("node:fs").appendFileSync(${JSON.stringify(spawned)}, JSON.stringify({ port: process.env.PACER_PORT ?? null, args: process.argv.slice(2) }) + "\\n");\n`);
  const review = seed(ctx, repo, "Review me", record => {
    record.state = "done"; record.settledAt = ctx.now - 120;
    record.result = { status: "done", executor: "codex#personal", model: null, backend: "direct", files: "", report: "Done.", acceptance: { cmd: "bun test", passed: true, tail: "1 passed" } };
  });
  const retry = seed(ctx, repo, "Retry me", record => {
    record.state = "failed"; record.settledAt = ctx.now - 120; record.attempts[0]!.exitCode = 1;
    record.result = { status: "failed", executor: "codex#personal", model: null, backend: "direct", files: "", report: "Failed.", acceptance: { cmd: "bun test", passed: false, tail: "1 failed" } };
  });
  const answer = seed(ctx, repo, "Answer me", record => {
    record.state = "needs_input";
    record.question = { text: "Which file should the parser write?", at: ctx.now - 60 };
  });
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
    { jsonrpc: "2.0", id: "e2e-review", method: "dispatch.review", params: { id: review.id, accepted: true, expect_rev: review.rev, note: "Looks right" } },
    { jsonrpc: "2.0", id: 3, method: "dispatch.retry", params: { id: retry.id, expect_rev: retry.rev, requestId: "e2e-retry", feedback: "Run the tests first" } },
    { jsonrpc: "2.0", id: 4, method: "dispatch.answer", params: { id: answer.id, expect_rev: answer.rev, requestId: "e2e-answer", text: "Write src/report.ts" } },
    { jsonrpc: "2.0", id: 5, method: "dispatch.review", params: { id: review.id } },
  ];
  const env = pinnedPort({ HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: `${stubs}:/usr/bin:/bin`, PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", BUN_OPTIONS: `--preload ${probe}` });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: ctx.home,
    env,
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write(lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const replies = new Map(stdout.trim().split("\n").map(line => JSON.parse(line)).map(reply => [reply.id, reply]));
    expect([...replies.keys()].sort((a, b) => String(a).localeCompare(String(b)))).toEqual([1, 3, 4, 5, "e2e-review"]);
    expect(stderr.split("\n").filter(line => line.startsWith("native dispatch."))).toEqual(["native dispatch.review 5"]);
    expect(replies.get(5).error.data.code).toBe("invalid_input");

    expect(replies.get("e2e-review").result.task).toMatchObject({ id: review.id, rev: review.rev + 1, review: { accepted: true, note: "Looks right" } });
    expect(replies.get(3).result).toMatchObject({ task_id: retry.id, state: "queued", queue: { detail: "Restart requested" }, result: null });
    expect(replies.get(4).result).toMatchObject({ task_id: answer.id, state: "queued", queue: { detail: "Restart requested" }, requested_executor: "codex#personal" });

    expect(readTask(ctx, review.id)!.review).toMatchObject({ accepted: true, note: "Looks right" });
    expect(readTask(ctx, retry.id)!.brief.feedback).toBe("Run the tests first");
    expect(workEvents(ctx, retry.id).map(event => event.kind)).toContain("work.retry_requested");
    const answered = readTask(ctx, answer.id)!;
    expect(answered.brief.qa).toEqual([{ q: "Which file should the parser write?", a: "Write src/report.ts" }]);
    expect(answered.question).toBeUndefined();
    expect(workEvents(ctx, answer.id).map(event => event.kind)).toContain("work.answer_recorded");

    const processes = () => existsSync(spawned) ? readFileSync(spawned, "utf8").trim().split("\n").map(line => JSON.parse(line) as { port: string | null; args: string[] }) : [];
    const runners = () => processes().filter(entry => entry.args[0] === "_run").map(entry => entry.args[1]).sort();
    for (let n = 0; n < 900 && runners().length < 2; n++) await Bun.sleep(100);
    expect(runners()).toEqual([retry.id, answer.id].sort());
    expect(processes().filter(entry => entry.args.join(" ") === "api --stdio")).toHaveLength(1);
    expect(new Set(processes().map(entry => entry.port))).toEqual(new Set([env.PACER_PORT]));
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    killRunners([review.id, retry.id, answer.id]);
    rmSync(ctx.home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}, 150000);
