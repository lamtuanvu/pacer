import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function exchange(home: string, requests: string[], forward: boolean) {
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
      ...(forward ? { PACER_FORWARD_OPS: "task.list" } : {}),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    const markers = stderr.split("\n").filter(line => /^native task\.list \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : requests.map((_, index) => `native task.list ${index + 2}`));
    return replies.slice(1);
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

test.skipIf(!front)("task.list matches forced forwarding with session probe injection", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 5; i++) {
    const task = createTask({ ...ctx, now: ctx.now + i }, { brief: { goal: String(i), repo: realpathSync(ctx.home) }, kind: null, requestedExecutor: "cursor", timeoutS: 60 });
    updateTask(ctx, task.id, row => {
      row.state = i === 0 ? "failed" : "done";
      row.executor = "cursor";
    });
  }
  const reference = await callOp(ctx, "task.list", { states: ["done"], limit: 2 });
  const request = (id: number, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "task.list", params });
  const requests = [request(2, { states: ["done"], limit: 2 })];
  const nativeHome = mkdtempSync(join(tmpdir(), "pacer-task-list-native-"));
  const forwardHome = mkdtempSync(join(tmpdir(), "pacer-task-list-forward-"));
  cpSync(ctx.home, nativeHome, { recursive: true });
  cpSync(ctx.home, forwardHome, { recursive: true });
  try {
    const native = await exchange(nativeHome, requests, false);
    const forwarded = await exchange(forwardHome, requests, true);
    expect(normalize(native[0]?.result)).toEqual(normalize(forwarded[0]?.result));
    expect(normalize(native[0]?.result)).toEqual(normalize(reference));
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardHome, { recursive: true, force: true });
  }
}, 120_000);
