import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
// Agent detection must not depend on what the host has installed; keep the preload's keychain stub first.
const agentFreePath = `${join(process.env.HOME!, "bin")}:/usr/bin:/bin`;

async function exchange(home: string, forward: boolean) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "snapshot.get", params: {} });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      HOME: home,
      PACER_HOME: join(home, ".pacer"),
      PATH: agentFreePath,
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
