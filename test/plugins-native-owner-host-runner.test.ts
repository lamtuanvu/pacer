import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { manifest as sshManifest } from "../plugins/pacer-ssh/manifest";
import { holdOwnerKey } from "../src/plugins/host-bridge";
import { issueConfiguredHostPrepare } from "../src/plugins/host-prepare-issuer";
import { issueConfiguredHostReport } from "../src/plugins/host-report-issuer";
import { issueConfiguredHostStop } from "../src/plugins/host-stop-issuer";
import { manifestSchema } from "../src/plugins/protocol";
import { PluginRegistry } from "../src/plugins/registry";
import { createTask, updateTask } from "../src/tasks/store";
import { gitRepo, fakeCtx, realRun } from "./helpers";
import { front, makeHome, ownerOn, serve, type Home } from "./native-plugin-door";

// B0a: with PACER_NATIVE_PLUGIN_HOST=1 Core pins every host-issued SSH sequence to the owner lane that
// served its diagnostic.ping (expectPid; the owner replies its pid). So the configured host legs
// (STOP, REPORT, host check) and the remote stop run under flag-on exactly as flag-off. Staged-input
// legs stay refused flag-on because the native process owner bridge does not carry a staged command.

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// STOP gets its completion receipt; every other script gets a REPORT-shaped payload.
const SSH = (log: string) => `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nnonce=$(printf '%s' "$*" | sed -n 's/.*__PACER_DONE__=\\([a-f0-9-]*\\).*/\\1/p')\nif [ -n "$nonce" ]; then printf '__PACER_BEGIN__\\ncode=137\\nkilled=1\\n\\n__PACER_DONE__=%s\\n' "$nonce"; else printf '__PACER_BEGIN__\\nalive=0\\nexit=137\\npid=4242\\n'; fi\n`;

function deps() {
  return {
    bundled: [{ manifest: manifestSchema.parse(sshManifest), main: () => import("../plugins/pacer-ssh/index") }],
    spawnBundled: () => ({ argv: [process.execPath, cli, "plugin", "run", "pacer-ssh"], cwd: process.cwd(), env: {} }),
  };
}

/** One short home with a running remote task, a fake `ssh`, and the bundled pacer-ssh, flag-off or on. */
async function legs(flag: boolean) {
  const h = makeHome(), bin = join(h.home, "bin"), ssh = join(bin, "ssh"), log = join(h.home, "ssh.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(ssh, SSH(log)); chmodSync(ssh, 0o755);
  writeFileSync(join(h.state, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: box\n");
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state, run: realRun,
    env: { PACER_PORT: process.env.PACER_PORT!, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? ssh : null });
  const id = createTask(ctx, { brief: { goal: "run", repo: h.home }, kind: null, requestedExecutor: null, timeoutS: 60 }).id;
  const remote = `/remote/.pacer-remote/runs/${id}/1`, local = join(h.state, "runs", id, "1");
  updateTask(ctx, id, record => { record.state = "running";
    record.run = { host: "box", mode: "new", remoteDir: remote, remoteWorktree: "/remote/worktree",
      workdir: "/remote/worktree", dir: local, attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" }; });
  const registry = new PluginRegistry(deps());
  cleanups.push(() => registry.shutdown());
  let service: Awaited<ReturnType<typeof serve>> | undefined;
  if (flag) {
    service = await serve(h, "", { ...ownerOn, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
    cleanups.push(() => service?.stop());
    holdOwnerKey(readFileSync(join(h.state, "run", "host.key"), "utf8").trim());
    ctx.env.PACER_HOST_SOCKET = join(h.state, "run", "host.sock");
  }
  await registry.enable(ctx, "pacer-ssh", true);
  return { h, ctx, registry, ssh, log, remote, local, id };
}

test.skipIf(!front)("flag-on configured STOP runs through the owner as flag-off", async () => {
  for (const flag of [false, true]) {
    const f = await legs(flag); cleanups.push(() => f.h.done());
    const grant = issueConfiguredHostStop(f.ctx, "box", f.remote, f.local, 5);
    const result = await f.registry.stopConfiguredHost(f.ctx, grant);
    expect(result).toEqual({ code: 0, stdout: "code=137\nkilled=1\n", stderr: "", timedOut: false });
    expect(readFileSync(f.log, "utf8")).toContain("BatchMode=yes");
    await expect(f.registry.stopConfiguredHost(f.ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
  }
}, 90000);

test.skipIf(!front)("flag-on configured REPORT runs through the owner as flag-off", async () => {
  for (const flag of [false, true]) {
    const f = await legs(flag); cleanups.push(() => f.h.done());
    const grant = issueConfiguredHostReport(f.ctx, "box", f.remote, f.local);
    const result = await f.registry.reportConfiguredHost(f.ctx, grant);
    expect(result).toEqual({ code: 0, stdout: "alive=0\nexit=137\npid=4242\n", stderr: "", timedOut: false });
  }
}, 90000);

test.skipIf(!front)("flag-on host check runs through the owner as flag-off", async () => {
  const outcomes: Record<string, unknown> = {};
  for (const flag of [false, true]) {
    const f = await legs(flag); cleanups.push(() => f.h.done());
    try {
      outcomes[String(flag)] = { ok: true, value: await f.registry.checkConfiguredHost(f.ctx, "box") };
    } catch (error) {
      outcomes[String(flag)] = { ok: false, code: (error as { code?: string }).code, message: (error as Error).message };
    }
  }
  expect(outcomes["true"]).toEqual(outcomes["false"]);
}, 90000);

test.skipIf(!front)("flag-on remote stop, then its report, run through the same owner as flag-off", async () => {
  // B0a: the remote stop's SSH legs are the host runner pacer-ssh serves through the owner. A stop that
  // reaches Core's broker must still drive both legs flag-on exactly as flag-off (m2-ledger "still open").
  const results: Record<string, unknown> = {};
  for (const flag of [false, true]) {
    const f = await legs(flag); cleanups.push(() => f.h.done());
    const stop = issueConfiguredHostStop(f.ctx, "box", f.remote, f.local, 5);
    const stopped = await f.registry.stopConfiguredHost(f.ctx, stop);
    const report = issueConfiguredHostReport(f.ctx, "box", f.remote, f.local);
    const reported = await f.registry.reportConfiguredHost(f.ctx, report);
    results[String(flag)] = { stopped, reported };
  }
  expect(results["true"]).toEqual(results["false"]);
}, 90000);

test.skipIf(!front)("flag-on keeps the owner lane through a remote stop and a following host check", async () => {
  // The owner pin (expectPid) must survive a completed remote stop so a later host check shares the same
  // owner lane, as flag-off reuses the same local provider process.
  const results: Record<string, unknown> = {};
  for (const flag of [false, true]) {
    const f = await legs(flag); cleanups.push(() => f.h.done());
    const stop = issueConfiguredHostStop(f.ctx, "box", f.remote, f.local, 5);
    await f.registry.stopConfiguredHost(f.ctx, stop);
    results[String(flag)] = { ok: true, value: await f.registry.checkConfiguredHost(f.ctx, "box") };
  }
  expect(results["true"]).toEqual(results["false"]);
}, 90000);

/** Short-home git command that fails the test on a git problem. */
async function g(repo: string, ...args: string[]) {
  const result = await realRun(["git", "-C", repo, ...args], 10_000);
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** One short home with a real published-base repo, a staged PREPARE and pacer-ssh served flag-on. */
async function prepareLegs(flag: boolean, repo: string, baseSha: string) {
  const h = makeHome(), bin = join(h.home, "bin"), ssh = join(bin, "ssh"), log = join(h.home, "ssh.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(ssh, SSH(log)); chmodSync(ssh, 0o755);
  writeFileSync(join(h.state, "strategy.yaml"), JSON.stringify({
    planner: "claude-code", providers: { "claude-code": {} },
    execution: { launch_mode: "headless" },
    hosts: { box: { ssh: "box", repos: { "example.invalid/o/r": "~/src/r" } } } }));
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state, run: realRun,
    env: { PACER_PORT: process.env.PACER_PORT!, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: h.home }, which: name => name === "ssh" ? ssh : Bun.which(name) });
  const id = createTask(ctx, { brief: { goal: "run", repo, base: "main" }, kind: "feature",
    requestedExecutor: null, timeoutS: 60 }).id;
  updateTask(ctx, id, record => { record.state = "running";
    record.placement = { requested: "new" }; });
  const registry = new PluginRegistry(deps());
  cleanups.push(() => registry.shutdown());
  let service: Awaited<ReturnType<typeof serve>> | undefined;
  if (flag) {
    service = await serve(h, "", { ...ownerOn, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: h.home } });
    cleanups.push(() => service?.stop());
    holdOwnerKey(readFileSync(join(h.state, "run", "host.key"), "utf8").trim());
    ctx.env.PACER_HOST_SOCKET = join(h.state, "run", "host.sock");
  }
  await registry.enable(ctx, "pacer-ssh", true);
  return { h, ctx, registry, log, id, baseSha };
}

test.skipIf(!front)("flag-on refuses the staged-input PREPARE, flag-off runs it through bundled SSH", async () => {
  // Staged-input legs stay refused flag-on: the native process owner bridge does not carry a staged
  // command, so pacer-ssh's PREPARE bundle must be handled flag-off only (ADR 0027, m2-ledger).
  const repo = gitRepo();
  cleanups.push(() => { try { realRun(["rm", "-rf", repo], 10_000); } catch {} });
  await g(repo, "config", "user.email", "t@t"); await g(repo, "config", "user.name", "t");
  await g(repo, "commit", "-q", "--allow-empty", "-m", "base");
  await g(repo, "remote", "add", "origin", "https://example.invalid/o/r");
  const baseSha = await g(repo, "rev-parse", "HEAD");
  const bundle = new Uint8Array([1, 2, 3]);
  const flags: Record<string, unknown> = {};
  for (const flag of [false, true]) {
    const f = await prepareLegs(flag, repo, baseSha); cleanups.push(() => f.h.done());
    const grant = await issueConfiguredHostPrepare(f.ctx, "box", f.id, f.baseSha, "main", bundle);
    try {
      flags[String(flag)] = { ok: true, value: await f.registry.prepareConfiguredHost(f.ctx, grant) };
    } catch (error) {
      flags[String(flag)] = { ok: false, code: (error as { code?: string }).code, message: (error as Error).message };
    }
  }
  expect((flags["false"] as { ok: boolean }).ok).toBe(true);
  expect(flags["true"]).toMatchObject({ ok: false, code: "plugin_unavailable" });
  expect((flags["true"] as { message: string }).message).toContain("staged command input");
}, 90000);