import { childEnv, fakeServiceManager } from "./child-env";
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { closedPort, pinnedEnv as pinnedPort, spawnPinned } from "./pinned-port";
import { createTask, updateTask } from "../src/tasks/store";
import type { TaskState } from "../src/tasks/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
// Agent detection must not depend on what the host has installed; keep the preload's keychain stub first.
const agentFreePath = `${join(process.env.HOME!, "bin")}:/usr/bin:/bin`;

/** Boot a Rust serve door and GET `/v3/snapshot`, optionally forced through the core. */
async function httpSnapshot(home: string, forward: boolean) {
  const port = closedPort();
  const env = pinnedPort({
    ...childEnv(home),
    PATH: `${fakeServiceManager(home)}:${agentFreePath}`,
    PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1",
    PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1",
    ...(forward ? { PACER_FORWARD_OPS: "http.snapshot" } : {}),
  }, port);
  const child = spawnPinned([front!, "serve", "--port", String(port)], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  try {
    for (let n = 0; n < 1000; n++) {
      try {
        token = readFileSync(join(home, ".pacer", "token"), "utf8").trim();
        // Parity compares against the Core-backed body, so wait until Core can
        // answer even for the native door (otherwise the read cache can freeze a
        // cold "starting" projection before the first status lands).
        const probe = await fetch(`${base}/v2/hello`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(500),
        });
        if (probe.ok) break;
      } catch {}
      await Bun.sleep(20);
    }
    expect(token).not.toBe("");
    const response = await fetch(`${base}/v3/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-pacer")).toBe("1");
    return await response.json() as { protocol?: string; seq?: number; snapshot?: Record<string, unknown> };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    await stderr;
  }
}

async function exchange(home: string, forward: boolean) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "snapshot.get", params: {} });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      ...childEnv(home),
      PATH: `${fakeServiceManager(home)}:${agentFreePath}`,
      PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1",
      ...(forward ? { PACER_FORWARD_OPS: "snapshot.get" } : {}),
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
    const markers = stderr.split("\n").filter(line => /^native snapshot\.get \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : ["native snapshot.get 2"]);
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

function stripVolatile(snapshot: Record<string, unknown>) {
  const next = { ...snapshot };
  if (next.service && typeof next.service === "object") {
    const service = { ...(next.service as Record<string, unknown>) };
    delete service.pid;
    delete service.startedAt;
    next.service = service;
  }
  if (next.machine && typeof next.machine === "object") {
    const machine = { ...(next.machine as Record<string, unknown>) };
    machine.os = "PLATFORM";
    machine.arch = "ARCH";
    for (const key of ["loadPerCore", "memoryPressure", "open", "reason", "detail"]) delete machine[key];
    next.machine = machine;
  }
  if (next.today && typeof next.today === "object") {
    const today = { ...(next.today as Record<string, unknown>) };
    delete today.since;
    next.today = today;
  }
  if (Array.isArray(next.executors)) {
    next.executors = (next.executors as Record<string, unknown>[]).map(row => {
      const copy = { ...row };
      delete copy.account;
      return copy;
    });
  }
  return next;
}

test.skipIf(!front)("snapshot.get matches forced forwarding over stdio", async () => {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(join(ctx.pacerHome, "link"), { recursive: true, mode: 0o700 });
  const reference = (await callOp(ctx, "snapshot.get", {})) as { snapshot?: Record<string, unknown> };
  const nativeHome = mkdtempSync(join(tmpdir(), "pacer-snapshot-get-native-"));
  const forwardHome = mkdtempSync(join(tmpdir(), "pacer-snapshot-get-forward-"));
  cpSync(ctx.home, nativeHome, { recursive: true });
  cpSync(ctx.home, forwardHome, { recursive: true });
  try {
    const native = await exchange(nativeHome, false);
    const forwarded = await exchange(forwardHome, true);
    const norm = (reply: { result?: { snapshot?: Record<string, unknown> } }) =>
      normalize({ ...reply?.result, snapshot: stripVolatile(reply?.result?.snapshot ?? {}) });
    expect(norm(native)).toEqual(norm(forwarded));
    expect(norm(native)).toEqual(normalize({ ...reference, snapshot: stripVolatile(reference.snapshot as Record<string, unknown>) }));
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardHome, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!front)("GET /v3/snapshot matches forced http.snapshot forwarding on the Rust door", async () => {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(join(ctx.pacerHome, "link"), { recursive: true, mode: 0o700 });
  const nativeHome = mkdtempSync(join(tmpdir(), "pacer-snapshot-http-native-"));
  const forwardHome = mkdtempSync(join(tmpdir(), "pacer-snapshot-http-forward-"));
  cpSync(ctx.home, nativeHome, { recursive: true });
  cpSync(ctx.home, forwardHome, { recursive: true });
  try {
    const native = await httpSnapshot(nativeHome, false);
    const forwarded = await httpSnapshot(forwardHome, true);
    // Wire contract both doors own: protocol-3 envelope + service projection.
    // Full snapshot-tree equality for the `snapshot.get` op (stdio) is covered
    // above; the HTTP liveSnapshot tree can still differ on planner/setup while
    // Core status is warming, so this route assertion stays on the envelope.
    expect(native.protocol).toBe("3.0.0");
    expect(forwarded.protocol).toBe("3.0.0");
    expect(typeof native.seq).toBe("number");
    expect(typeof forwarded.seq).toBe("number");
    expect(native.snapshot?.service).toBeDefined();
    expect(forwarded.snapshot?.service).toBeDefined();
    expect(Object.keys(stripVolatile(native.snapshot ?? {})).sort()).toEqual(
      Object.keys(stripVolatile(forwarded.snapshot ?? {})).sort(),
    );
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardHome, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!front)("snapshot recent and old active selection matches forced forwarding", async () => {
  const ctx = fakeCtx({ now: Math.floor(Date.now() / 1000), which: () => null });
  const selected: string[] = [];
  // [age, state, archived, variant] — variant is "open" (awaiting answer),
  // "answered", or "dismissed" for the needs_input rows.
  const cases: [number, string, boolean, "open" | "answered" | "dismissed"][] = [
    [60, "done", false, "open"], [172800, "queued", false, "open"],
    [172800, "done", false, "open"], [172800, "needs_input", false, "open"],
    [60, "done", true, "open"], [172800, "needs_input", false, "answered"],
    [172800, "needs_input", false, "dismissed"],
  ];
  for (const [age, state, archived, variant] of cases) {
    const at = { ...ctx, now: ctx.now - age };
    const task = createTask(at, { brief: { goal: "snapshot selection", repo: ctx.home },
      kind: null, requestedExecutor: null, timeoutS: 60 });
    if (archived) mkdirSync(join(ctx.pacerHome, "archive", new Date(at.now * 1000).toISOString().slice(0, 7), task.id), { recursive: true });
    updateTask(at, task.id, row => { row.state = state as TaskState; row.archived = archived;
      if (state === "needs_input") row.question = { text: "Which?", answer: variant === "answered" ? "postgres" : undefined, at: at.now };
      if (variant === "dismissed") row.dismissed = true; });
    // Only tasks that still need you must never age out, exactly like running/queued;
    // an answered or dismissed needs_input does not.
    const stillNeedsYou = state === "needs_input" && variant === "open";
    if (!archived && (age < 86400 || state === "queued" || stillNeedsYou)) selected.push(task.id);
  }
  const native = await exchange(ctx.home, false);
  const forwarded = await exchange(ctx.home, true);
  expect(native.error).toBeUndefined();
  expect(forwarded.error).toBeUndefined();
  expect(native.result.snapshot.tasks).toEqual(forwarded.result.snapshot.tasks);
  expect(native.result.snapshot.tasks.map((task: { id: string }) => task.id).sort()).toEqual(selected.sort());
}, 120_000);
