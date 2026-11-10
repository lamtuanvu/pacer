/**
 * `service.install` and `update.apply` through the real Rust front doors (`pacer serve`, `pacer api --stdio`) and the
 * real Core bridge, against the test core in fixtures/install-apply-core.ts: recorded effects instead of launchd,
 * systemd or a release, in a disposable HOME and PACER_HOME. Each scenario runs natively and with both ops in
 * PACER_FORWARD_OPS; the replies and the effects must match. `service.handover` and `service.work` are not native:
 * their replies through both front doors must be byte-identical to forcing them through PACER_FORWARD_OPS.
 */
import {afterAll, describe, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {join} from "node:path";
import {UPGRADE_REFUSAL} from "../src/api/caller-policy";
import {createTask, updateTask} from "../src/tasks/store";
import {fakeCtx} from "./helpers";

const CORE = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/install-apply-core.ts")]);
const FORWARD = "service.install,update.apply";
const LONG = 300_000;
const DELAY_MS = 1500;

let binary = process.env.PACER_TEST_NATIVE_FRONT_DOOR ?? "";
function frontDoor() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer", "--locked"], {stdio: "inherit"});
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/pacer");
  }
  return binary;
}

const homes: string[] = [];
const children: Array<{kill(): void}> = [];
afterAll(() => {
  for (const child of children) child.kill();
  for (const home of homes) rmSync(home, {recursive: true, force: true});
});

type Fixture = {installDelayMs?: number; installFail?: string; standalone?: boolean};
function newHome() {
  // host.sock must fit SUN_LEN (~104); bun test's TMPDIR is too deep for native serve.
  const home = mkdtempSync("/tmp/piae-");
  homes.push(home);
  mkdirSync(join(home, ".pacer"), {mode: 0o700});
  return home;
}

/** `forward` is the PACER_FORWARD_OPS value; a shared `home` lets native and forced-forward runs read the same state. */
function sandbox(forward?: string, extra: Record<string, string> = {}, home = newHome()) {
  const pacerHome = join(home, ".pacer");
  const env: Record<string, string> = {
    HOME: home, PACER_HOME: pacerHome, PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: CORE,
    PACER_BACKEND: "direct", PACER_ORCA_USER_DATA: join(home, "orca"), PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", ...(forward ? {PACER_FORWARD_OPS: forward} : {}), ...extra,
  };
  return {
    home, pacerHome, env,
    behave: (fixture: Fixture) => writeFileSync(join(pacerHome, "fixture.json"), JSON.stringify(fixture)),
    effects: () => existsSync(join(pacerHome, "effects.log")) ? readFileSync(join(pacerHome, "effects.log"), "utf8").trim().split("\n") : [],
  };
}

function drain(stream: ReadableStream<Uint8Array>) {
  const sink = {text: "", done: Promise.resolve()};
  sink.done = (async () => { const decoder = new TextDecoder(); for await (const chunk of stream) sink.text += decoder.decode(chunk, {stream: true}); })();
  return sink;
}

async function until(check: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address() as {port: number};
      server.close(() => resolve(port));
    });
  });
}

/** Keeps the shape the scenarios compare: job ids, times and pids differ per run. */
function normalize(body: any): unknown {
  const job = body?.result?.job;
  return job ? {...body, result: {...body.result, job: {kind: job.kind, target: job.target}}} : body;
}

async function serve(forward?: string, home?: string) {
  const box = sandbox(forward, {}, home);
  rmSync(join(box.pacerHome, "core-ready"), {force: true});
  const port = await freePort();
  const child = Bun.spawn([frontDoor(), "serve", "--port", String(port)], {env: {...box.env, PACER_PORT: String(port)}, cwd: box.home, stdout: "ignore", stderr: "pipe"});
  children.push(child);
  const stderr = drain(child.stderr);
  await until(() => existsSync(join(box.pacerHome, "core-ready")) && existsSync(join(box.pacerHome, "token")), "pacer serve and its core");
  const token = readFileSync(join(box.pacerHome, "token"), "utf8").trim();
  const origin = `http://127.0.0.1:${port}`;
  const session = randomBytes(32).toString("hex");
  mkdirSync(join(box.pacerHome, "app"), {mode: 0o700, recursive: true});
  writeFileSync(join(box.pacerHome, "app/sessions.json"), JSON.stringify([{hash: createHash("sha256").update(session).digest("hex"), expiresAt: Date.now() / 1000 + 3600}]));
  const request = async (path: string, body: unknown, headers: Record<string, string> = {authorization: `Bearer ${token}`}, signal?: AbortSignal) => {
    const response = await fetch(`${origin}${path}`, {method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify(body), signal});
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch {}
    return {status: response.status, body: normalize(parsed)};
  };
  return {
    ...box, child, stderr,
    op: (name: string, params: unknown, headers?: Record<string, string>, signal?: AbortSignal) => request(`/v3/ops/${name}`, params, headers, signal),
    /** The reply exactly as sent: status, content type and body bytes. */
    raw: async (name: string, body: string, headers: Record<string, string> = {authorization: `Bearer ${token}`}) => {
      const response = await fetch(`${origin}/v3/ops/${name}`, {method: "POST", headers: {"content-type": "application/json", ...headers}, body});
      return {status: response.status, type: response.headers.get("content-type"), body: await response.text()};
    },
    request,
    cookie: (withOrigin: boolean) => ({cookie: `pacer_session=${session}`, ...(withOrigin ? {origin, "x-pacer-client": "app"} : {})}),
    stop: async () => { child.kill(); await child.exited; await stderr.done; },
  };
}

function connect(forward?: string, extra: Record<string, string> = {}, home?: string) {
  const box = sandbox(forward, extra, home);
  const child = Bun.spawn([frontDoor(), "api", "--stdio"], {env: box.env, cwd: box.home, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
  children.push(child);
  const stderr = drain(child.stderr);
  const replies = new Map<number, unknown>();
  const lines = new Map<number, string>();
  const waiting = new Map<number, (reply: unknown) => void>();
  const order: number[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, {stream: true});
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (typeof message.id !== "number") continue;
        const {jsonrpc: _, ...reply} = message;
        order.push(message.id);
        lines.set(message.id, line);
        replies.set(message.id, normalize(reply));
        waiting.get(message.id)?.(replies.get(message.id));
      }
    }
  })();
  let next = 1;
  const call = (method: string, params: unknown = {}) => {
    const id = next++;
    const reply = new Promise<any>(resolve => waiting.set(id, resolve));
    child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
    child.stdin.flush();
    return reply;
  };
  return {
    ...box, stderr, order, call,
    /** The reply line exactly as the front door wrote it. */
    line: (id: number) => lines.get(id),
    close: async () => { child.stdin.end(); await child.exited; await stderr.done; },
  };
}

describe("HTTP front door", () => {
  async function scenarios(server: Awaited<ReturnType<typeof serve>>) {
    const out: Record<string, unknown> = {};
    server.behave({});
    out.install = await server.op("service.install", {consent: true});
    out.installNoConsent = await server.op("service.install", {});
    out.installWrongConsent = await server.op("service.install", {consent: "yes"});
    out.installNullParams = await server.op("service.install", null);
    out.applyArray = await server.op("update.apply", []);
    out.apply = await server.op("update.apply", {});
    server.behave({standalone: false});
    out.applyFromSource = await server.op("update.apply", {});
    server.behave({installFail: "fixture: launchctl refused"});
    out.installFails = await server.op("service.install", {consent: true});

    server.behave({installDelayMs: DELAY_MS});
    const started = Date.now();
    const order: string[] = [];
    const slow = server.op("service.install", {consent: true}).then(reply => { order.push("slow"); return reply; });
    await until(() => server.effects().some(line => line.endsWith(" start") && line.startsWith("install 3")), "the delayed install to start", 5_000);
    out.concurrentInstall = await server.op("service.install", {consent: true}).then(reply => { order.push("concurrent"); return reply; });
    out.version = (await server.op("version.get", {})).status;
    order.push("version");
    out.delayed = await slow;
    out.delayedOrder = order;
    expect(Date.now() - started).toBeGreaterThanOrEqual(DELAY_MS);

    server.behave({});
    out.cookie = await server.op("service.install", {consent: true}, server.cookie(true));
    out.cookieNoOrigin = await server.op("service.install", {consent: true}, server.cookie(false));
    out.unauthenticated = await server.op("update.apply", {}, {});
    out.workGrant = await server.op("service.install", {consent: true}, {authorization: `Bearer pwg_${"ab".repeat(32)}`});
    out.externalServiceBridge = await server.request("/_internal/service-effects", {request: {kind: "install"}});
    out.externalUpdateBridge = await server.request("/_internal/update-effects", {request: {kind: "apply"}});

    server.behave({installDelayMs: DELAY_MS});
    const abort = new AbortController();
    const abandoned = server.op("service.install", {consent: true}, undefined, abort.signal).catch(error => (error as Error).name);
    await until(() => server.effects().includes("install 5 start"), "the abandoned install to start", 5_000);
    abort.abort();
    out.abandoned = await abandoned;
    await until(() => server.effects().includes("install 5 done"), "core to finish the abandoned install", 10_000);
    out.effects = server.effects();
    return out;
  }

  test("native replies, refusals, errors, identity and in-flight calls match the forwarded path", async () => {
    const native = await serve();
    const nativeResults = await scenarios(native);
    await native.stop();
    const forwarded = await serve(FORWARD);
    const forwardedResults = await scenarios(forwarded);
    await forwarded.stop();

    expect(nativeResults).toEqual(forwardedResults);
    expect(native.stderr.text).toContain("native service.install");
    expect(native.stderr.text).toContain("native update.apply");
    expect(forwarded.stderr.text).not.toContain("native service.install");
    expect(forwarded.stderr.text).not.toContain("native update.apply");

    const r = nativeResults as Record<string, any>;
    expect(r.install).toEqual({status: 200, body: {result: {installed: true, running: true}}});
    expect(r.installNoConsent).toMatchObject({status: 400, body: {error: {code: "invalid_input", message: "consent: Invalid input: expected true"}}});
    expect(r.installNullParams.body.error.code).toBe("invalid_input");
    expect(r.applyArray).toMatchObject({status: 400, body: {error: {code: "invalid_input", message: "params: Invalid input: expected object, received array"}}});
    expect(r.apply).toEqual({status: 200, body: {result: {job: {kind: "update.apply", target: "pacer"}}}});
    expect(r.applyFromSource.body.error.code).toBe("not_allowed");
    expect(r.installFails.status).toBeGreaterThanOrEqual(400);
    expect(r.concurrentInstall.body.error.code).toBe("conflict");
    expect(r.delayed).toEqual(r.install);
    expect(r.delayedOrder).toEqual(["concurrent", "version", "slow"]);
    expect(r.cookie).toEqual(r.install);
    expect(r.cookieNoOrigin.status).toBe(403);
    expect(r.unauthenticated.status).toBe(401);
    expect(r.workGrant.status).toBeGreaterThanOrEqual(400);
    expect(r.externalServiceBridge.status).toBe(404);
    expect(r.externalUpdateBridge.status).toBe(404);
    expect(r.abandoned).toBe("AbortError");
    expect(r.effects).toEqual([
      "install 1 start", "install 1 done", "update job",
      "install 2 start", "install 2 failed",
      "install 3 start", "install 3 done",
      "install 4 start", "install 4 done",
      "install 5 start", "install 5 done",
    ]);
  }, LONG);
});

describe("stdio front door", () => {
  async function scenarios(forwarded: boolean) {
    const rpc = connect(forwarded ? FORWARD : undefined);
    const out: Record<string, unknown> = {};
    expect((await rpc.call("hello", {protocol: 3})).result.protocol).toStartWith("3.");
    rpc.behave({});
    out.install = await rpc.call("service.install", {consent: true});
    out.installNoConsent = await rpc.call("service.install", {});
    out.installNullParams = await rpc.call("service.install", null);
    out.applyArray = await rpc.call("update.apply", []);
    out.apply = await rpc.call("update.apply", {});
    rpc.behave({standalone: false});
    out.applyFromSource = await rpc.call("update.apply", {});
    rpc.behave({installFail: "fixture: launchctl refused"});
    out.installFails = await rpc.call("service.install", {consent: true});

    rpc.behave({installDelayMs: DELAY_MS});
    const started = Date.now();
    const slow = rpc.call("service.install", {consent: true});
    await until(() => rpc.effects().includes("install 3 start"), "the delayed install to start", 5_000);
    const concurrent = rpc.call("service.install", {consent: true});
    const version = rpc.call("version.get", {});
    out.concurrentInstall = await concurrent;
    out.version = Object.keys(await version);
    out.delayed = await slow;
    expect(Date.now() - started).toBeGreaterThanOrEqual(DELAY_MS);
    out.answeredLast = rpc.order.at(-1);
    out.effects = rpc.effects();
    await rpc.close();

    const executor = connect(forwarded ? FORWARD : undefined, {PACER_ROLE: "executor"});
    await executor.call("hello", {protocol: 3});
    out.executorInstall = await executor.call("service.install", {consent: true});
    out.executorApply = await executor.call("update.apply", {});
    out.executorEffects = executor.effects();
    await executor.close();

    const granted = connect(forwarded ? FORWARD : undefined, {PACER_WORK_GRANT: `pwg_${"ab".repeat(32)}`});
    await granted.call("hello", {protocol: 3});
    out.grantInstall = await granted.call("service.install", {consent: true});
    out.grantEffects = granted.effects();
    await granted.close();
    return {out, traces: [rpc.stderr.text, executor.stderr.text, granted.stderr.text]};
  }

  test("native replies, refusals, errors, identity and in-flight calls match the forwarded path", async () => {
    const native = await scenarios(false);
    const forwarded = await scenarios(true);
    expect(native.out).toEqual(forwarded.out);

    const [session, executor, granted] = native.traces;
    expect(session).toContain("native service.install");
    expect(session).toContain("native update.apply");
    expect(executor).toContain("native service.install");
    expect(granted).not.toContain("native service.install");
    for (const trace of forwarded.traces) expect(trace).not.toMatch(/native (service\.install|update\.apply)/);

    const r = native.out as Record<string, any>;
    expect(r.install).toEqual({id: 2, result: {installed: true, running: true}});
    expect(r.installNoConsent.error).toMatchObject({message: "consent: Invalid input: expected true", data: {code: "invalid_input"}});
    expect(r.installNullParams.error.data.code).toBe("invalid_input");
    expect(r.applyArray.error).toMatchObject({message: "params: Invalid input: expected object, received array", data: {code: "invalid_input"}});
    expect(r.apply.result).toEqual({job: {kind: "update.apply", target: "pacer"}});
    expect(r.applyFromSource.error.data.code).toBe("not_allowed");
    expect(r.installFails.error).toBeDefined();
    expect(r.concurrentInstall.error.data.code).toBe("conflict");
    expect(r.delayed.result).toEqual({installed: true, running: true});
    expect(r.answeredLast).toBe(9);
    expect(r.effects).toEqual(["install 1 start", "install 1 done", "update job", "install 2 start", "install 2 failed", "install 3 start", "install 3 done"]);
    expect(r.executorInstall.error.data.code).toBe("not_allowed");
    expect(r.executorApply.error.data.code).toBe("not_allowed");
    expect(r.executorEffects).toEqual([]);
    expect(r.grantInstall.error).toBeDefined();
    expect(r.grantEffects).toEqual([]);
  }, LONG);
});

describe("service.handover and service.work stay forwarded", () => {
  const HANDOVER_WORK = "service.handover,service.work";
  const UNTRACED = /native (service\.handover|service\.work)/;
  const GRANT = `pwg_${"ab".repeat(32)}`;

  /** One running task from an older runner without a handover record: counted and listed, never signalled. */
  function seeded() {
    const home = newHome();
    const ctx = fakeCtx({home, pacerHome: join(home, ".pacer"), now: Date.now() / 1000});
    mkdirSync(join(home, "repo"));
    const task = createTask(ctx, {brief: {goal: "g", repo: join(home, "repo")}, kind: null, requestedExecutor: null, timeoutS: 60});
    updateTask(ctx, task.id, t => { t.state = "running"; t.runnerPid = 4194302; t.runnerPacer = "0.10.0"; });
    return {home, taskId: task.id};
  }

  test("HTTP replies are byte-identical to PACER_FORWARD_OPS forcing", async () => {
    const {home, taskId} = seeded();
    async function run(forward?: string) {
      const server = await serve(forward, home);
      const replies = [
        await server.raw("service.handover", '{"wait_s":0}'),
        await server.raw("service.handover", "{}"),
        await server.raw("service.handover", '{"wait_s":61}'),
        await server.raw("service.handover", "[]"),
        await server.raw("service.handover", "{"),
        await server.raw("service.work", "{}"),
        await server.raw("service.work", "[]"),
        await server.raw("service.work", "{}", server.cookie(true)),
        await server.raw("service.handover", '{"wait_s":0}', server.cookie(true)),
        await server.raw("service.handover", '{"wait_s":0}', server.cookie(false)),
        await server.raw("service.work", "{}", {}),
        await server.raw("service.handover", '{"wait_s":0}', {authorization: `Bearer ${GRANT}`}),
        await server.raw("service.work", "{}", {authorization: `Bearer ${GRANT}`}),
      ];
      await server.stop();
      return {replies, stderr: server.stderr.text};
    }
    const native = await run();
    const forwarded = await run(HANDOVER_WORK);
    expect(native.replies).toEqual(forwarded.replies);
    for (const trace of [native.stderr, forwarded.stderr]) expect(trace).not.toMatch(UNTRACED);

    const [handover, handoverDefault, tooLong, array, malformed, work, workArray, workCookie, handoverCookie, noOrigin, unauthenticated, grantHandover, grantWork] = native.replies;
    const v = JSON.parse(handover.body).result.pacer;
    expect(handover).toEqual({status: 200, type: expect.stringContaining("application/json"), body: JSON.stringify({result: {pacer: v, tasks: 1, sessions: 0, handed_over: 0,
      kept_on_previous_runner: 1, summary: `Updated to v${v}. 1 task and 0 sessions kept running; 1 stayed on the previous runner.`}})});
    expect(handoverDefault).toEqual(handover);
    expect(handoverCookie).toEqual(handover);
    for (const reply of [tooLong, array, malformed]) expect(JSON.parse(reply.body).error.code).toBe("invalid_input");
    expect(JSON.parse(work.body).result.tasks).toEqual([{task_id: taskId, runner_pacer: "0.10.0", older: true}]);
    expect(work.body).not.toContain(home);
    expect(JSON.parse(workArray.body).error.code).toBe("invalid_input");
    expect(workCookie).toEqual(work);
    expect(noOrigin.status).toBe(403);
    expect(unauthenticated.status).toBe(401);
    expect(grantHandover.status).toBeGreaterThanOrEqual(400);
    expect(grantWork.status).toBeGreaterThanOrEqual(400);
  }, LONG);

  test("stdio reply lines are byte-identical to PACER_FORWARD_OPS forcing", async () => {
    const {home, taskId} = seeded();
    async function run(forward?: string) {
      const lines: Array<string | undefined> = [], traces: string[] = [];
      for (const extra of [{}, {PACER_ROLE: "executor"}, {PACER_WORK_GRANT: GRANT}] as Record<string, string>[]) {
        const rpc = connect(forward, extra, home);
        expect((await rpc.call("hello", {protocol: 3})).result.protocol).toStartWith("3.");
        for (const [method, params] of [["service.handover", {wait_s: 0}], ["service.handover", {wait_s: 61}], ["service.handover", []],
          ["service.handover", null], ["service.work", {}], ["service.work", []]] as const) {
          const {id} = await rpc.call(method, params);
          lines.push(rpc.line(id));
        }
        await rpc.close();
        traces.push(rpc.stderr.text);
      }
      return {lines, traces};
    }
    const native = await run();
    const forwarded = await run(HANDOVER_WORK);
    expect(native.lines).toEqual(forwarded.lines);
    for (const traces of [native.traces, forwarded.traces]) {
      // A work-grant session forwards everything, hello included.
      expect(traces.map(trace => trace.includes("native hello 1"))).toEqual([true, true, false]);
      for (const trace of traces) expect(trace).not.toMatch(UNTRACED);
    }

    const replies = native.lines.map(line => JSON.parse(line!));
    const [operator, executor, granted] = [replies.slice(0, 6), replies.slice(6, 12), replies.slice(12)];
    expect(operator[0].result).toMatchObject({tasks: 1, sessions: 0, handed_over: 0, kept_on_previous_runner: 1});
    for (const reply of [operator[1], operator[2], operator[5]]) expect(reply.error.data.code).toBe("invalid_input");
    expect(operator[3].result).toMatchObject({tasks: 1});
    expect(operator[4].result.tasks).toEqual([{task_id: taskId, runner_pacer: "0.10.0", older: true}]);
    expect(executor[0].error).toMatchObject({message: UPGRADE_REFUSAL, data: {code: "not_allowed"}});
    expect(executor[4].result.tasks).toEqual(operator[4].result.tasks);
    for (const reply of [granted[0], granted[4]]) expect(reply.error).toBeDefined();
  }, LONG);
});
