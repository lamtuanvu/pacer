import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, pacerArgv, record, sandboxEnv, startService, stopService, type Session } from "./core";
import { captureOwnedProcessGroup, stopOwnedProcessGroup } from "./process-group";
import { gone } from "./native-stdio";
import { deepServeHome, serveSocketDir, serveSocketPath } from "./serve-socket";

/**
 * B0b deep-home serve reverse-bridge fallback (ADR 0027 item 5): on a home whose
 * `run/host.sock` would exceed the `sockaddr_un` limit, flag-on serve binds the
 * owner lease in the private per-user `pacer-<hash>` directory instead, the pid
 * and key sidecars follow the socket, the fallback is logged once, and a second
 * serve is refused naming that private lease. Requires a deep sandbox home
 * (`--front-door rust --native-plugin-host` with an id long enough that
 * `home/run/host.sock` exceeds 103 bytes). Accepts no operation or override.
 */
export async function exerciseDeepServe(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !session.nativePluginHost || session.nativeForwardEcho || session.nativeForwardOps || session.realKeychain) {
    throw Error("deep serve requires a --front-door rust --native-plugin-host sandbox without forwarding or real Keychain");
  }
  if (session.stopped) throw Error("deep serve requires a healthy sandbox");
  const home = join(session.root, "home");
  if (!deepServeHome(home)) throw Error(`deep serve requires a deep home; ${join(home, "run/host.sock")} fits in the socket limit`);
  const dir = serveSocketDir(home);
  const socket = serveSocketPath(home);
  if (socket.startsWith(`${home}/`)) throw Error(`expected the private per-user socket, still in the home: ${socket}`);

  const runSockets = ["host.sock", "host.sock.pid", "host.key"].filter(name => existsSync(join(home, "run", name)));
  let behavior = "Serve host.sock binds in the private per-user directory for a deep home";
  try {
    if (runSockets.length) throw Error(`serve left host sidecars in run/ for a deep home: ${runSockets.join(", ")}`);
    for (const name of ["host.sock", "host.sock.pid", "host.key"]) {
      if (!existsSync(join(dir, name))) throw Error(`${name} is not beside the deep-home socket at ${dir}`);
    }
    const log = readFileSync(join(session.root, "logs/serve.log"), "utf8");
    const fallback = log.split("\n").filter(line => line.includes("pacer: serve: PACER_HOME") && line.includes("too deep for the plugin owner socket in run"));
    if (fallback.length !== 1) throw Error(`expected one deep-home fallback line, found ${fallback.length}: ${log}`);
    if (!fallback[0].includes(home)) throw Error(`fallback line does not name the home: ${fallback[0]}`);
    if (!fallback[0].includes(socket)) throw Error(`fallback line does not name the private socket: ${fallback[0]}`);
    const enabled = log.split("\n").filter(line => line.startsWith("pacer: native plugin host enabled"));
    if (enabled.length !== 1 || !enabled[0].includes(`socket=${socket}`)) throw Error(`enabled line differs: ${enabled.join(" | ")}`);
    record(session, { kind: "note", behavior, surface: "service", verdict: "PASS",
      steps: `--native-plugin-host serve on a deep home (${home}); inspect serve.log and the private ${dir}`,
      text: `host.sock, host.sock.pid and host.key sat in ${dir}; none were left in run/. serve.log had exactly one fallback line: "${fallback[0]}", and one enabled line naming ${socket}.` });

    behavior = "A second serve on a deep home is refused with the private lease";
    const argv = [...pacerArgv(session), "serve", "--port", String(await freePort())];
    const startedAt = Date.now();
    const second = Bun.spawn(argv, { cwd: join(session.root, "repo"), env: { ...sandboxEnv(session), PACER_SERVE_OWNER_WAIT_MS: "1500" }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => second.kill("SIGKILL"), 20000);
    const [code, out, err] = await Promise.all([second.exited, new Response(second.stdout).text(), new Response(second.stderr).text()]);
    clearTimeout(timer);
    const waited = Date.now() - startedAt;
    record(session, { kind: "command", argv: [...argv, "(PACER_SERVE_OWNER_WAIT_MS=1500)"], code, stdout: out, stderr: err });
    const refusal = `another pacer owns the plugin host socket at ${socket} (pid ${session.pid}): stop the other pacer (pacer service stop) or wait for it to exit`;
    if (code !== 3 || waited < 1500 || !err.includes(refusal)) throw Error(`second serve exited ${code} after ${waited} ms: ${err}`);
    const pid = readFileSync(join(dir, "host.sock.pid"), "utf8").trim();
    if (pid !== String(session.pid)) throw Error(`host.sock.pid names ${pid}, expected the service pid ${session.pid}`);
    record(session, { kind: "note", behavior, surface: "CLI", verdict: "PASS",
      steps: "pacer serve on a second port with PACER_SERVE_OWNER_WAIT_MS=1500; then read host.sock.pid",
      text: `The second serve waited ${waited} ms and exited 3 with: ${refusal}. host.sock.pid in the private directory names the service pid ${session.pid}, so the owner pid follows the socket.` });

    behavior = "Deep-home serve stop removes the private socket and sidecars";
    await stopService(session);
    if (!await gone(session.pid, 10000)) throw Error("the stopped service survived");
    const remaining = ["host.sock", "host.sock.pid", "host.key"].filter(name => existsSync(join(dir, name)));
    if (remaining.length) throw Error(`deep-home stop left sidecars: ${remaining.join(", ")} in ${dir}`);
    if (!existsSync(dir)) throw Error("the private per-user directory itself should remain (other homes use it)");
    record(session, { kind: "note", behavior, surface: "service", verdict: "PASS",
      steps: "stopService on the deep-home service, wait for its group to exit, then check the private socket dir",
      text: `The service ${session.pid} stopped; host.sock and both sidecars were gone from ${dir}, while the per-user directory stayed for reuse.` });
    await startService(session);
    record(session, { kind: "note", behavior, surface: "service", verdict: "PASS",
      steps: "startService on the deep-home service",
      text: "The deep-home service started again on the sandbox port." });
  } catch (error) {
    record(session, { kind: "note", behavior, surface: "service", verdict: "FAIL", text: (error as Error).message });
    throw error;
  }
}

/** Stop a second serve started by the deep fixture, should the FNM leave it behind. */
export async function stopDeepServeProcessGroup(pid: number): Promise<void> {
  const group = captureOwnedProcessGroup(pid);
  if (group) await stopOwnedProcessGroup(group);
}