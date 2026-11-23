import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginRegistry } from "../src/plugins/registry";
import { issuePersistedFetch } from "../src/plugins/fetch-issuer";
import { resolveTransferredBundle, type ClaimedBundleTicket } from "../src/plugins/bundle-stage";
import { prepareClaimedBundle, publishPreparedBundle } from "../src/plugins/claimed-bundle";
import { manifestSchema } from "../src/plugins/protocol";
import { createTask, updateTask } from "../src/tasks/store";
import type { CallAuthority } from "../src/plugins/authority";
import { fakeCtx, realRun } from "./helpers";

function fixture(sshBody = "printf '__PACER_BEGIN__\\nabc'",
  preflightOutput = `ancestor=1\\ndirty=0\\ncommits=1\\nhead=${"b".repeat(40)}\\n`) {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-fetch-bridge-"));
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), fakeSsh = join(bin, "ssh");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "session-stream.ts", "pacer-plugin.json"])
    copyFileSync(join(import.meta.dir, "..", "plugins", "pacer-ssh", file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "ssh-argv.log")}'\ncase "$*" in
  *"git merge-base"*) printf '__PACER_BEGIN__\\n${preflightOutput}' ;;
  *) ${sshBody} ;;
esac\n`);
  chmodSync(fakeSsh, 0o755);
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? fakeSsh : name === "git" ? "/usr/bin/git" : null,
    now: Date.now() / 1000 });
  const manifest = manifestSchema.parse({ id: "host-broker-caller", version: "1.0.0", publisher: "pacer",
    host: "^1.5", contributes: {}, capabilities: [{ name: "hosts" }], reentrant: true });
  const registry = new PluginRegistry({ bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "fixtures", "host-broker", "caller.ts")],
      cwd: home, env: {} }), eventPumpMs: 0 });
  const task = createTask(ctx, { brief: { goal: "fetch", repo: home }, kind: null,
    requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, record => { record.run = { dir: join(pacerHome, "runs", task.id),
    attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: "/remote/worktree",
    logFile: join(pacerHome, "tasks", "run.log"), host: "box", remoteWorktree: "/remote/worktree",
    baseSha: "a".repeat(40), remoteBranch: `pacer/${task.id}` }; });
  return { home, ctx, registry, taskId: task.id, fakeSsh };
}

test("registry finalizes a verified private bundle before the caller authority retires", async () => {
  const f = fixture();
  try {
    const git = async (...args: string[]) => {
      const result = await realRun(["git", ...args], 20_000);
      if (result.code) throw Error(result.stderr);
      return result.stdout.trim();
    };
    await git("init", "-q", "-b", "main", f.home);
    await git("-C", f.home, "config", "user.email", "test@example.invalid");
    await git("-C", f.home, "config", "user.name", "Test");
    await git("-C", f.home, "commit", "-q", "--allow-empty", "-m", "base");
    const base = await git("-C", f.home, "rev-parse", "HEAD"), branch = `pacer/${f.taskId}`;
    await git("-C", f.home, "checkout", "-q", "-b", branch);
    await git("-C", f.home, "commit", "-q", "--allow-empty", "-m", "result");
    const bundle = join(f.home, "fixture.bundle");
    await git("-C", f.home, "bundle", "create", bundle, `${base}..${branch}`);
    updateTask(f.ctx, f.taskId, record => { record.run!.baseSha = base; });
    writeFileSync(f.fakeSsh, `#!/bin/sh
case "$*" in
  *"git merge-base"*) printf '__PACER_BEGIN__\\nancestor=1\\ndirty=0\\ncommits=1\\nhead=${await git("-C", f.home, "rev-parse", branch)}\\n' ;;
  *) printf '__PACER_BEGIN__\\n'; cat '${bundle}' ;;
esac
`);
    chmodSync(f.fakeSsh, 0o755);
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 1024 * 1024, 5000);
    let publishedPath = "";
    const response = await f.registry.callWithIssuedHostFetch<{ fetched: { ok: true } }>(f.ctx,
      "host-broker-caller", "diagnostic.ping", { mode: "fetch", maxBytes: 1024 * 1024 }, grant,
      async (caller, ticket) => {
        const prepared = await prepareClaimedBundle(caller, ticket, grant);
        publishedPath = publishPreparedBundle(caller, prepared).path;
      });
    expect(response.fetched).toEqual({ ok: true });
    expect(existsSync(publishedPath)).toBe(true);
    const correctProgram = readFileSync(f.fakeSsh, "utf8");
    writeFileSync(f.fakeSsh, correctProgram.replace(`head=${await git("-C", f.home, "rev-parse", branch)}`,
      `head=${"c".repeat(40)}`));
    const wrongHeadGrant = issuePersistedFetch(f.ctx, f.taskId, 1, 1024 * 1024, 5000);
    let wrongHeadPath = "";
    await expect(f.registry.callWithIssuedHostFetch(f.ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "fetch", maxBytes: 1024 * 1024 }, wrongHeadGrant, async (caller, ticket) => {
        wrongHeadPath = publishPreparedBundle(caller,
          await prepareClaimedBundle(caller, ticket, wrongHeadGrant)).path;
      })).rejects.toMatchObject({ code: "capability_denied" });
    expect(wrongHeadPath).not.toBe("");
    expect(existsSync(wrongHeadPath)).toBe(false);
    writeFileSync(f.fakeSsh, correctProgram);
    const secondGrant = issuePersistedFetch(f.ctx, f.taskId, 1, 1024 * 1024, 5000);
    let rolledBackPath = "";
    await expect(f.registry.callWithIssuedHostFetch(f.ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "fetch", maxBytes: 1024 * 1024 }, secondGrant, async (caller, ticket) => {
        rolledBackPath = publishPreparedBundle(caller,
          await prepareClaimedBundle(caller, ticket, secondGrant)).path;
        updateTask(f.ctx, f.taskId, record => { record.run!.remoteWorktree = "/remote/replaced"; });
      })).rejects.toMatchObject({ code: "capability_denied" });
    expect(rolledBackPath).not.toBe("");
    expect(existsSync(rolledBackPath)).toBe(false);
    expect(existsSync(publishedPath)).toBe(true);
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("dirty remote preflight refuses bundle staging before the fetch effect", async () => {
  const f = fixture(undefined, `ancestor=1\\ndirty=1\\ncommits=1\\nhead=${"b".repeat(40)}\\n`);
  try {
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 16, 5000);
    let claimed = false;
    await expect(f.registry.callWithIssuedHostFetch(f.ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "fetch" }, grant, () => { claimed = true; }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(claimed).toBe(false);
    const argv = readFileSync(join(f.home, "ssh-argv.log"), "utf8");
    expect(argv).toContain("git merge-base");
    expect(argv).not.toContain("git bundle create");
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("caller fetch requires a host-attached grant and claims the private stage before provider revoke", async () => {
  const f = fixture();
  try {
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    await expect(f.registry.call(f.ctx, "host-broker-caller", "diagnostic.ping", { mode: "fetch" }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(existsSync(join(f.home, "ssh-argv.log"))).toBe(false);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 16, 5000);
    let claimedPath = "", claims = 0;
    const result = await (f.registry as any).callWithIssuedHostFetch(f.ctx, "host-broker-caller",
      "diagnostic.ping", { mode: "fetch" }, grant,
      (caller: CallAuthority, ticket: ClaimedBundleTicket) => {
        claims++;
        const stage = resolveTransferredBundle(caller, ticket);
        claimedPath = stage.path;
        expect(readFileSync(stage.path).toString()).toBe("abc");
        expect(stage.bytes).toBe(3);
      });
    expect(result.fetched).toEqual({ ok: true });
    expect(claims).toBe(1);
    expect(existsSync(claimedPath)).toBe(false);
    expect(readFileSync(join(f.home, "ssh-argv.log"), "utf8")).toContain("bundle create");
    await expect((f.registry as any).callWithIssuedHostFetch(f.ctx, "host-broker-caller",
      "diagnostic.ping", { mode: "fetch" }, grant, () => {}))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("a failed host claim cleans the transferred private stage", async () => {
  const f = fixture();
  try {
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 16, 5000);
    let stagePath = "";
    await expect(f.registry.callWithIssuedHostFetch(f.ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "fetch" }, grant, (caller, ticket) => {
        stagePath = resolveTransferredBundle(caller, ticket).path;
        throw Error("host verification failed");
      })).rejects.toBeDefined();
    expect(stagePath).not.toBe("");
    expect(existsSync(stagePath)).toBe(false);
    expect(readFileSync(join(f.home, "ssh-argv.log"), "utf8")).toContain("bundle create");
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("a task revision during an asynchronous host claim prevents success and cleans the stage", async () => {
  const f = fixture();
  try {
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 16, 5000);
    let stagePath = "";
    await expect(f.registry.callWithIssuedHostFetch(f.ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "fetch" }, grant, async (caller, ticket) => {
        stagePath = resolveTransferredBundle(caller, ticket).path;
        await Bun.sleep(10);
        updateTask(f.ctx, f.taskId, record => { record.run!.remoteWorktree = "/remote/replaced"; });
      })).rejects.toMatchObject({ code: "capability_denied" });
    expect(stagePath).not.toBe("");
    expect(existsSync(stagePath)).toBe(false);
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("provider generation retirement during an asynchronous host claim prevents success", async () => {
  const f = fixture();
  try {
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 16, 5000);
    let stagePath = "";
    await expect(f.registry.callWithIssuedHostFetch(f.ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "fetch" }, grant, async (caller, ticket) => {
        stagePath = resolveTransferredBundle(caller, ticket).path;
        await Bun.sleep(10);
        writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"),
          "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\nplugins:\n  config:\n    pacer-ssh: {revision: 2}\n");
      })).rejects.toMatchObject({ code: "capability_denied" });
    expect(stagePath).not.toBe("");
    expect(existsSync(stagePath)).toBe(false);
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("caller cancellation during provider fetch returns no private claim", async () => {
  const f = fixture("sleep 2\nprintf '__PACER_BEGIN__\\nabc'");
  try {
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 16, 5000);
    const cancel = new AbortController();
    let claimed = false;
    const pending = f.registry.callWithIssuedHostFetch(f.ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "fetch" }, grant, () => { claimed = true; }, cancel.signal);
    void pending.catch(() => {});
    const argvLog = join(f.home, "ssh-argv.log"), until = Date.now() + 2000;
    while (!existsSync(argvLog) && Date.now() < until) await Bun.sleep(10);
    expect(existsSync(argvLog)).toBe(true);
    cancel.abort();
    await expect(pending).rejects.toBeDefined();
    expect(claimed).toBe(false);
    const transfers = join(f.ctx.pacerHome, "transfers");
    expect(existsSync(transfers) ? readdirSync(transfers) : []).toEqual([]);
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("caller cannot inject task, path, provider or SSH arguments into the fetch envelope", async () => {
  const f = fixture();
  try {
    await f.registry.enable(f.ctx, "pacer-ssh", true);
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1, 16, 5000);
    for (const extra of [{ taskId: f.taskId }, { alias: "other" }, { sshTarget: "other" },
      { argv: ["ssh", "other"] }, { remoteWorktree: "/remote/other" }]) {
      await expect((f.registry as any).callWithIssuedHostFetch(f.ctx, "host-broker-caller",
        "diagnostic.ping", { mode: "fetch", fetchExtra: extra }, grant, () => {}))
        .rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(existsSync(join(f.home, "ssh-argv.log"))).toBe(false);
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});
