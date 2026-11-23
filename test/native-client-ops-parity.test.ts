import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientControlBridge } from "../src/api/client-control-bridge";
import type { Ctx } from "../src/types";
import { closedPort, pinnedPort } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = ["client.register", "client.heartbeat", "client.list", "client.control.enroll", "client.control.targets",
  "client.control.request", "client.control.result", "client.control.claim", "client.control.complete"];
const U = "00000000-0000-4000-8000-000000000000", T = "a".repeat(64);

const baseEnv = (home: string, forward: boolean, extra: Record<string, string> = {}) => ({
  HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS.join(",") } : {}),
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
    .replace(/"(deadline|registeredAt|heartbeatAt|permission_changed_at)":[0-9.e+]+/g, '"$1":"<time>"');
}

/** One interactive `pacer api --stdio` connection; replies are matched by request id. */
async function stdio(home: string, forward: boolean, extra: Record<string, string> = {}) {
  const child = Bun.spawn([front!, "api", "--stdio"], { cwd: home, env: pinnedPort(baseEnv(home, forward, extra)), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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

async function serve(home: string, forward: boolean) {
  const port = closedPort();
  const env = pinnedPort(baseEnv(home, forward), port);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let n = 0; n < 500 && !token; n++) {
    try {
      const candidate = readFileSync(join(env.PACER_HOME, "token"), "utf8").trim();
      const response = await fetch(`${base}/v2/hello`, { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(500) });
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

test.skipIf(!front)("params errors match forced forwarding byte for byte over stdio", async () => {
  const run = async (forward: boolean) => {
    const home = tempHome();
    const client = await stdio(home, forward);
    try {
      const replies: string[] = [];
      for (const [op, params] of invalidParams) replies.push(await client.raw(op, params));
      return { replies, stderr: await client.close() };
    } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.replies).toEqual(forwarded.replies);
  expect(stdioMarkers(native.stderr)).toEqual(invalidParams.map(([op]) => `native ${op}`));
  expect(stdioMarkers(forwarded.stderr)).toEqual([]);
  // The two valid heartbeats name an unknown client, which is also `invalid_input`.
  expect(native.replies.every(line => JSON.parse(line).error?.data?.code === "invalid_input")).toBe(true);
}, 120000);

test.skipIf(!front)("params errors and undecodable bodies match forced forwarding over HTTP", async () => {
  const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap(part => typeof part === "string" ? [...new TextEncoder().encode(part)] : part));
  const cases: { op: string; body: string | Uint8Array<ArrayBuffer>; native: boolean }[] = [
    ...invalidParams.filter(([, params]) => params !== undefined).map(([op, params]) => ({ op, body: JSON.stringify(params), native: true })),
    // Bodies serde_json refuses reach Core unchanged, as TypeScript's decoder reads them.
    { op: "client.list", body: "{", native: false },
    { op: "client.list", body: "", native: false },
    { op: "client.register", body: String.raw`{"kind":"app","version":"\ud800"}`, native: false },
    { op: "client.heartbeat", body: bytes([0xef, 0xbb, 0xbf], '{"client_id":""}'), native: false },
    { op: "client.heartbeat", body: bytes('{"client_id":"', [0xff, 0xfe], '"}'), native: false },
    { op: "client.control.complete", body: `{"request_id":"${U}","worker_token":"${T}","result":1e400}`, native: false },
    { op: "client.list", body: "x".repeat(256 * 1024 + 1), native: false },
  ];
  const run = async (forward: boolean) => {
    const home = tempHome();
    const service = await serve(home, forward);
    try {
      const replies = [];
      for (const { op, body } of cases) replies.push(await service.post(op, body));
      return { replies: replies.map(reply => ({ ...reply, body: normalize(reply.body) })), stderr: await service.stop() };
    } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.replies).toEqual(forwarded.replies);
  expect(httpMarkers(native.stderr)).toEqual(cases.filter(c => c.native).map(c => `native ${c.op}`));
  expect(httpMarkers(forwarded.stderr)).toEqual([]);
  expect(native.replies.at(-1)!.status).toBe(413);
}, 120000);

/** Stored shapes `client.list` must read exactly as TypeScript does. */
const FUTURE = 4102444800;
const entry = (fields: Record<string, unknown> = {}) => ({ client_id: "c1", kind: "app", version: "1", notifier: false, registeredAt: 1, heartbeatAt: FUTURE, ...fields });
const seeds: [string, string][] = [
  ["missing", ""],
  ["unparsable", "{"],
  ["bom", `﻿${JSON.stringify([entry()])}`],
  ["object", "{}"],
  ["null", "null"],
  ["empty", "[]"],
  ["valid", JSON.stringify([entry()])],
  ["stripped and reordered", JSON.stringify([{ extra: 1, heartbeatAt: FUTURE, registeredAt: 1, notifier: true, version: "2", kind: "tui", client_id: "c2", permission_changed_at: 7.5, notification_alerts: "banner", notification_permission: "denied" }])],
  ["lapsed entry is hidden", JSON.stringify([entry({ heartbeatAt: 1 }), entry({ client_id: "c3" })])],
  ["one invalid entry empties the list", JSON.stringify([entry(), entry({ client_id: "" })])],
  ["invalid kind", JSON.stringify([entry({ kind: "bogus" })])],
  ["null permission", JSON.stringify([entry({ notification_permission: null })])],
  ["string clock", JSON.stringify([entry({ heartbeatAt: "1" })])],
  ["infinite clock", JSON.stringify([entry()]).replace(String(FUTURE), "1e999")],
  ["whole float", JSON.stringify([entry()]).replace(String(FUTURE), `${FUTURE}.0`)],
  ["fraction", JSON.stringify([entry({ registeredAt: 1763512345.125 })])],
  ["exponent clock", JSON.stringify([entry({ registeredAt: 1e21 })])],
  ["small clock", JSON.stringify([entry({ registeredAt: 0.0000015 })])],
  ["large whole clock", JSON.stringify([entry({ registeredAt: 1e20 })])],
  ["noncharacter text", JSON.stringify([entry({ version: "﷐" })])],
  ["lone surrogate", JSON.stringify([entry()]).replace('"version":"1"', String.raw`"version":"\ud800"`)],
  ["unicode", JSON.stringify([entry({ version: "é😀 " })])],
  ["deep unknown field", JSON.stringify([{ ...entry(), deep: 0 }]).replace('"deep":0', `"deep":${"[".repeat(600)}${"]".repeat(600)}`)],
];

test.skipIf(!front)("stored registries read and rewrite as TypeScript reads and rewrites them", async () => {
  const run = async (forward: boolean) => {
    const out: Record<string, unknown> = {};
    for (const [name, seed] of seeds) {
      const home = tempHome();
      if (name !== "missing") writeFileSync(registryFile(home), seed);
      const client = await stdio(home, forward);
      try {
        const list = await client.raw("client.list", {});
        const beat = await client.raw("client.heartbeat", { client_id: "c1", notifier: true, notification_alerts: "alert" });
        let file = "";
        try { file = readFileSync(registryFile(home), "utf8"); } catch {}
        out[name] = { list, beat, file: normalize(file) };
      } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
    }
    return out;
  };
  expect(await run(false)).toEqual(await run(true));
}, 240000);

test.skipIf(!front)("registration, heartbeat and listing write the same file as TypeScript", async () => {
  const flows: [string, unknown][] = [
    ["client.register", { kind: "desktop", version: "1.2.3", notifier: true, notification_permission: "unsupported", notification_alerts: "none", ignored: 1 }],
    ["client.register", { version: "é😀", kind: "tui" }],
    ["client.register", { kind: "cli", version: "2", notification_alerts: "banner", notifier: false, capture: false }],
  ];
  const run = async (forward: boolean) => {
    const home = tempHome();
    const client = await stdio(home, forward);
    try {
      const log: string[] = [], ids: string[] = [];
      for (const [op, params] of flows) {
        const line = await client.raw(op, params);
        ids.push(JSON.parse(line).result.client_id);
        log.push(line, readFileSync(registryFile(home), "utf8"));
      }
      const beats: Record<string, unknown>[] = [
        { client_id: ids[0], notification_permission: "authorized" }, // from the placeholder: no marker
        { client_id: ids[0], notification_permission: "denied" }, // a real change stamps the marker
        { client_id: ids[0], notification_alerts: "alert", notifier: false },
        { client_id: ids[1], notification_permission: "denied", notification_alerts: "none" }, // first reports: no marker
        { client_id: ids[1] },
        { client_id: "missing" },
      ];
      for (const beat of beats) log.push(await client.raw("client.heartbeat", beat), readFileSync(registryFile(home), "utf8"));
      log.push(await client.raw("client.list"));
      return { log: log.map(normalize), stderr: await client.close() };
    } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.log).toEqual(forwarded.log);
  expect(stdioMarkers(native.stderr).length).toBe(10);
  expect(stdioMarkers(forwarded.stderr)).toEqual([]);
}, 60000);

test.skipIf(!front)("entries a day past their heartbeat are dropped at the next registration", async () => {
  const home = tempHome();
  const now = Date.now() / 1000;
  writeFileSync(registryFile(home), JSON.stringify([entry({ client_id: "old", heartbeatAt: now - 86500 }), entry({ client_id: "kept", heartbeatAt: now - 3600 })]));
  const client = await stdio(home, false);
  try {
    await client.raw("client.register", { kind: "app", version: "1" });
    const stored = JSON.parse(readFileSync(registryFile(home), "utf8")) as { client_id: string }[];
    expect(stored.map(item => item.client_id).slice(0, 1)).toEqual(["kept"]);
    expect(stored).toHaveLength(2);
    // The lapsed entry stays stored for a waking client but is not listed.
    expect(JSON.parse(await client.raw("client.list")).result).toHaveLength(1);
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 30000);

test.skipIf(!front)("concurrent HTTP registrations lose no entry", async () => {
  const home = tempHome();
  const service = await serve(home, false);
  try {
    const replies = await Promise.all(Array.from({ length: 24 }, (_, n) => service.post("client.register", JSON.stringify({ kind: "app", version: String(n) }))));
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    expect(JSON.parse(readFileSync(registryFile(home), "utf8"))).toHaveLength(24);
  } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

type Call = (op: string, params?: unknown) => Promise<string>;
/** The whole worker loop and each refusal; returns normalized replies. */
async function controlFlow(call: Call) {
  const log: string[] = [];
  const step = async (op: string, params?: unknown) => { const line = await call(op, params); log.push(line); return JSON.parse(line); };
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
  return log.map(normalize);
}

test.skipIf(!front)("the control worker loop matches forced forwarding over stdio", async () => {
  const run = async (forward: boolean) => {
    const home = tempHome();
    const client = await stdio(home, forward);
    try {
      const log = await controlFlow(client.raw);
      return { log, stderr: await client.close() };
    } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.log).toEqual(forwarded.log);
  expect(stdioMarkers(native.stderr).length).toBe(native.log.length);
  expect(stdioMarkers(forwarded.stderr)).toEqual([]);
  expect(JSON.parse(native.log[0]!).result.worker_token).toBe("<id1>");
}, 60000);

test.skipIf(!front)("the control worker loop matches forced forwarding over HTTP", async () => {
  const run = async (forward: boolean) => {
    const home = tempHome();
    const service = await serve(home, forward);
    try {
      const log = await controlFlow(async (op, params) => {
        const reply = await service.post(op, params === undefined ? "null" : JSON.stringify(params));
        return JSON.stringify({ status: reply.status, type: reply.type, ...JSON.parse(reply.body) });
      });
      return { log, stderr: await service.stop() };
    } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.log).toEqual(forwarded.log);
  expect(httpMarkers(native.stderr).length).toBe(native.log.length);
  expect(httpMarkers(forwarded.stderr)).toEqual([]);
}, 60000);

test.skipIf(!front)("values serde cannot repeat exactly are answered by Core", async () => {
  const run = async (forward: boolean) => {
    const home = tempHome();
    const service = await serve(home, forward);
    try {
      const post = async (op: string, body: string) => (await service.post(op, body)).body;
      const worker = JSON.parse(await post("client.control.enroll", '{"kind":"app","window":"main"}')).result;
      const log: string[] = [];
      for (const result of ["1e21", "1.5e-7", "100000000000000000000", '"\\ud83d"', "-0"]) {
        const request = JSON.parse(await post("client.control.request", JSON.stringify({ client_id: worker.client_id, action: { type: "theme.get" } }))).result;
        log.push(await post("client.control.claim", JSON.stringify({ client_id: worker.client_id, worker_token: worker.worker_token })));
        log.push(await post("client.control.complete", `{"request_id":"${request.request_id}","worker_token":"${worker.worker_token}","result":${result}}`));
        log.push(await post("client.control.result", JSON.stringify({ request_id: request.request_id })));
      }
      // A route holding an unpaired surrogate reaches Core whole, and so does the claim that hands it out.
      const route = await post("client.control.request", `{"client_id":"${worker.client_id}","action":{"type":"navigate","route":"/\\ud83d"}}`);
      log.push(route, await post("client.control.claim", JSON.stringify({ client_id: worker.client_id, worker_token: worker.worker_token })));
      return log.map(normalize);
    } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native).toEqual(forwarded);
  expect(native.join("\n")).toContain("1e+21");
  expect(native.join("\n")).toContain("\\ud83d");
}, 60000);

test.skipIf(!front)("a desktop capture registration carries a credential Core's broker accepts", async () => {
  const home = tempHome();
  const client = await stdio(home, false);
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

test.skipIf(!front)("scoped callers and unusual registry paths stay on the forwarded path", async () => {
  const results = [];
  for (const forward of [false, true]) {
    const home = tempHome();
    const client = await stdio(home, forward, { PACER_ENFORCEMENT_TOKEN: "pet_x" });
    try {
      const replies = [await client.raw("client.list", {}), await client.raw("client.control.targets", {})];
      results.push({ replies, markers: stdioMarkers(await client.close()) });
    } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
  }
  expect(results[0]!.replies).toEqual(results[1]!.replies);
  expect(results[0]!.markers).toEqual([]);
  expect(JSON.parse(results[0]!.replies[0]!).error.data.code).toBe("not_allowed");
  const home = tempHome();
  mkdirSync(registryFile(home));
  const client = await stdio(home, false);
  try {
    const reply = JSON.parse(await client.raw("client.register", { kind: "app", version: "1" }));
    expect(reply.error.data.code).toBe("internal");
    expect(stdioMarkers(await client.close())).toEqual([]);
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("the client control bridge is sealed from stdio callers", async () => {
  const home = tempHome();
  const client = await stdio(home, false);
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
  // No connected desktop client: the bridge refuses before minting a worker.
  await expect(clientControlBridge(ctx, request)).rejects.toMatchObject({ code: "not_found" });
  // A live desktop entry satisfies the gate, and the minted credential is a 64-hex token.
  writeFileSync(registryFile(home), JSON.stringify([{ client_id: "abc", kind: "desktop", version: "1", notifier: false, registeredAt: now, heartbeatAt: now }]));
  const reply = await clientControlBridge(ctx, request) as { reply: string };
  expect(reply.reply).toMatch(/^[0-9a-f]{64}$/);
  // A lapsed (heartbeated 45s+ ago) desktop entry is treated as not connected.
  writeFileSync(registryFile(home), JSON.stringify([{ client_id: "abc", kind: "desktop", version: "1", notifier: false, registeredAt: now, heartbeatAt: now - 60 }]));
  await expect(clientControlBridge(ctx, request)).rejects.toMatchObject({ code: "not_found" });
  // A live but non-desktop kind still fails the gate.
  writeFileSync(registryFile(home), JSON.stringify([{ client_id: "abc", kind: "app", version: "1", notifier: false, registeredAt: now, heartbeatAt: now }]));
  await expect(clientControlBridge(ctx, request)).rejects.toMatchObject({ code: "not_found" });
  rmSync(home, { recursive: true, force: true });
}, 30000);
