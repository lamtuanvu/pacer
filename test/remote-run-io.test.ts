import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { RemoteRunIO } from "../src/remote/run-io";
import { publishSessionFiles, recoverSessionFiles, type SessionFilesSnapshot } from "../src/remote/session-files";
import { Unreachable, type RunIO } from "../src/supervisor/io";
import { readRun, type RunState } from "../src/supervisor/run";
import { supervise } from "../src/supervisor/supervise";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { issueConfiguredHostReport, consumeConfiguredHostReport } from "../src/plugins/host-report-issuer";
import { issueConfiguredHostSessionFiles, consumeConfiguredHostSessionFiles } from "../src/plugins/host-session-files-issuer";
import { issueConfiguredHostReadFrom, consumeConfiguredHostReadFrom } from "../src/plugins/host-read-from-issuer";
import { issueConfiguredHostSessionSocket, consumeConfiguredHostSessionSocket } from "../src/plugins/host-session-socket-issuer";
import { issueConfiguredHostBinaryCheck, consumeConfiguredHostBinaryCheck } from "../src/plugins/host-binary-check-issuer";
import { issueConfiguredHostBinaryUpload, consumeConfiguredHostBinaryUpload } from "../src/plugins/host-binary-upload-issuer";
import { issueConfiguredHostStart, consumeConfiguredHostStart } from "../src/plugins/host-start-issuer";
import { issueConfiguredHostRuntimeProbe, consumeConfiguredHostRuntimeProbe } from "../src/plugins/host-runtime-probe-issuer";
import { pluginRegistry } from "../src/plugins";

const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };
function setup() {
  const home = tmpDir(), local = tmpDir(), log = join(tmpDir(), "ssh.log");
  writeFileSync(join(home, ".bash_profile"), 'echo hello from profile\nexport PATH="$HOME/bin:$PATH"\n');
  const env = fakeSshEnv(home, log);
  const bin = join(home, "bin"); mkdirSync(bin, { recursive: true });
  const ssh = join(bin, "ssh");
  const downFile = join(home, "down.txt"); writeFileSync(downFile, "");
  writeFileSync(ssh, `#!/bin/sh\nPACER_FAKE_HOST_HOME=${JSON.stringify(home)} PACER_FAKE_SSH_LOG=${JSON.stringify(log)} PACER_FAKE_SSH_DOWN="$(cat ${JSON.stringify(downFile)})"; export PACER_FAKE_HOST_HOME PACER_FAKE_SSH_LOG PACER_FAKE_SSH_DOWN\nexec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"\n`, { mode: 0o755 });
  env.PATH = `${bin}:${env.PATH}`;
  // macOS has no setsid utility; provide the same session semantics on the fake host.
  if (!Bun.which("setsid")) {
    const bin = join(home, "bin"); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "setsid"), `#!${Bun.which("python3")}\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
  }
  if (Bun.which("gtail")) {
    const bin=join(home,"bin");mkdirSync(bin,{recursive:true});
    symlinkSync(Bun.which("gtail")!,join(bin,"tail"));
    env.PATH=`${bin}:${env.PATH}`;
  }
  const ctx = fakeCtx({ env: { ...process.env, ...env }, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env, ...o?.env } }),
    which: name => name === "ssh" ? ssh : null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: box-ssh\n");
  const task = createTask(ctx, { brief: { goal: "remote fixture", repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const remote = join(home, ".pacer-remote", "runs", task.id, "1");
  updateTask(ctx, task.id, record => { record.state = "running";
    record.run = { host: "box", mode: "new", remoteDir: remote, remoteWorktree: home,
      workdir: home, dir: local, attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" }; });
  return { io: new RemoteRunIO(ctx, host, remote, local), home, remote, local, log, ctx,
    setDown: (value: string) => writeFileSync(downFile, value) };
}

function enableFull(ctx: ReturnType<typeof setup>["ctx"]) {
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: box-ssh\n    session: full\n");
}

test("REPORT grants are one-use and bind the persisted run snapshot", async () => {
  const { ctx, remote, local } = setup();
  await expect(pluginRegistry(ctx).call(ctx, "pacer-ssh", "hostRunner.run", {
    session: "a".repeat(32), script: "REPORT", args: [remote], timeoutMs: 60_000, maxBytes: 65_536,
  })).rejects.toMatchObject({ code: "capability_denied" });
  const grant = issueConfiguredHostReport(ctx, "box", remote, local);
  consumeConfiguredHostReport(ctx, grant);
  expect(() => consumeConfiguredHostReport(ctx, grant)).toThrow();
  const stale = issueConfiguredHostReport(ctx, "box", remote, local);
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  expect(() => consumeConfiguredHostReport(ctx, stale)).toThrow();
  expect(() => issueConfiguredHostReport(ctx, "box", remote, join(local, "other"))).toThrow();
});

test("disabled SSH provider leaves REPORT unreachable without direct SSH fallback", async () => {
  const { ctx, io, log } = setup();
  await pluginRegistry(ctx).disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  await expect(io.read()).rejects.toBeInstanceOf(Unreachable);
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("SESSION_FILES metadata grant binds one persisted full-session run", async () => {
  const { ctx, remote, local } = setup();
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: box-ssh\n    session: full\n");
  await expect(pluginRegistry(ctx).call(ctx, "pacer-ssh", "hostRunner.run", {
    session: "a".repeat(32), script: "SESSION_FILES", args: [remote], timeoutMs: 60_000, maxBytes: 16_384,
  })).rejects.toMatchObject({ code: "capability_denied" });
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.log"), "recording");
  const grant = issueConfiguredHostSessionFiles(ctx, "box", remote, local);
  const result = await pluginRegistry(ctx).sessionFilesConfiguredHost(ctx, grant);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("session.log.bytes=9\n");
  expect(() => consumeConfiguredHostSessionFiles(ctx, grant)).toThrow();
  const stale = issueConfiguredHostSessionFiles(ctx, "box", remote, local);
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  expect(() => consumeConfiguredHostSessionFiles(ctx, stale)).toThrow();
  expect(() => issueConfiguredHostSessionFiles(ctx, "box", remote, join(local, "wrong"))).toThrow();
});

test("SESSION_FILES and recording ranges require full-session host and bundled provider", async () => {
  const { ctx, remote, local, log } = setup();
  expect(() => issueConfiguredHostSessionFiles(ctx, "box", remote, local)).toThrow();
  expect(() => issueConfiguredHostReadFrom(ctx, "box", remote, local, "session.log" as never, 0, 1)).toThrow();
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: box-ssh\n    session: full\n");
  const grant = issueConfiguredHostSessionFiles(ctx, "box", remote, local);
  await pluginRegistry(ctx).disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  await expect(pluginRegistry(ctx).sessionFilesConfiguredHost(ctx, grant)).rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("READ_FROM pages only fixed recording names for a persisted full-session run", async () => {
  const { ctx, remote, local } = setup();
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: box-ssh\n    session: full\n");
  mkdirSync(remote, { recursive: true });
  for (const name of ["session.log", "session.log.1", "session.ckpt", "session.state"] as const) {
    writeFileSync(join(remote, name), name);
    const grant = issueConfiguredHostReadFrom(ctx, "box", remote, local, name, 0, 262_144);
    const result = await pluginRegistry(ctx).readFromConfiguredHost(ctx, grant);
    expect(Buffer.from(result.stdout, "hex").toString()).toBe(name);
  }
  expect(() => issueConfiguredHostReadFrom(ctx, "box", remote, local, "session.sock.path" as never, 0, 1)).toThrow();
});

test("READ_FROM grants bind one persisted stream range and preserve the 256 KiB binary chunk", async () => {
  const { ctx, remote, local } = setup();
  mkdirSync(remote, { recursive: true });
  const bytes = randomBytes(262_144);
  writeFileSync(join(remote, "stdout"), bytes);
  await expect(pluginRegistry(ctx).call(ctx, "pacer-ssh", "hostRunner.run", {
    session: "a".repeat(32), script: "READ_FROM", args: [remote, "stdout", "0", "262144", "hex"],
    timeoutMs: 60_000, maxBytes: 524_288,
  })).rejects.toMatchObject({ code: "capability_denied" });
  const grant = issueConfiguredHostReadFrom(ctx, "box", remote, local, "stdout", 0, 262_144);
  const result = await pluginRegistry(ctx).readFromConfiguredHost(ctx, grant);
  expect(result.code).toBe(0);
  expect(Buffer.from(result.stdout, "hex")).toEqual(bytes);
  await expect(pluginRegistry(ctx).readFromConfiguredHost(ctx, grant))
    .rejects.toMatchObject({ code: "capability_denied" });
  const stale = issueConfiguredHostReadFrom(ctx, "box", remote, local, "stdout", 1, 1);
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  expect(() => consumeConfiguredHostReadFrom(ctx, stale)).toThrow();
  expect(() => issueConfiguredHostReadFrom(ctx, "box", remote, local, "../../secret" as never, 0, 1)).toThrow();
  expect(() => issueConfiguredHostReadFrom(ctx, "box", remote, local, "stdout", 0, 262_145)).toThrow();
}, 30000);

test("disabled SSH provider refuses READ_FROM without direct SSH fallback", async () => {
  const { ctx, remote, local, log } = setup();
  const registry = pluginRegistry(ctx);
  await registry.disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const grant = issueConfiguredHostReadFrom(ctx, "box", remote, local, "stderr", 0, 1);
  await expect(registry.readFromConfiguredHost(ctx, grant)).rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("READ_FROM refuses malformed or over-range provider hex", async () => {
  const { ctx, remote, local, home } = setup();
  const ssh = join(home, "bin", "ssh"), registry = pluginRegistry(ctx);
  for (const hex of ["a0z", "a0a0"]) {
    writeFileSync(ssh, `#!/bin/sh\nprintf '__PACER_BEGIN__\\n${hex}'\n`, { mode: 0o755 });
    const grant = issueConfiguredHostReadFrom(ctx, "box", remote, local, "stdout", 0, 1);
    await expect(registry.readFromConfiguredHost(ctx, grant)).rejects.toMatchObject({ code: "plugin_refused" });
  }
});

test("SESSION_SOCKET discovers only the configured persisted run and consumes its grant once", async () => {
  const { ctx, remote, local } = setup();
  const { createServer } = await import("node:net");
  const { socketPath } = await import("../src/session/host");
  const path = socketPath(remote), server = createServer();
  mkdirSync(remote, { recursive: true });
  if (path !== join(remote, "session.sock")) writeFileSync(join(remote, "session.sock.path"), path);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    await expect(pluginRegistry(ctx).call(ctx, "pacer-ssh", "hostRunner.run", {
      session: "a".repeat(32), script: "SESSION_SOCKET", args: [remote], timeoutMs: 60_000, maxBytes: 4096,
    })).rejects.toMatchObject({ code: "capability_denied" });
    const grant = issueConfiguredHostSessionSocket(ctx, "box", remote, local);
    const result = await pluginRegistry(ctx).sessionSocketConfiguredHost(ctx, grant);
    expect(result).toMatchObject({ code: 0, stdout: path, timedOut: false });
    await expect(pluginRegistry(ctx).sessionSocketConfiguredHost(ctx, grant))
      .rejects.toMatchObject({ code: "capability_denied" });
    const stale = issueConfiguredHostSessionSocket(ctx, "box", remote, local);
    const taskId = remote.split("/").at(-2)!;
    updateTask(ctx, taskId, task => { task.state = "queued"; });
    expect(() => consumeConfiguredHostSessionSocket(ctx, stale)).toThrow();
    expect(() => issueConfiguredHostSessionSocket(ctx, "box", remote, join(local, "wrong"))).toThrow();
  } finally { server.close(); }
});

test("disabled SSH provider refuses SESSION_SOCKET without a direct fallback", async () => {
  const { ctx, remote, local, log } = setup();
  const { RemoteSession } = await import("../src/remote/session");
  const { Duplex } = await import("node:stream");
  const registry = pluginRegistry(ctx);
  await registry.disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const grant = issueConfiguredHostSessionSocket(ctx, "box", remote, local);
  await expect(registry.sessionSocketConfiguredHost(ctx, grant)).rejects.toMatchObject({ code: "plugin_unavailable" });
  const bridge = new RemoteSession(ctx, host, remote, local);
  const socket = new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const closed = new Promise<void>(resolve => socket.once("close", resolve));
  bridge.accept(socket as unknown as import("node:net").Socket);
  await closed;
  await bridge.close();
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("BINARY check is issued only for one persisted run and exact content hash", async () => {
  const { ctx, home, remote, local } = setup();
  const hash = "a".repeat(64);
  await expect(pluginRegistry(ctx).call(ctx, "pacer-ssh", "hostRunner.run", {
    session: "a".repeat(32), script: "BINARY", args: [hash, "check"], timeoutMs: 60_000, maxBytes: 4096,
  })).rejects.toMatchObject({ code: "capability_denied" });
  const grant = issueConfiguredHostBinaryCheck(ctx, "box", remote, local, hash);
  consumeConfiguredHostBinaryCheck(ctx, grant);
  expect(() => consumeConfiguredHostBinaryCheck(ctx, grant)).toThrow();
  const stale = issueConfiguredHostBinaryCheck(ctx, "box", remote, local, hash);
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  expect(() => consumeConfiguredHostBinaryCheck(ctx, stale)).toThrow();
  expect(() => issueConfiguredHostBinaryCheck(ctx, "box", remote, local, "bad")).toThrow();
  expect(() => issueConfiguredHostBinaryCheck(ctx, "box", remote, join(home, "wrong"), hash)).toThrow();
});

test("runtime PROBE is one-use and bound to the persisted run", async () => {
  const { ctx, home, remote, local } = setup();
  await expect(pluginRegistry(ctx).call(ctx, "pacer-ssh", "hostRunner.run", {
    session: "a".repeat(32), script: "PROBE", args: [], timeoutMs: 60_000, maxBytes: 4096,
  })).rejects.toMatchObject({ code: "capability_denied" });
  const grant = issueConfiguredHostRuntimeProbe(ctx, "box", remote, local);
  consumeConfiguredHostRuntimeProbe(ctx, grant);
  expect(() => consumeConfiguredHostRuntimeProbe(ctx, grant)).toThrow();
  const stale = issueConfiguredHostRuntimeProbe(ctx, "box", remote, local);
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  expect(() => consumeConfiguredHostRuntimeProbe(ctx, stale)).toThrow();
  expect(() => issueConfiguredHostRuntimeProbe(ctx, "box", remote, join(home, "wrong"))).toThrow();
});

test("disabled SSH provider refuses runtime PROBE without direct fallback", async () => {
  const { ctx, remote, local, log } = setup();
  const { ensureRemoteBinary } = await import("../src/remote/runtime");
  const registry = pluginRegistry(ctx);
  await registry.disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const grant = issueConfiguredHostRuntimeProbe(ctx, "box", remote, local);
  await expect(registry.probeConfiguredHostRuntime(ctx, grant)).rejects.toMatchObject({ code: "plugin_unavailable" });
  const binary = join(tmpDir(), "pacer"); writeFileSync(binary, "probe fixture");
  await expect(ensureRemoteBinary(ctx, host, remote, local, { binary })).rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("remote runtime PROBE uses bundled SSH without a direct fallback", async () => {
  const { ctx, remote, local, log } = setup();
  const { ensureRemoteBinary } = await import("../src/remote/runtime");
  const binary = join(tmpDir(), "pacer"); writeFileSync(binary, "probe fixture");
  const original = ctx.run;
  let direct = 0;
  ctx.run = (argv, ms, options) => {
    if (argv[0] === "ssh") direct++;
    return original(argv, ms, options);
  };
  await ensureRemoteBinary(ctx, host, remote, local, { binary });
  expect(direct).toBe(0);
  expect(readFileSync(log, "utf8")).toContain("getconf GNU_LIBC_VERSION");
});

test("malformed runtime PROBE result cannot advance to binary operations", async () => {
  const { ctx, remote, local, log } = setup();
  const { ensureRemoteBinary } = await import("../src/remote/runtime");
  const binary = join(tmpDir(), "pacer"); writeFileSync(binary, "probe fixture");
  const registry = pluginRegistry(ctx), probe = registry.probeConfiguredHostRuntime.bind(registry);
  registry.probeConfiguredHostRuntime = async () => ({ code: 0, stdout: "os=Linux\n", stderr: "", timedOut: false });
  try {
    await expect(ensureRemoteBinary(ctx, host, remote, local, { binary })).rejects.toThrow();
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  } finally { registry.probeConfiguredHostRuntime = probe; }
});

test("timed-out runtime PROBE cannot advance to binary operations", async () => {
  const { ctx, home, remote, local } = setup();
  const { ensureRemoteBinary } = await import("../src/remote/runtime");
  const binary = join(tmpDir(), "pacer"); writeFileSync(binary, "probe fixture");
  const registry = pluginRegistry(ctx);
  const probe = registry.probeConfiguredHostRuntime.bind(registry);
  const check = registry.checkConfiguredHostBinary.bind(registry);
  const upload = registry.uploadConfiguredHostBinary.bind(registry);
  let later = 0;
  registry.probeConfiguredHostRuntime = async () => ({ code: 0,
    stdout: `os=Linux\narch=x86_64\nglibc=2.36\nhome=${home}\n`, stderr: "", timedOut: true });
  registry.checkConfiguredHostBinary = async () => { later++; return { code: 1, stdout: "", stderr: "", timedOut: false }; };
  registry.uploadConfiguredHostBinary = async () => { later++; return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  try {
    await expect(ensureRemoteBinary(ctx, host, remote, local, { binary })).rejects.toThrow();
    expect(later).toBe(0);
  } finally {
    registry.probeConfiguredHostRuntime = probe;
    registry.checkConfiguredHostBinary = check;
    registry.uploadConfiguredHostBinary = upload;
  }
});

test("persisted run drift cancels an in-flight runtime PROBE", async () => {
  const { ctx, home, remote, local } = setup();
  const registry = pluginRegistry(ctx), grant = issueConfiguredHostRuntimeProbe(ctx, "box", remote, local);
  const marker = join(home, "probe-started"), ssh = ctx.which("ssh")!;
  const source = readFileSync(ssh, "utf8");
  const command = `exec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"`;
  expect(source).toContain(command);
  const fakeSsh = command.slice(5);
  writeFileSync(ssh, source.replace(command, `for arg in "$@"; do last="$arg"; done
case "$last" in
  *"getconf GNU_LIBC_VERSION"*) printf ready > ${JSON.stringify(marker)}; sleep 2; exec ${fakeSsh} ;;
  *) exec ${fakeSsh} ;;
esac`), { mode: 0o755 });
  const pending = registry.probeConfiguredHostRuntime(ctx, grant);
  for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20);
  expect(existsSync(marker)).toBe(true);
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  await expect(pending).rejects.toThrow();
}, 10000);

test("disabled SSH provider refuses BINARY check without direct SSH fallback", async () => {
  const { ctx, remote, local, log } = setup();
  const registry = pluginRegistry(ctx);
  await registry.disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const grant = issueConfiguredHostBinaryCheck(ctx, "box", remote, local, "a".repeat(64));
  await expect(registry.checkConfiguredHostBinary(ctx, grant)).rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("BINARY upload grant binds one persisted run and exact private bytes", async () => {
  const { ctx, remote, local, log } = setup();
  const bytes = randomBytes(8193), registry = pluginRegistry(ctx);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await expect(registry.call(ctx, "pacer-ssh", "hostRunner.upload", {
    session: "a".repeat(32), script: "BINARY", args: [hash, "upload"],
    timeoutMs: 300_000, maxBytes: 4096, completionNonce: "a".repeat(8) + "-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  })).rejects.toMatchObject({ code: "capability_denied" });
  const grant = issueConfiguredHostBinaryUpload(ctx, "box", remote, local, bytes);
  bytes.fill(0);
  expect(Buffer.from(consumeConfiguredHostBinaryUpload(ctx, grant))).not.toEqual(bytes);
  expect(() => consumeConfiguredHostBinaryUpload(ctx, grant)).toThrow();
  const stale = issueConfiguredHostBinaryUpload(ctx, "box", remote, local, randomBytes(32));
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  expect(() => consumeConfiguredHostBinaryUpload(ctx, stale)).toThrow();
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain(hash);
});

test("disabled SSH provider refuses BINARY upload without direct SSH fallback", async () => {
  const { ctx, remote, local, log } = setup();
  const registry = pluginRegistry(ctx);
  await registry.disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const grant = issueConfiguredHostBinaryUpload(ctx, "box", remote, local, randomBytes(32));
  await expect(registry.uploadConfiguredHostBinary(ctx, grant)).rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("START grant binds the persisted run and private input exactly once", () => {
  const { ctx, remote, local, home } = setup();
  const args = [remote, home, "pipe", "PACER_ROLE=executor", "--", "sh", "-c", "cat"];
  const grant = issueConfiguredHostStart(ctx, "box", remote, local, args, Buffer.from("wrapper\n__PACER_STDIN__\nprompt"));
  expect(grant.resource.script).toBe("START");
  expect(Buffer.from(consumeConfiguredHostStart(ctx, grant)).toString()).toBe("wrapper\n__PACER_STDIN__\nprompt");
  expect(() => consumeConfiguredHostStart(ctx, grant)).toThrow();
  const stale = issueConfiguredHostStart(ctx, "box", remote, local, args, Buffer.from("wrapper\n__PACER_STDIN__\ninput"));
  updateTask(ctx, remote.split("/").at(-2)!, task => { task.state = "queued"; });
  expect(() => consumeConfiguredHostStart(ctx, stale)).toThrow();
});

test("START refuses private stdin beyond its 50 MiB bound before SSH", () => {
  const { ctx, remote, local, home, log } = setup();
  const args = [remote, home, "pipe", "--", "sh", "-c", "cat"];
  const large = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);
  Buffer.from("__PACER_STDIN__\n").copy(large, 0);
  expect(() => issueConfiguredHostStart(ctx, "box", remote, local, args, large)).toThrow();
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
});

test("unissued START and private start-input process mode are denied", async () => {
  const { ctx, remote, home, log } = setup();
  const registry = pluginRegistry(ctx);
  const params = { session: "a".repeat(32), script: "START", args: [remote, home, "pipe", "--", "sh", "-c", "cat"],
    timeoutMs: 60_000, maxBytes: 65_536, completionNonce: "a".repeat(8) + "-" + "b".repeat(4) + "-" + "c".repeat(4) + "-" + "d".repeat(4) + "-" + "e".repeat(12) };
  await expect(registry.call(ctx, "pacer-ssh", "hostRunner.run", params)).rejects.toMatchObject({ code: "capability_denied" });
  await expect(registry.call(ctx, "pacer-ssh", "hostRunner.run", params, {
    resources: { reads: [], stores: [], commands: [{ argv: ["ssh", "--", "box-ssh"], timeoutMs: 60_000,
      mode: "start-input", input: Buffer.from("private"), inputSha256: "0".repeat(64) }] },
  })).rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
});

test("lost START receipt leaves its launch uncertain without retrying SSH", async () => {
  const { ctx, io, remote, home, log } = setup();
  const marker = join(home, "start-attempts");
  const ssh = ctx.which("ssh")!, source = readFileSync(ssh, "utf8");
  const command = `exec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"`;
  expect(source).toContain(command);
  const fakeSsh = command.slice(5);
  writeFileSync(ssh, source.replace(command, `for arg in "$@"; do last="$arg"; done
case "$last" in
  *"start.error"*) printf x >> ${JSON.stringify(marker)}; ${fakeSsh} | sed '/__PACER_DONE__/d' ;;
  *) exec ${fakeSsh} ;;
esac`), { mode: 0o755 });
  expect(await io.start(["sh", "-c", "echo one"], home, {}, "prompt")).toHaveProperty("error");
  expect(existsSync(join(remote, "pid"))).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe("x");
  expect(readFileSync(log, "utf8")).toContain("start.error");
});

test("persisted run drift cancels START before its remote write", async () => {
  const { ctx, io, remote, home } = setup();
  const marker = join(home, "start-held"), ssh = ctx.which("ssh")!, source = readFileSync(ssh, "utf8");
  const command = `exec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"`;
  expect(source).toContain(command);
  writeFileSync(ssh, source.replace(command, `for arg in "$@"; do last="$arg"; done
case "$last" in
  *"start.error"*) printf held > ${JSON.stringify(marker)}; sleep 2 ;;
esac
${command}`), { mode: 0o755 });
  const started = io.start(["sh", "-c", "echo should-not-run"], home, {}, "prompt");
  for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await Bun.sleep(20);
  expect(existsSync(marker)).toBe(true);
  updateTask(ctx, remote.split("/").at(-2)!, task => { task.state = "queued"; });
  expect(await started).toHaveProperty("error");
  expect(existsSync(join(remote, "pid"))).toBe(false);
}, 10_000);

test("START SSH child uses the sandbox context environment", async () => {
  const { ctx, io, home } = setup();
  ctx.env.HOME = join(home, "sandbox-context-home");
  mkdirSync(ctx.env.HOME, { recursive: true });
  const marker = join(home, "start-context-home"), ssh = ctx.which("ssh")!, source = readFileSync(ssh, "utf8");
  const command = `exec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"`;
  expect(source).toContain(command);
  expect(ctx.env.HOME).not.toBe(process.env.HOME);
  writeFileSync(ssh, source.replace(command, `for arg in "$@"; do last="$arg"; done
case "$last" in
  *"start.error"*) printf '%s' "$HOME" > ${JSON.stringify(marker)} ;;
esac
${command}`), { mode: 0o755 });
  expect(await io.start(["sh", "-c", "exit 0"], home, {}, "prompt")).toHaveProperty("pid");
  expect(readFileSync(marker, "utf8")).toBe(ctx.env.HOME);
});

test("disabled SSH provider refuses START without direct SSH fallback", async () => {
  const { ctx, io, home, log } = setup();
  await pluginRegistry(ctx).disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  expect(await io.start(["sh", "-c", "exit 0"], home, {}, "prompt")).toHaveProperty("error");
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("BINARY upload refuses bytes beyond its 128 MiB cap", () => {
  const { ctx, remote, local } = setup();
  expect(() => issueConfiguredHostBinaryUpload(ctx, "box", remote, local,
    new Uint8Array(128 * 1024 * 1024 + 1))).toThrow();
});
async function exited(io: RemoteRunIO): Promise<RunState> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const s = await io.read();
    if (s.exit !== null) return s;
    await Bun.sleep(50);
  }
  throw new Error("remote run did not exit");
}

test("a remote run starts detached, mirrors output and records its exit", async () => {
  const { io, home, local } = setup();
  expect(await io.start(["sh", "-c", "echo one; sleep 1; echo two; exit 3"], home, {}, "")).toHaveProperty("pid");
  const s = await exited(io);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe("one\ntwo\n");
  expect(s.exit).toBe(3); expect(s.alive).toBe(false);
  expect(readRun(local).exit).toBe(3);
}, 10000);

test("the prompt reaches the host agent unchanged", async () => {
  const { io, home, local, log } = setup();
  const prompt = `hostile-brief '" $(touch "$HOME/pwned") \`id\`\nline two\n__PACER_STDIN__\nlast line`;
  expect(await io.start(["sh", "-c", "cat"], home, {}, prompt)).toHaveProperty("pid");
  await exited(io);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(prompt);
  expect(readFileSync(log, "utf8")).not.toContain("hostile-brief");
  expect(existsSync(join(home, "pwned"))).toBe(false);
}, 10000);

test("START streams a prompt beyond the public text RPC limit through private stdin", async () => {
  const { io, home, local } = setup();
  const prompt = "x".repeat(70_000) + "\nprivate tail ' ";
  expect(await io.start(["sh", "-c", "cat"], home, {}, prompt)).toHaveProperty("pid");
  expect((await exited(io)).exit).toBe(0);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(prompt);
}, 10_000);

test.skipIf(!canInspectProcesses())("stop terminates the remote process group", async () => {
  const { io, home, remote } = setup();
  expect(await io.start(["sh", "-c", 'trap "" TERM; echo ready; sleep 30'], home, {}, "")).toHaveProperty("pid");
  while (!(await io.read()).stdoutBytes) await Bun.sleep(50);
  const started = Date.now();
  expect(await io.stop({ graceMs: 1000, sleep: Bun.sleep })).toEqual({ code: 137, killed: true });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(readFileSync(join(remote, "exit"), "utf8").trim()).toBe("137");
}, 10000);

test("unreachable polls keep the run until the grace ends", async () => {
  let calls = 0, now = 0;
  const state: RunState = { pid: 1, startedAt: 1, exit: 3, alive: false, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null };
  const io: RunIO = { read: async () => { if (++calls <= 3) throw new Unreachable("box"); return state; }, stop: async () => { throw new Error("must not stop unreachable run"); } };
  const options = { io, deadlineMs: 10000, isStopped: () => false, pollMs: 10, now: () => now, sleep: async (ms: number) => { now += ms; }, unreachableGraceMs: 50 };
  expect(await supervise(options)).toEqual({ kind: "exited", code: 3 });
  io.read = async () => { throw new Unreachable("box"); };
  expect(await supervise(options)).toEqual({ kind: "lost", code: 137 });
});

test("mirrors capped byte chunks without losing a split UTF-8 character", async () => {
  const { io, home, remote, local } = setup();
  expect(await io.start(["sh", "-c", "exit 0"], home, {}, "")).toHaveProperty("pid");
  await exited(io);
  const output = "a".repeat(262143) + "🦊" + "z";
  writeFileSync(join(remote, "stdout"), output);
  const first = await io.read();
  expect(readFileSync(join(local, "stdout")).length).toBe(Buffer.byteLength(output));
  expect(first.exit).toBe(0);
  expect((await io.read()).exit).toBe(0);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(output);
}, 10000);

test("a failed SSH poll is unreachable and does not erase the local record", async () => {
  const local = tmpDir(); writeFileSync(join(local, "stdout"), "kept\n");
  const env = fakeSshEnv(tmpDir(), join(tmpDir(), "ssh.log"), "box-ssh");
  const ctx = fakeCtx({ run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env, ...o?.env } }) });
  const io = new RemoteRunIO(ctx, host, "~/.pacer-remote/runs/t/1", local);
  await expect(io.read()).rejects.toBeInstanceOf(Unreachable);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe("kept\n");
});

test("read reports remote command failures as unreachable, and stop on an unreachable host ends quietly", async () => {
  const { RemoteRunIO } = await import("../src/remote/run-io");
  const { Unreachable } = await import("../src/supervisor/io");
  const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };
  const failing = (code: number) => ({ ...fakeCtx(), run: async () => ({ code, stdout: "", stderr: "boom" }) });
  expect(await new RemoteRunIO(failing(1), host, "~/r", tmpDir()).read().catch((e) => e)).toBeInstanceOf(Unreachable);
  const unreachable = setup();
  unreachable.setDown("box-ssh");
  expect(await unreachable.io.stop({ graceMs: 1000, sleep: async () => {} })).toEqual({ code: 137, killed: false });
});

const utilScript = Bun.spawnSync(["script", "--version"]).stdout.toString().includes("util-linux");
test.skipIf(!utilScript)("PTY remote launch preserves argv/stdin and child exit under util-linux script", async () => {
  const { io, home, remote, local } = setup();
  const prompt = `quoted ' \" $(touch \"$HOME/pwned\")\n🦊`;
  expect(await io.start(["sh", "-c", 'test -t 1 || exit 91; cat; printf "\\033[31mred\\033[0m\\n"; exit 7'], home, {}, prompt, { session: "pty" })).toHaveProperty("pid");
  expect((await exited(io)).exit).toBe(7);
  expect(existsSync(join(remote, "session.raw"))).toBe(true);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(prompt + "red\n");
  expect(existsSync(join(home, "pwned"))).toBe(false);
  expect(existsSync(join(local, "session.ckpt"))).toBe(true);
}, 10000);

test("PTY selection wraps safely with script while pipe mode retains the wrapper", async () => {
  const { io, home, remote } = setup();
  const bin = join(home, "bin"); mkdirSync(bin, {recursive:true});
  writeFileSync(join(bin,"script"), '#!/bin/sh\n[ "$1" = "-qfec" ] || exit 92\nprintf "wrapped\\n" > "$3"\nexec sh -c "$2"\n', {mode:0o755});
  writeFileSync(join(home,".bash_profile"), 'export PATH="$HOME/bin:$PATH"\n');
  const arg = `a 'quoted' \"value\" $(touch \"$HOME/pwned\")`;
  expect(await io.start(["sh","-c",'printf "%s" "$1" > argument; cat > prompt; exit 7',"agent",arg], home, {}, "input", {session:"pty"})).toHaveProperty("pid");
  // Observe remote exit directly; recording derivation is tested separately.
  for(let n=0; n<100 && !existsSync(join(remote,"exit")); n++) await Bun.sleep(20);
  expect(readFileSync(join(remote,"exit"),"utf8").trim()).toBe("7");
  expect(readFileSync(join(remote,"session.raw"),"utf8")).toBe("wrapped\n");
  expect(readFileSync(join(home,"argument"),"utf8")).toBe(arg);
  expect(readFileSync(join(home,"prompt"),"utf8")).toBe("input");
  expect(existsSync(join(home,"pwned"))).toBe(false);
});

test("raw mirror derives phase-1 files, masks secrets, drains chunks, rotates and resumes", async () => {
  const { io, home, remote, local, ctx } = setup();
  mkdirSync(remote,{recursive:true});
  writeFileSync(join(remote,"session.host"),"script");
  writeFileSync(join(remote,"started"),"1");
  writeFileSync(join(local,"session.json"),JSON.stringify({capBytes:1024}));
  ctx.env.PACER_KEY_TEST = "private-secret";
  const text = "x".repeat(262140) + "🦊\u001b[31mred\u001b[0m\r\nprivate-secret\ntail";
  writeFileSync(join(remote,"session.raw"), `Script started on date [COMMAND=\"agent\"]\n${text}\nScript done on date [COMMAND_EXIT_CODE=\"3\"]\n`);
  writeFileSync(join(remote,"exit"),"3");
  expect((await io.read()).exit).toBe(3);
  const expected = "x".repeat(262140)+"🦊red\n****\ntail";
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(expected);
  expect(existsSync(join(local,"session.log.1"))).toBe(true);
  expect(existsSync(join(local,"session.raw"))).toBe(false);
  const { replayRecording } = await import("../src/session/recording");
  const screen = await replayRecording(local);
  expect(screen.plain()).toContain("****"); screen.dispose();
  const resumed = new RemoteRunIO(ctx,host,remote,local);
  await exited(resumed);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(expected);
  expect((await resumed.read()).exit).toBe(3);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(expected);
},10000);

test.skipIf(!await canListen())("a read-only viewer streams over the ControlMaster and detaching returns to polling", async () => {
  const { io, remote, local, log, ctx } = setup();
  mkdirSync(remote,{recursive:true});
  writeFileSync(join(remote,"session.host"),"pty");
  writeFileSync(join(remote,"session.raw"),'Script started on date [COMMAND="agent"]\nfirst\r\n');
  writeFileSync(join(remote,"pid"),String(process.pid));
  await io.read();
  const { createConnection } = await import("node:net");
  const { socketPath } = await import("../src/session/host");
  const { wire, FrameType, WireDecoder } = await import("../src/session/framing");
  const socket = createConnection(socketPath(local));
  await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
  const frames: {type:number;data:Buffer}[] = [], decoder = new WireDecoder();
  socket.on("data", bytes=>frames.push(...decoder.push(Buffer.from(bytes))));
  socket.write(wire(FrameType.hello,{v:1,label:"test"}));
  const wait = async (predicate:()=>boolean) => {
    for(let n=0;n<200 && !predicate();n++) await Bun.sleep(20);
    expect(predicate()).toBe(true);
  };
  await wait(()=>readFileSync(log,"utf8").includes('tail -c +'));
  socket.write(wire(FrameType.input,Buffer.from("never remote input")));
  socket.write(wire(FrameType.size,{cols:30,rows:10}));
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(remote,"session.raw"),"second\r\n");
  await wait(()=>frames.some(f=>f.type===FrameType.output && f.data.includes(Buffer.from("second"))));
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\n");
  expect((await import("../src/remote/ssh")).sshArgv(ctx,host,(await import("../src/remote/scripts")).SCRIPTS.FOLLOW,[remote,"0"])).toContain("ControlMaster=auto");
  socket.destroy();
  await Bun.sleep(150);
  appendFileSync(join(remote,"session.raw"),"third\r\n");
  await io.read();
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\nthird\n");
  expect(readFileSync(log,"utf8")).not.toContain("never remote input");
  writeFileSync(join(remote,"exit"),"0");
  expect((await io.read()).exit).toBe(0);
},10000);

async function canListen(): Promise<boolean> {
  const {createServer} = await import("node:net");
  const {rmSync} = await import("node:fs");
  const path=join(tmpDir(),"probe.sock"), server=createServer();
  try {
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path,resolve);});
    return true;
  } catch {return false;}
  finally {server.close();rmSync(path,{force:true});}
}

test("viewer protocol streams raw bytes with fake SSH and kills tail on detach", async()=>{
  const {ctx,remote,local,log}=setup();
  const {RemoteRecording}=await import("../src/remote/recording");
  const {RemoteViewer}=await import("../src/remote/viewer");
  const {EventEmitter}=await import("node:events");
  const {appendFileSync}=await import("node:fs");
  const {wire,FrameType,WireDecoder}=await import("../src/session/framing");
  const {SCRIPTS}=await import("../src/remote/scripts");
  const {runRemote}=await import("../src/remote/ssh");
  mkdirSync(remote,{recursive:true});
  const raw='Script started on date [COMMAND="agent"]\nfirst\r\n';
  writeFileSync(join(remote,"session.raw"),raw);
  writeFileSync(join(remote,"pid"),String(process.pid));
  const recording=new RemoteRecording(ctx,local);
  await recording.output(Buffer.from(raw));
  let queue:Promise<unknown>=Promise.resolve();
  const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
  const viewer=new RemoteViewer(ctx,host,remote,recording,serial);
  const decoder=new WireDecoder(), frames:{type:number;data:Buffer}[]=[];
  class SocketFixture extends EventEmitter {
    destroyed=false;writableLength=0;
    write(bytes:Buffer) {frames.push(...decoder.push(bytes));return true;}
    end(bytes:Buffer) {this.write(bytes);}
    destroy() {this.destroyed=true;this.emit("close");}
  }
  const socket=new SocketFixture();
  viewer.accept(socket as unknown as import("node:net").Socket);
  const wait=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await Bun.sleep(20);expect(fn()).toBe(true);};
  try {
    socket.emit("data",wire(FrameType.hello,{v:1,label:"test"}));
    await wait(()=>viewer.active);
    socket.emit("data",wire(FrameType.input,Buffer.from("do not forward")));
    socket.emit("data",wire(FrameType.size,{cols:10,rows:10}));
    appendFileSync(join(remote,"session.raw"),"second\r\n");
    await wait(()=>frames.some(f=>f.type===FrameType.output&&f.data.includes(Buffer.from("second"))));
    expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\n");
    expect(recording.recording.term.cols).toBe(120);
    expect((await import("../src/remote/ssh")).sshArgv(ctx,host,(await import("../src/remote/scripts")).SCRIPTS.FOLLOW,[remote,"0"])).toContain("ControlMaster=auto");
    expect(readFileSync(log,"utf8")).not.toContain("do not forward");
    socket.destroy();
    await wait(()=>!viewer.active);
    appendFileSync(join(remote,"session.raw"),"third\r\n");
    const r=await runRemote(ctx,host,SCRIPTS.READ_FROM,[remote,"session.raw",String(recording.offset),"262144","hex"]);
    await serial(()=>recording.output(Buffer.from(r.stdout,"hex")));
    expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\nthird\n");
  } finally {await viewer.close(0);await recording.close();}
},10000);

test("script framing survives byte splits and preserves ordinary Script done output", async()=>{
  const {ctx,local}=setup();
  const {RemoteRecording}=await import("../src/remote/recording");
  const recording=new RemoteRecording(ctx,local);
  const body="🦊\r\nScript done on is agent output\r\nlast";
  const raw=Buffer.from(`Script started on date [COMMAND="agent"]\n${body}\nScript done on date [COMMAND_EXIT_CODE="0"]\n`);
  for(const byte of raw) await recording.output(Buffer.from([byte]));
  await recording.close();
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("🦊\nScript done on is agent output\nlast");
});

function canInspectProcesses(): boolean {
  try {return Bun.spawnSync(["ps","-p",String(process.pid),"-o","args="]).exitCode === 0;}
  catch {return false;}
}


test("mirror drains up to 4 MiB each poll and resumes the persisted raw cursor", async () => {
  const {io,ctx,remote,local,log}=setup();
  mkdirSync(remote,{recursive:true});
  writeFileSync(join(remote,"session.host"),"pty");
  writeFileSync(join(remote,"session.raw"),'Script started on date [COMMAND="agent"]\n'+"line\n".repeat(900000));
  writeFileSync(join(remote,"exit"),"0");
  expect((await io.read()).exit).toBeNull();
  const first=readFileSync(join(local,"stdout"));
  expect(first.length).toBeGreaterThan(4*1024*1024-100);
  expect(first.length).toBeLessThanOrEqual(4*1024*1024);
  const before = readFileSync(log, "utf8").length;
  const resumed=new RemoteRunIO(ctx,host,remote,local);
  expect((await resumed.read()).exit).toBe(0);
  const offsets = [...readFileSync(log, "utf8").slice(before).matchAll(/session\.raw\s+(\d+)\s+\d+\s+hex/g)]
    .map(match => Number(match[1]));
  expect(offsets[0]).toBeGreaterThan(4*1024*1024-100);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("line\n".repeat(900000));
},30000);

test.skipIf(!await canListen())("viewer removes stale sockets and retries a failed listen next poll", async()=>{
  const {io,remote,local}=setup();
  const {socketPath}=await import("../src/session/host");
  const {rmSync}=await import("node:fs");
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.host"),"pty");
  writeFileSync(join(remote,"session.raw"),"header\nfirst\n");
  const path=socketPath(local);
  mkdirSync(path); // unlink must fail on a directory, without preventing recording.
  await io.read();
  rmSync(path,{recursive:true});
  writeFileSync(path,"stale socket");
  await io.read();
  const {createConnection}=await import("node:net");const socket=createConnection(path);
  try {await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});}
  finally {socket.destroy();writeFileSync(join(remote,"exit"),"0");await io.read();}
});

test("FOLLOW ends when the recorded run pid exits", async()=>{
  const {ctx,remote}=setup();const {SCRIPTS}=await import("../src/remote/scripts");
  const {runRemote}=await import("../src/remote/ssh");
  const tail=Bun.spawnSync([Bun.which("gtail") ?? "tail","--version"]);
  if(!tail.stdout.toString().includes("GNU coreutils")) return;
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.raw"),"first\n");
  const child=Bun.spawn(["sleep","1"],{stdout:"ignore",stderr:"ignore"});
  writeFileSync(join(remote,"pid"),String(child.pid));
  const result=await runRemote(ctx,host,SCRIPTS.FOLLOW,[remote,"0"],{timeoutMs:4000});
  expect([0,143]).toContain(result.code);expect(result.stdout).toBe("first\n");
},6000);

test("restart preserves a partial line and rereads withheld secret bytes",async()=>{
  const {ctx,local}=setup();
  const {RemoteRecording}=await import("../src/remote/recording");
  ctx.env.PACER_KEY_TEST="restart-private-value";
  const raw=Buffer.from('Script started on date [COMMAND="agent"]\nprefix \x1b[31mrestart-private-value\x1b[0m after\r\n\nScript done on date [COMMAND_EXIT_CODE="0"]\n');
  const first=new RemoteRecording(ctx,local);
  await first.output(raw.subarray(0,raw.indexOf(Buffer.from("value"))));
  const state=readFileSync(join(local,"session.remote.json"),"utf8");
  expect(state).not.toContain("restart-private");
  const resumed=new RemoteRecording(ctx,local);await resumed.ready;
  expect(resumed.offset).toBeGreaterThan(0);
  await resumed.output(raw.subarray(resumed.offset));await resumed.close();
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("prefix **** after\n");
  const {replayRecording}=await import("../src/session/recording");
  const replay=await replayRecording(local);expect(replay.plain()).toContain("prefix **** after");replay.dispose();
  first.recording.dispose();
});

test("PTY wrapper conversion rejects an unrecognized wrapper",async()=>{
  const {ptyWrapper}=await import("../src/remote/run-io");
  expect(()=>ptyWrapper("#!/bin/sh\necho changed\n")).toThrow("replacement failed");
});

test("PTY script uses the bash resolved on the remote PATH",async()=>{
  const {io,home,remote}=setup();const bin=join(home,"bin");mkdirSync(bin,{recursive:true});
  symlinkSync(Bun.which("bash")!,join(bin,"bash"));
  writeFileSync(join(bin,"script"),'#!/bin/sh\nprintf "%s" "$SHELL" > "$HOME/selected-shell"\nexec "$SHELL" -c "$2"\n',{mode:0o755});
  expect(await io.start(["true"],home,{},"",{session:"pty"})).toHaveProperty("pid");
  for(let n=0;n<100&&!existsSync(join(remote,"exit"));n++) await Bun.sleep(20);
  expect(readFileSync(join(home,"selected-shell"),"utf8")).toBe(join(bin,"bash"));
});

test("service exit kills its live stream SSH child",async()=>{
  const {ctx,home,local}=setup();const bin=join(home,"stream-bin");mkdirSync(bin);
  const pidFile=join(home,"stream-pid");
  writeFileSync(join(bin,"ssh"),'#!/bin/sh\necho $$ > "$STREAM_PID"\nprintf "__PACER_BEGIN__\\n"\nexec sleep 30\n',{mode:0o755});
  const file=join(home,"service.ts");
  writeFileSync(file,`
    import {EventEmitter} from "node:events";
    import {existsSync} from "node:fs";
    import {RemoteViewer} from ${JSON.stringify(new URL("../src/remote/viewer.ts",import.meta.url).pathname)};
    import {RemoteRecording} from ${JSON.stringify(new URL("../src/remote/recording.ts",import.meta.url).pathname)};
    import {wire,FrameType} from ${JSON.stringify(new URL("../src/session/framing.ts",import.meta.url).pathname)};
    const ctx={pacerHome:process.env.PACER_HOME,env:process.env} as any;
    const recording=new RemoteRecording(ctx,process.env.LOCAL!);await recording.ready;
    const viewer=new RemoteViewer(ctx,{ssh:"unused"} as any,"unused",recording,fn=>fn());
    class Socket extends EventEmitter {writableLength=0;write(){return true;}destroy(){this.emit("close");}}
    const socket=new Socket();viewer.accept(socket as any);
    socket.emit("data",wire(FrameType.hello,{v:1}));
    for(let n=0;n<100&&!existsSync(process.env.STREAM_PID!);n++)await Bun.sleep(10);
    process.exit(existsSync(process.env.STREAM_PID!)?0:2);
  `);
  const proc=Bun.spawn([process.execPath,file],{env:{...ctx.env,PATH:`${bin}:${ctx.env.PATH}`,STREAM_PID:pidFile,PACER_HOME:ctx.pacerHome,LOCAL:local},stdout:"ignore",stderr:"pipe"});
  expect(await proc.exited).toBe(0);
  const pid=Number(readFileSync(pidFile,"utf8"));
  const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
  try {
    for(let n=0;n<100&&alive();n++)await Bun.sleep(10);
    expect(alive()).toBe(false);
  }finally{try{process.kill(pid,"SIGKILL");}catch{}}
},5000);

test("release upload is content addressed, host verified, reused and repaired",async()=>{
  const {ctx,home,remote,local}=setup();
  const {ensureRemoteBinary,remotePlatform}=await import("../src/remote/runtime");
  const binary=join(tmpDir(),"pacer");writeFileSync(binary,"release fixture\u0000\u00ff");
  expect(remotePlatform("Linux","aarch64")).toEqual({os:"linux",arch:"arm64"});
  expect(()=>remotePlatform("Linux","mips")).toThrow("unsupported");
  const installed=await ensureRemoteBinary(ctx,host,remote,local,{binary});
  const bytes=readFileSync(binary);
  const hash=new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(installed).toBe(join(home,".pacer-remote/bin",hash,"pacer"));
  expect(readFileSync(installed)).toEqual(bytes);
  const first=statSync(installed).mtimeMs;
  await ensureRemoteBinary(ctx,host,remote,local,{binary});
  expect(statSync(installed).mtimeMs).toBe(first);
  const {chmodSync}=await import("node:fs");
  const dirs=[join(home,".pacer-remote"),join(home,".pacer-remote/bin"),join(home,".pacer-remote/bin",hash)];
  for(const dir of dirs)chmodSync(dir,0o755);
  writeFileSync(installed,"corrupt");
  await ensureRemoteBinary(ctx,host,remote,local,{binary});
  expect(readFileSync(installed)).toEqual(bytes);
  for(const dir of dirs)expect(statSync(dir).mode&0o777).toBe(0o700);
  // The broker owns upload stdin, so corrupt it at the fake SSH transport boundary.
  const ssh=ctx.which("ssh")!;
  writeFileSync(ssh,readFileSync(ssh,"utf8").replace('"$@"','"$@" </dev/null'),{mode:0o755});
  writeFileSync(installed,"corrupt again");
  await expect(ensureRemoteBinary(ctx,host,remote,local,{binary})).rejects.toThrow("hash");
});

test("lost binary upload receipt stays unverified after the remote file is written", async () => {
  const { ctx, home, remote, local, log } = setup();
  const { ensureRemoteBinary } = await import("../src/remote/runtime");
  const binary = join(tmpDir(), "pacer"); writeFileSync(binary, "receipt fixture");
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(binary)).digest("hex");
  const ssh = ctx.which("ssh")!, source = readFileSync(ssh, "utf8");
  const command = `exec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"`;
  expect(source).toContain(command);
  const fakeSsh = command.slice(5);
  writeFileSync(ssh, source.replace(command, `for arg in "$@"; do last="$arg"; done
case "$last" in
  *" upload") ${fakeSsh} | sed '/__PACER_DONE__/d' ;;
  *) exec ${fakeSsh} ;;
esac`), { mode: 0o755 });
  await expect(ensureRemoteBinary(ctx, host, remote, local, { binary }))
    .rejects.toThrow("completion is unverified");
  expect(readFileSync(join(home, ".pacer-remote", "bin", hash, "pacer"))).toEqual(readFileSync(binary));
  expect(readFileSync(log, "utf8")).toContain("upload");
});

test("persisted run drift cancels an in-flight binary upload before its remote write", async () => {
  const { ctx, home, remote, local } = setup();
  const { ensureRemoteBinary } = await import("../src/remote/runtime");
  const binary = join(tmpDir(), "pacer"); writeFileSync(binary, "drift fixture");
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(binary)).digest("hex");
  const marker = join(home, "upload-started"), ssh = ctx.which("ssh")!;
  const source = readFileSync(ssh, "utf8");
  const command = `exec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"`;
  expect(source).toContain(command);
  const fakeSsh = command.slice(5);
  writeFileSync(ssh, source.replace(command, `for arg in "$@"; do last="$arg"; done
case "$last" in
  *" upload") printf ready > ${JSON.stringify(marker)}; sleep 2; exec ${fakeSsh} ;;
  *) exec ${fakeSsh} ;;
esac`), { mode: 0o755 });
  const pending = ensureRemoteBinary(ctx, host, remote, local, { binary });
  for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20);
  expect(existsSync(marker)).toBe(true);
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "queued"; });
  await expect(pending).rejects.toThrow();
  expect(existsSync(join(home, ".pacer-remote", "bin", hash, "pacer"))).toBe(false);
}, 10000);

test("timed-out or malformed binary cache checks never trigger direct upload", async () => {
  const { ctx, remote, local } = setup();
  const { ensureRemoteBinary } = await import("../src/remote/runtime");
  const binary = join(tmpDir(), "pacer"); writeFileSync(binary, "release fixture");
  const registry = pluginRegistry(ctx), check = registry.checkConfiguredHostBinary.bind(registry);
  const run = ctx.run;
  let uploads = 0;
  ctx.run = (argv, ms, options) => {
    if (argv.at(-1) === "upload") uploads++;
    return run(argv, ms, options);
  };
  try {
    for (const result of [
      { code: 1, stdout: "", stderr: "", timedOut: true },
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 0, stdout: "/tmp/foreign/pacer\n", stderr: "", timedOut: false },
    ]) {
      registry.checkConfiguredHostBinary = async () => result;
      await expect(ensureRemoteBinary(ctx, host, remote, local, { binary })).rejects.toThrow();
    }
    expect(uploads).toBe(0);
  } finally { registry.checkConfiguredHostBinary = check; }
});

test("opted-in hosts launch _session and mirror native recordings without script",async()=>{
  const {ctx,home,remote,local}=setup();
  enableFull(ctx);
  const binary=join(tmpDir(),"pacer");
  // A local executable stands in for the release and enters the real session host.
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${new URL("../src/cli.ts",import.meta.url).pathname}' "$@"\n`,{mode:0o755});
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local,{binary});
  const prompt="quoted ' 🦊\n";
  expect(await io.start(["sh","-c",'cat; printf "\\033[31mred\\033[0m\\n"; exit 7'],home,{},prompt)).toHaveProperty("pid");
  expect((await exited(io)).exit).toBe(7);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(prompt+"red\n");
  expect(readFileSync(join(remote,"session.host"),"utf8")).toBe("builtin");
  expect(existsSync(join(remote,"session.raw"))).toBe(false);
  expect(readFileSync(join(local,"session.log"))).toEqual(readFileSync(join(remote,"session.log")));
  const {replayRecording}=await import("../src/session/recording");
  const a=await replayRecording(local),b=await replayRecording(remote);
  expect(a.snapshot()).toEqual(b.snapshot());a.dispose();b.dispose();
},15000);

test("native completion drains recordings when REPORT observed the launch marker first", async () => {
  const { ctx, home, remote, local } = setup();
  enableFull(ctx);
  const release = join(home, "release-session");
  const binary = join(tmpDir(), "pacer");
  // START sees the real owned process before _session has initialized its PTY.
  writeFileSync(binary, `#!/bin/sh
printf '%s' "$$" > "$2/pid"
while [ ! -e '${release}' ]; do sleep 0.01; done
exec '${process.execPath}' '${new URL("../src/cli.ts", import.meta.url).pathname}' "$@"
`, { mode: 0o755 });
  const ssh = join(home, "bin", "ssh"), intercepted = join(home, "bin", "report-ssh");
  const marker = join(home, "report-interleaved");
  writeFileSync(intercepted, `#!/bin/sh
case "$*" in
  *admission_complete=%s*)
    if [ ! -e '${marker}' ]; then
      observed=$(cat '${join(remote, "session.host")}')
      touch '${marker}' '${release}'
      n=0
      while [ ! -e '${join(remote, "exit")}' ] && [ "$n" -lt 800 ]; do sleep 0.01; n=$((n + 1)); done
      '${ssh}' "$@" | sed "s/^session=.*/session=$observed/"
      exit
    fi ;;
esac
exec '${ssh}' "$@"
`, { mode: 0o755 });
  ctx.which = name => name === "ssh" ? intercepted : null;
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local, { binary });
  try {
    expect(await io.start(["sh", "-c", "printf done; exit 7"], home, {}, "")).toHaveProperty("pid");
    expect((await exited(io)).exit).toBe(7);
    expect(readFileSync(join(remote, "session.host"), "utf8")).toBe("builtin");
    expect(readFileSync(join(local, "session.log"))).toEqual(readFileSync(join(remote, "session.log")));
  } finally {
    writeFileSync(release, "");
  }
}, 15000);

test("a pending full launch can settle to pipe fallback without losing or repeating bytes", async () => {
  const { ctx, remote, local } = setup();
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "full");
  writeFileSync(join(remote, "exit"), "7");
  writeFileSync(join(remote, "stdout"), "done");
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  expect(await io.read()).toMatchObject({ exit: null, alive: true, stdoutBytes: 4 });
  writeFileSync(join(remote, "session.host"), "none");
  expect(await io.read()).toMatchObject({ exit: 7, alive: false, stdoutBytes: 4 });
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe("done");
  expect((await io.read()).exit).toBe(7);
});

for(const refused of [false,true]) test.skipIf(!await canListen())(`full remote protocol supports exact snapshots and control (forward refused=${refused})`,async()=>{
  const {ctx,home,local,remote,log}=setup();
  enableFull(ctx);
  if(refused) ctx.env.PACER_FAKE_FORWARD_REFUSED="1";
  const run=ctx.run;
  // The fixture runner must also receive transport environment overrides.
  ctx.run=(argv,ms,o)=>run(argv,ms,{...o,env:{...ctx.env,...o?.env}});
  const {Recording}=await import("../src/session/recording");
  const {ViewerHub}=await import("../src/session/viewers");
  const {createServer,createConnection}=await import("node:net");
  const {socketPath}=await import("../src/session/host");
  const {wire,FrameType,WireDecoder}=await import("../src/session/framing");
  mkdirSync(remote,{recursive:true});
  const binary=join(home,"fixture-pacer");
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${new URL("../src/cli.ts",import.meta.url).pathname}' "$@"\n`,{mode:0o755});
  writeFileSync(join(remote,"session.binary"),binary);
  const record=new Recording(remote);await record.output(Buffer.from("\x1b[31mexact\x1b[0m\r\n"));
  let typed="",cols=120;
  const hub=new ViewerHub(()=>wire(FrameType.snapshot,{...record.snapshot(),controller:hub.controller,viewers:hub.size}),()=>null,fn=>{void fn();},()=>{},()=>{},
    {input:bytes=>{typed+=bytes.toString();},resize:(c)=>{cols=c;}});
  const path=socketPath(remote),server=createServer(socket=>hub.add(socket));
  await new Promise<void>(resolve=>server.listen(path,resolve));
  writeFileSync(join(remote,"session.sock.path"),path);
  writeFileSync(join(remote,"session.host"),"builtin");writeFileSync(join(remote,"pid"),String(process.pid));
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local);
  const frames:{type:number;data:Buffer}[]=[];
  let socket:ReturnType<typeof createConnection>|undefined;
  const wait=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await Bun.sleep(20);expect(fn()).toBe(true);};
  try{
    await io.read();
    socket=createConnection(socketPath(local));const decoder=new WireDecoder();
    await new Promise<void>((resolve,reject)=>{socket!.once("connect",resolve);socket!.once("error",reject);});
    socket.on("data",bytes=>frames.push(...decoder.push(Buffer.from(bytes))));
    socket.write(wire(FrameType.hello,{v:1,client:"cli",label:"remote viewer"}));
    await wait(()=>frames.some(f=>f.type===FrameType.snapshot));
    expect(JSON.parse(frames.find(f=>f.type===FrameType.snapshot)!.data.toString()).screenAnsi).toBe(record.snapshot().screenAnsi);
    socket.write(wire(FrameType.take,{}));
    await wait(()=>frames.some(f=>f.type===FrameType.control&&JSON.parse(f.data.toString()).you===true));
    socket.write(wire(FrameType.input,Buffer.from("input 🦊")));socket.write(wire(FrameType.size,{cols:80,rows:24}));
    await wait(()=>typed==="input 🦊"&&cols===80);
    socket.write(wire(FrameType.release,{}));await wait(()=>hub.controller===null);
    expect(readFileSync(log,"utf8")).toContain("-O forward");
    if(refused)expect(readFileSync(log,"utf8")).toContain("socket exec pipe");
    if(!refused){
      socket.destroy();await wait(()=>readFileSync(log,"utf8").includes("-O cancel"));
      const count=readFileSync(log,"utf8").split("-O forward").length;
      await io.read();expect(readFileSync(log,"utf8").split("-O forward").length).toBe(count);
      frames.length=0;
      socket=createConnection(socketPath(local));const nextDecoder=new WireDecoder();
      socket.on("data",bytes=>frames.push(...nextDecoder.push(Buffer.from(bytes))));
      await new Promise<void>((resolve,reject)=>{socket!.once("connect",resolve);socket!.once("error",reject);});
      socket.write(wire(FrameType.hello,{v:1}));await wait(()=>frames.some(f=>f.type===FrameType.snapshot));
      expect(readFileSync(log,"utf8").split("-O forward").length).toBe(count+1);
    }
  }finally{
    socket?.destroy();writeFileSync(join(remote,"exit"),"0");await io.read();
    hub.destroy();server.close();await record.close();
  }
},15000);

for(const lateRefusal of [false,true]) test(`exec fallback relays session frames over fake SSH (late refusal=${lateRefusal})`,async()=>{
  const {ctx,home,local,remote,log}=setup();
  const {RemoteSession}=await import("../src/remote/session");
  const {Duplex}=await import("node:stream");
  const {wire,FrameType,WireDecoder}=await import("../src/session/framing");
  const {createServer}=await import("node:net");
  const {socketPath}=await import("../src/session/host");
  mkdirSync(remote,{recursive:true});
  const remoteSocket=socketPath(remote), remoteServer=createServer();
  if(remoteSocket!==join(remote,"session.sock"))writeFileSync(join(remote,"session.sock.path"),remoteSocket);
  await new Promise<void>((resolve,reject)=>{remoteServer.once("error",reject);remoteServer.listen(remoteSocket,resolve);});
  // This executable stands in for a session socket endpoint in socket-restricted sandboxes.
  const pipe=join(home,"protocol.ts"),pidFile=join(home,"pipe.pid");
  writeFileSync(pipe,`
    import {writeFileSync} from "node:fs";
    writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    setInterval(()=>{},1000);
    import {wire,FrameType,WireDecoder} from ${JSON.stringify(new URL("../src/session/framing.ts",import.meta.url).pathname)};
    const decoder=new WireDecoder();
    process.stdin.on("data",bytes=>{for(const frame of decoder.push(bytes)) {
      if(frame.type===FrameType.hello)process.stdout.write(wire(FrameType.snapshot,{screenAnsi:"exact",cols:120,rows:40}));
      if(frame.type===FrameType.take)process.stdout.write(wire(FrameType.control,{you:true}));
      if(frame.type===FrameType.input)process.stdout.write(wire(FrameType.output,frame.data));
    }});
  `);
  writeFileSync(join(remote,"session.binary"),join(home,"fixture-pacer"));
  writeFileSync(join(home,"fixture-pacer"),`#!/bin/sh\nexec '${process.execPath}' '${pipe}'\n`,{mode:0o755});
  ctx.env.PACER_FAKE_FORWARD_REFUSED="1";
  const original=ctx.run;
  const commands:string[][]=[];
  ctx.run=(argv,ms,o)=>{
    commands.push(argv);
    if(argv.at(-1)?.includes('[ -S "$path" ]'))return Promise.resolve({code:0,stdout:"__PACER_BEGIN__\n/tmp/fixture.sock",stderr:""});
    if(lateRefusal && argv.includes("-O") && argv.includes("forward"))return Promise.resolve({code:0,stdout:"",stderr:""});
    return original(argv,ms,{...o,env:{...ctx.env,...o?.env}});
  };
  const bridge=new RemoteSession(ctx,host,remote,local);
  const frames:{type:number;data:Buffer}[]=[],decoder=new WireDecoder();
  const socket=new Duplex({read(){},write(data,_encoding,done){frames.push(...decoder.push(Buffer.from(data)));done();}});
  const wait=async(fn:()=>boolean)=>{for(let n=0;n<200&&!fn();n++)await Bun.sleep(10);expect(fn()).toBe(true);};
  try{
    await bridge.prepare();bridge.accept(socket as unknown as import("node:net").Socket);
    socket.push(wire(FrameType.hello,{v:1}));
    await wait(()=>frames.some(f=>f.type===FrameType.snapshot));
    socket.push(wire(FrameType.take,{}));
    await wait(()=>frames.some(f=>f.type===FrameType.control));
    socket.push(wire(FrameType.input,Buffer.from("control 🦊")));
    await wait(()=>frames.some(f=>f.type===FrameType.output&&f.data.toString()==="control 🦊"));
    expect(readFileSync(log,"utf8")).toContain("socket exec pipe");
    if(lateRefusal){
      await bridge.prepare();
      expect(readFileSync(log,"utf8").split('[ -S "$path" ]').length-1).toBe(2);
      expect(commands.filter(a=>a.includes("forward")).length).toBe(2);
    }
    expect(commands.find(a=>a.includes("-O")&&a.includes("forward"))).toEqual(expect.arrayContaining(["-L",expect.stringContaining("ControlPath=")]));
  }finally{
    socket.destroy();await bridge.close();remoteServer.close();
    const pid=Number(readFileSync(pidFile,"utf8"));
    const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
    try{await wait(()=>!alive());}finally{if(alive())process.kill(pid,"SIGKILL");}
  }
  if(lateRefusal)expect(commands.some(a=>a.includes("cancel"))).toBe(true);
});

test("native recording observation failures are retried as unreachable",async()=>{
  const ctx=fakeCtx({run:async argv=>argv.at(-1)?.includes("for stream in stdout stderr session.raw")
    ? {code:0,stdout:"__PACER_BEGIN__\nsession=builtin\npid=1\nalive=1\n",stderr:""}
    : {code:1,stdout:"",stderr:"rotation changed"}});
  await expect(new RemoteRunIO(ctx,host,"~/run",tmpDir()).read()).rejects.toBeInstanceOf(Unreachable);
});

test("forward preparation creates a private directory and removes stale socket paths",async()=>{
  const {RemoteSession}=await import("../src/remote/session");
  const {socketPath}=await import("../src/session/host");
  const {createServer}=await import("node:net");
  const {ctx,remote,local}=setup();
  mkdirSync(remote,{recursive:true});
  const remoteSocket=socketPath(remote),remoteServer=createServer();
  if(remoteSocket!==join(remote,"session.sock"))writeFileSync(join(remote,"session.sock.path"),remoteSocket);
  await new Promise<void>((resolve,reject)=>{remoteServer.once("error",reject);remoteServer.listen(remoteSocket,resolve);});
  let forwards=0;
  const run=ctx.run;
  ctx.run=async (argv,ms,o)=>{
    if(argv.includes("forward")){
      expect(statSync(join(local,"forward")).mode&0o777).toBe(0o700);
      expect(existsSync(socketPath(join(local,"forward")))).toBe(false);
      forwards++;
      return {code:0,stdout:"",stderr:""};
    }
    return run(argv,ms,o);
  };
  const first=new RemoteSession(ctx,host,remote,local);
  try{await first.prepare();}finally{await first.close();}
  expect(forwards).toBe(1);
  const {chmodSync}=await import("node:fs");
  chmodSync(join(local,"forward"),0o755);
  writeFileSync(socketPath(join(local,"forward")),"stale");
  const second=new RemoteSession(ctx,host,remote,local);
  try{await second.prepare();}finally{await second.close();remoteServer.close();}
  expect(forwards).toBe(2);
});

test("socket discovery waits for an actual remote socket",async()=>{
  const {ctx,remote}=setup();const {runRemote}=await import("../src/remote/ssh");
  const {SCRIPTS}=await import("../src/remote/scripts");
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.sock.path"),join(remote,"missing.sock"));
  expect((await runRemote(ctx,host,SCRIPTS.SESSION_SOCKET,[remote])).code).not.toBe(0);
});

test("native mirrors transfer only appended log bytes and changed retained files",async()=>{
  const {ctx,remote,local}=setup();const {rmSync,appendFileSync,renameSync}=await import("node:fs");
  enableFull(ctx);
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.host"),"builtin");writeFileSync(join(remote,"exit"),"0");
  for(const name of ["session.log","session.log.1","session.ckpt","session.state"])writeFileSync(join(remote,name),name==="session.state"?"state":"first");
  const registry=pluginRegistry(ctx), ranges:string[][]=[];
  const read=registry.readFromConfiguredHost.bind(registry);
  registry.readFromConfiguredHost=async (context,grant,signal)=>{ranges.push([...grant.resource.args]);return read(context,grant,signal);};
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local);
  await io.read();const retained=statSync(join(local,"session.ckpt")).mtimeMs;
  await io.read();
  const unchanged=ranges.length;
  expect(unchanged).toBe(4);
  expect(statSync(join(local,"session.ckpt")).mtimeMs).toBe(retained);
  appendFileSync(join(remote,"session.log"),"second");await io.read();
  expect(ranges.slice(unchanged)).toEqual([[remote,"session.log","5","6","hex"]]);
  expect(readFileSync(join(local,"session.log"),"utf8")).toBe("firstsecond");
  renameSync(join(remote,"session.log"),join(remote,"session.log.1"));writeFileSync(join(remote,"session.log"),"new");
  writeFileSync(join(remote,"session.ckpt"),"next");await io.read();
  expect(ranges.some(args=>args[1]==="session.log.1"&&args[2]==="0")).toBe(true);
  expect(readFileSync(join(local,"session.log"),"utf8")).toBe("new");
  expect(readFileSync(join(local,"session.log.1"),"utf8")).toBe("firstsecond");
  expect(readFileSync(join(local,"session.ckpt"),"utf8")).toBe("next");
  rmSync(join(remote,"session.log.1"));await io.read();expect(existsSync(join(local,"session.log.1"))).toBe(false);
});

test("full-session mirror pages a recording larger than one plugin response", async () => {
  const { ctx, remote, local } = setup();
  enableFull(ctx);
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "builtin");
  writeFileSync(join(remote, "exit"), "0");
  const bytes = randomBytes(1024 * 1024 + 17);
  writeFileSync(join(remote, "session.log"), bytes);
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  await io.read();
  expect(readFileSync(join(local, "session.log"))).toEqual(bytes);
});

test("full-session mirror retains a bounded cursor across polls before publishing a large recording", async () => {
  const { ctx, remote, local } = setup();
  enableFull(ctx);
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "builtin");
  writeFileSync(join(remote, "exit"), "0");
  const bytes = randomBytes(5 * 1024 * 1024);
  writeFileSync(join(remote, "session.log"), bytes);
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  expect((await io.read()).exit).toBeNull();
  expect(existsSync(join(local, "session.log"))).toBe(false);
  const staleTemp = join(local, ".session-files-paging", "manifest.json.tmp-crashed-writer");
  writeFileSync(staleTemp, "stale", { mode: 0o600 });
  const taskId = remote.split("/").at(-2)!;
  updateTask(ctx, taskId, task => { task.state = "running"; });
  const restarted = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  expect((await restarted.read()).exit).toBe(0);
  expect(existsSync(staleTemp)).toBe(false);
  expect(readFileSync(join(local, "session.log"))).toEqual(bytes);
}, 30_000);

test("full-session state read never exceeds an exhausted recording poll budget", async () => {
  const { ctx, remote, local } = setup();
  enableFull(ctx);
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "builtin");
  writeFileSync(join(remote, "exit"), "0");
  writeFileSync(join(remote, "session.log"), Buffer.alloc(4 * 1024 * 1024, 0x61));
  writeFileSync(join(remote, "session.state"), "viewer");
  const registry = pluginRegistry(ctx), original = registry.readFromConfiguredHost.bind(registry);
  let requested = 0;
  registry.readFromConfiguredHost = async (context, grant, signal) => {
    requested += Number(grant.resource.args[3]);
    return original(context, grant, signal);
  };
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  expect((await io.read()).exit).toBe(0);
  expect(requested).toBe(4 * 1024 * 1024);
  expect(existsSync(join(local, "session.state"))).toBe(false);
  expect(readFileSync(join(local, "session.log")).length).toBe(4 * 1024 * 1024);
  await io.read();
  expect(requested).toBe(4 * 1024 * 1024 + 6);
  expect(readFileSync(join(local, "session.state"), "utf8")).toBe("viewer");
}, 30_000);

test("a rotated generation discards a retained paging cursor", async () => {
  const { ctx, remote, local } = setup();
  enableFull(ctx);
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "builtin");
  writeFileSync(join(remote, "exit"), "0");
  writeFileSync(join(remote, "session.log"), Buffer.alloc(5 * 1024 * 1024, 0x61));
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  expect((await io.read()).exit).toBeNull();
  expect(existsSync(join(local, ".session-files-paging/manifest.json"))).toBe(true);
  const { renameSync } = await import("node:fs");
  renameSync(join(remote, "session.log"), join(remote, "session.log.1"));
  writeFileSync(join(remote, "session.log"), "new generation");
  writeFileSync(join(remote, "session.ckpt"), "new checkpoint");
  expect((await io.read()).exit).toBeNull();
  expect(existsSync(join(local, "session.log"))).toBe(false);
  expect((await io.read()).exit).toBe(0);
  expect(readFileSync(join(local, "session.log"), "utf8")).toBe("new generation");
  expect(readFileSync(join(local, "session.log.1"))).toEqual(Buffer.alloc(5 * 1024 * 1024, 0x61));
}, 30_000);

test("full-session mirror refuses rotation during pagination without publishing a mixed set", async () => {
  const { ctx, remote, local } = setup();
  enableFull(ctx);
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "builtin");
  writeFileSync(join(remote, "exit"), "0");
  writeFileSync(join(remote, "session.log"), "old log");
  writeFileSync(join(remote, "session.ckpt"), "old checkpoint");
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  await io.read();
  const priorLog = readFileSync(join(local, "session.log"));
  const priorCheckpoint = readFileSync(join(local, "session.ckpt"));
  writeFileSync(join(remote, "session.log"), Buffer.alloc(300_000, 0x61));
  const registry = pluginRegistry(ctx), original = registry.readFromConfiguredHost.bind(registry);
  let changed = false;
  registry.readFromConfiguredHost = async (context, grant, signal) => {
    const result = await original(context, grant, signal);
    if (!changed) { changed = true; writeFileSync(join(remote, "session.ckpt"), "new checkpoint"); }
    return result;
  };
  await expect(io.read()).rejects.toBeInstanceOf(Unreachable);
  expect(readFileSync(join(local, "session.log"))).toEqual(priorLog);
  expect(readFileSync(join(local, "session.ckpt"))).toEqual(priorCheckpoint);
});

test("full-session state churn does not block stable multi-page recording bytes", async () => {
  const { ctx, remote, local } = setup();
  enableFull(ctx);
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "builtin");
  writeFileSync(join(remote, "exit"), "0");
  writeFileSync(join(remote, "session.log"), "old log");
  writeFileSync(join(remote, "session.state"), "old state");
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  await io.read();
  const bytes = Buffer.concat([Buffer.from("old log"), Buffer.alloc(300_000, 0x61)]);
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(remote, "session.log"), bytes.subarray(7));
  const registry = pluginRegistry(ctx), original = registry.readFromConfiguredHost.bind(registry);
  let changed = false;
  registry.readFromConfiguredHost = async (context, grant, signal) => {
    const result = await original(context, grant, signal);
    if (!changed) { changed = true; writeFileSync(join(remote, "session.state"), "new viewer state"); }
    return result;
  };
  expect((await io.read()).exit).toBe(0);
  expect(readFileSync(join(local, "session.log"))).toEqual(bytes);
  expect(readFileSync(join(local, "session.state"), "utf8")).toBe("old state");
});

test("full-session mirror refuses a short range without changing the last local recording", async () => {
  const { ctx, remote, local } = setup();
  enableFull(ctx);
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, "session.host"), "builtin");
  writeFileSync(join(remote, "exit"), "0");
  writeFileSync(join(remote, "session.log"), "old log");
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  await io.read();
  writeFileSync(join(remote, "session.log"), Buffer.alloc(300_000, 0x61));
  const registry = pluginRegistry(ctx);
  registry.readFromConfiguredHost = async () => ({ code: 0, stdout: "aa", stderr: "", timedOut: false });
  await expect(io.read()).rejects.toBeInstanceOf(Unreachable);
  expect(readFileSync(join(local, "session.log"), "utf8")).toBe("old log");
});

test("full-session metadata refusal does not retry direct SSH", async () => {
  const { ctx, remote, local, log } = setup();
  enableFull(ctx);
  const registry = pluginRegistry(ctx);
  registry.reportConfiguredHost = async () => ({ code: 0, stdout: "session=builtin\nexit=0\n", stderr: "", timedOut: false });
  await registry.disable(ctx, "pacer-ssh");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const io = new RemoteRunIO(ctx, { ...host, session: "full" }, remote, local);
  await expect(io.read()).rejects.toBeInstanceOf(Unreachable);
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});

test("recording publication rolls back a failed second replacement and recovers after restart", async () => {
  const { renameSync } = await import("node:fs");
  const local = tmpDir(), stage = tmpDir();
  writeFileSync(join(local, "session.ckpt"), "old checkpoint");
  writeFileSync(join(local, "session.log"), "old log");
  writeFileSync(join(stage, "session.ckpt"), "new checkpoint");
  writeFileSync(join(stage, "session.log"), "new log");
  const snapshot: SessionFilesSnapshot = {
    "session.ckpt": { bytes: 14, sum: "changed" }, "session.log.1": { bytes: null, sum: "" },
    "session.log": { bytes: 7, sum: "2" }, "session.state": { bytes: null, sum: "" },
  };
  let replacements = 0;
  expect(() => publishSessionFiles(local, stage, ["session.ckpt", "session.log"], snapshot, (source, target) => {
    if (++replacements === 2) throw Error("injected publish failure");
    renameSync(source, target);
  })).toThrow("injected publish failure");
  expect(readFileSync(join(local, "session.ckpt"), "utf8")).toBe("old checkpoint");
  expect(readFileSync(join(local, "session.log"), "utf8")).toBe("old log");

  const backup = join(local, ".session-files-rollback");
  mkdirSync(backup, { mode: 0o700 });
  writeFileSync(join(backup, "session.ckpt"), "old checkpoint");
  writeFileSync(join(backup, "session.log"), "old log");
  writeFileSync(join(local, ".session-files-rollback.json"), JSON.stringify([
    { name: "session.ckpt", present: true }, { name: "session.log", present: true },
  ]));
  writeFileSync(join(local, "session.ckpt"), "partially published");
  recoverSessionFiles(local);
  expect(readFileSync(join(local, "session.ckpt"), "utf8")).toBe("old checkpoint");
  expect(readFileSync(join(local, "session.log"), "utf8")).toBe("old log");
  expect(existsSync(join(local, ".session-files-rollback.json"))).toBe(false);
});

test("START rejects a binary tampered with after upload",async()=>{
  const {ctx,home,remote,local}=setup();
  enableFull(ctx);
  const binary=join(tmpDir(),"pacer"),marker=join(home,"tampered-executed");
  writeFileSync(binary,"#!/bin/sh\nexit 0\n",{mode:0o755});
  const hash=new Bun.CryptoHasher("sha256").update(readFileSync(binary)).digest("hex");
  const ssh=ctx.which("ssh")!, source=readFileSync(ssh,"utf8");
  const command=`exec ${JSON.stringify(join(import.meta.dir,"fixtures","bin","ssh"))} "$@"`;
  expect(source).toContain(command);
  writeFileSync(ssh,source.replace(command,`for arg in "$@"; do last="$arg"; done
case "$last" in
  *"start.error"*) printf '%s\\n' '#!/bin/sh' 'touch ${marker}' > ${JSON.stringify(join(home,".pacer-remote/bin",hash,"pacer"))} ;;
esac
${command}`),{mode:0o755});
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local,{binary});
  const began=Date.now(),result=await io.start(["true"],home,{},"");
  expect(result).toEqual({error:"remote start refused: runtime binary failed its hash check"});
  // The refusal is reported at once, not after START's 5 s wait for a pid.
  expect(Date.now()-began).toBeLessThan(4000);
  expect(existsSync(marker)).toBe(false);
},10000);

test("service exit cancels its full-session SSH forward",async()=>{
  const {ctx,home,local,remote,log}=setup();const file=join(home,"exit-forward.ts");
  const {createServer}=await import("node:net");
  const {socketPath}=await import("../src/session/host");
  mkdirSync(remote,{recursive:true});
  const remoteSocket=socketPath(remote),remoteServer=createServer();
  if(remoteSocket!==join(remote,"session.sock"))writeFileSync(join(remote,"session.sock.path"),remoteSocket);
  await new Promise<void>((resolve,reject)=>{remoteServer.once("error",reject);remoteServer.listen(remoteSocket,resolve);});
  writeFileSync(file,`
    import {RemoteSession} from ${JSON.stringify(new URL("../src/remote/session.ts",import.meta.url).pathname)};
    import {fakeCtx,realRun} from ${JSON.stringify(new URL("./helpers.ts",import.meta.url).pathname)};
    const ctx=fakeCtx({home:process.env.HOST_HOME,pacerHome:process.env.PACER_HOME,env:process.env,
      run:(argv,ms,o)=>argv.includes("forward")?Promise.resolve({code:0,stdout:"",stderr:""}):realRun(argv,ms,{...o,env:{...process.env,...o?.env}}),
      which:name=>name==="ssh"?process.env.FAKE_SSH!:null});
    const bridge=new RemoteSession(ctx,{alias:"box",ssh:"box-ssh",repos:{},maxTasks:2,accounts:{}} as any,process.env.REMOTE!,process.env.LOCAL!);
    await bridge.prepare();process.exit(0);
  `);
  const proc=Bun.spawn([process.execPath,file],{env:{...ctx.env,PACER_HOME:ctx.pacerHome,HOST_HOME:ctx.home,FAKE_SSH:ctx.which("ssh")!,REMOTE:remote,LOCAL:local},stdout:"ignore",stderr:"pipe"});
  try{expect(await proc.exited).toBe(0);}finally{remoteServer.close();}
  expect(readFileSync(log,"utf8")).toContain("-O cancel");
});
