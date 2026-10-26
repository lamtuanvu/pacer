import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpDir } from "./helpers";
import { atomicWrite, down, environmentScript, freePort, healthy, loadSession, readEvidence, record, renderReport, run, pacerArgv, validateFrontDoor, frontDoorBuild, sandboxEnv, saveSession, sessions, shellQuote, up, validId, type Session } from "../scripts/live/core";
import { resolveRepoInput } from "../src/core/repos";
import { seedUi } from "../scripts/live/seed";
import { makeCtx } from "../src/ctx";
import { loadStrategy } from "../src/config/strategy";
import { listTasks } from "../src/tasks/store";
import { taskStatus, taskStop } from "../src/tasks/api";
import { checkSetup } from "../src/setup/check";
import { handleV2 } from "../src/api/http";
import { computeStatus } from "../src/engine/status";
import { refusal } from "../scripts/live/guard";
import { desktopExecutable } from "../scripts/live/surfaces";
import { main } from "../scripts/live/cli";
import { BLOCKED_OPS, ClientWebSocket, refusedOp, startProxy, upstreamHeaders } from "../scripts/live/proxy";

function fixture(): Session {
  const root = join(tmpDir(), "sandbox");
  for (const path of ["", "home", "bin", "repo", "evidence", "logs"]) mkdirSync(join(root, path), { recursive: true });
  return { id: "sandbox", root, pid: 12345, port: 49672, createdAt: "2026-10-18T00:00:00Z" };
}

describe("live guard (D3)", () => {
  for (const args of [
    ["install", "codex"], ["uninstall"], ["init"], ["setup"], ["statusline"], ["update", "--check"],
    ["service", "install"], ["service", "uninstall"], ["plugin", "uninstall"], ["plugin", "remove"],
    ["account", "add"], ["account", "rm"], ["account", "login"], ["host", "setup"], ["orca"], ["orca", "status"], ["open"], ["open", "--browser"], ["api", "--stdio"],
  ]) test(`refuses ${args.join(" ")}`, () => expect(refusal(args)).toContain("D3"));
  for (const args of [["status", "--json"], ["service", "status"], ["account", "list"], ["host", "check"], ["plugin", "install"], ["plugin", "list"], ["plugin", "doctor"], ["open", "--print", "tasks"], ["delegate", "--wait"], ["wait", "task"], ["_run", "task"], ["dashboard"]]) {
    test(`allows ${args.join(" ")}`, () => expect(refusal(args)).toBeUndefined());
  }
  test("executable guard exits 3 without reading a session or dispatching pacer", () => {
    const child = Bun.spawnSync([process.execPath, "scripts/live/guard.ts", "missing-session", "install"], { cwd: join(import.meta.dir, "..") });
    expect(child.exitCode).toBe(3);
    expect(child.stderr.toString()).toContain("D3");
  });
});

test("fixed stdio fixture refuses caller-supplied commands before loading a session", async () => {
  for (const command of ["stdio-strategy-list", "stdio-strategy-show", "stdio-strategy-use"]) {
    await expect(main([command, "--id", "missing", "api"])).rejects.toThrow(`usage: live ${command}`);
    await expect(main([command, "--id", "missing", "--", "api", "--stdio"])).rejects.toThrow(`usage: live ${command}`);
  }
});

test("sandbox environment keeps HOME and auth references but overrides pacer state", () => {
  const session = fixture();
  const env = sandboxEnv(session, { HOME: "/real-home", PATH: "/tool-bin", PACER_HOME: "/wrong", PACER_PORT: "4317", PACER_BIN: "/installed-pacer", PACER_BACKEND: "orca", PACER_ROLE: "executor" });
  expect(env.HOME).toBe("/real-home");
  expect(env.PATH).toBe(`${session.root}/bin:/tool-bin`);
  expect(env.PACER_HOME).toBe(join(session.root, "home"));
  expect(env.PACER_BIN).toBe(join(session.root, "bin/pacer"));
  expect(env.PACER_PORT).toBe("49672");
  expect(env.PACER_NO_UPDATE_CHECK).toBe("1");
  expect(env.PACER_BACKEND).toBe("direct");
  expect(env.PACER_ROLE).toBe("executor");
  expect(env.PACER_ORCA_USER_DATA).toBe(join(session.root, "orca-profile"));
  expect(environmentScript(session)).not.toContain("export HOME=");
  expect(env.PACER_CORE_ARGV).toBeUndefined();
});

test("the rust front door runs the Rust binary and points it at the checkout core", () => {
  const session = { ...fixture(), frontDoor: "rust" as const };
  const core = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts")];
  expect(pacerArgv(session)).toEqual([join(session.root, "bin/pacer-rust")]);
  expect(pacerArgv({})).toEqual(core);
  expect(JSON.parse(sandboxEnv(session, {}).PACER_CORE_ARGV!)).toEqual(core);
  expect(environmentScript(session)).toContain("export PACER_CORE_ARGV=");
});

test("up refuses an unknown front door before creating a sandbox", async () => {
  const base = tmpDir();
  await expect(up("fd", undefined, base, undefined, "go")).rejects.toThrow("Unknown front door");
  expect(readdirSync(base)).toEqual([]);
});

test("environment shell quoting preserves text without executing substitutions", () => {
  const value = "a'b $(false) `false`\nnext";
  const child = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote(value)}`]);
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe(value);
});

test("port selection refuses default and invalid ports", async () => {
  const candidates = [4317, 0, 70000, 43210];
  expect(await freePort(async () => candidates.shift()!)).toBe(43210);
  await expect(freePort(async () => 4317)).rejects.toThrow("non-default");
});

test("session ids cannot escape the live root; metadata must match", () => {
  for (const id of ["../escape", "/absolute", "a/b", ".", "x y"]) expect(() => validId(id)).toThrow();
  const session = fixture();
  const base = join(session.root, "..");
  saveSession(session);
  expect(loadSession(session.id, base)).toEqual(session);
  expect(sessions(base)).toEqual([session]);
  atomicWrite(join(session.root, "session.json"), JSON.stringify({ ...session, port: 4317 }));
  expect(() => loadSession(session.id, base)).toThrow("Invalid");
  for (const extra of [{ innerPort: 4317 }, { innerPort: session.port }, { innerPort: 70000 }, { proxyPid: 0 }]) {
    atomicWrite(join(session.root, "session.json"), JSON.stringify({ ...session, ...extra }));
    expect(() => loadSession(session.id, base)).toThrow("Invalid");
  }
});

test("evidence is appended and reports retain commands, steps, captures and verdicts", async () => {
  const session = fixture();
  record(session, { kind: "note", behavior: "isolated service", surface: "API", verdict: "PASS", steps: "up | status", text: "Fresh token\nhealthy" });
  record(session, { kind: "note", behavior: "desktop", surface: "desktop", text: "App unavailable" });
  record(session, { kind: "note", behavior: "example", surface: "CLI", verdict: "FAIL", text: "Observed failure" });
  record(session, { kind: "capture", path: "evidence/screen.png" });
  const result = await run([process.execPath, "-e", 'console.log("x".repeat(17000)); console.error("observed"); process.exit(3)'], session);
  expect(result.code).toBe(3);
  expect(result.stdout.length).toBeGreaterThan(16000);
  const entries = readEvidence(session);
  expect(entries).toHaveLength(5);
  expect(entries.every(entry => Number.isFinite(Date.parse(entry.at)))).toBe(true);
  expect(entries[4].stdout).toContain("[truncated]");
  expect(entries[4].stderr).toContain("observed");
  const report = renderReport(session);
  expect(report).toContain("1 PASS, 1 FAIL, 1 UNVERIFIED");
  expect(report).toContain("up \\| status");
  expect(report).toContain("Fresh token<br>healthy");
  expect(report).toContain("evidence/screen.png");
  expect(report).toContain("exit 3");
  expect(statSync(join(session.root, "evidence/log.jsonl")).mode & 0o777).toBe(0o600);
  expect(renderReport(session, [])).toContain("UNVERIFIED");
});


let canBind = true;
try { await freePort(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  canBind = false;
  console.warn("Live lifecycle test UNVERIFIED: sandbox denies loopback binding (EPERM)");
}
test.skipIf(!canBind)("up/status/down uses a free port and leaves no service", async () => {
  const base = tmpDir();
  const session = await up("cycle", undefined, base);
  try {
    expect(session.port).not.toBe(4317);
    expect(session.innerPort).not.toBe(4317);
    expect(session.innerPort).not.toBe(session.port);
    expect(session.proxyPid).toBeGreaterThan(1);
    expect(session.serviceIdentity?.pid).toBe(session.pid);
    expect(session.serviceIdentity?.birth).toBeTruthy();
    expect(await healthy({ ...session, proxyPid: 1 })).toBe(false);
    expect(await healthy({ ...session, pid: 1 })).toBe(false);
    expect(await healthy(session)).toBe(true);
    expect(sessions(base)[0].pid).toBe(session.pid);
    const status = await run([join(session.root, "bin/pacer"), "status", "--json"], session);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toHaveProperty("generatedAt");
    const login = await run([join(session.root, "bin/pacer"), "open", "--print"], session);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain(`http://127.0.0.1:${session.port}/app/auth?code=`);
    const blocked = await run([join(session.root, "bin/pacer"), "install"], session);
    expect(blocked.code).toBe(3);
    expect(readFileSync(join(session.root, "env.sh"), "utf8")).toContain(session.root);
  } finally { await down(session); }
  expect(existsSync(session.root)).toBe(false);
  expect(await healthy(session)).toBe(false);
  for (const port of [session.port, session.innerPort!]) {
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  }
}, 10000);

test("CLI rejects incomplete or unknown harness options before touching a session", async () => {
  await expect(main(["note", "--id"])).rejects.toThrow("requires a value");
  await expect(main(["pacer", "--unknown"])).rejects.toThrow("Unknown option");
  await expect(main(["up", "--id", "../escape"])).rejects.toThrow("id must contain");
});

test("allowed guard command dispatches checkout CLI with sandbox state", async () => {
  const session = fixture();
  saveSession(session);
  atomicWrite(join(session.root, "home/strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {usage: quota}\nrouting:\n  - default: [codex]\n");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/live/guard.ts"), join(session.root, "session.json"), "status", "--json"], {
    env: { ...process.env, PACER_HOME: join(tmpDir(), "wrong-home") }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toHaveProperty("generatedAt");
});

describe("live service guard (D8)", () => {
  for (const version of [2, 3]) {
    for (const op of Object.keys(BLOCKED_OPS).filter(op => op !== "service.*")) {
      test(`refuses v${version} ${op}`, () => {
        expect(refusedOp("POST", `/v${version}/ops/${op}`)).toBe(op);
      });
    }
    for (const op of ["service.install", "service.uninstall", "service.restart", "service.future"]) {
      test(`refuses v${version} ${op}`, () => expect(refusedOp("POST", `/v${version}/ops/${op}`)).toBe(op));
    }
    for (const op of ["service.status", "setup.init", "plugin.install", "agent.preview", "task.delegate", "task.session", "account.list"]) {
      test(`allows v${version} ${op}`, () => expect(refusedOp("POST", `/v${version}/ops/${op}`)).toBeUndefined());
    }
  }
  test("only op POSTs are filtered", () => {
    expect(refusedOp("GET", "/v3/ops/agent.connect")).toBeUndefined();
    expect(refusedOp("POST", "/app/agent.connect")).toBeUndefined();
    expect(refusedOp("POST", "/v1/ops/agent.connect")).toBeUndefined();
  });
  test("procedure lists exactly the exported policy with its handler audit", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/testing/live-validation.md"), "utf8");
    const table = doc.split("<!-- D8 policy -->")[1].split("<!-- /D8 policy -->")[0];
    const rows = table.split("\n").filter(row => row.startsWith("| `"));
    expect(rows).toEqual(Object.entries(BLOCKED_OPS).map(([op, reason]) => `| \`${op}\` | ${reason} |`));
  });
  test("Host and only matching public Origins are rewritten; authentication survives", () => {
    for (const host of ["127.0.0.1", "localhost"]) {
      const input = new Headers({ host: `${host}:49100`, origin: `http://${host}:49100`, cookie: "pacer_session=example", authorization: "Bearer example", "x-pacer-client": "app" });
      const result = upstreamHeaders(input, 49100, 49101);
      expect(result.get("host")).toBe("127.0.0.1:49101");
      expect(result.get("origin")).toBe("http://127.0.0.1:49101");
      expect(result.get("cookie")).toBe(input.get("cookie"));
      expect(result.get("authorization")).toBe(input.get("authorization"));
      expect(result.get("x-pacer-client")).toBe("app");
      expect(input.get("host")).toBe(`${host}:49100`);
    }
    for (const origin of [undefined, "null", "http://evil.invalid", "http://127.0.0.1:4317", "https://127.0.0.1:49100"]) {
      const result = upstreamHeaders(new Headers(origin ? { origin } : {}), 49100, 49101);
      expect(result.get("origin")).toBe(origin ?? null);
    }
  });
});

test.skipIf(!canBind)("real proxy forwards assets, ops, cookies, streaming SSE and WebSocket frames", async () => {
  const session = fixture();
  session.port = await freePort();
  session.innerPort = await freePort();
  while (session.innerPort === session.port) session.innerPort = await freePort();
  const seen: string[] = [];
  let release!: () => void;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: session.innerPort,
    async fetch(req, server) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      if (req.headers.get("host") !== `127.0.0.1:${session.innerPort}`) return new Response("bad host", { status: 421 });
      if (req.headers.get("upgrade") === "websocket") {
        if (req.headers.get("cookie") !== "pacer_session=example" || req.headers.get("origin") !== `http://127.0.0.1:${session.innerPort}`) return new Response("bad auth", { status: 403 });
        if (server.upgrade(req)) return;
      }
      if (url.pathname.endsWith("/events")) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": first\n\n"));
            release = () => { controller.enqueue(new TextEncoder().encode("data: second\n\n")); controller.close(); };
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (req.method === "POST") return Response.json({ body: await req.text(), origin: req.headers.get("origin"), client: req.headers.get("x-pacer-client"), cookie: req.headers.get("cookie") });
      return new Response(`asset${url.search}`, { status: 201, headers: [ ["set-cookie", "a=1; HttpOnly"], ["set-cookie", "b=2; SameSite=Strict"], ["content-type", "text/plain"], ["content-security-policy", "default-src 'self'"] ] });
    },
    websocket: { message(ws, message) { ws.send(message); } },
  });
  const proxy = startProxy(session);
  const origin = `http://127.0.0.1:${session.port}`;
  try {
    const asset = await fetch(`${origin}/app/example.js?x=1`, { redirect: "manual" });
    expect(asset.status).toBe(201);
    expect(await asset.text()).toBe("asset?x=1");
    expect(asset.headers.getSetCookie()).toEqual(["a=1; HttpOnly", "b=2; SameSite=Strict"]);
    expect(asset.headers.get("content-security-policy")).toBe("default-src 'self'");
    const wrongHost = await fetch(`${origin}/app/`, { headers: { host: "evil.invalid" } });
    expect(wrongHost.status).toBe(421);
    for (const version of [2, 3]) {
      const path = `/v${version}/ops/agent.connect`;
      const blocked = await fetch(origin + path, { method: "POST", body: "{}" });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({ error: { code: "forbidden", message: "Live validation D8: agent.connect changes the real user environment" } });
      expect(seen).not.toContain(path);
      const response = await fetch(`${origin}/v${version}/ops/setup.init`, { method: "POST", headers: { origin, "x-pacer-client": "app", cookie: "pacer_session=example" }, body: '{"planner":"codex"}' });
      expect(await response.json()).toEqual({ body: '{"planner":"codex"}', origin: `http://127.0.0.1:${session.innerPort}`, client: "app", cookie: "pacer_session=example" });
      const stream = await fetch(`${origin}/v${version}/events`);
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      const reader = stream.body!.getReader();
      // The upstream stays open until after the first chunk reaches the client.
      const first = await Promise.race([reader.read(), Bun.sleep(1000).then(() => { throw Error("SSE was buffered"); })]);
      expect(new TextDecoder().decode(first.value)).toBe(": first\n\n");
      release();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");
      expect((await reader.read()).done).toBe(true);
      await new Promise<void>((ok, fail) => {
        const ws = new ClientWebSocket(`${origin.replace("http:", "ws:")}/v${version}/tasks/example/session`, { headers: { origin, cookie: "pacer_session=example" } });
        const timer = setTimeout(() => { ws.close(); fail(Error("WebSocket timeout")); }, 2000);
        let textReceived = false;
        ws.binaryType = "arraybuffer";
        ws.onopen = () => ws.send("hello");
        ws.onerror = () => { clearTimeout(timer); fail(Error("WebSocket error")); };
        ws.onmessage = event => {
          try {
            if (!textReceived) {
              expect(event.data).toBe("hello");
              textReceived = true;
              ws.send(new Uint8Array([0, 1, 255]));
            } else {
              expect(new Uint8Array(event.data)).toEqual(new Uint8Array([0, 1, 255]));
              clearTimeout(timer); ws.close(); ok();
            }
          } catch (error) { clearTimeout(timer); ws.close(); fail(error); }
        };
      });
    }
    const notes = readEvidence(session);
    expect(notes).toHaveLength(2);
    expect(notes.every(note => note.kind === "note" && note.verdict === "UNVERIFIED")).toBe(true);
    expect(renderReport(session)).toContain("D8 blocked agent.connect");
  } finally { proxy.stop(true); upstream.stop(true); }
}, 10000);


test("UI seed writes only sandbox home and supplies safe task fixtures and account usage", async () => {
  const session = fixture();
  const outside = readdirSync(session.root).filter(name => name !== "home");
  seedUi(session.root);
  expect(readdirSync(session.root).filter(name => name !== "home")).toEqual(outside);
  for (const name of outside) expect(readdirSync(join(session.root, name))).toEqual([]);
  session.seed = "ui";
  const env = sandboxEnv(session);
  expect(env.HOME).toBe(join(session.root, "home"));
  const ctx = makeCtx({ env, which: bin => Bun.which(bin, { PATH: env.PATH }), run: async argv => {
    const child = Bun.spawnSync(argv, { env });
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  } });
  const tasks = listTasks(ctx, Infinity);
  expect(tasks).toHaveLength(5);
  for (const task of tasks) expect((await resolveRepoInput(ctx, task.repo!.key)).path).toBe(task.repo!.path);
  expect(new Set(tasks.map(task => task.state))).toEqual(new Set(["done", "failed", "partial", "running"]));
  expect(tasks.filter(task => task.state === "done" && !task.review)).toHaveLength(1);
  expect(tasks.filter(task => task.review?.accepted)).toHaveLength(1);
  const failed = tasks.find(task => task.state === "failed")!;
  expect(existsSync(failed.worktree!)).toBe(false);
  const running = tasks.find(task => task.state === "running")!;
  expect(running.childPid).toBeUndefined();
  expect(running.run).toBeUndefined();
  expect(taskStatus({ ...ctx, now: ctx.now + 3600 }, running.id)?.state).toBe("running");

  const status = await computeStatus(ctx, loadStrategy(ctx));
  expect(status.accounts).toHaveLength(2);
  expect(status.accounts!.every(account => account.usedPct !== null)).toBe(true);
  const setup = await checkSetup(ctx, { snapshotProbe: false, status });
  expect(setup.complete).toBe(true);
  expect(setup.ready).toBe(true);
  const response = await handleV2(new Request("http://127.0.0.1/v3/snapshot"), { getCtx: () => ctx });
  expect(response.status).toBe(200);
  const { snapshot } = await response.json();
  expect(snapshot.setup.complete).toBe(true);
  expect(snapshot.setup.ready).toBe(true);
  expect(snapshot.tasks).toHaveLength(5);
  expect(snapshot.attention.some((item: {kind: string}) => item.kind === "review")).toBe(true);
  for (const task of tasks) {
    const detail = await handleV2(new Request("http://127.0.0.1/v3/ops/task.get", { method: "POST", body: JSON.stringify({ id: task.id }) }), { getCtx: () => ctx });
    expect(detail.status).toBe(200);
    expect((await detail.json()).result.id).toBe(task.id);
  }
  expect(taskStop(ctx, running.id)?.state).toBe("stopped");
  for (const argv of [["launchctl", "bootstrap", "gui/0"], ["systemctl", "--user", "restart", "pacer-serve.service"], ["codex", "exec", "sample"]]) {
    const child = Bun.spawnSync(argv, { env });
    expect(child.exitCode).toBe(3);
    expect(child.stderr.toString()).toContain("D3");
  }
  expect(JSON.parse(readFileSync(join(ctx.pacerHome, "state/attention.json"), "utf8"))[`failed:${failed.id}`]).toHaveProperty("since");
});

test("unknown seeds fail before creating a sandbox", async () => {
  const base = tmpDir();
  await expect(up("invalid-seed", undefined, base, "unknown")).rejects.toThrow("Unknown seed");
  expect(readdirSync(base)).toEqual([]);
  await expect(main(["up", "--seed", "unknown"])).rejects.toThrow("Unknown seed");
  await expect(main(["up", "--seed"])).rejects.toThrow("requires a value");
  await expect(main(["status", "--seed", "ui"])).rejects.toThrow("only valid for up");
});


test.skipIf(!canBind)("seeded service exposes setup-complete snapshots and task details", async () => {
  const session = await up("ui-cycle", undefined, tmpDir(), "ui");
  try {
    const token = readFileSync(join(session.root, "home/token"), "utf8").trim();
    const base = `http://127.0.0.1:${session.port}`;
    const headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(`${base}/v3/snapshot`, { headers });
    expect(response.status).toBe(200);
    const { snapshot } = await response.json();
    expect(snapshot.setup.complete).toBe(true);
    expect(snapshot.setup.ready).toBe(true);
    expect(snapshot.tasks).toHaveLength(5);
    expect(snapshot.tasks.some((task: {state: string}) => task.state === "running")).toBe(true);
    expect(snapshot.accounts).toHaveLength(2);
    expect(snapshot.attention.length).toBeGreaterThan(0);
    for (const task of snapshot.tasks) {
      const detail = await fetch(`${base}/v3/ops/task.get`, { method: "POST", headers, body: JSON.stringify({ id: task.id }) });
      expect(detail.status).toBe(200);
      expect((await detail.json()).result.id).toBe(task.id);
    }
  } finally { await down(session); }
}, 15000);


test.skipIf(process.platform !== "darwin")("desktop bundle selects CFBundleExecutable when a CLI sidecar is present", () => {
  const app = join(tmpDir(), "pacer.app");
  const binaries = join(app, "Contents/MacOS");
  mkdirSync(binaries, { recursive: true });
  atomicWrite(join(binaries, "pacer"), "sidecar", 0o700);
  atomicWrite(join(binaries, "pacer-desktop"), "shell", 0o700);
  atomicWrite(join(app, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>pacer-desktop</string></dict></plist>');
  expect(desktopExecutable(app)).toBe(join(binaries, "pacer-desktop"));
});

test("desktop bundle falls back to a single file and refuses ambiguity", () => {
  const app = join(tmpDir(), "pacer.app");
  const binaries = join(app, "Contents/MacOS");
  mkdirSync(binaries, { recursive: true });
  atomicWrite(join(binaries, "shell"), "shell", 0o700);
  mkdirSync(join(binaries, "support"));
  expect(desktopExecutable(app)).toBe(join(binaries, "shell"));
  atomicWrite(join(binaries, "sidecar"), "sidecar", 0o700);
  expect(() => desktopExecutable(app)).toThrow("multiple executables");
});


test("desktop bundle does not follow symlink candidates", () => {
  const root = tmpDir();
  const app = join(root, "pacer.app");
  const binaries = join(app, "Contents/MacOS");
  mkdirSync(binaries, { recursive: true });
  atomicWrite(join(binaries, "shell"), "shell", 0o700);
  atomicWrite(join(root, "outside"), "outside", 0o700);
  symlinkSync(join(root, "outside"), join(binaries, "sidecar"));
  expect(desktopExecutable(app)).toBe(join(binaries, "shell"));
});

test.skipIf(process.platform !== "darwin")("desktop bundle reports malformed plist instead of guessing", () => {
  const app = join(tmpDir(), "pacer.app");
  const binaries = join(app, "Contents/MacOS");
  mkdirSync(binaries, { recursive: true });
  atomicWrite(join(binaries, "shell"), "shell", 0o700);
  atomicWrite(join(app, "Contents/Info.plist"), "invalid plist");
  expect(() => desktopExecutable(app)).toThrow("plutil");
});
test("OTA CLI requires explicit scoped options and never accepts arbitrary commands", async () => {
  for (const args of [
    ["ota", "prepare"], ["ota", "prepare", "--id", "missing"],
    ["ota", "exercise", "--id", "missing"], ["ota", "cleanup", "--id", "missing", "--app", "/outside"],
    ["ota", "exercise", "--id", "missing", "--scenario", "install", "--", "rm", "-rf", "/outside"],
    ["ota", "cleanup", "--id", "missing", "--feed", "https://example.invalid"],
    ["env", "--from-app", "/outside"],
  ]) await expect(main(args)).rejects.toThrow();
});


test("OTA-only options are rejected before up can create a sandbox", async () => {
  await expect(main(["up", "--id", "../escape", "--from-app", "/outside"])).rejects.toThrow("OTA options");
});


test.skipIf(!canBind)("proxy preserves refused WebSocket handshake statuses, headers and bodies", async () => {
  const session = fixture();
  session.port = await freePort();
  session.innerPort = await freePort();
  while (session.innerPort === session.port) session.innerPort = await freePort();
  const sockets = new Set<Socket>();
  const upstream = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", data => {
      const url = new URL(data.toString().split(" ")[1], "http://localhost");
      const status = Number(url.searchParams.get("status"));
      const stall = url.searchParams.get("stall") === "true";
      if (url.searchParams.get("chunked") === "true") {
        socket.end(`HTTP/1.1 ${status} Refused\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n`);
        return;
      }
      const body = stall ? "x" : url.searchParams.get("large") === "true" ? "x".repeat(256 * 1024 + 1) : `refused ${status}`;
      socket.write(`HTTP/1.1 ${status} Refused\r\nContent-Length: ${stall ? 10 : Buffer.byteLength(body)}\r\nX-Pacer: 1\r\nConnection: close\r\n\r\n${body}`);
      if (!stall) socket.end();
    });
  });
  await new Promise<void>(resolve => upstream.listen(session.innerPort, "127.0.0.1", resolve));
  const proxy = startProxy(session);
  try {
    const cases = [
      [400, "normal"], [401, "normal"], [403, "normal"], [404, "normal"],
      [409, "normal"], [404, "large"], [404, "stall"], [404, "chunked"],
    ] as const;
    for (const [status, mode] of cases) {
      const result = await new Promise<{status: number; marker: string | string[] | undefined; body: string}>((resolve, reject) => {
        const req = request(`http://127.0.0.1:${session.port}/v3/tasks/missing/session?status=${status}&large=${mode === "large"}&stall=${mode === "stall"}&chunked=${mode === "chunked"}`, {
          headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
        }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({ status: response.statusCode!, marker: response.headers["x-pacer"], body: Buffer.concat(chunks).toString() }));
          response.on("error", reject);
        });
        req.setTimeout(5000, () => req.destroy(Error("handshake response timed out")));
        req.on("error", reject);
        req.on("upgrade", (_response, socket) => { socket.destroy(); reject(Error("unexpected upgrade")); });
        req.end();
      });
      expect(result).toEqual(mode !== "normal"
        ? { status: 502, marker: undefined, body: "Live validation upstream unavailable\n" }
        : { status, marker: "1", body: `refused ${status}` });
    }
  } finally { proxy.stop(true); for (const socket of sockets) socket.destroy(); upstream.close(); }
}, 30000);

test("test-only native front door requires its exact explicit mode", () => {
  expect(() => validateFrontDoor("rust-test-ops")).not.toThrow();
  expect(() => validateFrontDoor("test-ops")).toThrow();
  expect(() => validateFrontDoor("rust-test-ops --features arbitrary")).toThrow();
  const session = { ...fixture(), frontDoor: "rust-test-ops" as const };
  expect(pacerArgv(session)[0]).toBe(join(session.root, "bin/pacer-test-ops"));
  expect(sandboxEnv(session).PACER_CORE_ARGV).toBeDefined();
});

test("Rust harness modes build and snapshot separate fixed Cargo targets", () => {
  const normal=frontDoorBuild("rust"), synthetic=frontDoorBuild("rust-test-ops");
  expect(normal.executable).not.toBe(synthetic.executable);
  for(const build of [normal,synthetic]) {
    const index=build.argv.indexOf("--target-dir");
    expect(index).toBeGreaterThan(0);
    expect(build.executable).toBe(join(build.argv[index+1],"debug/pacer"));
  }
  expect(normal.argv).not.toContain("--features");
  expect(synthetic.argv.slice(-2)).toEqual(["--features","test-ops"]);
});
