import { childEnv, fakeServiceManager } from "./child-env";
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { policyGateFixture } from "./fixtures/policy-host";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const STRATEGY = "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {launch_mode: headless}\n";

type Params = Record<string, unknown>;

/** Drive `task.review` through the native front door and assert the native marker. */
async function reviewExchange(
  home: string,
  params: Params,
  native = true,
  extraEnv: Record<string, string> = {},
) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "task.review",
    params: { expect_rev: readRev(home, String(params.id)), ...params },
  });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: {
      ...childEnv(home),
      PATH: `${fakeServiceManager(home)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1",
      ...extraEnv,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n" + request + "\n",
    );
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    const markers = stderr.split("\n").filter(line => /^native task\.review \d+$/.test(line));
    expect(markers, stderr).toEqual(native ? ["native task.review 2"] : []);
    return replies[1];
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}

function readRev(home: string, id: string): number {
  const ctx = { home, pacerHome: join(home, ".pacer") };
  return readTask(ctx as Parameters<typeof readTask>[0], id)!.rev;
}

function seedHome(mutate?: (ctx: ReturnType<typeof fakeCtx>, id: string) => void) {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  const task = createTask(ctx, {
    brief: { goal: "Native review parity", repo: ctx.home },
    kind: "feature",
    requestedExecutor: "codex",
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { executor: "codex", model: null, backend: "direct" } as typeof t.result;
  });
  mutate?.(ctx, task.id);
  const home = mkdtempSync(join(tmpdir(), "pacer-native-review-"));
  cpSync(ctx.home, home, { recursive: true });
  return { home, id: task.id, ctx };
}

test.skipIf(!front)("accept on a plain done task is native", async () => {
  const { home, id } = seedHome();
  try {
    const reply = await reviewExchange(home, { id, verdict: "accept", note: "ship it" });
    expect(reply?.result?.task?.review?.accepted).toBe(true);
    expect(reply?.result?.task?.review?.note).toBe("ship it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!front)("send_back with a note is native and retries when no turn starts", async () => {
  const { home, id } = seedHome();
  try {
    const reply = await reviewExchange(home, { id, verdict: "send_back", note: "handle errors" });
    expect(reply?.result?.task?.review?.accepted).toBe(false);
    expect(reply?.result?.retry?.id ?? reply?.result?.retry?.task_id).toBeTruthy();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!front)("retry verdict is native and launches a replacement", async () => {
  const { home, id } = seedHome();
  try {
    const reply = await reviewExchange(home, { id, verdict: "retry", executor: "codex" });
    expect(reply?.result?.task?.review?.accepted).toBe(false);
    expect(reply?.result?.retry?.id ?? reply?.result?.retry?.task_id).toBeTruthy();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!front)("accept of managed work is native", async () => {
  const { home, id } = seedHome((ctx, taskId) => {
    registerWork(ctx, taskId, { allowDelegation: true });
  });
  try {
    const reply = await reviewExchange(home, { id, verdict: "accept", note: "work looks good" });
    expect(reply?.result?.task?.review?.accepted).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!front)("accept on a diagnosticCheck task is native", async () => {
  const { home, id } = seedHome((ctx, taskId) => {
    updateTask(ctx, taskId, t => { t.diagnosticCheck = "CLI codex"; });
  });
  try {
    const reply = await reviewExchange(home, { id, verdict: "accept" });
    expect(reply?.result?.task?.review?.accepted).toBe(true);
    const stored = readTask({ home, pacerHome: join(home, ".pacer") } as Parameters<typeof readTask>[0], id)!;
    expect(stored.diagnosticRecheck).toMatchObject({ passed: expect.any(Boolean) });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!front)("a closed-policy plugin veto is enforced natively", async () => {
  const fixture = policyGateFixture({ verdict: "veto", reason: "review blocked" }, 0, tmpDir());
  const task = createTask(fixture.ctx, {
    brief: { goal: "policy review", repo: fixture.repo },
    kind: "feature",
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  updateTask(fixture.ctx, task.id, t => { t.state = "done"; });
  try {
    const reply = await reviewExchange(fixture.ctx.home, { id: task.id, verdict: "accept" });
    expect(reply?.result).toBeUndefined();
    // B0b has no native policy provider table yet, so closed mode fails closed
    // with the unavailable-plugin reason rather than the plugin's own veto text.
    expect(JSON.stringify(reply?.error)).toContain("cannot be verified");
    expect(readTask(fixture.ctx, task.id)?.review).toBeUndefined();
  } finally {
    rmSync(fixture.ctx.home, { recursive: true, force: true });
  }
});

test.skipIf(!front)("a task with a pending agent check reviews natively", async () => {
  const { home, id } = seedHome();
  const db = new Database(join(home, ".pacer", "state", "tasks.db"));
  db.exec("CREATE TABLE IF NOT EXISTS agent_session_checks (task TEXT, generation INTEGER, verified INTEGER)");
  db.prepare("INSERT INTO agent_session_checks (task, generation, verified) VALUES (?, 1, 0)").run(id);
  db.close();
  try {
    const reply = await reviewExchange(home, { id, verdict: "accept" });
    expect(reply?.result?.task?.review?.accepted).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
