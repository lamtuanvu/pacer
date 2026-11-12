import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { installFixture } from "../../conformance/install";
import { down, healthy, pacerArgv, record, sandboxEnv, type Session } from "./core";

type Reply = { id?: number; result?: unknown; error?: unknown };

export function verifyNativeStdio(stdout: string, stderr: string, exit: number): void {
  if (exit !== 0) throw Error(`native stdio exited ${exit}: ${stderr}`);
  const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as Reply);
  if (replies.length !== 3 || replies[0]?.id !== 1 || replies[1]?.id !== 2 || replies[2]?.id !== 3) {
    throw Error("native stdio returned unexpected reply IDs");
  }
  if ((replies[0].result as { protocol?: string } | undefined)?.protocol !== "3.0.0") throw Error("native stdio did not negotiate protocol 3");
  if (JSON.stringify(replies[1].result) !== JSON.stringify({ fixture: "native-stdio", n: 1 })) throw Error("native stdio echo result differed");
  if ((replies[2].result as { protocol?: string } | undefined)?.protocol !== "2.8.0") throw Error("native stdio did not negotiate protocol 2");
  const markers = stderr.split("\n").filter(line => line.startsWith("native test.echo"));
  if (markers.length !== 1 || markers[0] !== "native test.echo 2") {
    throw Error("native stdio execution trace was absent or repeated");
  }
  const hello = stderr.split("\n").filter(line => line.startsWith("native hello"));
  if (hello.length !== 2 || hello[0] !== "native hello 1" || hello[1] !== "native hello 3") {
    throw Error("native hello execution trace was absent or repeated");
  }
}

export function verifyForwardedHello(stdout: string, stderr: string, exit: number): void {
  if (exit !== 0) throw Error(`forwarded stdio exited ${exit}: ${stderr}`);
  const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as Reply);
  if (replies.length !== 2 || replies[0]?.id !== 1 || replies[1]?.id !== 2 ||
      (replies[0].result as { protocol?: string } | undefined)?.protocol !== "3.0.0" ||
      (replies[1].result as { protocol?: string } | undefined)?.protocol !== "2.8.0") {
    throw Error("forwarded hello replies differed");
  }
  if (stderr.split("\n").some(line => line.startsWith("native hello"))) {
    throw Error("forwarded hello executed natively");
  }
}

/** Fixed protocol exchange inside an owned sandbox; the ordinary D3 CLI guard remains in force. */
export async function exerciseNativeStdio(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !session.nativeTestOps || session.nativeForwardEcho || session.realKeychain || session.stopped) {
    throw Error("native stdio requires an active sandbox Rust test-ops build without forwarding or real Keychain");
  }
  if (!await healthy(session)) throw Error("native stdio requires a healthy guarded sandbox");
  const argv = [...pacerArgv(session), "api", "--stdio"];
  const env = { ...sandboxEnv(session), HOME: join(session.root, "home"), PACER_NO_SELF_REPAIR: "1" };
  const child = Bun.spawn(argv, { cwd: join(session.root, "repo"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const input = [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
    { jsonrpc: "2.0", id: 2, method: "test.echo", params: { fixture: "native-stdio", n: 1 } },
    { jsonrpc: "2.0", id: 3, method: "hello", params: { protocol: 2 } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  await child.stdin.write(input);
  await child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  record(session, { kind: "command", argv, code, stdout, stderr });
  try {
    verifyNativeStdio(stdout, stderr, code);
    record(session, { kind: "note", behavior: "Protocol-3 native stdio dispatch", surface: "stdio API", verdict: "PASS",
      steps: "Fixed hello(3), test.echo, hello(2) exchange in the owned sandbox", text: "Protocol 3 accepted, test.echo returned exact fixture payload once, native hello and echo traces recorded, protocol 2 accepted." });
  } catch (error) {
    record(session, { kind: "note", behavior: "Protocol-3 native stdio dispatch", surface: "stdio API", verdict: "FAIL", text: (error as Error).message });
    throw error;
  }
  const forwarded = Bun.spawn(argv, { cwd: join(session.root, "repo"),
    env: { ...env, PACER_FORWARD_OPS: "*" }, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const forwardInput = [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
    { jsonrpc: "2.0", id: 2, method: "hello", params: { protocol: 2 } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  await forwarded.stdin.write(forwardInput);
  await forwarded.stdin.end();
  const [forwardCode, forwardStdout, forwardStderr] = await Promise.all([
    forwarded.exited, new Response(forwarded.stdout).text(), new Response(forwarded.stderr).text(),
  ]);
  record(session, { kind: "command", argv, code: forwardCode, stdout: forwardStdout, stderr: forwardStderr });
  try {
    verifyForwardedHello(forwardStdout, forwardStderr, forwardCode);
    record(session, { kind: "note", behavior: "Forced-forward stdio hello", surface: "stdio API", verdict: "PASS",
      steps: "Fixed hello(3), hello(2) exchange with PACER_FORWARD_OPS=* in the owned sandbox",
      text: "TypeScript returned both versions and neither request produced a native hello trace." });
  } catch (error) {
    record(session, { kind: "note", behavior: "Forced-forward stdio hello", surface: "stdio API", verdict: "FAIL", text: (error as Error).message });
    throw error;
  }
}

export const PLUGIN = "fx-ui";
export const RENDER = { plugin: PLUGIN, surface: "activity", id: "checklist", context: { route: "overview", theme: "light" } };
/** The fixed plugin exchange: one request before hello, then the plugin lifecycle under protocol 3. */
export const PLUGIN_STDIO_STEPS: ReadonlyArray<readonly [number, string, Record<string, unknown>]> = [
  [1, "plugin.list", {}],
  [2, "hello", { protocol: 3 }],
  [3, "plugin.list", {}],
  [4, "plugin.enable", { id: PLUGIN, grant: true }],
  [5, "plugin.doctor", { id: PLUGIN }],
  [6, "plugin.ui.render", RENDER],
  [7, "plugin.settings.get", { plugin: PLUGIN }],
  [8, "plugin.disable", { id: PLUGIN }],
  [9, "plugin.enable", { id: PLUGIN, grant: true }],
  [10, "plugin.doctor", { id: PLUGIN }],
];
export type PluginOwnership = "core" | "own" | "attach";

type PluginReply = Reply & { error?: { code?: number; message?: string; data?: { code?: string; hint?: string } }; result?: any };

/** Checks the replies and native traces of one run of the fixed plugin exchange; returns the owner socket. */
export function verifyPluginStdio(replies: Map<number, PluginReply>, stderr: string, ownership: PluginOwnership): string | undefined {
  const reply = (id: number) => {
    const value = replies.get(id);
    if (!value) throw Error(`plugin stdio returned no reply to ${id}`);
    return value;
  };
  if (reply(1).error?.data?.code !== "unknown_op") throw Error("plugin.list before hello was not refused by TypeScript");
  if (reply(2).result?.protocol !== "3.0.0") throw Error("plugin stdio did not negotiate protocol 3");
  for (const [id] of PLUGIN_STDIO_STEPS.slice(2)) if (reply(id).error) throw Error(`plugin step ${id} failed: ${JSON.stringify(reply(id).error)}`);
  if (!reply(3).result?.plugins?.some((p: { id?: string }) => p.id === PLUGIN)) throw Error("plugin.list did not list the fixture plugin");
  for (const id of [5, 10]) if (reply(id).result?.reports?.[0]?.ok !== true) throw Error(`plugin.doctor ${id} did not report a healthy plugin`);
  const lines = stderr.split("\n");
  for (const [id, method] of PLUGIN_STDIO_STEPS) {
    if (method === "hello") continue;
    const count = lines.filter(line => line === `native ${method} ${id}`).length;
    if (count !== (id === 1 ? 0 : 1)) throw Error(`native trace for ${method} ${id} appeared ${count} times`);
  }
  const owner = lines.filter(line => line.startsWith("native plugin owner "));
  // An owning connection binds in run/, or in the private per-user pacer-<hash>/ directory for a deep home.
  const expected = ownership === "own" ? /^native plugin owner own (\/.*\/(?:run|pacer-[0-9a-f]{16})\/s[0-9a-f]{12}\.sock)$/ : /^native plugin owner attach (\/.*\/run\/host\.sock)$/;
  const match = owner.length === 1 ? expected.exec(owner[0]) : null;
  if (ownership === "core" ? owner.length !== 0 : !match) {
    throw Error(`plugin ownership trace differed from ${ownership}: ${owner.join(" | ") || "none"}`);
  }
  return match?.[1];
}

/** Where an owning connection must bind: `run/` unless that path exceeds the 103-byte socket limit. */
export function verifyOwnerSocket(home: string, socket: string): "run" | "private" {
  const deep = join(home, "run", "s000000000000.sock").length > 103;
  const inRun = dirname(socket) === join(home, "run");
  const inPrivate = !socket.startsWith(`${home}/`) && /^pacer-[0-9a-f]{16}$/.test(basename(dirname(socket))) && socket.length <= 103;
  if (deep ? !inPrivate : !inRun) throw Error(`owner socket ${socket} is not in the ${deep ? "private per-user directory" : "home's run directory"}`);
  return deep ? "private" : "run";
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export async function gone(pid: number, ms = 5000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(50)) if (!alive(pid)) return true;
  return !alive(pid);
}
/** Running fixture plugin processes. Native owners report no pid in `plugin.doctor`, so they are found by entry path. */
export function pluginProcesses(home: string): Array<{ pid: number; ppid: number }> {
  const entry = join(home, "plugins", PLUGIN, "main.ts");
  return Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,command="]).stdout.toString().split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && match[3].split(" ").includes(entry) ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : [];
  });
}
const connectionSockets = (home: string) => existsSync(join(home, "run")) ? readdirSync(join(home, "run")).filter(name => /^s[0-9a-f]{12}\.sock$/.test(name)) : [];

/** One stdio connection that sends fixed lines one at a time and waits for each reply. */
function stdioConnection(session: Session, nativeHost: "0" | "1") {
  const argv = [...pacerArgv(session), "api", "--stdio"];
  const env = { ...sandboxEnv(session), HOME: join(session.root, "home"), PACER_NO_SELF_REPAIR: "1", PACER_DEBUG_NATIVE: "1", PACER_NATIVE_PLUGIN_HOST: nativeHost };
  const child = Bun.spawn(argv, { cwd: join(session.root, "repo"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const replies = new Map<number, PluginReply>(), waiters = new Map<number, (reply: PluginReply) => void>();
  const stdout: string[] = [];
  const pump = (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder();
    let buffer = "";
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      buffer += decoder.decode(part.value, { stream: true });
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        stdout.push(line);
        const message = JSON.parse(line) as PluginReply;
        if (typeof message.id !== "number") continue;
        replies.set(message.id, message);
        waiters.get(message.id)?.(message);
      }
    }
  })();
  return {
    argv, replies, pid: child.pid,
    async call(id: number, method: string, params: unknown): Promise<PluginReply> {
      const answered = new Promise<PluginReply>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`plugin stdio: no reply to ${id}`)), 30000);
        waiters.set(id, value => { clearTimeout(timer); resolve(value); });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      child.stdin.flush();
      return await answered;
    },
    async close() {
      child.stdin.end();
      if (await Promise.race([child.exited.then(() => false), Bun.sleep(20000).then(() => true)])) child.kill("SIGKILL");
      const code = await child.exited;
      await pump;
      const text = await stderr;
      record(session, { kind: "command", argv: [...argv, `(PACER_NATIVE_PLUGIN_HOST=${nativeHost})`], code, stdout: stdout.join("\n"), stderr: text });
      return { code, stderr: text };
    },
  };
}

export async function httpOp(session: Session, op: string, params: unknown): Promise<PluginReply> {
  const token = readFileSync(join(session.root, "home/token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${session.port}/v3/ops/${op}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(30000) });
  return await response.json() as PluginReply;
}

/**
 * Fixed stdio plugin exchange with the native host off and on, on the sandbox's Rust front door.
 * A running sandbox service decides the flag-on owner (attach when it runs `--native-plugin-host`);
 * a sandbox stopped with `down --keep` is a home without a service. Accepts no operation, path or
 * environment override.
 */
export async function exerciseNativePluginStdio(session: Session, stopService = false): Promise<void> {
  if (session.frontDoor !== "rust" || session.nativeForwardEcho || session.nativeForwardOps || session.realKeychain) {
    throw Error("native plugin stdio requires a Rust front-door sandbox without forwarding or real Keychain");
  }
  const serviceLive = !session.stopped && await healthy(session);
  if (!session.stopped && !serviceLive) throw Error("native plugin stdio requires a healthy sandbox or one stopped with down --keep");
  if (stopService && !(serviceLive && session.nativePluginHost)) throw Error("--stop-service requires a healthy --native-plugin-host sandbox");
  const home = join(session.root, "home");
  if (!existsSync(join(home, "plugins", PLUGIN))) installFixture("ui", join(home, "plugins"));
  const where = serviceLive ? `beside the sandbox service (native host ${session.nativePluginHost ? "on" : "off"})` : "on the sandbox home with its service stopped";
  const flagOn: PluginOwnership = serviceLive && session.nativePluginHost ? "attach" : "own";
  const runs: Array<["0" | "1", PluginOwnership]> = stopService ? [["1", "attach"]] : [["0", "core"], ["1", flagOn]];
  for (const [nativeHost, ownership] of runs) {
    const behavior = `Stdio plugin ops, native host ${nativeHost === "1" ? "on" : "off"} (${ownership})`;
    const baseline = new Set(pluginProcesses(home).map(p => p.pid));
    const connection = stdioConnection(session, nativeHost);
    // The one plugin process this connection's exchange started, checked against the expected parent.
    const started = async () => {
      let fresh: Array<{ pid: number; ppid: number }> = [];
      // An attached connection may reuse the service's process from an earlier connection.
      const ours = (p: { pid: number; ppid: number }) => !baseline.has(p.pid) || (ownership === "attach" && p.ppid === session.pid);
      for (let i = 0; i < 100 && fresh.length !== 1; i++, await Bun.sleep(50)) fresh = pluginProcesses(home).filter(ours);
      if (fresh.length !== 1) throw Error(`expected one new plugin process, found ${JSON.stringify(fresh)}`);
      const [child] = fresh;
      const parent = ownership === "own" ? child.ppid === connection.pid : ownership === "attach" ? child.ppid === session.pid : child.ppid !== connection.pid && child.ppid !== session.pid;
      if (!parent) throw Error(`plugin process ${child.pid} has parent ${child.ppid}, not the ${ownership} owner (stdio ${connection.pid}, service ${session.pid})`);
      return child.pid;
    };
    try {
      let first = 0, second = 0;
      for (const [id, method, params] of PLUGIN_STDIO_STEPS) {
        await connection.call(id, method, params);
        if (id === 5) first = await started();
        if (id === 8 && !await gone(first)) throw Error(`plugin.disable left plugin process ${first} running`);
        if (id === 10) second = await started();
      }
      let shared = "";
      if (ownership === "attach") {
        const served = await httpOp(session, "plugin.doctor", { id: PLUGIN });
        if (served.error || served.result?.reports?.[0]?.ok !== true) throw Error(`service doctor failed: ${JSON.stringify(served)}`);
        if (await started() !== second) throw Error("the service started a second plugin process");
        shared = ` The service's own plugin.doctor reported it healthy without starting another process.`;
      }
      if (stopService) {
        await down(session, true);
        const after = await connection.call(11, "plugin.ui.render", RENDER);
        record(session, { kind: "note", text: `plugin.ui.render after the attached service stopped: ${JSON.stringify(after)}` });
        if (after.error?.data?.code !== "plugin_unavailable" || !after.error.data.hint) throw Error(`render after the service stopped was not plugin_unavailable with a restart hint: ${JSON.stringify(after)}`);
        if (!await gone(second)) throw Error(`plugin process ${second} outlived the stopped service`);
        record(session, { kind: "note", behavior: "Attached stdio connection when the service stops", surface: "stdio API", verdict: "PASS",
          steps: "Attached stdio session open across live down --keep, then plugin.ui.render",
          text: `The render answered plugin_unavailable (${after.error.message}; hint: ${after.error.data.hint}); the service's plugin process ${second} stopped with the service.` });
      }
      const { code, stderr } = await connection.close();
      if (code !== 0) throw Error(`stdio exited ${code}: ${stderr}`);
      const socket = verifyPluginStdio(connection.replies, stderr, ownership);
      const placement = ownership === "own" && socket ? verifyOwnerSocket(home, socket) : undefined;
      let teardown = "";
      if (ownership === "attach" && !stopService) {
        if (!alive(second)) throw Error(`the service's plugin process ${second} stopped with the attached connection`);
        teardown = ` After EOF the service's plugin process ${second} was still running.`;
      } else if (ownership !== "attach") {
        if (!await gone(second)) throw Error(`plugin process ${second} outlived its stdio connection`);
        if (connectionSockets(home).length) throw Error(`connection sockets remained: ${connectionSockets(home).join(", ")}`);
        if (socket && existsSync(socket)) throw Error(`connection socket ${socket} remained`);
        const place = placement === "private" ? ` ${socket} (the private per-user directory: the home's run/ path exceeds 103 bytes)` : "";
        teardown = ` After EOF plugin process ${second} had exited${ownership === "own" ? ` and the connection socket${place} was removed` : ""}.`;
      }
      record(session, { kind: "note", behavior, surface: "stdio API", verdict: "PASS",
        steps: `Fixed exchange ${where}: plugin.list before hello, hello(3), list, enable, doctor, ui.render, settings.get, disable, enable, doctor`,
        text: `Pre-hello plugin.list went to TypeScript; the ${PLUGIN_STDIO_STEPS.length - 2} protocol-3 plugin requests answered natively once each, and the ownership trace was ${ownership === "core" ? "absent" : ownership}. Each doctor started one plugin process under the ${ownership === "own" ? "stdio front door" : ownership === "attach" ? "service" : "stdio Core child"}, and disable stopped the first (${first}).${shared}${teardown}` });
    } catch (error) {
      await connection.close().catch(() => undefined);
      record(session, { kind: "note", behavior, surface: "stdio API", verdict: "FAIL", text: (error as Error).message });
      throw error;
    }
  }
  if (serviceLive && !stopService) {
    const listed = await httpOp(session, "plugin.list", {});
    const doctor = await httpOp(session, "plugin.doctor", { id: PLUGIN });
    if (listed.error || !listed.result?.plugins?.some((p: { id?: string }) => p.id === PLUGIN) || doctor.error || doctor.result?.reports?.[0]?.ok !== true) {
      record(session, { kind: "note", behavior: "HTTP plugin ops beside stdio sessions", surface: "HTTP API", verdict: "FAIL", text: JSON.stringify({ listed, doctor }) });
      throw Error("HTTP plugin ops failed after the stdio sessions");
    }
    record(session, { kind: "note", behavior: "HTTP plugin ops beside stdio sessions", surface: "HTTP API", verdict: "PASS",
      steps: "plugin.list and plugin.doctor through the guarded proxy after both stdio sessions",
      text: `The service listed ${PLUGIN} and reported it healthy.` });
  }
}
