import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function exchange(home: string, taskId: string, forward: boolean) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.get", params: { id: taskId } });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      HOME: home,
      PACER_HOME: join(home, ".pacer"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1",
      ...(forward ? { PACER_FORWARD_OPS: "task.get" } : {}),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n" + request + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    const markers = stderr.split("\n").filter(line => /^native task\.get \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : ["native task.get 2"]);
    return replies[1];
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

test.skipIf(!front)("task.get matches forced forwarding with task read enrichment", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const task = createTask(ctx, { brief: { goal: "Goal", repo: realpathSync(ctx.home) }, kind: null, requestedExecutor: "cursor", timeoutS: 60 });
  updateTask(ctx, task.id, row => {
    row.state = "done";
    row.executor = "cursor";
  });
  const reference = await callOp(ctx, "task.get", { id: task.id });
  const nativeHome = mkdtempSync(join(tmpdir(), "pacer-task-get-native-"));
  const forwardHome = mkdtempSync(join(tmpdir(), "pacer-task-get-forward-"));
  cpSync(ctx.home, nativeHome, { recursive: true });
  cpSync(ctx.home, forwardHome, { recursive: true });
  try {
    const native = await exchange(nativeHome, task.id, false);
    const forwarded = await exchange(forwardHome, task.id, true);
    expect(normalize(native?.result)).toEqual(normalize(forwarded?.result));
    expect(normalize(native?.result)).toEqual(normalize(reference));
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardHome, { recursive: true, force: true });
  }
}, 120_000);
