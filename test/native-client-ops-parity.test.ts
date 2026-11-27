import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toApiError } from "../src/api/errors";
import { clientControlBridge } from "../src/api/client-control-bridge";
import { ClientControl } from "../src/clients/control";
import type { Ctx } from "../src/types";
import { closedPort, pinnedPort } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const U = "00000000-0000-4000-8000-000000000000", T = "a".repeat(64);

const baseEnv = (home: string, extra: Record<string, string> = {}) => ({
  HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  ...extra,
});
function tempHome() {
  const home = mkdtempSync("/tmp/pcl-");
  mkdirSync(join(home, ".pacer", "state"), { recursive: true, mode: 0o700 });
  return home;
}
const registryFile = (home: string) => join(home, ".pacer", "state", "clients.json");

/** Ids, credentials and clocks differ per run; number them in order of first use. */
function normalize(text: string) {
  const seen = new Map<string, string>();
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{64}\b/g, match => {
      if (match === U || match === T) return match;
      if (!seen.has(match)) seen.set(match, `<id${seen.size}>`);
      return seen.get(match)!;
    })
    .replace(/"(deadline|registeredAt|heartbeatAt|permission_changed_at)":[0-9.e+-]+/g, '"$1":"<time>"');
}

/** One interactive `pacer api --stdio` connection; replies are matched by request id. */
async function stdio(home: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([front!, "api", "--stdio"], { cwd: home, env: pinnedPort(baseEnv(home, extra)), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const waiting = new Map<number, (line: string) => void>();
  const reader = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const id = JSON.parse(line).id as number;
        waiting.get(id)?.(line);
        waiting.delete(id);
      }
    }
  })();
  let next = 1;
  const raw = async (method: string, params?: unknown) => {
    const id = next++;
    const reply = new Promise<string>(resolve => waiting.set(id, resolve));
    await child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    await child.stdin.flush();
    return reply;
  };
  expect(JSON.parse(await raw("hello", { protocol: 3 })).result.protocol).toBe("3.0.0");
  const close = async () => {
    await child.stdin.end();
    await Promise.race([child.exited, Bun.sleep(5000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await reader;
    return stderr;
  };
  return { raw, close };
}

/** `ready=false` is for scoped sessions, whose Core child cannot announce `/v3/hello`. */
async function serve(home: string, extra: Record<string, string> = {}, ready = true) {
  const port = closedPort();
  const env = pinnedPort(baseEnv(home, extra), port);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let n = 0; n < 500 && !token; n++) {
    try {
      const candidate = readFileSync(join(env.PACER_HOME, "token"), "utf8").trim();
      if (!candidate) continue;
      if (!ready) { token = candidate; break; }
      const response = await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(500) });
      if (response.ok) token = candidate;
    } catch {}
    if (!token) await Bun.sleep(20);
  }
  expect(token).not.toBe("");
  const post = async (op: string, body: string | Uint8Array<ArrayBuffer>) => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(20000) });
    return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
  };
  const stop = async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    return stderr;
  };
  return { post, stop };
}
const httpMarkers = (stderr: string) => stderr.split("\n").filter(line => /^native client\.[\w.]+$/.test(line));
const stdioMarkers = (stderr: string) => stderr.split("\n").filter(line => /^native client\.[\w.]+ \d+$/.test(line)).map(line => line.replace(/ \d+$/, ""));

const invalidParams: [string, unknown][] = [
  ["client.register", undefined], ["client.register", null], ["client.register", {}], ["client.register", []], ["client.register", "x"], ["client.register", 1], ["client.register", true],
  ["client.register", { kind: "bad", version: "" }],
  ["client.register", { kind: 1, version: 2, notifier: "x", capture: 1, notification_permission: "x", notification_alerts: null }],
  ["client.register", { kind: "app", version: "", capture: true }], ["client.register", { kind: "bad", version: "", capture: true }],
  ["client.register", { kind: "app", version: "1", capture: true }], ["client.register", { kind: "app", version: 1, capture: true }],
  ["client.register", { kind: "app", version: "1", capture: true, notifier: "x" }], ["client.register", { kind: "app", version: "1", capture: "yes" }],
  ["client.heartbeat", {}], ["client.heartbeat", { client_id: "" }], ["client.heartbeat", { client_id: "x".repeat(129) }],
  ["client.heartbeat", { client_id: "😀".repeat(129) }], ["client.heartbeat", { client_id: "😀".repeat(128) }], ["client.heartbeat", { client_id: "é".repeat(128) }],
  ["client.heartbeat", { client_id: 1, notifier: 1, notification_permission: 1, notification_alerts: 1 }],
  ["client.list", []], ["client.list", "x"], ["client.list", 5],
  ["client.control.enroll", {}], ["client.control.enroll", { kind: "x", window: "y" }], ["client.control.enroll", { kind: 1, window: null }],
  ["client.control.targets", [1]], ["client.control.targets", "x"],
  ["client.control.request", {}], ["client.control.request", { client_id: "x", action: {} }],
  ...[null, "x", [], {}, { type: "nope" }, { type: 1 }, { type: "theme.set" }, { type: "theme.set", value: "x" }, { type: "navigate" }, { type: "navigate", route: "" },
    { type: "navigate", route: "x" }, { type: "navigate", route: "//x" }, { type: "navigate", route: "/" + "a".repeat(2048) }, { type: "navigate", route: "x".repeat(2049) },
    { type: "navigate", route: "/a\nb" }, { type: "navigate", route: "/a\u001f" }, { type: "navigate", route: 1 }, { type: "window", action: "x" }, { type: "window" }, { type: "tray" }, { type: "tray", action: "close" },
    { type: "launch-at-login", enabled: "x" }, { type: "launch-at-login" }].map(action => ["client.control.request", { client_id: U, action }] as [string, unknown]),
  ["client.control.result", {}], ["client.control.result", { request_id: "ABCDEF00-0000-4000-8000-000000000000" }], ["client.control.result", { request_id: `${U}\n` }], ["client.control.result", { request_id: 1 }],
  ["client.control.claim", {}], ["client.control.claim", { client_id: U, worker_token: "A".repeat(64) }], ["client.control.claim", { client_id: 1, worker_token: 2 }],
  ["client.control.complete", {}], ["client.control.complete", { request_id: U, worker_token: T, error: "x" }], ["client.control.complete", { request_id: U, worker_token: T, error: null, result: null }],
  ["client.control.complete", { request_id: "x", worker_token: "y", error: 1 }],
];

test.skipIf(!front)("published params are enforced natively over stdio", async () => {
  const home = tempHome();
  const client = await stdio(home);
  try {
    const replies: string[] = [];
    for (const [op, params] of invalidParams) replies.push(await client.raw(op, params));
    expect(replies.every(line => JSON.parse(line).error?.data?.code === "invalid_input")).toBe(true);
    expect(stdioMarkers(await client.close())).toEqual(invalidParams.map(([op]) => `native ${op}`));
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 120000);

test.skipIf(!front)("published params and undecodable bodies are enforced natively over HTTP", async () => {
  const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap(part => typeof part === "string" ? [...new TextEncoder().encode(part)] : part));
  const paramsCases = invalidParams.filter(([, params]) => params !== undefined).map(([op, params]) => [op, JSON.stringify(params)] as [string, string]);
  // A BOM is stripped by the JSON reader, so this is a published-params error, not a decode error.
  paramsCases.push(["client.heartbeat", new TextDecoder().decode(bytes([0xef, 0xbb, 0xbf], '{"client_id":""}'))]);
  // Bodies only a JavaScript parser accepts (S0/Q3), plus malformed bytes and an oversized body.
  const undecodable: [string, string | Uint8Array<ArrayBuffer>][] = [
    // A lone surrogate is a JSON escape JavaScript accepts but the serde documents refuse.
    ["client.register", String.raw`{"kind":"app","version":"\ud800"}`],
    ["client.control.complete", `{"request_id":"${U}","worker_token":"${T}","result":"\\ud800"}`],
    ["client.list", "{"],
    ["client.list", ""],
    ["client.heartbeat", bytes('{"client_id":"', [0xff, 0xfe], '"}')],
    ["client.control.complete", `{"request_id":"${U}","worker_token":"${T}","result":1e400}`],
    ["client.list", "x".repeat(256 * 1024 + 1)],
  ];
  const home = tempHome();
  const service = await serve(home);
  try {
    const replies = [];
    for (const [op, body] of paramsCases) replies.push(await service.post(op, body));
    for (const [op, body] of undecodable) replies.push(await service.post(op, body));
    expect(httpMarkers(await service.stop())).toEqual(paramsCases.map(([op]) => `native ${op}`));
    for (const reply of replies.slice(0, paramsCases.length)) {
      expect(JSON.parse(reply.body).error.code).toBe("invalid_input");
    }
    for (const [index, reply] of replies.slice(paramsCases.length, -1).entries()) {
      expect(JSON.parse(reply.body).error, `undecodable case ${index}: ${undecodable[index]![0]}`).toEqual({ code: "invalid_input", message: "body is not JSON" });
    }
    expect(replies.at(-1)!.status).toBe(413);
  } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
}, 120000);

/** Stored shapes `client.list` must read exactly as TypeScript does; S0 cases read as unreadable. */
const FUTURE = 4102444800;
const entry = (fields: Record<string, unknown> = {}) => ({ client_id: "c1", kind: "app", version: "1", notifier: false, registeredAt: 1, heartbeatAt: FUTURE, ...fields });
const seeds: [string, string, number, boolean][] = [
  ["missing", "", 0, false],
  ["unparsable", "{", 0, false],
  ["bom", `﻿${JSON.stringify([entry()])}`, 0, false],
  ["object", "{}", 0, false],
  ["null", "null", 0, false],
  ["empty", "[]", 0, false],
  ["valid", JSON.stringify([entry()]), 1, true],
  ["stripped and reordered", JSON.stringify([{ extra: 1, heartbeatAt: FUTURE, registeredAt: 1, notifier: true, version: "2", kind: "tui", client_id: "c2", permission_changed_at: 7.5, notification_alerts: "banner", notification_permission: "denied" }]), 1, false],
  ["lapsed entry is hidden", JSON.stringify([entry({ heartbeatAt: 1 }), entry({ client_id: "c3" })]), 1, true],
  ["one invalid entry empties the list", JSON.stringify([entry(), entry({ client_id: "" })]), 0, false],
  ["invalid kind", JSON.stringify([entry({ kind: "bogus" })]), 0, false],
  ["null permission", JSON.stringify([entry({ notification_permission: null })]), 0, false],
  ["string clock", JSON.stringify([entry({ heartbeatAt: "1" })]), 0, false],
  ["infinite clock", JSON.stringify([entry()]).replace(String(FUTURE), "1e999"), 0, false],
  ["whole float", JSON.stringify([entry()]).replace(String(FUTURE), `${FUTURE}.0`), 1, true],
  ["fraction", JSON.stringify([entry({ registeredAt: 1763512345.125 })]), 1, true],
  ["exponent clock", JSON.stringify([entry({ registeredAt: 1e21 })]), 1, true],
  ["small clock", JSON.stringify([entry({ registeredAt: 0.0000015 })]), 1, true],
  ["large whole clock", JSON.stringify([entry({ registeredAt: 1e20 })]), 1, true],
  // S0/Q3: quoted JS-only strings and deep nesting read as an unreadable, empty file.
  ["noncharacter text", JSON.stringify([entry({ version: "﷐" })]), 0, false],
  ["lone surrogate", JSON.stringify([entry()]).replace('"version":"1"', String.raw`"version":"\ud800"`), 0, false],
  ["unicode", JSON.stringify([entry({ version: "é😀 " })]), 1, true],
  ["deep unknown field", JSON.stringify([{ ...entry(), deep: 0 }]).replace('"deep":0', `"deep":${"[".repeat(600)}${"]".repeat(600)}`), 0, false],
  ["exponent heartbeatAt", JSON.stringify([entry({ heartbeatAt: 1e3 })]), 0, true],
];

test.skipIf(!front)("stored registries read and rewrite natively", async () => {
  for (const [name, seed, count, beatOk] of seeds) {
    const home = tempHome();
    if (name !== "missing") writeFileSync(registryFile(home), seed);
    const client = await stdio(home);
    try {
      const listed = JSON.parse(await client.raw("client.list", {})).result;
      expect(listed, name).toHaveLength(count);
      const beat = JSON.parse(await client.raw("client.heartbeat", { client_id: "c1", notifier: true, notification_alerts: "alert" }));
      expect(beat.error?.data?.code === "invalid_input", name).toBe(!beatOk);
      let file = "";
      try { file = readFileSync(registryFile(home), "utf8"); } catch {}
      if (beatOk) {
        expect(file, name).toContain('"notifier":true');
        expect(file, name).toContain('"notification_alerts":"alert"');
      } else {
        expect(normalize(file), name).toBe(normalize(seed));
      }
    } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
  }
}, 240000);

test.skipIf(!front)("registration, heartbeat and listing write the same file as TypeScript", async () => {
  const flows: [string, unknown][] = [
    ["client.register", { kind: "desktop", version: "1.2.3", notifier: true, notification_permission: "unsupported", notification_alerts: "none", ignored: 1 }],
    ["client.register", { version: "é😀", kind: "tui" }],
    ["client.register", { kind: "cli", version: "2", notification_alerts: "banner", notifier: false, capture: false }],
  ];
  const home = tempHome();
  const client = await stdio(home);
  try {
    const log: string[] = [];
    const ids: string[] = [];
    for (const [op, params] of flows) {
      const line = await client.raw(op, params);
      ids.push(JSON.parse(line).result.client_id);
      expect(ids.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
      log.push(normalize(line), normalize(readFileSync(registryFile(home), "utf8")));
    }
    const beats: Record<string, unknown>[] = [
      { client_id: ids[0], notification_permission: "authorized" },
      { client_id: ids[0], notification_permission: "denied" },
      { client_id: ids[0], notification_alerts: "alert", notifier: false },
      { client_id: ids[1], notification_permission: "denied", notification_alerts: "none" },
      { client_id: ids[1] },
      { client_id: "missing" },
    ];
    let marker: unknown;
    for (const beat of beats) {
      const line = await client.raw("client.heartbeat", beat);
      log.push(normalize(line), normalize(readFileSync(registryFile(home), "utf8")));
      if (beat.client_id === ids[0] && beat.notification_permission === "denied") {
        const stored = JSON.parse(readFileSync(registryFile(home), "utf8"));
        marker = stored.find((item: { client_id: string }) => item.client_id === ids[0]).permission_changed_at;
      }
    }
    expect(marker).toBeDefined();
    expect(JSON.parse(await client.raw("client.list")).result).toHaveLength(3);
    expect(stdioMarkers(await client.close()).length).toBe(10);
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("entries a day past their heartbeat are dropped at the next registration", async () => {
  const home = tempHome();
  const now = Date.now() / 1000;
  writeFileSync(registryFile(home), JSON.stringify([entry({ client_id: "old", heartbeatAt: now - 86500 }), entry({ client_id: "kept", heartbeatAt: now - 3600 })]));
  const client = await stdio(home);
  try {
    await client.raw("client.register", { kind: "app", version: "1" });
    const stored = JSON.parse(readFileSync(registryFile(home), "utf8")) as { client_id: string }[];
    expect(stored.map(item => item.client_id).slice(0, 1)).toEqual(["kept"]);
    expect(stored).toHaveLength(2);
    expect(JSON.parse(await client.raw("client.list")).result).toHaveLength(1);
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 30000);

test.skipIf(!front)("concurrent HTTP registrations lose no entry", async () => {
  const home = tempHome();
  const service = await serve(home);
  try {
    const replies = await Promise.all(Array.from({ length: 24 }, (_, n) => service.post("client.register", JSON.stringify({ kind: "app", version: String(n) }))));
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    expect(JSON.parse(readFileSync(registryFile(home), "utf8"))).toHaveLength(24);
  } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

type Call = (op: string, params?: unknown) => Promise<string>;
/** Normalize a transport line to `{result}` or `{error:{code,message,hint?}}` for comparison. */
function shape(line: string): string {
  const reply = JSON.parse(line);
  if (reply.result !== undefined) return normalize(JSON.stringify({ result: reply.result }));
  const data = reply.error?.data ?? reply.error;
  return normalize(JSON.stringify({
    error: { code: data.code ?? reply.error.code, message: reply.error.message, ...(data.hint ? { hint: data.hint } : {}) },
  }));
}

/** The whole worker loop and each refusal; returns normalized replies. */
async function controlFlow(call: Call) {
  const log: string[] = [];
  const step = async (op: string, params?: unknown) => {
    const line = await call(op, params);
    log.push(shape(line));
    return JSON.parse(line);
  };
  const value = (reply: any) => reply.result ?? reply;
  const app = value(await step("client.control.enroll", { kind: "app", window: "main" }));
  const tray = value(await step("client.control.enroll", { kind: "desktop", window: "tray" }));
  const desktop = value(await step("client.control.enroll", { kind: "desktop", window: "main", ignored: true }));
  await step("client.control.targets", {});
  await step("client.control.targets");
  await step("client.control.request", { client_id: U, action: { type: "quit" } });
  await step("client.control.request", { client_id: tray.client_id, action: { type: "navigate", route: "/settings" } });
  await step("client.control.request", { client_id: app.client_id, action: { type: "quit" } });
  await step("client.control.request", { client_id: app.client_id, action: { type: "window", action: "show" } });
  await step("client.control.claim", { client_id: app.client_id, worker_token: T });
  await step("client.control.claim", { client_id: app.client_id, worker_token: app.worker_token });
  const request = value(await step("client.control.request", { client_id: app.client_id, action: { type: "navigate", route: "/tasks?q=é", stripped: 1 } }));
  await step("client.control.request", { client_id: app.client_id, action: { type: "theme.get" } });
  await step("client.control.result", { request_id: request.request_id });
  await step("client.control.complete", { request_id: request.request_id, worker_token: app.worker_token, result: { early: true } });
  await step("client.control.claim", { client_id: app.client_id, worker_token: app.worker_token });
  await step("client.control.complete", { request_id: request.request_id, worker_token: desktop.worker_token, result: {} });
  await step("client.control.complete", { request_id: request.request_id, worker_token: app.worker_token, result: { n: 1.5, big: 12345678901234567890, list: [null, "é", { "2": 1, "1": 2 }] } });
  await step("client.control.result", { request_id: request.request_id });
  await step("client.control.complete", { request_id: request.request_id, worker_token: app.worker_token });
  const failed = value(await step("client.control.request", { client_id: desktop.client_id, action: { type: "launch-at-login", enabled: true } }));
  await step("client.control.claim", { client_id: desktop.client_id, worker_token: desktop.worker_token });
  await step("client.control.complete", { request_id: failed.request_id, worker_token: desktop.worker_token, result: "ignored", error: "unsupported" });
  await step("client.control.result", { request_id: failed.request_id });
  await step("client.control.result", { request_id: U });
  return log;
}

/** The TypeScript reference the native broker was ported from. */
function referenceCall(broker: ClientControl): Call {
  return async (op, params) => {
    const p = (params ?? {}) as any;
    try {
      let result: unknown;
      switch (op) {
        case "client.control.enroll": result = broker.enroll(p.kind, p.window); break;
        case "client.control.targets": result = broker.targets(); break;
        case "client.control.request": result = broker.request(p.client_id, p.action); break;
        case "client.control.result": result = broker.result(p.request_id); break;
        case "client.control.claim": result = broker.claim(p.client_id, p.worker_token); break;
        case "client.control.complete": result = broker.complete(p.request_id, p.worker_token, p.result, p.error); break;
        default: throw new Error(`unexpected op ${op}`);
      }
      return JSON.stringify({ result });
    } catch (error) { return JSON.stringify({ error: toApiError(error) }); }
  };
}

test.skipIf(!front)("the control worker loop matches the TypeScript broker over stdio", async () => {
  const home = tempHome();
  const client = await stdio(home);
  try {
    const log = await controlFlow(client.raw);
    expect(log).toEqual(await controlFlow(referenceCall(new ClientControl(() => Date.now()))));
    expect(stdioMarkers(await client.close()).length).toBe(log.length);
    expect(JSON.parse(log[0]!).result.worker_token).toBe("<id1>");
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("the control worker loop matches the TypeScript broker over HTTP", async () => {
  const home = tempHome();
  const service = await serve(home);
  try {
    const log = await controlFlow(async (op, params) => {
      const reply = await service.post(op, params === undefined ? "null" : JSON.stringify(params));
      return reply.body;
    });
    expect(log).toEqual(await controlFlow(referenceCall(new ClientControl(() => Date.now()))));
    expect(httpMarkers(await service.stop()).length).toBe(log.length);
  } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("control results use serde number spelling and refuse unpaired surrogates", async () => {
  const home = tempHome();
  const service = await serve(home);
  try {
    const post = async (op: string, body: string) => (await service.post(op, body)).body;
    const worker = JSON.parse(await post("client.control.enroll", '{"kind":"app","window":"main"}')).result;
    const log: string[] = [];
    for (const result of ["1e21", "1.5e-7", "100000000000000000000", "-0"]) {
      const request = JSON.parse(await post("client.control.request", JSON.stringify({ client_id: worker.client_id, action: { type: "theme.get" } }))).result;
      log.push(await post("client.control.claim", JSON.stringify({ client_id: worker.client_id, worker_token: worker.worker_token })));
      log.push(await post("client.control.complete", `{"request_id":"${request.request_id}","worker_token":"${worker.worker_token}","result":${result}}`));
      log.push(await post("client.control.result", JSON.stringify({ request_id: request.request_id })));
    }
    // serde_json writes exponent numbers with an explicit `+` sign, as JSON.stringify does here.
    expect(log.join("\n")).toContain("1e+21");
    expect(log.join("\n")).toContain("1.5e-7");
    expect(log.join("\n")).toContain("1e+20");
    expect(log.join("\n")).toContain("-0.0");
    // S0/Q3: the serde body decoder refuses the escape JavaScript accepts.
    const rejected = JSON.parse(await post("client.control.complete", `{"request_id":"${U}","worker_token":"${T}","result":"\\ud800"}`));
    expect(rejected.error).toEqual({ code: "invalid_input", message: "body is not JSON" });
  } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("a desktop capture registration carries a credential Core's broker accepts", async () => {
  const home = tempHome();
  const client = await stdio(home);
  try {
    const reply = JSON.parse(await client.raw("client.register", { kind: "desktop", version: "1", capture: true })).result;
    expect(Object.keys(reply)).toEqual(["client_id", "lease_s", "capture_worker"]);
    expect(reply.capture_worker).toMatch(/^[0-9a-f]{64}$/);
    const renewed = JSON.parse(await client.raw("desktop.capture.register", { client_id: reply.client_id, worker_token: reply.capture_worker }));
    expect(renewed.result).toEqual({ worker_token: reply.capture_worker });
    const stored = JSON.parse(readFileSync(registryFile(home), "utf8"));
    expect(JSON.stringify(stored)).not.toContain(reply.capture_worker);
    expect(Object.keys(stored[0])).not.toContain("capture");
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 30000);

test.skipIf(!front)("assistant and enforcement callers are refused natively over HTTP", async () => {
  // A scoped stdio session forwards the whole connection to Core before any op runs,
  // so those identities are observed over HTTP, where each op is dispatched natively.
  for (const [extra, message] of [
    [{ PACER_ASSISTANT_GRANT: "pag_x" }, "An assistant grant runs assistant.tool only."],
    [{ PACER_ENFORCEMENT_TOKEN: "pet_x" }, "Enforcement identity only reports a native child denial"],
  ] as [Record<string, string>, string][]) {
    const home = tempHome();
    const service = await serve(home, extra, false);
    try {
      for (const op of ["client.list", "client.control.targets"]) {
        const reply = JSON.parse((await service.post(op, "{}")).body);
        expect(reply.error).toEqual({ code: "not_allowed", message });
      }
      expect(httpMarkers(await service.stop())).toEqual(["native client.list", "native client.control.targets"]);
    } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
  }
}, 60000);

test.skipIf(!front)("forced forwarding reports unavailable for a native-only op", async () => {
  const home = tempHome();
  const service = await serve(home, { PACER_FORWARD_OPS: "client.control.targets" });
  try {
    const reply = JSON.parse((await service.post("client.control.targets", "{}")).body);
    expect(reply.error).toEqual({
      code: "unavailable",
      message: "client.control.targets is answered by the pacer front door",
      hint: "Unset PACER_FORWARD_OPS for this operation.",
    });
  } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("a directory registry is refused natively", async () => {
  const home = tempHome();
  mkdirSync(registryFile(home));
  const client = await stdio(home);
  try {
    const reply = JSON.parse(await client.raw("client.register", { kind: "app", version: "1" }));
    expect(reply.error.data.code).toBe("internal");
    expect(reply.error.message).toMatch(/directory/i);
    expect(stdioMarkers(await client.close())).toEqual(["native client.register"]);
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("the client control bridge is sealed from stdio callers", async () => {
  const home = tempHome();
  const client = await stdio(home);
  try {
    const request = { op: "client.control.targets", params: {} };
    for (const params of [{ request }, { request, key: "guess" }]) {
      expect(JSON.parse(await client.raw("_internal.client-control", params)).error.data.code).toBe("unknown_op");
    }
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 30000);

test("the client control bridge gates desktop capture registration on a live desktop client", async () => {
  const home = tempHome();
  const now = Date.now() / 1000;
  const ctx = { pacerHome: join(home, ".pacer"), now } as Ctx;
  const request = { op: "client.capture.register", client_id: "abc" };
  await expect(clientControlBridge(ctx, request)).rejects.toMatchObject({ code: "not_found" });
  writeFileSync(registryFile(home), JSON.stringify([{ client_id: "abc", kind: "desktop", version: "1", notifier: false, registeredAt: now, heartbeatAt: now }]));
  const reply = await clientControlBridge(ctx, request) as { reply: string };
  expect(reply.reply).toMatch(/^[0-9a-f]{64}$/);
  writeFileSync(registryFile(home), JSON.stringify([{ client_id: "abc", kind: "desktop", version: "1", notifier: false, registeredAt: now, heartbeatAt: now - 60 }]));
  await expect(clientControlBridge(ctx, request)).rejects.toMatchObject({ code: "not_found" });
  writeFileSync(registryFile(home), JSON.stringify([{ client_id: "abc", kind: "app", version: "1", notifier: false, registeredAt: now, heartbeatAt: now }]));
  await expect(clientControlBridge(ctx, request)).rejects.toMatchObject({ code: "not_found" });
  rmSync(home, { recursive: true, force: true });
}, 30000);
