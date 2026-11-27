import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toApiError } from "../src/api/errors";
import { callOp } from "../src/api/ops";
import { createTerminal } from "../src/terminal/workspace";
import { parseOutboxEvent } from "../src/link/envelope";
import { readOutboxSince } from "../src/link/store";
import { fakeCtx } from "./helpers";
import { front, home, serve } from "./native-repo-front-door";
import { closedPort, spawnPinned } from "./port-isolation";

// Parity for native `terminal.*`. The driver compares parameter refusals, the executor refusal, revision checks and
// registry bytes with the TypeScript handlers on seeded homes; the front doors run the same lifecycle natively and
// forced through PACER_FORWARD_OPS on twin homes, over stdio and HTTP, with real login shells.

const OPS = ["terminal.list", "terminal.create", "terminal.rename", "terminal.close"];
const FORWARD = OPS.join(",");
const ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000.25;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const fresh = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "pacer-terminal-parity-"))); dirs.push(dir); return dir; };

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"]);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}

type Step = { op: string; params?: unknown; env?: Record<string, string> };
type Seed = (home: string) => void;

const record = (more: object = {}) => ({ id: ID, kind: "shell", title: "zsh", cwd: "/tmp", createdAt: 1_700_000_000.125, rev: 3, state: "running", ...more });
function seedRecord(pacerHome: string, value: unknown = record()) {
  mkdirSync(join(pacerHome, "terminals", ID), { recursive: true, mode: 0o700 });
  writeFileSync(join(pacerHome, "terminals", ID, "record.json"), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
}
const stored = (pacerHome: string) => {
  const path = join(pacerHome, "terminals", ID, "record.json");
  return existsSync(path) ? `${(lstatSync(path).mode & 0o777).toString(8)} ${readFileSync(path, "utf8")}` : null;
};

/** What Core's bridge answers the driver; a reply the handler passes through unchanged is compared only by its request. */
const PARTS = { "terminal.present": { presented: true }, "terminal.stop": { stopped: true }, "terminal.list": [], "terminal.shell": { argv: ["/bin/sh", "-l"] }, "terminal.live": { live: 0 }, "terminal.start": { pid: 1 } };

/** Runs the steps through the TypeScript handlers and the native driver on identical homes. */
async function compare(steps: Step[], seed: Seed = () => {}) {
  const reference = fresh(), native = fresh();
  seed(reference);
  seed(native);
  const input = steps.map(step => JSON.stringify({ op: step.op, params: step.params ?? null, home: native, now: NOW, env: step.env ?? {}, terminalParts: PARTS })).join("\n") + "\n";
  const replies = execFileSync(driver(), [], { input, cwd: native }).toString().trim().split("\n").map(line => JSON.parse(line));
  for (const [i, step] of steps.entries()) {
    const ctx = fakeCtx({ home: reference, pacerHome: reference, now: NOW, env: step.env ?? {} });
    let expected: unknown;
    try { expected = { result: await callOp(ctx, step.op, step.params ?? null) }; }
    catch (error) { expected = { error: toApiError(error) }; }
    const { bridge: _bridge, ...actual } = replies[i];
    const label = JSON.stringify(step);
    if ("error" in (expected as object)) expect(JSON.stringify(actual), label).toBe(JSON.stringify(expected));
    else if (step.op === "terminal.close") expect(actual, label).toEqual(expected as object);
    else expect(actual.error, label).toBeUndefined();
  }
  expect(stored(native)).toBe(stored(reference));
  return replies;
}

const invalid = (op: string, params: unknown): Step => ({ op, params });
const CREATE = { request_id: "one", kind: "shell" };
const RENAME = { id: ID, title: "T", expect_rev: 3 };
const CLOSE = { id: ID, expect_rev: 3 };

test("native terminal parameters refuse like Zod, in Zod's order", async () => {
  const shapes: unknown[] = [[], "x", 1, true];
  const steps: Step[] = [
    ...OPS.flatMap(op => shapes.map(params => invalid(op, params))),
    invalid("terminal.list", { extra: 1 }), invalid("terminal.list", { b: 1, 2: 1, a: 1, 1: 1 }),
    invalid("terminal.create", null), invalid("terminal.create", {}), invalid("terminal.create", { ...CREATE, argv: ["sh"] }),
    ...["", "a b", "é", "x".repeat(129), "a\n", 1, null].map(request_id => invalid("terminal.create", { ...CREATE, request_id })),
    ...["action", 1, null].map(kind => invalid("terminal.create", { ...CREATE, kind })),
    ...["", "x".repeat(4097), "😀".repeat(2049), 1, null].map(cwd => invalid("terminal.create", { ...CREATE, cwd })),
    invalid("terminal.create", { request_id: "a b", kind: "x", cwd: "", z: 1, y: 2 }),
    invalid("terminal.rename", {}), invalid("terminal.rename", { ...RENAME, extra: 1 }),
    ...["", "not-a-uuid", ID.toUpperCase().replace("4111", "9111"), "11111111-1111-0111-8111-111111111111", "11111111-1111-4111-c111-111111111111", 1, null].map(id => invalid("terminal.rename", { ...RENAME, id })),
    ...["", "x".repeat(81), "😀".repeat(41), 1, null].map(title => invalid("terminal.rename", { ...RENAME, title })),
    ...[0, -1, -0, 1.5, -1.5, 1e20, -1e20, 9007199254740992, "1", null, true].map(expect_rev => invalid("terminal.rename", { ...RENAME, expect_rev })),
    invalid("terminal.close", {}), invalid("terminal.close", { ...CLOSE, title: "T" }),
    ...[0, 1.5, 1e20, "1"].map(expect_rev => invalid("terminal.close", { ...CLOSE, expect_rev })),
  ];
  await compare(steps);
}, 600_000);

test("native terminal operations refuse executor sessions after validating parameters", async () => {
  const env = { PACER_ROLE: "executor" };
  await compare([
    { op: "terminal.list", params: {}, env }, { op: "terminal.list", params: { x: 1 }, env },
    { op: "terminal.create", params: CREATE, env }, { op: "terminal.create", params: {}, env },
    { op: "terminal.rename", params: RENAME, env }, { op: "terminal.close", params: CLOSE, env },
  ], home => seedRecord(home));
}, 600_000);

test("native terminal ops refuse enforcement and assistant identities before the params", async () => {
  const enforced = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  const assistant = { PACER_ASSISTANT_GRANT: "pag_x" };
  await compare([
    ...OPS.map(op => ({ op, params: { x: 1 }, env: enforced })),
    { op: "terminal.create", params: { ...CREATE, cwd: "/" }, env: enforced },
    ...OPS.map(op => ({ op, params: { x: 1 }, env: assistant })),
    { op: "terminal.create", params: CREATE, env: assistant },
  ], home => seedRecord(home));
}, 600_000);

test("native rename and close keep TypeScript's revision guards and record bytes", async () => {
  const rename = (title: string, expect_rev: number): Step => ({ op: "terminal.rename", params: { id: ID, title, expect_rev } });
  const close = (expect_rev: number): Step => ({ op: "terminal.close", params: { id: ID, expect_rev } });
  await compare([rename("Stale", 2), rename("   ", 3), rename("  Build é ﻿", 3), rename("Next", 3), close(3), close(5), rename("Gone", 6), close(6)], home => seedRecord(home));
  // Unknown keys, their order and fractional times survive a rewrite.
  await compare([rename("Kept", 3)], home => seedRecord(home, `{"z":1,"id":"${ID}","10":"n","2":"m","kind":"shell","title":"a","cwd":"/tmp","createdAt":1700000000.1234567,"rev":3,"state":"running"}`));
  for (const value of ["not json", "null", "[]", "5", JSON.stringify(record({ id: "other" })), JSON.stringify(record({ state: "closed" }))]) {
    await compare([rename("T", 3), close(3)], home => seedRecord(home, value));
  }
  const upper = ID.replace("1111-4111", "AAAA-4111");
  await compare([{ op: "terminal.rename", params: { ...RENAME, id: upper } }, { op: "terminal.close", params: { ...CLOSE, id: upper } }]);
}, 600_000);

/** A terminal event skeleton: both runtimes promise one entity event per mutation, its removal flag and marker keys. */
function terminalEvents(dir: string) {
  const ctx = fakeCtx({ home: dir, pacerHome: dir, env: {} });
  return readOutboxSince(ctx, 0).flatMap(entry => {
    const event = parseOutboxEvent(entry.envelope);
    return event?.type === "entity" && event.data.kind === "terminal"
      ? [{ removed: "removed" in event.data, hasValue: "value" in event.data }]
      : [];
  });
}
function markerKeys(dir: string) {
  return Object.keys(JSON.parse(readFileSync(join(dir, "terminals", ID, "published.json"), "utf8"))).sort();
}

test("native rename and close publish the same terminal event shapes and marker format as TypeScript", async () => {
  const steps: Step[] = [
    { op: "terminal.rename", params: { id: ID, title: "T", expect_rev: 3 } },
    { op: "terminal.close", params: { id: ID, expect_rev: 4 } },
  ];
  const [reference, native] = [fresh(), fresh()];
  for (const dir of [reference, native]) seedRecord(dir);
  const input = steps.map(step => JSON.stringify({ op: step.op, params: step.params, home: native, now: NOW, env: {}, terminalParts: PARTS })).join("\n") + "\n";
  execFileSync(driver(), [], { input, cwd: native });
  for (const step of steps) {
    const ctx = fakeCtx({ home: reference, pacerHome: reference, now: NOW, env: {} });
    await callOp(ctx, step.op, step.params);
  }
  expect(terminalEvents(native)).toEqual(terminalEvents(reference));
  expect(terminalEvents(native)).toEqual([{ removed: false, hasValue: true }, { removed: true, hasValue: false }]);
  expect(markerKeys(native)).toEqual(markerKeys(reference));
  // Close leaves the removal marker; rename's { live, exit, rev } format is covered by the Rust unit test.
  expect(markerKeys(native)).toEqual(["removed"]);
}, 600_000);

test("registries only TypeScript reads faithfully stay forwarded", () => {
  const forwarded = (op: string, params: unknown, seed: Seed) => {
    const dir = fresh();
    seed(dir);
    const input = JSON.stringify({ op, params, home: dir, now: NOW, env: {}, terminalParts: PARTS }) + "\n";
    return JSON.parse(execFileSync(driver(), [], { input, cwd: dir }).toString()).forwarded === true;
  };
  const requests = (text: string) => (dir: string) => { mkdirSync(join(dir, "terminals"), { recursive: true }); writeFileSync(join(dir, "terminals", "requests.json"), text); };
  for (const text of ["null", "[]", "5", '"x"']) expect(forwarded("terminal.create", CREATE, requests(text)), text).toBe(true);
  expect(forwarded("terminal.create", CREATE, requests('{"one":5}'))).toBe(true);
  expect(forwarded("terminal.create", CREATE, requests("not json"))).toBe(false);
  const surrogate = `{"id":"${ID}","title":"\\ud800","rev":1,"state":"running"}`;
  expect(forwarded("terminal.list", {}, home => seedRecord(home, surrogate))).toBe(true);
  expect(forwarded("terminal.rename", RENAME, home => seedRecord(home, surrogate))).toBe(true);
  expect(forwarded("terminal.close", CLOSE, home => seedRecord(home, surrogate))).toBe(true);
  expect(forwarded("terminal.list", {}, home => seedRecord(home))).toBe(false);
}, 600_000);

test("native create reserves, refuses and records a failed launch like TypeScript", async () => {
  const run = (dir: string, parts: object, ...params: object[]) => {
    const input = params.map(p => JSON.stringify({ op: "terminal.create", params: p, home: dir, now: NOW, env: {}, terminalParts: { ...PARTS, ...parts } })).join("\n") + "\n";
    return execFileSync(driver(), [], { input, cwd: dir }).toString().trim().split("\n").map(line => JSON.parse(line));
  };
  const typescript = async (dir: string, start: () => { pid: number } | { error: string }, ...ids: string[]) => {
    const ctx = fakeCtx({ home: dir, pacerHome: dir, now: NOW, env: {} });
    const out: unknown[] = [];
    for (const requestId of ids) {
      try { out.push({ result: await createTerminal(ctx, { requestId, kind: "shell", cwd: dir }, { start }) }); }
      catch (error) { out.push({ error: toApiError(error) }); }
    }
    return out;
  };
  const shape = (dir: string) => {
    const root = join(dir, "terminals"), id = readdirSync(root).find(name => /^[0-9a-f-]{36}$/.test(name))!;
    const clean = (text: string) => text.replaceAll(id, "<id>").replaceAll(dir, "<home>").replace(/"payload":"[0-9a-f]{64}"/, '"payload":<hash>').replace(/"title":"[^"]*"/, '"title":<shell>');
    const file = (path: string) => `${(lstatSync(path).mode & 0o777).toString(8)} ${clean(readFileSync(path, "utf8"))}`;
    return [(lstatSync(root).mode & 0o777).toString(8), (lstatSync(join(root, id)).mode & 0o777).toString(8), file(join(root, id, "record.json")), file(join(root, "requests.json"))];
  };

  const [failedNative, failedReference] = [fresh(), fresh()];
  const replies = run(failedNative, { "terminal.start": { error: "boom" } }, { ...CREATE, cwd: failedNative }, { ...CREATE, cwd: failedNative });
  const expected = await typescript(failedReference, () => ({ error: "boom" }), "one", "one");
  expect(replies.map(({ bridge: _bridge, ...reply }) => reply)).toEqual(expected as object[]);
  expect(shape(failedNative)).toEqual(shape(failedReference));
  // The launch names only the reserved record: no command, folder or environment crosses the bridge.
  const launch = replies[0].bridge.find((request: { kind: string }) => request.kind === "terminal.start");
  expect(Object.keys(launch)).toEqual(["kind", "id"]);

  const [okNative, okReference] = [fresh(), fresh()];
  run(okNative, {}, { ...CREATE, cwd: okNative });
  await typescript(okReference, () => ({ pid: 1 }), "one");
  expect(shape(okNative)).toEqual(shape(okReference));

  const full = fresh();
  const [refused] = run(full, { "terminal.live": { live: 16 } }, { ...CREATE, cwd: full });
  expect(refused.error).toEqual({ code: "not_allowed", message: "Too many live terminals; close one before opening another" });
  expect(readdirSync(join(full, "terminals"))).toEqual([]);
}, 600_000);

// Front doors: real shells on twin homes.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Session start-up races the reply: these fields keep their presence and type, not their value. */
const clean = (text: string, dir: string) => text.replaceAll(realpathSync(dir), "<home>").replaceAll(dir, "<home>").replace(UUID, "<id>")
  .replace(/"createdAt":[\d.]+/g, '"createdAt":<now>').replace(/"live":(true|false)/g, '"live":<bool>')
  .replace(/"exit":(null|-?\d+)/g, '"exit":<exit>').replace(/"cols":\d+,"rows":\d+/g, '"cols":<n>,"rows":<n>')
  .replace(/"hostVersion":\{[^}]*\}/g, '"hostVersion":<host>').replace(/"payload":"[0-9a-f]{64}"/g, '"payload":<hash>');

type Call = (op: string, params: unknown) => Promise<string>;

function registry(dir: string) {
  const root = join(dir, ".pacer", "terminals");
  if (!existsSync(root)) return [];
  const file = (path: string) => `${(lstatSync(path).mode & 0o777).toString(8)} ${clean(readFileSync(path, "utf8"), dir)}`;
  const records = readdirSync(root).filter(name => UUID.test(name) || /^[0-9a-f-]{36}$/.test(name)).map(name => file(join(root, name, "record.json"))).sort();
  return [`${(lstatSync(root).mode & 0o777).toString(8)}`, file(join(root, "requests.json")), ...records];
}

/** The lifecycle both routes answer. `$H` names the home; ids come from each route's own replies. */
async function lifecycle(call: Call, dir: string) {
  const out: string[] = [];
  const step = async (op: string, params: unknown) => { const reply = await call(op, params); out.push(`${op} ${clean(reply, dir)}`); return reply; };
  await step("terminal.list", {});
  const created = await step("terminal.create", { request_id: "one", kind: "shell", cwd: dir });
  const id = created.match(UUID)?.[0];
  expect(id, created).toBeDefined();
  try {
    await step("terminal.create", { request_id: "one", kind: "shell", cwd: dir });
    await step("terminal.create", { request_id: "one", kind: "shell", cwd: join(dir, "r") });
    await step("terminal.create", { request_id: "__proto__", kind: "shell", cwd: dir });
    await step("terminal.create", { request_id: "constructor", kind: "shell" });
    await step("terminal.create", { request_id: "two", kind: "shell", cwd: "relative" });
    await step("terminal.create", { request_id: "two", kind: "shell", cwd: join(dir, "missing") });
    await step("terminal.create", { request_id: "two", kind: "shell", cwd: join(dir, ".pacer", "strategy.yaml") });
    await step("terminal.rename", { id, title: "Stale", expect_rev: 9 });
    await step("terminal.rename", { id, title: "   ", expect_rev: 1 });
    await step("terminal.rename", { id, title: "  Build shell  ", expect_rev: 1 });
    await step("terminal.list", {});
    await step("terminal.close", { id, expect_rev: 1 });
    out.push(...registry(dir));
    await step("terminal.close", { id, expect_rev: 2 });
    await step("terminal.close", { id, expect_rev: 3 });
    await step("terminal.rename", { id, title: "Gone", expect_rev: 3 });
    await step("terminal.create", { request_id: "one", kind: "shell", cwd: dir });
    await step("terminal.list", {});
    await step("terminal.list", { extra: 1 });
    await step("terminal.rename", { id: "nope", title: "", expect_rev: 0, extra: 1 });
    out.push(...registry(dir));
  } finally {
    await call("terminal.close", { id, expect_rev: 1 }).catch(() => "");
    await call("terminal.close", { id, expect_rev: 2 }).catch(() => "");
  }
  return out;
}

const doorEnv = (dir: string, port: string, forward: string | null, extra: Record<string, string> = {}) => ({
  HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:/usr/bin:/bin`, PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]), PACER_PORT: port,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", ...(forward ? { PACER_FORWARD_OPS: forward } : {}), ...extra,
});

async function overStdio<T>(dir: string, forward: string | null, run: (call: Call) => Promise<T>, extra: Record<string, string> = {}) {
  const child = spawnPinned([front!, "api", "--stdio"], { cwd: dir, env: doorEnv(dir, closedPort(), forward, extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let buffered = "", id = 1;
  const line = async () => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdio closed: ${await stderr}`);
      buffered += new TextDecoder().decode(value);
    }
    const at = buffered.indexOf("\n"), out = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return out;
  };
  const send = (value: object) => { child.stdin.write(JSON.stringify(value) + "\n"); child.stdin.flush(); };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } });
    await line();
    const result = await run(async (op, params) => { send({ jsonrpc: "2.0", id: ++id, method: op, params }); return (await line()).replace(/"id":\d+,?/, ""); });
    child.stdin.end();
    await child.exited;
    return { result, stderr: await stderr };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

async function overHttp<T>(dir: string, forward: string | null, run: (call: Call) => Promise<T>) {
  const server = await serve(dir, forward);
  try {
    const result = await run((op, params) => server.post(op, params));
    return { result, stderr: await server.stop() };
  } catch (error) { await server.stop(); throw error; }
}

const markers = (stderr: string) => stderr.split("\n").filter(line => OPS.includes(line.split(" ")[1] ?? "") && line.startsWith("native "));

for (const transport of ["stdio", "http"] as const) {
  const over = transport === "stdio" ? overStdio : overHttp;
  test.skipIf(!front)(`terminal lifecycle over ${transport} matches forced forwarding`, async () => {
    const twin = () => { const dir = realpathSync(home()); mkdirSync(join(dir, "r"), { recursive: true }); return dir; };
    const [native, forwarded] = [twin(), twin()];
    const [a, b] = await Promise.all([over(native, null, call => lifecycle(call, native)), over(forwarded, FORWARD, call => lifecycle(call, forwarded))]);
    expect(a.result).toEqual(b.result);
    expect(markers(a.stderr).length).toBeGreaterThan(10);
    expect(markers(b.stderr)).toEqual([]);
  }, 180_000);
}

test.skipIf(!front)("an executor session is refused natively over stdio like forced forwarding", async () => {
  const sequential = async (call: Call) => { const out: string[] = []; for (const ask of [(c: Call) => c("terminal.list", {}), (c: Call) => c("terminal.list", { x: 1 }), (c: Call) => c("terminal.create", { request_id: "e", kind: "shell" }), (c: Call) => c("terminal.close", { id: ID, expect_rev: 1 })]) out.push(await ask(call)); return out; };
  const executor = { PACER_ROLE: "executor" };
  const [native, forwarded] = [realpathSync(home()), realpathSync(home())];
  const a = await overStdio(native, null, sequential, executor), b = await overStdio(forwarded, FORWARD, sequential, executor);
  expect(a.result).toEqual(b.result);
  expect(a.result[0]).toContain("Executor sessions cannot manage general terminals");
  expect(markers(a.stderr).length).toBe(4);
  expect(existsSync(join(native, ".pacer", "terminals"))).toBe(false);
}, 180_000);

test.skipIf(!front)("an enforcement identity over stdio is refused by Core like forced forwarding", async () => {
  const enforce = async (call: Call) => { const out: string[] = []; for (const ask of [(c: Call) => c("terminal.list", { x: 1 }), (c: Call) => c("terminal.create", { request_id: "e", kind: "shell" }), (c: Call) => c("terminal.rename", { id: ID, title: "T", expect_rev: 1 }), (c: Call) => c("terminal.close", { id: ID, expect_rev: 1 })]) out.push(await ask(call)); return out; };
  const identity = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  const [native, forwarded] = [realpathSync(home()), realpathSync(home())];
  const a = await overStdio(native, null, enforce, identity), b = await overStdio(forwarded, FORWARD, enforce, identity);
  expect(a.result).toEqual(b.result);
  expect(a.result[0]).toContain("Enforcement identity only reports a native child denial");
  // API-5: a stdio session holding the identity runs nothing natively.
  expect(markers(a.stderr).length).toBe(0);
}, 180_000);
