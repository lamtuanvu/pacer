import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

import { sourceFingerprint, type SourceFingerprint } from "./control/fingerprint";
import { seedUi, validateSeed } from "./seed";
import { processIdentity, type ProcessIdentity } from "../../src/update/desktop/process-identity";

export const checkout = resolve(import.meta.dir, "../..");
export const liveRoot = join(checkout, ".work/live");
export interface Session {
  id: string;
  root: string;
  port: number;
  pid: number;
  innerPort?: number;
  proxyPid?: number;
  serviceIdentity?: ProcessIdentity;
  createdAt: string;
  seed?: "ui";
  /** "rust": the Rust front door (target/debug/pacer) serves and dispatches, forwarding to the TypeScript core. */
  frontDoor?: "rust";
  stopped?: boolean;
  desktopPid?: number;
  desktopExecutable?: string;
  desktopSha256?: string;
  serviceSource?: SourceFingerprint;
  desktopIdentity?: { pid: number; start_identity: string };
}
export interface Evidence {
  at: string;
  kind: "command" | "note" | "attach" | "capture";
  text?: string;
  behavior?: string;
  surface?: string;
  verdict?: "PASS" | "FAIL" | "UNVERIFIED";
  steps?: string;
  argv?: string[];
  code?: number;
  stdout?: string;
  stderr?: string;
  path?: string;
}

export function validId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw Error("id must contain only letters, digits, _ or - (max 80 characters)");
  return id;
}
export function atomicWrite(path: string, data: string, mode = 0o600): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { flag: "wx", mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function saveSession(session: Session): void {
  atomicWrite(join(session.root, "session.json"), JSON.stringify(session, null, 2) + "\n");
}
export function sessions(base = liveRoot): Session[] {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(id => existsSync(join(base, id, "session.json")))
    .map(id => loadSession(id, base)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function loadSession(id?: string, base = liveRoot): Session {
  if (!id) {
    const latest = sessions(base)[0];
    if (!latest) throw Error("No live sandbox. Run bun run live up first.");
    return latest;
  }
  const root = resolve(base, validId(id));
  const session = JSON.parse(readFileSync(join(root, "session.json"), "utf8")) as Session;
  if (session.root !== root || session.id !== id || !Number.isInteger(session.port) || session.port === 4317 || session.port < 1 || session.port > 65535 || !Number.isInteger(session.pid) || session.pid < 1) {
    throw Error("Invalid live session metadata");
  }
  if ((session.innerPort !== undefined && (!Number.isInteger(session.innerPort) || session.innerPort < 1 || session.innerPort > 65535 || session.innerPort === 4317 || session.innerPort === session.port)) ||
      (session.proxyPid !== undefined && (!Number.isInteger(session.proxyPid) || session.proxyPid < 1))) throw Error("Invalid live proxy metadata");
  if (session.serviceIdentity && (session.serviceIdentity.pid !== session.pid || !session.serviceIdentity.bootId || !session.serviceIdentity.birth)) throw Error("Invalid live source process identity");
  return session;
}
/** The checkout CLI the sandbox runs: the TypeScript core, or the Rust front door in front of it. */
export function pacerArgv(session: Pick<Session, "frontDoor">): string[] {
  return session.frontDoor === "rust" ? [join(checkout, "target/debug/pacer")] : [process.execPath, join(checkout, "src/cli.ts")];
}
export function sourceServiceMatchesExecutable(observed: string | null, session: Pick<Session, "frontDoor">, canonicalize: (path: string) => string = realpathSync): boolean {
  return observed !== null && observed === canonicalize(pacerArgv(session)[0]);
}
export function validateFrontDoor(frontDoor: string | undefined): void {
  if (frontDoor !== undefined && frontDoor !== "rust") throw Error(`Unknown front door: ${frontDoor} (expected rust)`);
}
export function sandboxEnv(session: Session, inherited = process.env): NodeJS.ProcessEnv {
  return {
    ...inherited,
    ...(session.frontDoor === "rust" ? { PACER_CORE_ARGV: JSON.stringify([process.execPath, join(checkout, "src/cli.ts")]) } : {}),
    PATH: `${join(session.root, "bin")}:${inherited.PATH ?? ""}`,
    PACER_BIN: join(session.root, "bin/pacer"),
    PACER_HOME: join(session.root, "home"),
    PACER_PORT: String(session.port),
    PACER_BACKEND: "direct",
    PACER_NO_UPDATE_CHECK: "1",
    PACER_ORCA_USER_DATA: join(session.root, "orca-profile"),
    ...(session.seed === "ui" ? {
      HOME: join(session.root, "home"),
      PATH: `${join(session.root, "home/bin")}:${join(session.root, "bin")}:${inherited.PATH ?? ""}`,
      CODEX_HOME: join(session.root, "home/accounts/team"),
      CLAUDE_CONFIG_DIR: join(session.root, "home/.claude"),
      XDG_CONFIG_HOME: join(session.root, "home/.config"),
      XDG_DATA_HOME: join(session.root, "home/.local/share"),
    } : {}),
  };
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function environmentScript(session: Session): string {
  const env = sandboxEnv(session);
  return ["PATH", "PACER_BIN", "PACER_HOME", "PACER_PORT", "PACER_BACKEND", "PACER_NO_UPDATE_CHECK", "PACER_ORCA_USER_DATA", ...(session.frontDoor === "rust" ? ["PACER_CORE_ARGV"] : []), ...(session.seed === "ui" ? ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] : [])]
    .map(key => `export ${key}=${shellQuote(env[key]!)}`).join("\n") + "\n";
}
async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return port;
}
export async function freePort(reserve = reservePort): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = await reserve();
    if (Number.isInteger(port) && port > 0 && port <= 65535 && port !== 4317) return port;
  }
  throw Error("Could not select a non-default free port");
}
export function record(session: Session, entry: Omit<Evidence, "at">): void {
  appendFileSync(join(session.root, "evidence/log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}
export function readEvidence(session: Session): Evidence[] {
  const path = join(session.root, "evidence/log.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
const cell = (text = "") => text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
export function renderReport(session: Session, entries = readEvidence(session)): string {
  const notes = entries.filter(entry => entry.kind === "note" && entry.behavior);
  const rows = notes.length ? notes.map(entry => `| ${[entry.behavior, entry.surface ?? "UNVERIFIED", entry.steps ?? "See command evidence below", entry.text, entry.verdict ?? "UNVERIFIED"].map(value => cell(value)).join(" | ")} |`) : ["| No behavior recorded | UNVERIFIED | — | Add a note for each changed behavior and surface | UNVERIFIED |"];
  const counts = { PASS: 0, FAIL: 0, UNVERIFIED: 0 };
  for (const entry of notes) counts[entry.verdict ?? "UNVERIFIED"]++;
  if (!notes.length) counts.UNVERIFIED++;
  const details = entries.map(entry => {
    if (entry.kind === "command") return `### ${entry.at}: command (exit ${entry.code})\n\n${JSON.stringify(entry.argv)}\n\n<pre>${escapeHtml((entry.stdout ?? "") + (entry.stderr ?? ""))}</pre>`;
    return `- ${entry.at} ${entry.kind}: ${entry.text ?? ""}${entry.path ? ` (${entry.path})` : ""}`;
  });
  return `# Live validation: ${session.id}\n\nStarted: ${session.createdAt}\n\nSummary: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.UNVERIFIED} UNVERIFIED.\n\n| Behavior | Surface | Steps | Observed | Verdict |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Evidence\n\n${details.join("\n\n")}\n`;
}
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
export async function run(argv: string[], session: Session, evidence = true): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { cwd: join(session.root, "repo"), env: sandboxEnv(session), stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (evidence) record(session, { kind: "command", argv, code, stdout: truncate(stdout), stderr: truncate(stderr) });
  return { code, stdout, stderr };
}
function truncate(text: string): string {
  return text.length > 16000 ? text.slice(0, 16000) + "\n[truncated]" : text;
}
async function identity(port: number, pid: number, proxy = false): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${proxy ? "__live/health" : "health"}`, { signal: AbortSignal.timeout(500) });
    return response.ok && response.headers.get(proxy ? "x-pacer-live-proxy" : "x-pacer") === "1" && (await response.json()).pid === pid;
  } catch { return false; }
}
export async function healthy(session: Session): Promise<boolean> {
  if (session.stopped || !session.innerPort || !session.proxyPid) return false;
  const checks = await Promise.all([
    identity(session.port, session.proxyPid, true),
    identity(session.innerPort, session.pid),
    identity(session.port, session.pid),
  ]);
  return checks.every(Boolean);
}
export function launch(session: Session, argv: string[], logName: string, overrides: NodeJS.ProcessEnv = {}): number {
  const log = openSync(join(session.root, "logs", logName), "a", 0o600);
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd: join(session.root, "repo"), env: { ...sandboxEnv(session), ...overrides }, detached: true, stdio: ["ignore", log, log] });
    // Report asynchronous exec errors in the same log as startup failures.
    child.on("error", error => record(session, { kind: "note", text: `Launch failed: ${error.message}` }));
    child.unref();
    if (!child.pid) throw Error(`Could not launch ${argv[0]}`);
    return child.pid;
  } finally { closeSync(log); }
}
export async function up(id = `live-${Date.now()}`, template?: string, base = liveRoot, seed?: string, frontDoor?: string): Promise<Session> {
  validateSeed(seed);
  validateFrontDoor(frontDoor);
  if (frontDoor === "rust") {
    const build = Bun.spawnSync(["cargo", "build", "-q", "--locked", "-p", "pacer"], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw Error(`cargo build -p pacer failed:\n${build.stderr.toString().trim()}`);
  }
  const root = resolve(base, validId(id));
  const port = await freePort();
  let innerPort = await freePort();
  while (innerPort === port) innerPort = await freePort();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 }); // Refuse existing sessions, including stopped ones.
  const session: Session = { serviceSource: sourceFingerprint(checkout), id, root, port, innerPort, seed, ...(frontDoor === "rust" ? { frontDoor } : {}), pid: 1, createdAt: new Date().toISOString() };
  try {
    for (const dir of ["home", "bin", "repo", "logs", "evidence", "orca-profile"]) mkdirSync(join(root, dir), { mode: 0o700 });
    if (template) cpSync(resolve(template), join(root, "repo"), {
      recursive: true,
      filter: (source) => ![".git", ".work", "node_modules"].includes(basename(source)),
      dereference: true,
    });
    atomicWrite(join(root, "bin/pacer"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(checkout, "scripts/live/guard.ts"))} ${shellQuote(join(root, "session.json"))} "$@"\n`, 0o700);
    for (const manager of ["launchctl", "systemctl"]) atomicWrite(join(root, "bin", manager), "#!/bin/sh\necho 'Live validation D3: service manager refused' >&2\nexit 3\n", 0o700);
    // Only sandbox-owned config is created; never copy the user's strategy or credentials.
    atomicWrite(join(root, "home/strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {usage: quota}\nrouting:\n  - default: [codex]\n");
    if (seed === "ui") seedUi(root);
    saveSession(session);
    for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=Live validation", "-c", "user.email=live@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "Sandbox baseline"]]) {
      const result = await run(["git", ...args], session, false);
      if (result.code) throw Error(`Sandbox git setup failed: ${result.stderr}`);
    }
    atomicWrite(join(root, "env.sh"), environmentScript(session));
    session.pid = launch(session, [...pacerArgv(session), "serve", "--port", String(session.innerPort)], "serve.log");
    const serviceIdentity = processIdentity(session.pid);
    if (!serviceIdentity) throw Error("Could not prove launched sandbox process incarnation");
    session.serviceIdentity = serviceIdentity;
    saveSession(session);
    session.proxyPid = launch(session, [process.execPath, join(checkout, "scripts/live/proxy.ts"), join(root, "session.json")], "proxy.log");
    saveSession(session);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await healthy(session)) {
        record(session, { kind: "note", text: `Service ready on sandbox port ${session.port}` });
        return session;
      }
      await Bun.sleep(100);
    }
    throw Error(`Service startup timed out; inspect ${join(root, "logs/serve.log")}`);
  } catch (error) {
    if (session.proxyPid) stopProcess(session.proxyPid);
    if (session.pid > 1) stopProcess(session.pid);
    throw error;
  }
}
export function stopProcess(pid: number): void {
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
export async function down(session: Session, keep = false): Promise<void> {
  // OTA owns its own resource ledger; never remove it through generic sandbox teardown.
  if (existsSync(join(session.root, "ota"))) {
    const { cleanupOta } = await import("./ota");
    await cleanupOta(session.id, { base: dirname(session.root) });
  }
  // Verify each identity independently so teardown works if either process died.
  const processes = [
    { pid: session.proxyPid, port: session.port, proxy: true },
    { pid: session.pid, port: session.innerPort ?? session.port, proxy: false },
  ];
  for (const child of processes) {
    if (!child.pid) continue;
    if (await identity(child.port, child.pid, child.proxy)) {
      stopProcess(child.pid);
      for (let n = 0; n < 30 && await identity(child.port, child.pid, child.proxy); n++) await Bun.sleep(100);
      if (await identity(child.port, child.pid, child.proxy)) throw Error("Sandbox process did not stop; keeping sandbox for inspection");
    } else if (!session.stopped) {
      try {
        process.kill(child.pid, 0);
        throw Error("Sandbox PID is alive but its identity could not be verified; refusing to kill or remove sandbox");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  if (Bun.which("tmux")) {
    const target = `pacer-live-${session.id}`;
    const check = await run(["tmux", "has-session", "-t", target], session, false);
    if (!check.code) {
      const result = await run(["tmux", "kill-session", "-t", target], session);
      if (result.code) throw Error(result.stderr);
    }
  }
  if (session.desktopPid) {
    const { processIdentity, sameProcess } = await import("./control/lease");
    const current = await processIdentity(session.desktopPid);
    if (current) {
      if (!session.desktopIdentity || session.desktopIdentity.pid !== session.desktopPid || !await sameProcess(session.desktopIdentity)) {
        throw Error("Desktop identity could not be verified; refusing to signal or remove sandbox");
      }
      stopProcess(session.desktopPid);
    }
  }
  session.stopped = true;
  saveSession(session);
  record(session, { kind: "note", text: "Sandbox stopped" });
  if (!keep) rmSync(session.root, { recursive: true });
}
