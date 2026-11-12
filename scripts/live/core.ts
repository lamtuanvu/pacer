import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { LOCAL_SERVERS } from "../../src/endpoints/detect";

import { captureOwnedProcessGroup, stopOwnedProcessGroup, validOwnedProcessGroup, type OwnedProcessGroup } from "./process-group";
import { sourceFingerprint, type SourceFingerprint } from "./control/fingerprint";
import { seedPluginRemove, seedUi, validateSeed } from "./seed";
import { deleteSandboxKeychainItems, prepareKeychain } from "./keychain";
import { processIdentity, signalSameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { controlDirPath } from "../../src/remote/ssh";

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
  proxyIdentity?: ProcessIdentity;
  serviceGroup?: OwnedProcessGroup;
  proxyGroup?: OwnedProcessGroup;
  modelProbeSandbox?: boolean;
  modelFixturePid?: number;
  modelFixtureGroup?: OwnedProcessGroup;
  waitingPid?: number;
  waitingGroup?: OwnedProcessGroup;
  waitingFixture?: true;
  createdAt: string;
  seed?: "ui" | "plugin-remove";
  /** "rust": the Rust front door (target/debug/pacer) serves and dispatches, forwarding to the TypeScript core. */
  frontDoor?: "rust";
  /** The disposable Rust front door includes test-only native operations. */
  nativeTestOps?: true;
  nativeForwardEcho?: true;
  /** The service runs with `PACER_NATIVE_PLUGIN_HOST=1`, so it owns plugin processes on `run/host.sock`. */
  nativePluginHost?: true;
  /** Test-ops fixtures: local model server ports (`<ollama>,<lmstudio>`), a `test/fixtures` Core entry and forwarded ops. */
  localModelPorts?: string;
  localModelFixture?: string;
  coreFixture?: string;
  nativeForwardOps?: string;
  /** The sandbox uses the login Keychain instead of the `security` stub; `down` deletes its identity items. */
  realKeychain?: true;
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
  for (const [identity, pid] of [[session.serviceIdentity, session.pid], [session.proxyIdentity, session.proxyPid]] as const) {
    if (identity && (identity.pid !== pid || !identity.bootId || !identity.birth)) throw Error("Invalid live source process identity");
  }
  for (const [group, pid] of [[session.serviceGroup, session.pid], [session.proxyGroup, session.proxyPid], [session.modelFixtureGroup, session.modelFixturePid], [session.waitingGroup, session.waitingPid]] as const) {
    if (group !== undefined && (pid === undefined || !validOwnedProcessGroup(group, pid))) throw Error("Invalid live process-group identity");
  }
  return session;
}
/** The checkout CLI the sandbox runs: the TypeScript core, or the Rust front door in front of it. */
export function pacerArgv(session: Pick<Session, "frontDoor"> & Partial<Pick<Session, "root" | "nativeTestOps">>): string[] {
  if (session.frontDoor === "rust") {
    return [session.nativeTestOps && session.root ? join(session.root, "bin/native-pacer") : join(process.env.CARGO_TARGET_DIR ?? join(checkout, "target"), "debug/pacer")];
  }
  return [process.execPath, join(checkout, "src/cli.ts")];
}
export function sourceServiceMatchesExecutable(observed: string | null, session: Pick<Session, "frontDoor">, canonicalize: (path: string) => string = realpathSync): boolean {
  return observed !== null && observed === canonicalize(pacerArgv(session)[0]);
}
export function validateFrontDoor(frontDoor: string | undefined): void {
  if (frontDoor !== undefined && frontDoor !== "rust") throw Error(`Unknown front door: ${frontDoor} (expected rust)`);
}
/** Inherited PACER_* settings that only change presentation or diagnostics, never identity or authority. */
export const SANDBOX_PASSTHROUGH = ["PACER_THEME", "PACER_COLOR", "PACER_ASCII", "PACER_PLAIN", "PACER_NO_ANIM", "PACER_LOGIN_ENV", "PACER_TRACE_STATUS"];
export function sandboxEnv(session: Session, inherited = process.env): NodeJS.ProcessEnv {
  // The sandbox sets every PACER_* value it needs. Other inherited ones, such as an executor's
  // PACER_ROLE, task id, work grant or tokens, would make the sandbox act as that session, so they
  // are dropped unless they are display or diagnostic settings. PACER (no underscore, e.g. PACER=off)
  // is policy rather than identity and is intentionally kept.
  const outside = Object.fromEntries(Object.entries(inherited).filter(([key]) => (!key.startsWith("PACER_") || SANDBOX_PASSTHROUGH.includes(key)) && !(session.waitingFixture && ["CODEX_THREAD_ID", "CODEX_SANDBOX"].includes(key))));
  return {
    ...outside,
    ...(session.frontDoor === "rust" ? { PACER_CORE_ARGV: JSON.stringify([process.execPath, join(checkout, session.coreFixture ? `test/fixtures/${session.coreFixture}` : "src/cli.ts")]) } : {}),
    ...(session.nativeTestOps ? { PACER_DEBUG_NATIVE: "1" } : {}),
    ...(session.nativeForwardEcho ? { PACER_FORWARD_OPS: "test.echo" } : {}),
    ...(session.nativeForwardOps ? { PACER_FORWARD_OPS: session.nativeForwardOps } : {}),
    ...(session.nativePluginHost ? { PACER_NATIVE_PLUGIN_HOST: "1" } : {}),
    ...(session.localModelPorts ? { PACER_TEST_LOCAL_SERVER_PORTS: session.localModelPorts } : {}),
    PATH: `${join(session.root, "bin")}:${inherited.PATH ?? ""}`,
    PACER_BIN: join(session.root, "bin/pacer"),
    PACER_HOME: join(session.root, "home"),
    PACER_PORT: String(session.port),
    PACER_BACKEND: "direct",
    PACER_NO_UPDATE_CHECK: "1",
    PACER_ORCA_USER_DATA: join(session.root, "orca-profile"),
    ...(session.seed ? {
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
  return ["PATH", "PACER_BIN", "PACER_HOME", "PACER_PORT", "PACER_BACKEND", "PACER_NO_UPDATE_CHECK", "PACER_ORCA_USER_DATA", ...(session.frontDoor === "rust" ? ["PACER_CORE_ARGV"] : []),
    ...(session.nativeForwardOps ? ["PACER_FORWARD_OPS"] : []), ...(session.nativePluginHost ? ["PACER_NATIVE_PLUGIN_HOST"] : []), ...(session.localModelPorts ? ["PACER_TEST_LOCAL_SERVER_PORTS"] : []), ...(session.seed ? ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] : [])]
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
/** SSH aliases the sandbox fake answers for; `.invalid` never resolves (RFC 2606) should a real ssh ever run. */
export const FAKE_SSH_ALIAS = "pacer-live-fake.invalid";
export const FAKE_SSH_DOWN_ALIAS = "pacer-live-down.invalid";
export const fakeHostHome = (root: string) => join(root, "fake-host/home");
export const fakeSshLog = (root: string) => join(root, "fake-host/ssh.log");
export const FAKE_SSH_FIXTURE = join(checkout, "test/fixtures/bin/ssh");
/**
 * The sandbox `ssh`: test/fixtures/bin/ssh, which runs the remote program locally with HOME set to the
 * fake host home. Plugin children get a minimal environment, so the fixture variables are fixed here.
 */
export function fakeSshScript(root: string, fixture = FAKE_SSH_FIXTURE): string {
  return `#!/bin/sh\nPACER_FAKE_HOST_HOME=${shellQuote(fakeHostHome(root))}\nPACER_FAKE_SSH_LOG=${shellQuote(fakeSshLog(root))}\nPACER_FAKE_SSH_DOWN=${shellQuote(FAKE_SSH_DOWN_ALIAS)}\nexport PACER_FAKE_HOST_HOME PACER_FAKE_SSH_LOG PACER_FAKE_SSH_DOWN\nexec /bin/sh ${shellQuote(fixture)} "$@"\n`;
}
export function installFakeSsh(root: string, fixture = FAKE_SSH_FIXTURE): void {
  mkdirSync(fakeHostHome(root), { recursive: true, mode: 0o700 });
  atomicWrite(join(root, "bin/ssh"), fakeSshScript(root, fixture), 0o700);
}
/** Throws unless `ssh` on the sandbox PATH is exactly the sandbox fake, so no host check can reach a real host. */
export function verifyFakeSsh(session: Session, which: (bin: string, options: { PATH: string }) => string | null = Bun.which, fixture = FAKE_SSH_FIXTURE): string {
  const path = join(session.root, "bin/ssh");
  const refuse = (reason: string): never => { throw Error(`Fake ssh check failed: ${reason}; refusing to run host checks`); };
  const resolved = which("ssh", { PATH: sandboxEnv(session).PATH ?? "" });
  if (resolved !== path) refuse(`sandbox PATH resolves ssh to ${resolved ?? "nothing"}, not ${path}`);
  let stat;
  try { stat = lstatSync(path); } catch { return refuse(`${path} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) refuse(`${path} is not a private regular file`);
  if (readFileSync(path, "utf8") !== fakeSshScript(session.root, fixture)) refuse(`${path} is not the sandbox fake`);
  if (!existsSync(fixture)) refuse(`${fixture} is missing`);
  return path;
}
/**
 * A sandbox's PACER_HOME is too long for socket paths, so pacer keeps its ssh control sockets in a `/tmp`
 * directory derived from that home. Remove only that exact directory, and only when it is ours.
 */
export function removeSshControlDir(root: string): void {
  const { dir, short } = controlDirPath(join(root, "home"));
  if (!short) return;
  let entry;
  try { entry = lstatSync(dir); } catch { return; }
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) return;
  rmSync(dir, { recursive: true });
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
export type NativeFixtures = Pick<Session, "localModelPorts" | "localModelFixture" | "coreFixture" | "nativeForwardOps">;
export function validateNativeFixtures(fixtures: NativeFixtures, nativeTestOps: boolean, nativeForwardEcho: boolean): void {
  const { localModelPorts, localModelFixture, coreFixture, nativeForwardOps } = fixtures;
  if ((localModelPorts ?? localModelFixture ?? coreFixture ?? nativeForwardOps) !== undefined && !nativeTestOps) throw Error("--local-model-ports, --core-fixture and --native-forward-ops require --native-test-ops");
  if (localModelPorts !== undefined && !(/^\d{1,5},\d{1,5}$/.test(localModelPorts) && localModelPorts.split(",").map(Number).every(port => port > 0 && port <= 65535 && ![4317, ...LOCAL_SERVERS.map(server => server.port)].includes(port)) && new Set(localModelPorts.split(",").map(Number)).size === 2)) throw Error("--local-model-ports requires two distinct non-default ports (excluding 4317 and local model defaults)");
  if (localModelFixture !== undefined && (!localModelPorts || !/^ollama=(ok|fail(?::\d{1,4})?),lmstudio=(ok|fail(?::\d{1,4})?)$/.test(localModelFixture))) throw Error("--local-model-fixture requires --local-model-ports and ollama=ok|fail[:ms],lmstudio=ok|fail[:ms]");
  if (coreFixture !== undefined && !(/^[a-z0-9][a-z0-9-]*\.ts$/.test(coreFixture) && existsSync(join(checkout, "test/fixtures", coreFixture)))) throw Error("--core-fixture must name a .ts file in test/fixtures");
  if (nativeForwardOps !== undefined && (nativeForwardEcho || !/^[a-z0-9.*_-]+(,[a-z0-9.*_-]+)*$/i.test(nativeForwardOps))) throw Error("--native-forward-ops must be a comma-separated op list and cannot be combined with --native-forward-echo");
}
export async function up(id = `live-${Date.now()}`, template?: string, base = liveRoot, seed?: string, frontDoor?: string, realKeychain = false, nativeTestOps = false, nativeForwardEcho = false, fixtures: NativeFixtures = {}, waitingFixture = false, nativePluginHost = false): Promise<Session> {
  validateSeed(seed);
  validateFrontDoor(frontDoor);
  if (nativeTestOps && frontDoor !== "rust") throw Error("--native-test-ops requires --front-door rust");
  if (nativeForwardEcho && !nativeTestOps) throw Error("--native-forward-echo requires --native-test-ops");
  if (nativePluginHost && frontDoor !== "rust") throw Error("--native-plugin-host requires --front-door rust");
  validateNativeFixtures(fixtures, nativeTestOps, nativeForwardEcho);
  if (frontDoor === "rust") {
    const build = Bun.spawnSync(["cargo", "build", "-q", "--locked", "-p", "pacer", ...(nativeTestOps ? ["--features", "test-ops"] : [])], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw Error(`cargo build -p pacer failed:\n${build.stderr.toString().trim()}`);
  }
  const root = resolve(base, validId(id));
  const port = await freePort();
  let innerPort = await freePort();
  while (innerPort === port) innerPort = await freePort();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 }); // Refuse existing sessions, including stopped ones.
  const session: Session = { serviceSource: sourceFingerprint(checkout), id, root, port, innerPort, seed, ...(frontDoor === "rust" ? { frontDoor } : {}), ...(nativeTestOps ? { nativeTestOps: true as const } : {}), ...(waitingFixture ? { waitingFixture: true as const } : {}), ...(nativeForwardEcho ? { nativeForwardEcho: true as const } : {}), ...(nativePluginHost ? { nativePluginHost: true as const } : {}), ...Object.fromEntries(Object.entries(fixtures).filter(([, value]) => value !== undefined)), ...(realKeychain ? { realKeychain: true as const } : {}), pid: 1, createdAt: new Date().toISOString() };
  try {
    for (const dir of ["home", "bin", "repo", "logs", "evidence", "orca-profile"]) mkdirSync(join(root, dir), { mode: 0o700 });
    if (nativeTestOps) cpSync(join(process.env.CARGO_TARGET_DIR ?? join(checkout, "target"), "debug/pacer"), join(root, "bin/native-pacer"));
    if (template) cpSync(resolve(template), join(root, "repo"), {
      recursive: true,
      filter: (source) => ![".git", ".work", "node_modules"].includes(basename(source)),
      dereference: true,
    });
    atomicWrite(join(root, "bin/pacer"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(checkout, "scripts/live/guard.ts"))} ${shellQuote(join(root, "session.json"))} "$@"\n`, 0o700);
    for (const manager of ["launchctl", "systemctl"]) atomicWrite(join(root, "bin", manager), "#!/bin/sh\necho 'Live validation D3: service manager refused' >&2\nexit 3\n", 0o700);
    // The machine identity lives in the login Keychain on macOS; sandboxes use a stub unless --real-keychain.
    prepareKeychain(session);
    // Remote host checks reach only a fake host home inside the sandbox; there is no real-ssh option.
    installFakeSsh(root);
    // Only sandbox-owned config is created; never copy the user's strategy or credentials.
    atomicWrite(join(root, "home/strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {usage: quota}\nrouting:\n  - default: [codex]\n");
    if (waitingFixture) atomicWrite(join(root, "home/strategy.yaml"), JSON.stringify({ planner: "codex#fixture", accounts: { fixture: { kind: "codex", home: join(root, "home/accounts/fixture"), usage: "quota" } }, runners: { "codex#fixture": {} }, routing: [{ default: ["codex#fixture"] }], messaging: { rules: [{ effect: "allow", relation: "any" }] } }));
    if (seed === "ui") seedUi(root);
    if (seed === "plugin-remove") seedPluginRemove(root);
    saveSession(session);
    if (session.localModelPorts) {
      session.modelFixturePid = launch(session, [process.execPath, join(checkout, "scripts/live/model-port-fixture.ts"), session.localModelPorts, join(root, "model-fixture-ready"), session.localModelFixture ?? "ollama=fail,lmstudio=fail"], "model-fixture.log");
      const identity = processIdentity(session.modelFixturePid);
      if (!identity) throw Error("Cannot identify local model fixture process");
      session.modelFixtureGroup = captureOwnedProcessGroup(session.modelFixturePid, identity);
      saveSession(session);
      const deadline = Date.now() + 3000;
      while (!existsSync(join(root, "model-fixture-ready")) && !existsSync(join(root, "model-fixture-ready.error")) && Date.now() < deadline && processIdentity(session.modelFixturePid)) await Bun.sleep(25);
      if (!existsSync(join(root, "model-fixture-ready"))) throw Error("--local-model-ports could not bind fixture ports; a port may already be listening (see model-fixture.log)");
    }
    for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=Live validation", "-c", "user.email=live@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "Sandbox baseline"]]) {
      const result = await run(["git", ...args], session, false);
      if (result.code) throw Error(`Sandbox git setup failed: ${result.stderr}`);
    }
    atomicWrite(join(root, "env.sh"), environmentScript(session));
    if (session.localModelPorts) session.modelProbeSandbox = process.platform === "darwin";
    session.pid = launch(session, serviceArgv(session), "serve.log");
    saveSession(session);
    const serviceIdentity = processIdentity(session.pid);
    if (!serviceIdentity) throw Error("Could not prove launched sandbox process incarnation");
    session.serviceIdentity = serviceIdentity;
    saveSession(session);
    session.serviceGroup = captureOwnedProcessGroup(session.pid, serviceIdentity);
    saveSession(session);
    session.proxyPid = launch(session, [process.execPath, join(checkout, "scripts/live/proxy.ts"), join(root, "session.json")], "proxy.log");
    saveSession(session);
    const proxyIdentity = processIdentity(session.proxyPid);
    if (!proxyIdentity) throw Error("Could not prove launched sandbox proxy incarnation");
    session.proxyIdentity = proxyIdentity;
    saveSession(session);
    session.proxyGroup = captureOwnedProcessGroup(session.proxyPid, proxyIdentity);
    saveSession(session);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await healthy(session)) {
    if (waitingFixture) {
      session.waitingPid = launch(session, [process.execPath, join(checkout, "scripts/live/waiting-session.ts")], "waiting.log", { HOME: join(root, "home") });
      saveSession(session);
      session.waitingGroup = captureOwnedProcessGroup(session.waitingPid);
      saveSession(session);
      const deadline = Date.now() + 8000;
      while (!existsSync(join(root, "home/waiting-fixtures.json")) && Date.now() < deadline) await Bun.sleep(50);
      if (!existsSync(join(root, "home/waiting-fixtures.json"))) throw Error("Waiting fixture startup timed out; inspect logs/waiting.log");
    }
        record(session, { kind: "note", text: `Service ready on sandbox port ${session.port}` });
        return session;
      }
      await Bun.sleep(100);
    }
    throw Error(`Service startup timed out; inspect ${join(root, "logs/serve.log")}`);
  } catch (error) {
    const failures: unknown[] = [];
    for (const [name, pid, identity, group] of [
      ["proxy", session.proxyPid, session.proxyIdentity, session.proxyGroup],
      ["service", session.pid, session.serviceIdentity, session.serviceGroup],
      ["model fixture", session.modelFixturePid, session.modelFixtureGroup?.leader, session.modelFixtureGroup],
      ["waiting fixture", session.waitingPid, session.waitingGroup?.leader, session.waitingGroup],
    ] as const) {
      if (!pid || pid <= 1) continue;
      try {
        if (group) {
          await stopOwnedProcessGroup(group);
          record(session, { kind: "note", text: `Startup cleanup stopped verified ${name} group` });
        } else {
          if (!identity || !signalSameProcess(identity, "SIGTERM")) throw Error(`Cannot verify ${name} leader for startup cleanup`);
          record(session, { kind: "note", text: `Startup cleanup signalled verified leader only (${name}); group ownership unavailable, keeping sandbox` });
        }
        saveSession(session);
      } catch (cleanupError) {
        failures.push(cleanupError);
        try {
          record(session, { kind: "note", text: `${name} startup cleanup failed: ${String(cleanupError)}; keeping sandbox` });
          saveSession(session);
        } catch (recordError) { failures.push(recordError); }
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], `Sandbox startup failed: ${String(error)}; cleanup incomplete, keeping sandbox`);
    throw error;
  }
}
function serviceArgv(session: Session): string[] {
  const argv = [...pacerArgv(session), "serve", "--port", String(session.innerPort)];
  if (!session.modelProbeSandbox) return argv;
  return ["/usr/bin/sandbox-exec", "-p", '(version 1)(allow default)(deny network-outbound (remote tcp "localhost:4317") (remote tcp "localhost:11434") (remote tcp "localhost:1234") (remote tcp "*:4317") (remote tcp "*:11434") (remote tcp "*:1234"))', ...argv];
}
/** Stop the sandbox service and wait until every process in its group has exited; the proxy stays up. */
export async function stopService(session: Session): Promise<void> {
  if (!session.serviceGroup || !validOwnedProcessGroup(session.serviceGroup, session.pid)) throw Error("Sandbox has no verified service process group; refusing to signal");
  await stopOwnedProcessGroup(session.serviceGroup);
  saveSession(session);
  record(session, { kind: "note", text: `Service ${session.pid} stopped; its process group exited` });
}
/** Start the sandbox service again on its inner port, after `stopService`. */
export async function startService(session: Session): Promise<void> {
  if (!session.serviceGroup?.stopped) throw Error("The sandbox service must stop before it starts again");
  session.pid = launch(session, serviceArgv(session), "serve.log");
  const serviceIdentity = processIdentity(session.pid);
  if (!serviceIdentity) throw Error("Could not prove launched sandbox process incarnation");
  session.serviceIdentity = serviceIdentity;
  session.serviceGroup = captureOwnedProcessGroup(session.pid, serviceIdentity);
  saveSession(session);
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await Bun.sleep(100)) {
    if (await healthy(session)) {
      record(session, { kind: "note", text: `Service ${session.pid} started again on sandbox port ${session.port}` });
      return;
    }
  }
  throw Error(`Service restart timed out; inspect ${join(session.root, "logs/serve.log")}`);
}
export function stopProcess(pid: number): void {
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
export async function down(session: Session, keep = false): Promise<void> {
  if (session.stopped && !existsSync(session.root)) return;
  // OTA owns its own resource ledger; never remove it through generic sandbox teardown.
  if (existsSync(join(session.root, "ota"))) {
    const { cleanupOta } = await import("./ota");
    await cleanupOta(session.id, { base: dirname(session.root) });
  }
  // A closed HTTP listener does not mean history/plugin descendants have stopped.
  // Group ownership is persisted at launch, before a leader can disappear or be reused.
  for (const [pid, group] of [[session.proxyPid, session.proxyGroup], [session.pid, session.serviceGroup], [session.modelFixturePid, session.modelFixtureGroup], [session.waitingPid, session.waitingGroup]] as const) {
    if (!pid) continue;
    if (!group || !validOwnedProcessGroup(group, pid)) {
      throw Error("Sandbox has no verified process-group identity; refusing to signal or remove sandbox");
    }
    await stopOwnedProcessGroup(group);
    saveSession(session);
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
  if (session.realKeychain) {
    const deleted = await deleteSandboxKeychainItems(session.root);
    record(session, { kind: "note", text: `Deleted ${deleted.length} sandbox Keychain item(s): ${deleted.join(", ") || "none"}` });
  }
  removeSshControlDir(session.root);
  session.stopped = true;
  saveSession(session);
  record(session, { kind: "note", text: "Sandbox stopped" });
  if (!keep) rmSync(session.root, { recursive: true });
}
