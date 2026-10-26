import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { execProcess } from "../src/exec/process";
import { prepareBundleStageAuthority, stageBundle, resolveStagedBundle,
  transferStagedBundleOwnership } from "../src/plugins/bundle-stage";
import { issuePersistedFetch } from "../src/plugins/fetch-issuer";
import { finalizeClaimedPublication, prepareClaimedBundle, publishPreparedBundle,
  withFinalizedClaimedBundleInput } from "../src/plugins/claimed-bundle";
import { writeNative } from "../src/plugins/write-native";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, realRun, tmpDir } from "./helpers";

const owners: CallAuthority[] = [];
afterEach(async () => { await Promise.allSettled(owners.splice(0).map(owner => owner.revoke())); });

async function fixture(email = "test@example.invalid", options: { signoff?: string; extraCommits?: number;
  wrongBranch?: boolean; wrongBase?: boolean; zeroCommits?: boolean; sha256?: boolean } = {}) {
  const home = tmpDir(), pacerHome = join(home, ".pacer"), repo = join(home, "repo"), remote = join(home, "remote");
  mkdirSync(pacerHome, { recursive: true });
  const git = async (...args: string[]) => {
    const result = await realRun(["git", ...args], 20_000);
    if (result.code) throw Error(result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-q", "-b", "main", ...(options.sha256 ? ["--object-format=sha256"] : []), repo);
  await git("-C", repo, "config", "user.email", "test@example.invalid");
  await git("-C", repo, "config", "user.name", "Test");
  await git("-C", repo, "commit", "-q", "--allow-empty", "-m", "base");
  const base = await git("-C", repo, "rev-parse", "HEAD");
  await git("clone", "-q", repo, remote);
  await git("-C", remote, "config", "user.email", email);
  await git("-C", remote, "config", "user.name", "Test");
  const ctx = fakeCtx({ home, pacerHome, run: realRun, env: { PATH: process.env.PATH ?? "" },
    which: name => name === "ssh" ? join(home, "ssh") : name === "git" ? "/usr/bin/git" : null });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const task = createTask(ctx, { brief: { goal: "verify", repo }, kind: null,
    requestedExecutor: null, timeoutS: 60 });
  const branch = `pacer/${task.id}`;
  await git("-C", remote, "checkout", "-q", "-b", branch);
  if (!options.zeroCommits) await git("-C", remote, "commit", "-q", "--allow-empty", "-m",
    options.signoff ? `result\n\nSigned-off-by: Other <${options.signoff}>` : "result");
  if (options.extraCommits) {
    const first = await git("-C", remote, "rev-parse", "HEAD");
    const history = Array.from({ length: options.extraCommits }, (_, i) => {
      const message = `extra ${i}`;
      return `commit refs/heads/${branch}\nmark :${i + 1}\ncommitter Test <${email}> 1700000000 +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${i === 0 ? first : `:${i}`}\n\n`;
    }).join("");
    const imported = await realRun(["git", "-C", remote, "fast-import", "--quiet"], 30_000, { stdin: history });
    if (imported.code) throw Error(imported.stderr);
  }
  const head = await git("-C", remote, "rev-parse", branch);
  updateTask(ctx, task.id, record => { record.run = { dir: join(pacerHome, "runs", task.id),
    attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: remote,
    logFile: join(pacerHome, "tasks", "run.log"), host: "box", remoteWorktree: remote,
    baseSha: options.wrongBase ? "f".repeat(base.length) : base, remoteBranch: branch }; });
  const bundle = join(home, "result.bundle");
  if (options.wrongBranch) await git("-C", remote, "branch", "pacer/wrong", branch);
  await git("-C", remote, "bundle", "create", bundle,
    options.zeroCommits ? branch : `${base}..${options.wrongBranch ? "pacer/wrong" : branch}`);
  const executable = join(home, "ssh");
  writeFileSync(executable, `#!/bin/sh\nprintf '__PACER_BEGIN__\\n'\ncat '${bundle}'\n`);
  chmodSync(executable, 0o700);
  const grant = issuePersistedFetch(ctx, task.id, 1, 1024 * 1024, 5000);
  const provider = createCallAuthority(ctx, { reads: [], commands: [], stores: [], bundleStages: [grant.resource] },
    { deadlineMs: Date.now() + 20_000, grants: ["process.spawn"] });
  const caller = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 20_000, grants: ["hosts"] });
  owners.push(provider, caller);
  prepareBundleStageAuthority(provider);
  const staged = await stageBundle(provider, { argv: grant.resource.argv, timeoutMs: 5000, maxBytes: 1024 * 1024 });
  const stagePath = resolveStagedBundle(provider, staged.handle).path;
  const ticket = transferStagedBundleOwnership(provider, staged.handle, caller, grant);
  await provider.revoke();
  return { ctx, caller, grant, ticket, stagePath, head, taskId: task.id, repo, remote, bundle, git };
}

test("host verifies the exact branch, commit count and identity before private publication", async () => {
  const f = await fixture();
  const prepared = await prepareClaimedBundle(f.caller, f.ticket, f.grant);
  expect(prepared).toMatchObject({ head: f.head, commits: 1 });
  const published = publishPreparedBundle(f.caller, prepared);
  expect(published.head).toBe(f.head);
  expect(existsSync(published.path)).toBe(true);
  expect(readFileSync(published.path).length).toBeGreaterThan(0);
  expect(() => publishPreparedBundle(f.caller, prepared)).toThrow();
  finalizeClaimedPublication(f.caller, f.ticket);
  await f.caller.revoke();
  expect(existsSync(published.path)).toBe(true);
});

test("valid SHA-256 bundle uses the source repository object format", async () => {
  const f = await fixture("test@example.invalid", { sha256: true });
  expect(f.head).toHaveLength(64);
  const prepared = await prepareClaimedBundle(f.caller, f.ticket, f.grant);
  expect(prepared).toMatchObject({ head: f.head, commits: 1 });
  const published = publishPreparedBundle(f.caller, prepared);
  finalizeClaimedPublication(f.caller, f.ticket);
  expect(readFileSync(published.path)).toEqual(readFileSync(f.bundle));
});

test("finalized bundle snapshot is immutable through same-UID rewrite and consumed once", async () => {
  const f = await fixture();
  const publication = publishPreparedBundle(f.caller,
    await prepareClaimedBundle(f.caller, f.ticket, f.grant));
  finalizeClaimedPublication(f.caller, f.ticket);
  await f.caller.revoke();
  const expected = readFileSync(f.bundle);
  await withFinalizedClaimedBundleInput(f.caller, f.ticket, f.grant, async input => {
    expect((input as unknown) instanceof Blob).toBe(true);
    writeFileSync(publication.path, "same-UID rewrite");
    const fetched = await execProcess({ argv: ["/usr/bin/git", "-C", f.repo, "bundle", "unbundle",
      "/dev/fd/0"], cwd: f.ctx.home, env: { PATH: process.env.PATH, HOME: f.ctx.home }, timeoutMs: 10_000,
      maxStdoutBytes: 1024 * 1024, stdinBlob: input as Blob });
    if (fetched.code !== 0) throw Error(fetched.stderr);
    expect(await f.git("-C", f.repo, "rev-parse", `${f.head}^{commit}`)).toBe(f.head);
    const actual = Buffer.from(await (input as Blob).arrayBuffer());
    expect(actual).toEqual(expected);
    actual[0] = 0;
    expect(Buffer.from(await (input as Blob).arrayBuffer())).toEqual(expected);
    expect(readdirSync(join(f.ctx.pacerHome, "transfers")).filter(name => name.startsWith(".bundle-input-")))
      .toHaveLength(0);
  });
  await expect(withFinalizedClaimedBundleInput(f.caller, f.ticket, f.grant, async () => {}))
    .rejects.toMatchObject({ code: "capability_denied" });
});

test("macOS Git fetch cannot consume a bundle through stdin directly", async () => {
  if (process.platform !== "darwin") return;
  const f = await fixture();
  publishPreparedBundle(f.caller, await prepareClaimedBundle(f.caller, f.ticket, f.grant));
  finalizeClaimedPublication(f.caller, f.ticket);
  await withFinalizedClaimedBundleInput(f.caller, f.ticket, f.grant, async input => {
    const fetched = await execProcess({ argv: ["/usr/bin/git", "-C", f.repo, "fetch", "--no-tags",
      "/dev/fd/0", f.grant.resource.args[2]], cwd: f.ctx.home,
      env: { PATH: process.env.PATH, HOME: f.ctx.home }, timeoutMs: 10_000,
      maxStdoutBytes: 1024 * 1024, stdinBlob: input as Blob });
    expect(fetched.code).not.toBe(0);
    await expect(f.git("-C", f.repo, "rev-parse", `${f.head}^{commit}`)).rejects.toThrow();
  });
});

test("finalized input rechecks the persisted run and consumes once on consumer failure", async () => {
  const changed = await fixture();
  publishPreparedBundle(changed.caller,
    await prepareClaimedBundle(changed.caller, changed.ticket, changed.grant));
  finalizeClaimedPublication(changed.caller, changed.ticket);
  const otherGrant = issuePersistedFetch(changed.ctx, changed.taskId, 1, 1024 * 1024, 5000);
  await expect(withFinalizedClaimedBundleInput(changed.caller, changed.ticket, otherGrant,
    async () => {})).rejects.toMatchObject({ code: "capability_denied" });
  updateTask(changed.ctx, changed.taskId, record => { record.run!.remoteBranch = "pacer/replaced"; });
  await expect(withFinalizedClaimedBundleInput(changed.caller, changed.ticket, changed.grant,
    async () => {})).rejects.toMatchObject({ code: "capability_denied" });

  const f = await fixture();
  publishPreparedBundle(f.caller, await prepareClaimedBundle(f.caller, f.ticket, f.grant));
  finalizeClaimedPublication(f.caller, f.ticket);
  await expect(withFinalizedClaimedBundleInput(f.caller, f.ticket, f.grant, async () => {
    throw Error("consumer failed");
  })).rejects.toThrow("consumer failed");
  await expect(withFinalizedClaimedBundleInput(f.caller, f.ticket, f.grant, async () => {}))
    .rejects.toMatchObject({ code: "capability_denied" });
});

test("finalized bundle input refuses same-UID file or directory replacement before consumption", async () => {
  for (const replace of ["file", "directory"]) {
    const f = await fixture();
    const publication = publishPreparedBundle(f.caller,
      await prepareClaimedBundle(f.caller, f.ticket, f.grant));
    finalizeClaimedPublication(f.caller, f.ticket);
    if (replace === "file") {
      renameSync(publication.path, `${publication.path}.moved`);
      writeFileSync(publication.path, readFileSync(f.bundle), { mode: 0o600 });
    } else {
      const tasks = join(f.ctx.pacerHome, "tasks");
      renameSync(tasks, `${tasks}-moved`);
      mkdirSync(tasks, { mode: 0o700 });
      writeFileSync(join(tasks, basename(publication.path)), readFileSync(f.bundle), { mode: 0o600 });
    }
    await expect(withFinalizedClaimedBundleInput(f.caller, f.ticket, f.grant, async () => {}))
      .rejects.toMatchObject({ code: "capability_denied" });
  }
});

test("transient same-UID stage rewrite during Git inspection cannot certify different bytes", async () => {
  const f = await fixture();
  await f.git("-C", f.remote, "commit", "-q", "--allow-empty", "-m", "alternate result");
  const alternateHead = await f.git("-C", f.remote, "rev-parse", "HEAD");
  const alternate = join(f.ctx.home, "alternate.bundle");
  await f.git("-C", f.remote, "bundle", "create", alternate,
    `${f.grant.resource.args[1]}..${f.grant.resource.args[2]}`);
  const stageTime = join(f.ctx.home, "stage-time");
  const snapshotTime = await realRun(["/bin/cp", "-p", f.stagePath, stageTime], 5000);
  if (snapshotTime.code) throw Error(snapshotTime.stderr);
  const wrapper = join(f.ctx.home, "git-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" bundle verify "*|*" bundle list-heads "*|*" bundle unbundle "*|*" fetch --no-tags "*)\n    /bin/cp '${alternate}' '${f.stagePath}'\n    /usr/bin/git "$@"\n    result=$?\n    /bin/cp '${f.bundle}' '${f.stagePath}'\n    /usr/bin/touch -r '${stageTime}' '${f.stagePath}'\n    exit "$result"\n    ;;\nesac\nexec /usr/bin/git "$@"\n`);
  chmodSync(wrapper, 0o700);
  f.ctx.which = name => name === "git" ? wrapper : name === "ssh" ? join(f.ctx.home, "ssh") : null;
  const prepared = await prepareClaimedBundle(f.caller, f.ticket, f.grant);
  expect(prepared.head).toBe(f.head);
  expect(prepared.head).not.toBe(alternateHead);
  const published = publishPreparedBundle(f.caller, prepared);
  finalizeClaimedPublication(f.caller, f.ticket);
  expect(readFileSync(published.path)).toEqual(readFileSync(f.bundle));
});

test("foreign commit identity is quarantined, never accepted, with bounded retention", async () => {
  const f = await fixture("foreign@example.invalid");
  await expect(prepareClaimedBundle(f.caller, f.ticket, f.grant))
    .rejects.toMatchObject({ code: "capability_denied" });
  const quarantine = join(f.ctx.pacerHome, "tasks", "quarantine", f.taskId);
  expect(readdirSync(quarantine).filter(name => name.endsWith(".bundle"))).toHaveLength(1);
  expect(readdirSync(join(f.ctx.pacerHome, "tasks")).filter(name => name.startsWith(f.taskId) && name.endsWith(".bundle")))
    .toHaveLength(0);
});

test("claimed bundle refuses a different valid grant for the same persisted run", async () => {
  const f = await fixture();
  const other = issuePersistedFetch(f.ctx, f.taskId, 1, 1024 * 1024, 5000);
  await expect(prepareClaimedBundle(f.caller, f.ticket, other))
    .rejects.toMatchObject({ code: "capability_denied" });
  const prepared = await prepareClaimedBundle(f.caller, f.ticket, f.grant);
  expect(prepared.head).toBe(f.head);
});

test("foreign signoff, branch mismatch and missing base are quarantined before acceptance", async () => {
  for (const options of [{ signoff: "foreign@example.invalid" }, { wrongBranch: true }, { wrongBase: true }]) {
    const f = await fixture("test@example.invalid", options);
    await expect(prepareClaimedBundle(f.caller, f.ticket, f.grant))
      .rejects.toMatchObject({ code: "capability_denied" });
    const quarantine = join(f.ctx.pacerHome, "tasks", "quarantine", f.taskId);
    expect(readdirSync(quarantine).filter(name => name.endsWith(".bundle"))).toHaveLength(1);
  }
});

test("more than 500 commits is quarantined and the ninth forensic artifact is refused", async () => {
  const f = await fixture("test@example.invalid", { extraCommits: 500 });
  await expect(prepareClaimedBundle(f.caller, f.ticket, f.grant))
    .rejects.toMatchObject({ code: "capability_denied" });
  const quarantine = join(f.ctx.pacerHome, "tasks", "quarantine", f.taskId);
  expect(readdirSync(quarantine).filter(name => name.endsWith(".bundle"))).toHaveLength(1);
  const second = await fixture("foreign@example.invalid");
  const secondQuarantine = join(second.ctx.pacerHome, "tasks", "quarantine", second.taskId);
  mkdirSync(secondQuarantine, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 8; i++) writeFileSync(join(secondQuarantine, `${second.taskId}.${i}.bundle`), "prior", { mode: 0o600 });
  await expect(prepareClaimedBundle(second.caller, second.ticket, second.grant))
    .rejects.toMatchObject({ code: "too_large" });
  expect(readdirSync(secondQuarantine).filter(name => name.endsWith(".bundle"))).toHaveLength(8);
});

test("a zero-commit bundle is quarantined", async () => {
  const f = await fixture("test@example.invalid", { zeroCommits: true });
  await expect(prepareClaimedBundle(f.caller, f.ticket, f.grant))
    .rejects.toMatchObject({ code: "capability_denied" });
  const quarantine = join(f.ctx.pacerHome, "tasks", "quarantine", f.taskId);
  expect(readdirSync(quarantine).filter(name => name.endsWith(".bundle"))).toHaveLength(1);
});

test("caller retirement or stage tamper prevents publication", async () => {
  const f = await fixture();
  const prepared = await prepareClaimedBundle(f.caller, f.ticket, f.grant);
  await f.caller.revoke();
  expect(() => publishPreparedBundle(f.caller, prepared)).toThrow();
  const second = await fixture();
  const pending = await prepareClaimedBundle(second.caller, second.ticket, second.grant);
  writeFileSync(second.stagePath, "tampered");
  expect(() => publishPreparedBundle(second.caller, pending)).toThrow();
  expect(readdirSync(join(second.ctx.pacerHome, "tasks")).filter(name =>
    name.startsWith(second.taskId) && name.endsWith(".bundle"))).toHaveLength(0);
});

test("unfinalized publication rolls back on caller revoke or task revision change", async () => {
  const revoked = await fixture();
  const first = publishPreparedBundle(revoked.caller,
    await prepareClaimedBundle(revoked.caller, revoked.ticket, revoked.grant));
  expect(existsSync(first.path)).toBe(true);
  await revoked.caller.revoke();
  expect(existsSync(first.path)).toBe(false);

  const changed = await fixture();
  const second = publishPreparedBundle(changed.caller,
    await prepareClaimedBundle(changed.caller, changed.ticket, changed.grant));
  updateTask(changed.ctx, changed.taskId, record => { record.run!.remoteWorktree = "/remote/replaced"; });
  expect(() => finalizeClaimedPublication(changed.caller, changed.ticket)).toThrow();
  await changed.caller.revoke();
  expect(existsSync(second.path)).toBe(false);

  const tampered = await fixture();
  const third = publishPreparedBundle(tampered.caller,
    await prepareClaimedBundle(tampered.caller, tampered.ticket, tampered.grant));
  writeFileSync(third.path, "substituted bytes");
  expect(() => finalizeClaimedPublication(tampered.caller, tampered.ticket)).toThrow();
  await tampered.caller.revoke();
  expect(existsSync(third.path)).toBe(false);
});

test("rollback stays in its pinned tasks directory after a same-UID ancestor swap", async () => {
  const f = await fixture();
  const published = publishPreparedBundle(f.caller,
    await prepareClaimedBundle(f.caller, f.ticket, f.grant));
  const tasks = join(f.ctx.pacerHome, "tasks"), moved = join(f.ctx.pacerHome, "tasks-moved");
  renameSync(tasks, moved);
  mkdirSync(tasks, { mode: 0o700 });
  writeFileSync(join(tasks, `${f.taskId}.json`), readFileSync(join(moved, `${f.taskId}.json`)), { mode: 0o600 });
  const decoy = join(tasks, basename(published.path));
  writeFileSync(decoy, "unrelated", { mode: 0o600 });
  expect(() => finalizeClaimedPublication(f.caller, f.ticket)).toThrow();
  await f.caller.revoke();
  expect(existsSync(join(moved, basename(published.path)))).toBe(false);
  expect(readFileSync(decoy, "utf8")).toBe("unrelated");
});

test("destination directory swap during link refuses publication and removes the pinned link", async () => {
  const f = await fixture();
  const prepared = await prepareClaimedBundle(f.caller, f.ticket, f.grant);
  const tasks = join(f.ctx.pacerHome, "tasks"), moved = join(f.ctx.pacerHome, "tasks-moved");
  const native = writeNative(), original = native.linkAt;
  let swapped = false;
  native.linkAt = (from, old, to, name) => {
    if (!swapped) {
      swapped = true;
      renameSync(tasks, moved);
      mkdirSync(tasks, { mode: 0o700 });
    }
    original(from, old, to, name);
  };
  try { expect(() => publishPreparedBundle(f.caller, prepared)).toThrow(); }
  finally { native.linkAt = original; }
  expect(swapped).toBe(true);
  expect(readdirSync(moved).filter(name => name.endsWith(".bundle"))).toHaveLength(0);
  expect(readdirSync(tasks).filter(name => name.endsWith(".bundle"))).toHaveLength(0);
});
