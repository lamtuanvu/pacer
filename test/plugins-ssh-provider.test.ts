import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRepoArgv, CHECK_REPO_SCRIPT, preflightArgv, PREFLIGHT_SCRIPT, probeArgv, PROBE_SCRIPT,
  setIdentityArgv, SET_IDENTITY_SCRIPT } from "../plugins/pacer-ssh/probe";
import { SCRIPTS } from "../src/remote/scripts";
import { controlDir, sshArgv } from "../src/remote/ssh";
import { fakeCtx, tmpDir } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { manifestSchema } from "../src/plugins/protocol";
import { handlers } from "../plugins/pacer-ssh/index";
import type { HostClient } from "@pacer/plugin";
import { createTask, updateTask } from "../src/tasks/store";
import { issuePersistedFetch } from "../src/plugins/fetch-issuer";
import { resolveStagedBundle } from "../src/plugins/bundle-stage";

test("SSH reference provider emits exactly the host-issued read-only probe command", () => {
  const home = tmpDir(), ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const host = { alias: "box", ssh: "ssh-fixture", repos: {}, accounts: {}, maxTasks: 1 };
  const controlPath = join(controlDir(ctx), "cm-%C");
  expect(PROBE_SCRIPT).toBe(SCRIPTS.PROBE);
  expect(probeArgv(host.ssh, controlPath)).toEqual(sshArgv(ctx, host, SCRIPTS.PROBE, []));
});

test("SSH reference provider emits only the host-issued read-only repo check command", () => {
  const home = tmpDir(), ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const host = { alias: "box", ssh: "ssh-fixture", repos: {}, accounts: {}, maxTasks: 1 };
  const controlPath = join(controlDir(ctx), "cm-%C");
  expect(CHECK_REPO_SCRIPT).toBe(SCRIPTS.CHECK_REPO);
  expect(checkRepoArgv(host.ssh, controlPath, "~/repo")).toEqual(sshArgv(ctx, host, SCRIPTS.CHECK_REPO, ["~/repo", "check"]));
});

test("SSH reference provider builds the exact fixed BUNDLE_OUT argv", async () => {
  const program = await import("../plugins/pacer-ssh/probe");
  expect(program.BUNDLE_OUT_SCRIPT).toBe(SCRIPTS.BUNDLE_OUT);
  const home = tmpDir(), ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const configured = { alias: "box", ssh: "ssh-fixture", repos: {}, accounts: {}, maxTasks: 1 };
  const controlPath = join(controlDir(ctx), "cm-%C");
  const args = ["/remote/worktree", "a".repeat(40), "pacer/task"] as [string, string, string];
  expect(program.bundleOutArgv(configured.ssh, controlPath, args))
    .toEqual(sshArgv(ctx, configured, SCRIPTS.BUNDLE_OUT, args));
});

test("SSH reference provider builds only the fixed persisted-run PREFLIGHT argv", async () => {
  const home = tmpDir(), ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const configured = { alias: "box", ssh: "ssh-fixture", repos: {}, accounts: {}, maxTasks: 1 };
  const controlPath = join(controlDir(ctx), "cm-%C");
  const args = ["/remote/worktree", "a".repeat(40), "pacer/task"] as const;
  expect(PREFLIGHT_SCRIPT).toBe(SCRIPTS.PREFLIGHT);
  expect(preflightArgv(configured.ssh, controlPath, args))
    .toEqual(sshArgv(ctx, configured, SCRIPTS.PREFLIGHT, [...args]));
  expect(() => preflightArgv(configured.ssh, controlPath, ["/remote/worktree", "bad", "pacer/task"]))
    .toThrow();
});

test("SSH reference provider runs only the exact issued SET_IDENTITY command", async () => {
  const home = tmpDir(), ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const controlPath = join(controlDir(ctx), "cm-%C");
  const args = ["~/repo", "Example", "example@example.invalid"];
  expect(SET_IDENTITY_SCRIPT).toBe(SCRIPTS.SET_IDENTITY);
  const completionNonce = "123e4567-e89b-42d3-a456-426614174000";
  expect(setIdentityArgv("ssh-fixture", controlPath, args, completionNonce)).toEqual(sshArgv(ctx,
    { alias: "box", ssh: "ssh-fixture", repos: {}, accounts: {}, maxTasks: 1 }, SCRIPTS.SET_IDENTITY, args,
    completionNonce));
  const calls: { method: string; argv: string[] }[] = [];
  const host = { call: async (method: string, params: { argv: string[] }) => {
    calls.push({ method, argv: params.argv });
    return { code: 0, stdout: "__PACER_BEGIN__\n", stderr: "", timedOut: false };
  } } as unknown as HostClient;
  const signal = new AbortController().signal;
  const opened = await handlers["hostRunner.open"]!(
    { alias: "box", sshTarget: "ssh-fixture", controlPath }, host, signal) as { session: string };
  const request = { session: opened.session, script: "SET_IDENTITY", args,
    timeoutMs: 1000, maxBytes: 1024, completionNonce };
  try {
    for (const bad of [{ ...request, args: ["../other", ...args.slice(1)] },
      { ...request, completionNonce: "forged" },
      { ...request, stdin: "unexpected" }, { ...request, args: ["~/repo", "", args[2]] }])
      await expect(handlers["hostRunner.run"]!(bad, host, signal))
        .rejects.toMatchObject({ code: "capability_denied" });
    expect(calls).toHaveLength(0);
    await expect(handlers["hostRunner.run"]!(request, host, signal))
      .resolves.toMatchObject({ code: 0, stdout: "" });
    expect(calls).toEqual([{ method: "capability.process.spawn", argv: setIdentityArgv("ssh-fixture", controlPath, args,
      completionNonce) }]);
  } finally { await handlers["hostRunner.close"]!({ session: opened.session }, host, signal); }
});

test("SSH fetch admits only BUNDLE_OUT in an owned session and returns an opaque stage handle", async () => {
  const calls: { method: string; params: any }[] = [];
  const handle = "123e4567-e89b-42d3-a456-426614174000";
  let response: unknown = { handle, bytes: 3, sha256: "a".repeat(64) };
  const host = { call: async (method: string, params: any) => {
    calls.push({ method, params });
    return response;
  } } as unknown as HostClient;
  const fetch = handlers["hostRunner.fetch"];
  expect(typeof fetch).toBe("function");
  const signal = new AbortController().signal;
  const home = tmpDir(), ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const controlPath = join(controlDir(ctx), "cm-%C");
  const opened = await handlers["hostRunner.open"]!(
    { alias: "box", sshTarget: "ssh-fixture", controlPath }, host, signal) as { session: string };
  const request = { session: opened.session, script: "BUNDLE_OUT", args: ["/remote/worktree", "a".repeat(40), "pacer/task"],
    timeoutMs: 1000, maxBytes: 16 };
  try {
    for (const bad of [
      { ...request, session: "a".repeat(32) }, { ...request, script: "PREPARE" },
      { ...request, args: ["/remote/worktree", "bad", "pacer/task"] },
      { ...request, args: ["/remote/worktree", "a".repeat(40), "other/task"] },
      { ...request, maxBytes: 50 * 1024 * 1024 + 1 }, { ...request, timeoutMs: 60_001 },
      { ...request, stdin: "secret" },
    ]) await expect(fetch!(bad, host, signal)).rejects.toMatchObject({ code: "capability_denied" });
    expect(calls).toHaveLength(0);
    expect(await fetch!(request, host, signal)).toEqual({ handle, bytes: 3, sha256: "a".repeat(64) });
    expect(calls).toEqual([{ method: "capability.process.stageBundle", params: {
      argv: sshArgv(ctx,
        { alias: "box", ssh: "ssh-fixture", repos: {}, accounts: {}, maxTasks: 1 }, SCRIPTS.BUNDLE_OUT,
        request.args), timeoutMs: 1000, maxBytes: 16 } }]);
    response = { handle: "../forged.bundle", bytes: 3, sha256: "a".repeat(64) };
    await expect(fetch!(request, host, signal)).rejects.toMatchObject({ code: "plugin_refused" });
    response = { handle, bytes: 17, sha256: "a".repeat(64) };
    await expect(fetch!(request, host, signal)).rejects.toMatchObject({ code: "plugin_refused" });
  } finally { await handlers["hostRunner.close"]!({ session: opened.session }, host, signal); }
  await expect(fetch!(request, host, signal)).rejects.toMatchObject({ code: "capability_denied" });
});

test("installed SSH provider stages BUNDLE_OUT bytes for the live host owner", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-ssh-bundle-provider-"));
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), fakeSsh = join(bin, "ssh");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const source = join(import.meta.dir, "..", "plugins", "pacer-ssh");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "pacer-plugin.json"])
    copyFileSync(join(source, file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "ssh-argv.log")}'\nprintf '__PACER_BEGIN__\\nabc'\n`);
  chmodSync(fakeSsh, 0o755);
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? fakeSsh : null, now: Date.now() / 1000 });
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled provider"); }, eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "pacer-ssh", true);
    const task = createTask(ctx, { brief: { goal: "fetch", repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, task.id, record => { record.run = { dir: join(pacerHome, "runs", task.id),
      attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: "/remote/worktree",
      logFile: join(pacerHome, "tasks", "run.log"), host: "box", remoteWorktree: "/remote/worktree",
      baseSha: "a".repeat(40), remoteBranch: `pacer/${task.id}` }; });
    const opened = await registry.call<{ session: string }>(ctx, "pacer-ssh", "hostRunner.open",
      { alias: "box", sshTarget: "ssh-fixture", controlPath: join(controlDir(ctx), "cm-%C") });
    const grant = issuePersistedFetch(ctx, task.id, 1, 16, 1000);
    let stagePath = "";
    await registry.callIssuedHostFetch(ctx, "pacer-ssh", grant,
      { session: opened.session, script: "BUNDLE_OUT", args: grant.resource.args, timeoutMs: 1000, maxBytes: 16 },
      (authority, staged) => {
        expect(staged).toMatchObject({ bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
        stagePath = resolveStagedBundle(authority, staged.handle).path;
        expect(readFileSync(stagePath).toString()).toBe("abc");
      });
    expect(existsSync(stagePath)).toBe(false);
    const argv = readFileSync(join(home, "ssh-argv.log"), "utf8");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("ssh-fixture");
    expect(argv).toContain("bundle create");
    await registry.call(ctx, "pacer-ssh", "hostRunner.close", { session: opened.session });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

test("SSH provider check accepts only a host snapshot and read-only configured path", async () => {
  const calls: { argv: string[] }[] = [];
  const host = { call: async (_method: string, params: { argv: string[] }) => {
    calls.push(params);
    return { code: 0, stdout: "__PACER_BEGIN__\nexists=1\ngit=1\n", stderr: "", timedOut: false };
  } } as unknown as HostClient;
  const check = handlers["hostRunner.check"]!;
  const signal = new AbortController().signal;
  for (const input of [
    { alias: "box" },
    { alias: "box", repo: "~/repo", sshTarget: "-bad", controlPath: "/tmp/private/cm-%C" },
    { alias: "box", repo: "~/repo", sshTarget: "box", controlPath: "relative/cm-%C" },
    { alias: "box", repo: "", sshTarget: "box", controlPath: "/tmp/private/cm-%C" },
  ]) await expect(check(input, host, signal)).rejects.toMatchObject({ code: "capability_denied" });
  expect(calls).toHaveLength(0);
  const result = await check({ alias: "box", repo: "~/repo", sshTarget: "box", controlPath: "/tmp/private/cm-%C" }, host, signal);
  expect(result).toMatchObject({ ok: true, checks: [{ name: "checkout", ok: true }] });
  expect(calls[0]?.argv).toEqual(checkRepoArgv("box", "/tmp/private/cm-%C", "~/repo"));
});

test("SSH provider rejects unissued operations and foreign sessions before spawn", async () => {
  const calls: unknown[] = [];
  const host = { call: async (_method: string, params: unknown) => {
    calls.push(params);
    return { code: 0, stdout: "__PACER_BEGIN__\nos=Fake\n", stderr: "", timedOut: false };
  } } as unknown as HostClient;
  const signal = new AbortController().signal;
  const open = handlers["hostRunner.open"]!;
  const run = handlers["hostRunner.run"]!;
  const close = handlers["hostRunner.close"]!;
  await expect(open({ alias: "box", sshTarget: "-BadTarget", controlPath: "/tmp/private/cm-%C" }, host, signal))
    .rejects.toMatchObject({ code: "invalid_input" });
  await expect(open({ alias: "box", sshTarget: "box", controlPath: "relative/cm-%C" }, host, signal))
    .rejects.toMatchObject({ code: "invalid_input" });
  const opened = await open({ alias: "box", sshTarget: "box", controlPath: "/tmp/private/cm-%C" }, host, signal) as { session: string };
  const request = { session: opened.session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 1024 };
  for (const invalid of [
    { ...request, script: "CLEAN" }, { ...request, args: ["--anything"] },
    { ...request, script: "CHECK_REPO", args: ["~/repo", "clone"] },
    { ...request, script: "CHECK_REPO", args: ["~/repo", "check", "extra"] },
    { ...request, script: "CHECK_REPO", args: ["", "check"] },
    { ...request, stdin: "input" }, { ...request, maxBytes: 65_537 },
    { ...request, session: "a".repeat(32) },
  ]) await expect(run(invalid, host, signal)).rejects.toMatchObject({ code: "capability_denied" });
  expect(calls).toHaveLength(0);
  expect(await run(request, host, signal)).toEqual({ code: 0, stdout: "os=Fake\n", stderr: "", timedOut: false });
  expect(calls).toHaveLength(1);
  expect(await run({ ...request, script: "CHECK_REPO", args: ["~/repo", "check"] }, host, signal))
    .toEqual({ code: 0, stdout: "os=Fake\n", stderr: "", timedOut: false });
  expect(calls).toHaveLength(2);
  await close({ session: opened.session }, host, signal);
  await expect(run(request, host, signal)).rejects.toMatchObject({ code: "capability_denied" });
  expect(calls).toHaveLength(2);
});

test("SSH provider rejects missing frames, connection failure and oversized output", async () => {
  let result = { code: 0, stdout: "noise", stderr: "", timedOut: false };
  const host = { call: async () => result } as unknown as HostClient;
  const signal = new AbortController().signal;
  const opened = await handlers["hostRunner.open"]!(
    { alias: "box", sshTarget: "box", controlPath: "/tmp/private/cm-%C" }, host, signal) as { session: string };
  const request = { session: opened.session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 32 };
  try {
    await expect(handlers["hostRunner.run"]!(request, host, signal)).rejects.toMatchObject({ code: "plugin_refused" });
    result = { code: 255, stdout: "", stderr: "connection refused", timedOut: false };
    await expect(handlers["hostRunner.run"]!(request, host, signal)).rejects.toMatchObject({ code: "plugin_unavailable" });
    result = { code: 0, stdout: `__PACER_BEGIN__\n${"x".repeat(33)}`, stderr: "", timedOut: false };
    await expect(handlers["hostRunner.run"]!(request, host, signal)).rejects.toMatchObject({ code: "too_large" });
  } finally {
    await handlers["hostRunner.close"]!({ session: opened.session }, host, signal);
  }
});

test("installed SSH reference provider uses only an issued probe through a fake executable", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-ssh-provider-"));
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), fakeSsh = join(bin, "ssh");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const source = join(import.meta.dir, "..", "plugins", "pacer-ssh");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "pacer-plugin.json"])
    copyFileSync(join(source, file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf 'called\\n' >> '${join(home, "ssh-calls.log")}'\nprintf '%s\\n' "$*" >> '${join(home, "ssh-argv.log")}'\nprintf '__PACER_BEGIN__\\nos=Fake\\narch=test\\n'\n`);
  chmodSync(fakeSsh, 0o755);
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? fakeSsh : null, now: Date.now() / 1000 });
  const callerManifest = manifestSchema.parse({ id: "host-broker-caller", version: "1.0.0", publisher: "pacer", host: "^1.5",
    contributes: {}, capabilities: [{ name: "hosts" }], reentrant: true });
  const registry = new PluginRegistry({ bundled: [{ manifest: callerManifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "fixtures", "host-broker", "caller.ts")], cwd: home, env: {} }), eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "pacer-ssh", true);
    const result = await registry.call<{ output: string }>(ctx, "host-broker-caller", "diagnostic.ping", {});
    expect(result.output).toBe("os=Fake\narch=test\n");
    const log = readFileSync(join(home, "ssh-argv.log"), "utf8");
    expect(log).toContain("ssh-fixture");
    expect(log).toContain("BatchMode=yes");
    expect(log).not.toContain("ECHO_STDIN");
    expect(readFileSync(join(home, "ssh-calls.log"), "utf8")).toBe("called\n");
    const direct = await registry.call<{ session: string }>(ctx, "pacer-ssh", "hostRunner.open",
      { alias: "box", sshTarget: "ssh-fixture", controlPath: join(controlDir(ctx), "cm-%C") });
    await expect(registry.call(ctx, "pacer-ssh", "hostRunner.run",
      { session: direct.session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 1024 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readFileSync(join(home, "ssh-calls.log"), "utf8")).toBe("called\n");
    await registry.call(ctx, "pacer-ssh", "hostRunner.close", { session: direct.session });
  } finally {
    await registry.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});

test("host issues one exact check command to the installed provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-ssh-check-"));
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), fakeSsh = join(bin, "ssh");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const source = join(import.meta.dir, "..", "plugins", "pacer-ssh");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "pacer-plugin.json"])
    copyFileSync(join(source, file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf 'called\\n' >> '${join(home, "ssh-calls.log")}'\nprintf '%s\\n' "$*" >> '${join(home, "ssh-argv.log")}'\n[ -f '${join(home, "pause-check")}' ] && sleep 5\nprintf '__PACER_BEGIN__\\nexists=1\\ngit=1\\n'\n`);
  chmodSync(fakeSsh, 0o755);
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    repos: {example.test/acme/repo: ~/repo}\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? fakeSsh : null, now: Date.now() / 1000 });
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled caller"); }, eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "pacer-ssh", true);
    await expect(registry.checkConfiguredHost(ctx, "box", "~/other"))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(existsSync(join(home, "ssh-calls.log"))).toBe(false);
    const checked = await registry.checkConfiguredHost(ctx, "box", "~/repo");
    expect(checked).toMatchObject({ ok: true, checks: [{ name: "checkout", ok: true }] });
    expect(readFileSync(join(home, "ssh-calls.log"), "utf8")).toBe("called\n");
    expect(readFileSync(join(home, "ssh-argv.log"), "utf8")).toEndWith(" pacer '~/repo' check\n");
    await expect(registry.call(ctx, "pacer-ssh", "hostRunner.check", { alias: "box", repo: "~/repo",
      sshTarget: "ssh-fixture", controlPath: join(controlDir(ctx), "cm-%C") }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readFileSync(join(home, "ssh-calls.log"), "utf8")).toBe("called\n");
    writeFileSync(join(home, "pause-check"), "");
    const controller = new AbortController(), pending = registry.checkConfiguredHost(ctx, "box", "~/repo", controller.signal);
    const until = Date.now() + 2000;
    while (readFileSync(join(home, "ssh-calls.log"), "utf8") !== "called\ncalled\n" && Date.now() < until)
      await Bun.sleep(10);
    expect(readFileSync(join(home, "ssh-calls.log"), "utf8")).toBe("called\ncalled\n");
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    const changed = registry.checkConfiguredHost(ctx, "box", "~/repo");
    const changedUntil = Date.now() + 2000;
    while (readFileSync(join(home, "ssh-calls.log"), "utf8") !== "called\ncalled\ncalled\n" && Date.now() < changedUntil)
      await Bun.sleep(10);
    expect(readFileSync(join(home, "ssh-calls.log"), "utf8")).toBe("called\ncalled\ncalled\n");
    writeFileSync(join(pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-changed\n    repos: {example.test/acme/repo: ~/repo}\n");
    await expect(changed).rejects.toBeDefined();
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
