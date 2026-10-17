import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { HttpClient } from "../src/api/http-client";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../src/api/client-types";
import { StdioClient } from "../src/api/stdio-client";
import { publish } from "../src/link/publish";
import { fakeCtx } from "./helpers";

const cli = ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "api", "--stdio"];
async function home() {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return { ctx, env: { ...process.env, PACER_HOME: ctx.pacerHome, HOME: ctx.home, TZ: "Asia/Ho_Chi_Minh" } };
}
const waitFor = async (f: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(20); } };

test("StdioClient speaks the protocol to pacer api --stdio", async () => {
  const { env } = await home();
  const client = new StdioClient(cli.slice(0, 2), env);
  try {
    expect((await client.hello()).protocol).toBe("2.8.0");
    expect((await client.snapshot()).protocol).toBe("2.8.0");
    const err = await client.call("task.get", { id: "missing" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) throw new Error("expected ApiError");
    expect(err.code).toBe("unknown_task");
  } finally { client.close(); }
});

test("StdioClient restarts and resumes after the child exits", async () => {
  const { ctx, env } = await home();
  const client = new StdioClient(cli.slice(0, 2), env, { maxBackoffMs: 200 });
  const seen: number[] = [];
  try {
    await client.hello();
    client.subscribe(0, (e) => seen.push(e.seq));
    const alert = (key: string) => ({ v: 1 as const, type: "alert" as const, data: { key, level: "info" as const, title: key, body: "", at: ctx.now } });
    await publish(ctx, [alert("a")], { bridge: false, channel: false });
    await waitFor(() => seen.length >= 1);
    (client as unknown as { child: { kill(s: string): void } }).child.kill("SIGKILL");
    await publish(ctx, [alert("b")], { bridge: false, channel: false });
    await waitFor(() => seen.length >= 2);
    expect(seen[1]).toBeGreaterThan(seen[0]!);
    expect(new Set(seen).size).toBe(seen.length);
  } finally { client.close(); }
});

function fakeSpawner() {
  const children: Array<ReturnType<typeof makeChild>> = [];
  const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
  function makeChild() {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      killedWith: [] as string[],
      kill(signal: string) { this.killedWith.push(signal); return true; },
    });
    const requests: Array<{ id: number; method: string; params: unknown }> = [];
    child.stdin.on("data", (data) => requests.push(JSON.parse(data.toString())));
    return Object.assign(child, { requests });
  }
  const start = ((file: string, args: readonly string[], options: unknown) => {
    calls.push({ file, args, options });
    const child = makeChild(); children.push(child); return child;
  }) as unknown as typeof spawn;
  return { children, calls, spawn: start };
}

test("StdioClient rejects pending calls on exit and close stops restarts", async () => {
  const fake = fakeSpawner();
  const client = new StdioClient(["pacer"], { PACER_ROLE: "executor" }, { spawn: fake.spawn, maxBackoffMs: 20 });
  const child = fake.children[0]!;
  const pending = client.hello().catch((e) => e);
  child.emit("exit", 1);
  const error = await pending;
  expect(error).toBeInstanceOf(ApiError);
  expect(error.code).toBe("internal");
  expect(error.message).toBe("pacer api exited");
  await waitFor(() => fake.children.length === 2);
  expect(fake.calls[0]).toMatchObject({ file: "pacer", args: ["api", "--stdio"], options: { stdio: ["pipe", "pipe", "pipe"], env: { PACER_ROLE: "executor" } } });
  const next = fake.children[1]!;
  const closing = client.snapshot().catch((e) => e);
  client.close();
  expect(await closing).toBeInstanceOf(ApiError);
  expect(next.killedWith).toEqual(["SIGTERM"]);
  next.emit("exit", 0);
  await Bun.sleep(50);
  expect(fake.children).toHaveLength(2);
});

test("StdioClient shares subscriptions, filters seqs and resumes each cursor", async () => {
  const fake = fakeSpawner();
  const client = new StdioClient(["pacer"], {}, { spawn: fake.spawn, maxBackoffMs: 20 });
  try {
    const a: number[] = [], b: number[] = [];
    const stopA = client.subscribe(5, (e) => a.push(e.seq));
    client.subscribe(2, (e) => b.push(e.seq));
    const child = fake.children[0]!;
    expect(child.requests.filter((r) => r.method === "subscribe").at(-1)?.params).toEqual({ since: 2 });
    for (const seq of [3, 6, 6]) child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq, at: 0, type: "alert", data: {} } }) + "\n");
    expect(a).toEqual([6]); expect(b).toEqual([3, 6]);
    child.emit("exit", 1);
    await waitFor(() => fake.children.length === 2);
    const next = fake.children[1]!;
    expect(next.requests.filter((r) => r.method === "subscribe").at(-1)?.params).toEqual({ since: 6 });
    stopA();
    next.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: 7, at: 0, type: "alert", data: {} } }) + "\n");
    expect(a).toEqual([6]); expect(b).toEqual([3, 6, 7]);
  } finally { client.close(); }
});

test("StdioClient bounds stdout lines, logs stderr, and matches fragmented responses by id", async () => {
  const fake = fakeSpawner(), logs: string[] = [];
  const client = new StdioClient(["pacer"], {}, { spawn: fake.spawn, log: (m) => logs.push(m) });
  try {
    const child = fake.children[0]!;
    const first = client.hello(), second = client.snapshot();
    expect(child.requests.map((r) => r.id)).toEqual([1, 2]);
    child.stdout.write("x".repeat(1024 * 1024));
    child.stdout.write("x".repeat(50));
    child.stdout.write("\n");
    child.stderr.write("diagnos"); child.stderr.write("tic\n");
    const reply = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { seq: 42 } });
    child.stdout.write(reply.slice(0, 20)); child.stdout.write(reply.slice(20) + "\n");
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocol: "2.8.0" } }) + "\n");
    expect(await second).toMatchObject({ seq: 42 });
    expect(await first).toMatchObject({ protocol: "2.8.0" });
    expect(logs).toContain("diagnostic");
    expect(logs.some((m) => /1 MiB/.test(m))).toBe(true);
  } finally { client.close(); }
});

test("HttpClient rejects non-loopback or credential-bearing bases", () => {
  for (const base of ["https://127.0.0.1:7431", "http://localhost:7431", "http://127.1:7431", "http://2130706433:7431", "http://@127.0.0.1:7431", "http://example.com:7431", "http://user:pass@127.0.0.1:7431", "http://127.0.0.1:7431/path", "http://127.0.0.1:7431?token=x"]) {
    expect(() => new HttpClient(base, "token")).toThrow();
  }
  expect(() => new HttpClient("http://127.0.0.1:7431", "token")).not.toThrow();
  expect(() => new HttpClient("http://127.0.0.1:80", "token")).not.toThrow();
});
