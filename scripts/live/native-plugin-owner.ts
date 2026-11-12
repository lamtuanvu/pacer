import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installFixture } from "../../conformance/install";
import { freePort, healthy, launch, pacerArgv, record, run, sandboxEnv, startService, stopService, type Session } from "./core";
import { captureOwnedProcessGroup, stopOwnedProcessGroup } from "./process-group";
import { alive, gone, httpOp, PLUGIN, pluginProcesses } from "./native-stdio";

const WAIT_MS = 1500;

/** Config publications for the plugins area, read from one SSE subscription. */
async function configStream(session: Session) {
  const token = readFileSync(join(session.root, "home/token"), "utf8").trim();
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${session.port}/v3/events?since=0`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
  const reader = response.body?.getReader();
  if (!response.ok || !reader) throw Error(`SSE subscription failed: ${response.status}`);
  let frames = "";
  const pump = (async () => {
    const decoder = new TextDecoder();
    try { for (let part = await reader.read(); !part.done; part = await reader.read()) frames += decoder.decode(part.value, { stream: true }); }
    catch { /* aborted */ }
  })();
  const count = () => frames.split("\n\n").filter(frame => frame.includes("event: config") && frame.includes('"area":"plugins"')).length;
  await Bun.sleep(500);
  return {
    count,
    async next(before: number, what: string) {
      for (const deadline = Date.now() + 10000; Date.now() < deadline; await Bun.sleep(50)) if (count() > before) return;
      throw Error(`no plugins config publication after ${what}`);
    },
    async close() { abort.abort(); await pump; },
  };
}

async function op(session: Session, name: string, params: unknown) {
  let reply = await httpOp(session, name, params);
  // A started front door answers before its TypeScript core is up.
  for (let i = 0; i < 120 && String(reply.error?.code) === "unavailable"; i++) {
    await Bun.sleep(250);
    reply = await httpOp(session, name, params);
  }
  if (reply.error) throw Error(`${name} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
const entry = async (session: Session) => (await op(session, "plugin.list", {})).plugins.find((p: { id: string }) => p.id === PLUGIN);
const report = async (session: Session) => (await op(session, "plugin.doctor", { id: PLUGIN })).reports[0];

/** The one fixture child the service owns. */
async function serviceChild(session: Session, not = 0): Promise<number> {
  const home = join(session.root, "home");
  let owned: Array<{ pid: number; ppid: number }> = [];
  for (let i = 0; i < 100; i++, await Bun.sleep(50)) {
    owned = pluginProcesses(home).filter(p => p.pid !== not);
    if (owned.length === 1 && owned[0].ppid === session.pid) return owned[0].pid;
  }
  throw Error(`expected one plugin process under service ${session.pid}, found ${JSON.stringify(owned)}`);
}

/** Kill the service's child; return when the service's Core has recorded the crash. */
async function crash(session: Session, transitions: string[]): Promise<number> {
  const pid = await serviceChild(session);
  const killedAt = Date.now();
  process.kill(pid, "SIGKILL");
  if (!await gone(pid)) throw Error(`plugin process ${pid} survived SIGKILL`);
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(20)) {
    const listed = await entry(session);
    if (listed.state !== "ready") {
      transitions.push(`${listed.state} (${listed.error})`);
      return killedAt;
    }
  }
  throw Error(`plugin.list never left ready after ${pid} was killed`);
}

/** A `pacer serve` waiting for the sandbox home's owner, on its own port and process group. */
async function waitingServe(session: Session) {
  const port = await freePort();
  const pid = launch(session, [...pacerArgv(session), "serve", "--port", String(port)], "waiting-serve.log", { PACER_SERVE_OWNER_WAIT_MS: "20000" });
  return { pid, group: captureOwnedProcessGroup(pid), log: () => readFileSync(join(session.root, "logs/waiting-serve.log"), "utf8") };
}

/**
 * Fixed owner lifecycle on a healthy `--front-door rust --native-plugin-host` sandbox: crash and
 * backoff of the service's fixture child, a refused second serve, and a restart that waits for the
 * old service to exit while a waiting serve takes the home over. Accepts no operation or override.
 */
export async function exerciseNativePluginOwner(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !session.nativePluginHost || session.nativeForwardEcho || session.nativeForwardOps || session.realKeychain) {
    throw Error("native plugin owner requires a --front-door rust --native-plugin-host sandbox without forwarding or real Keychain");
  }
  if (session.stopped || !await healthy(session)) throw Error("native plugin owner requires a healthy sandbox");
  const home = join(session.root, "home");
  const socket = join(home, "run/host.sock");
  if (!existsSync(join(home, "plugins", PLUGIN))) installFixture("ui", join(home, "plugins"));

  let behavior = "Plugin config publications through the native owner";
  try {
    const events = await configStream(session);
    try {
      for (const [name, params] of [["plugin.enable", { id: PLUGIN, grant: true }], ["plugin.disable", { id: PLUGIN }], ["plugin.enable", { id: PLUGIN, grant: true }]] as const) {
        const before = events.count();
        await op(session, name, params);
        await events.next(before, name);
      }
    } finally { await events.close(); }
    record(session, { kind: "note", behavior, surface: "HTTP API + SSE", verdict: "PASS",
      steps: "SSE /v3/events through the guarded proxy; plugin.enable, plugin.disable, plugin.enable",
      text: "Each change published one config event for the plugins area." });

    behavior = "Crash, backoff and failing state of a service-owned plugin";
    const transitions: string[] = [];
    if ((await report(session)).ok !== true) throw Error("fixture plugin did not start");
    transitions.push((await entry(session)).state);
    const waits: number[] = [];
    for (const [n, backoff] of [[1, 1000], [2, 2000]] as const) {
      const old = await serviceChild(session);
      const killedAt = await crash(session, transitions);
      const doctor = await report(session);
      waits.push(Date.now() - killedAt);
      if (doctor.ok !== true || doctor.restarts !== n) throw Error(`doctor after crash ${n}: ${JSON.stringify(doctor)}`);
      if (waits[n - 1] < backoff) throw Error(`restart ${n} came ${waits[n - 1]} ms after the crash, before the ${backoff} ms backoff`);
      await serviceChild(session, old);
      transitions.push((await entry(session)).state);
    }
    await crash(session, transitions);
    const failing = await report(session);
    if (failing.ok !== false || failing.state !== "failing" || failing.restarts !== 3) throw Error(`doctor after crash 3: ${JSON.stringify(failing)}`);
    if (pluginProcesses(home).length) throw Error("a failing plugin was restarted");
    const enabledAt = Date.now();
    await op(session, "plugin.enable", { id: PLUGIN, grant: true });
    const recovered = await report(session);
    const recovery = Date.now() - enabledAt;
    if (recovered.ok !== true || recovered.restarts !== 0) throw Error(`doctor after enable: ${JSON.stringify(recovered)}`);
    transitions.push((await entry(session)).state);
    const expected = ["ready", "idle (exited on SIGKILL)", "ready", "idle (exited on SIGKILL)", "ready", "failing (exited on SIGKILL; 3 failures within a minute)", "ready"];
    if (JSON.stringify(transitions) !== JSON.stringify(expected)) throw Error(`plugin.list transitions ${JSON.stringify(transitions)}`);
    record(session, { kind: "note", behavior, surface: "HTTP API", verdict: "PASS",
      steps: "SIGKILL the service's fixture child three times, plugin.list and plugin.doctor after each, then plugin.enable",
      text: `plugin.list went ${transitions.join(" -> ")}, the TypeScript registry's sequence. The doctor restarts came ${waits.join(" and ")} ms after crashes 1 and 2 (backoff 1000 and 2000 ms) with restarts 1 and 2; crash 3 left it failing with restarts 3 and no process; enable restarted it in ${recovery} ms with restarts 0.` });

    behavior = "A second serve on a live sandbox home";
    const argv = [...pacerArgv(session), "serve", "--port", String(await freePort())];
    const startedAt = Date.now();
    const second = Bun.spawn(argv, { cwd: join(session.root, "repo"), env: { ...sandboxEnv(session), PACER_SERVE_OWNER_WAIT_MS: String(WAIT_MS) }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => second.kill("SIGKILL"), 20000);
    const [code, out, err] = await Promise.all([second.exited, new Response(second.stdout).text(), new Response(second.stderr).text()]);
    clearTimeout(timer);
    const waited = Date.now() - startedAt;
    record(session, { kind: "command", argv: [...argv, `(PACER_SERVE_OWNER_WAIT_MS=${WAIT_MS})`], code, stdout: out, stderr: err });
    const refusal = `another pacer owns the plugin host socket at ${socket} (pid ${session.pid}): stop the other pacer (pacer service stop) or wait for it to exit`;
    if (code !== 3 || waited < WAIT_MS || !err.includes(refusal)) throw Error(`second serve exited ${code} after ${waited} ms: ${err}`);
    const doctor = await run([...pacerArgv(session), "doctor", "--json"], session);
    const live = `${socket} is live (owner pid ${session.pid})`;
    if (!doctor.stdout.includes(live)) throw Error(`pacer doctor does not name the live owner: ${doctor.stdout}`);
    if (!await healthy(session)) throw Error("the first service stopped answering");
    record(session, { kind: "note", behavior, surface: "CLI", verdict: "PASS",
      steps: `pacer serve on a second port with PACER_SERVE_OWNER_WAIT_MS=${WAIT_MS}, then pacer doctor --json`,
      text: `The second serve waited ${waited} ms and exited 3 with: ${refusal}. pacer doctor reported "${live}". The first service stayed healthy.` });

    behavior = "Service restart cycle with a serve waiting for the owner";
    const before = await serviceChild(session);
    const oldPid = session.pid;
    const waiting = await waitingServe(session);
    try {
      for (const deadline = Date.now() + 10000; Date.now() < deadline && !waiting.log().includes("waiting up to 20000 ms"); await Bun.sleep(50));
      if (!waiting.log().includes("waiting up to 20000 ms")) throw Error(`waiting serve did not wait: ${waiting.log()}`);
      await stopService(session);
      if (alive(before) || alive(oldPid)) throw Error("the stopped service left its plugin process or itself running");
      let took = false;
      for (const deadline = Date.now() + 15000; Date.now() < deadline && !took; await Bun.sleep(50)) {
        took = existsSync(`${socket}.pid`) && readFileSync(`${socket}.pid`, "utf8").trim() === String(waiting.pid);
      }
      if (!took || !alive(waiting.pid)) throw Error(`the waiting serve did not take over: ${waiting.log()}`);
      if (waiting.log().includes("another pacer owns")) throw Error("the waiting serve was refused");
    } finally { await stopOwnedProcessGroup(waiting.group); }
    for (const name of ["host.sock", "host.sock.pid"]) if (existsSync(join(home, "run", name))) throw Error(`${name} outlived the waiting serve`);
    await startService(session);
    const after = await report(session);
    if (after.ok !== true) throw Error(`doctor after restart: ${JSON.stringify(after)}`);
    const child = await serviceChild(session);
    if (readFileSync(`${socket}.pid`, "utf8").trim() !== String(session.pid)) throw Error("host.sock.pid does not name the restarted service");
    record(session, { kind: "note", behavior, surface: "service", verdict: "PASS",
      steps: "Start a serve with PACER_SERVE_OWNER_WAIT_MS=20000, stop the service and wait for its group to exit, stop the waiting serve, start the service again",
      text: `Service ${oldPid} and its plugin process ${before} exited; the waiting serve ${waiting.pid} then owned ${socket}, and on its stop removed the socket and sidecar. The restarted service ${session.pid} owns the socket and started plugin process ${child} on plugin.doctor.` });
  } catch (error) {
    record(session, { kind: "note", behavior, surface: "HTTP API", verdict: "FAIL", text: (error as Error).message });
    throw error;
  }
}
