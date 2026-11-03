import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { CoreError } from "../core/errors";
import { gitInfo, realpathSafe } from "../core/git";
import { listTasksWhere, readTask, updateTask, withTaskLock } from "../tasks/store";
import { TERMINAL_STATES } from "../tasks/types";
import { taskWorktreePath, taskWorktreesDir } from "../supervisor/worktree";
import type { Ctx } from "../types";
import type { CallAuthority, CallResources } from "./authority";

type Grant = NonNullable<CallResources["worktree"]>;
const deny = (message: string): never => { throw new CoreError("capability_denied", message); };
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;
const first = (text: string) => text.trim().split("\n")[0] ?? "";

/** Issue only from a running, provider-owned task after any host-approved fetch. */
export async function issueOwnedWorktreeGrant(ctx: Ctx, taskId: string, providerId: string,
  attempt: number, base: string): Promise<Grant> {
  if (!base || base.length > 256 || base.startsWith("-") || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new CoreError("invalid_input", "invalid worktree base or attempt");
  const task = readTask(ctx, taskId);
  if (!task || task.state !== "running" || task.stopPending || task.executorProvider !== providerId ||
    task.attempts.length + 1 !== attempt || !isAbsolute(task.brief.repo))
    return deny("worktree owner is not a running provider attempt");
  const info = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in info) return deny(info.error);
  let path = taskWorktreePath(ctx, info.top, taskId), workdir = info.sub ? join(path, info.sub) : path;
  let branch = `pacer/${taskId}`, selectedBase = base;
  if (task.worktree) {
    const ownerId = task.retryOf ?? task.id;
    const prior = task.retryOf ? readTask(ctx, ownerId) : undefined;
    if (task.retryOf ? !prior || !TERMINAL_STATES.includes(prior.state) ||
      prior.worktree !== task.worktree && prior.result?.worktree !== task.worktree
      : task.attempts.length === 0) return deny("reused worktree has no settled task owner");
    const reused = await gitInfo(ctx.run, task.worktree);
    if ("error" in reused || reused.sub !== info.sub ||
      realpathSafe(reused.top) !== realpathSafe(taskWorktreePath(ctx, info.top, ownerId)) ||
      realpathSafe(reused.main) !== realpathSafe(info.main) ||
      reused.branch !== `pacer/${ownerId}`) return deny("reused worktree is not the prior task-owned checkout");
    path = reused.top; workdir = task.worktree; branch = reused.branch; selectedBase = "HEAD";
  }
  const baseRepo = task.worktree ? path : info.top;
  const resolved = await ctx.run(["git", "-C", baseRepo,
    "rev-parse", "--verify", `${selectedBase}^{commit}`], 10_000);
  const baseSha = resolved.stdout.trim();
  if (resolved.code !== 0 || resolved.timedOut || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseSha))
    return deny("selected worktree base is not available locally");
  const commonResult = await ctx.run(["git", "-C", info.top, "rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000);
  if (commonResult.code !== 0 || commonResult.timedOut || !isAbsolute(commonResult.stdout.trim()))
    return deny("repository common directory is unavailable");
  const repoCommon = realpathSync(commonResult.stdout.trim());
  const homePath = ctx.pacerHome, homeReal = realpathSync(homePath);
  const homeStat = lstatSync(homePath), homeTarget = lstatSync(homeReal);
  const sourceStat = lstatSync(task.brief.repo), topStat = lstatSync(info.top),
    mainStat = lstatSync(info.main), commonStat = lstatSync(repoCommon);
  const repoSourceReal = realpathSync(task.brief.repo);
  const sourceSub = relative(realpathSync(info.top), repoSourceReal);
  if (!topStat.isDirectory() || !mainStat.isDirectory() || !commonStat.isDirectory() ||
    sourceSub === ".." ||
    sourceSub.startsWith(`..${sep}`) || isAbsolute(sourceSub))
    return deny("repository identity changed");
  return withTaskLock(ctx, taskId, () => {
    const current = readTask(ctx, taskId);
    if (!current || current.rev !== task.rev || current.state !== "running" || current.stopPending ||
      current.executorProvider !== providerId || current.attempts.length + 1 !== attempt ||
      current.brief.repo !== task.brief.repo) return deny("worktree owner changed before issue");
    const intent = current.worktreeIntent;
    if (intent && (intent.attempt !== attempt || intent.providerId !== providerId ||
      intent.repoTop !== info.top || intent.repoMain !== info.main || intent.path !== path ||
      intent.workdir !== workdir || intent.branch !== branch || intent.baseSha !== baseSha))
      return deny("worktree has a different durable placement intent");
    const busy = listTasksWhere(ctx, { states: ["running"] }).some(other => other.id !== taskId &&
      realpathSafe(other.worktree ?? other.brief.repo) === realpathSafe(task.brief.repo));
    return { taskId, rev: current.rev, attempt, providerId,
      homePath, homeReal, homeIdentity: { dev: homeStat.dev, ino: homeStat.ino },
      homeTargetIdentity: { dev: homeTarget.dev, ino: homeTarget.ino },
      repoSource: task.brief.repo,
      repoSourceReal, repoSourceIdentity: { dev: sourceStat.dev, ino: sourceStat.ino },
      repoTop: info.top, repoMain: info.main, repoCommon,
      repoTopIdentity: { dev: topStat.dev, ino: topStat.ino },
      repoMainIdentity: { dev: mainStat.dev, ino: mainStat.ino },
      repoCommonIdentity: { dev: commonStat.dev, ino: commonStat.ino },
      sub: info.sub, dirty: info.dirty, busy, baseRepo,
      ...(task.worktree ? { reusedWorkdir: task.worktree } : {}),
      base: selectedBase, baseSha, path, workdir, branch };
  });
}

function assertOwner(authority: CallAuthority, grant: Grant, afterIntent = false): void {
  authority.assertActive();
  const task = readTask(authority.ctx, grant.taskId);
  if (!task || task.state !== "running" || task.stopPending || task.executorProvider !== grant.providerId ||
    task.attempts.length + 1 !== grant.attempt || task.brief.repo !== grant.repoSource ||
    (grant.reusedWorkdir !== undefined && task.worktree !== grant.reusedWorkdir) ||
    (!afterIntent && task.rev !== grant.rev)) return deny("worktree owner changed");
  const source = lstatSync(grant.repoSource), top = lstatSync(grant.repoTop),
    main = lstatSync(grant.repoMain), common = lstatSync(grant.repoCommon);
  const home = lstatSync(grant.homePath), target = lstatSync(grant.homeReal);
  if (!same(home, grant.homeIdentity) || !same(target, grant.homeTargetIdentity) ||
    realpathSync(grant.homePath) !== grant.homeReal)
    return deny("worktree home identity changed");
  if (!same(source, grant.repoSourceIdentity) || realpathSync(grant.repoSource) !== grant.repoSourceReal)
    return deny("repository source identity changed");
  if (!same(top, grant.repoTopIdentity) || !same(main, grant.repoMainIdentity) ||
    !same(common, grant.repoCommonIdentity) || !top.isDirectory() ||
    !main.isDirectory() || !common.isDirectory()) return deny("repository identity changed");
  if (afterIntent) {
    const intent = task.worktreeIntent;
    if (!intent || intent.attempt !== grant.attempt || intent.providerId !== grant.providerId ||
      intent.repoTop !== grant.repoTop || intent.repoMain !== grant.repoMain ||
      intent.path !== grant.path || intent.workdir !== grant.workdir ||
      intent.branch !== grant.branch || intent.baseSha !== grant.baseSha)
      return deny("durable placement intent changed");
  }
}

async function exactBase(authority: CallAuthority, grant: Grant): Promise<void> {
  const result = await authority.ctx.run(["git", "-C", grant.baseRepo,
    "rev-parse", "--verify", `${grant.base}^{commit}`], 10_000);
  if (result.code !== 0 || result.timedOut || result.stdout.trim() !== grant.baseSha)
    return deny("worktree base moved since issuance");
}

function privateParents(ctx: Ctx, grant: Grant): void {
  const root = taskWorktreesDir(ctx), parent = dirname(grant.path);
  for (const path of [root, parent]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const linked = lstatSync(path), stat = fstatSync(fd);
      if (!stat.isDirectory() || linked.isSymbolicLink() || !same(linked, stat) ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid()))
        return deny("worktree parent owner changed");
      if ((stat.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
      if ((fstatSync(fd).mode & 0o077) !== 0 || !same(lstatSync(path), fstatSync(fd)))
        return deny("worktree parent cannot be made private");
    } finally { closeSync(fd); }
  }
  if (realpathSync(parent) !== join(realpathSync(root), basename(parent)))
    return deny("worktree parent moved");
}

async function verifyCreated(authority: CallAuthority, grant: Grant): Promise<void> {
  if (!existsSync(grant.path) || lstatSync(grant.path).isSymbolicLink() ||
    realpathSync(grant.path) !== join(realpathSync(dirname(grant.path)), basename(grant.path)))
    return deny("worktree path changed");
  const commands = [
    ["git", "-C", grant.path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["git", "-C", grant.path, "symbolic-ref", "--quiet", "--short", "HEAD"],
    ["git", "-C", grant.path, "rev-parse", "--verify", "HEAD^{commit}"],
  ];
  const [common, branch, head] = await Promise.all(commands.map(argv => authority.ctx.run(argv, 10_000)));
  if (!common || !branch || !head || [common, branch, head].some(result => result.code !== 0 || result.timedOut) ||
    realpathSafe(common.stdout.trim()) !== grant.repoCommon ||
    branch.stdout.trim() !== grant.branch || head.stdout.trim() !== grant.baseSha)
    return deny("existing worktree has foreign origin, branch or HEAD");
}

/** The only mutating path consumes a one-use grant and persists the exact placement first. */
export async function answerWorktree(authority: CallAuthority, method: string,
  params: { taskId: string; attempt: number; baseSha?: string }): Promise<unknown> {
  const grant = method === "capability.worktree.createOrReuse"
    ? authority.consumeWorktreeCreate(params.taskId, params.attempt, params.baseSha ?? "")
    : authority.worktreeGrant(params.taskId, params.attempt);
  assertOwner(authority, grant);
  if (method === "capability.worktree.inspect") {
    return { top: grant.repoTop, main: grant.repoMain, sub: grant.sub || null,
      dirty: grant.dirty, busy: grant.busy, existingWorkdir: readTask(authority.ctx, grant.taskId)?.worktree ?? null };
  }
  await exactBase(authority, grant);
  assertOwner(authority, grant);
  if (method === "capability.worktree.resolveBase") return { base: grant.base, sha: grant.baseSha };
  if (method !== "capability.worktree.createOrReuse") return deny("unknown worktree operation");
  withTaskLock(authority.ctx, grant.taskId, () => {
    assertOwner(authority, grant);
    const existing = readTask(authority.ctx, grant.taskId)?.worktreeIntent;
    if (!existing) updateTask(authority.ctx, grant.taskId, task => {
      task.worktreeIntent = { attempt: grant.attempt, providerId: grant.providerId,
        repoTop: grant.repoTop, repoMain: grant.repoMain, path: grant.path,
        workdir: grant.workdir, branch: grant.branch, baseSha: grant.baseSha };
    });
    else assertOwner(authority, grant, true);
  });
  assertOwner(authority, grant, true);
  privateParents(authority.ctx, grant);
  const reused = existsSync(grant.path);
  if (!reused) {
    const branch = await authority.ctx.run(["git", "-C", grant.repoTop, "show-ref", "--verify", "--quiet", `refs/heads/${grant.branch}`], 10_000);
    if (branch.code === 0 || branch.timedOut || branch.code !== 1) return deny("worktree branch already exists or cannot be checked");
    assertOwner(authority, grant, true);
    const made = await authority.ctx.run(["git", "-C", grant.repoTop, "worktree", "add", "-q", "-b", grant.branch,
      grant.path, grant.baseSha], 60_000);
    if (made.code !== 0 || made.timedOut) return deny(`worktree effect is uncertain: ${first(made.stderr)}`);
  }
  assertOwner(authority, grant, true);
  await verifyCreated(authority, grant);
  return { path: grant.path, workdir: grant.workdir, branch: grant.branch,
    baseSha: grant.baseSha, reused };
}

/** Clear the placement journal only after the selected attempt has a durable run owner. */
export async function bindOwnedWorktreeIntent(ctx: Ctx, taskId: string, providerId: string, attempt: number): Promise<void> {
  const initial = readTask(ctx, taskId), intent = initial?.worktreeIntent;
  if (!initial || !intent || intent.providerId !== providerId || intent.attempt !== attempt)
    return deny("worktree placement has no matching durable intent");
  const info = await gitInfo(ctx.run, intent.workdir);
  const branch = await ctx.run(["git", "-C", intent.path, "symbolic-ref", "--quiet", "--short", "HEAD"], 10_000);
  if ("error" in info || realpathSafe(info.top) !== realpathSafe(intent.path) ||
    realpathSafe(info.main) !== realpathSafe(intent.repoMain) ||
    branch.code !== 0 || branch.timedOut || branch.stdout.trim() !== intent.branch)
    return deny("bound worktree origin or branch changed");
  withTaskLock(ctx, taskId, () => {
    const task = readTask(ctx, taskId), current = task?.worktreeIntent, run = task?.run;
    if (!task || task.rev !== initial.rev || task.state !== "running" ||
      task.executorProvider !== providerId || !current ||
      JSON.stringify(current) !== JSON.stringify(intent) ||
      !run || run.attempt !== attempt || run.mode !== "new" || run.host ||
      run.workdir !== intent.workdir || task.worktree !== intent.workdir ||
      run.dir !== join(ctx.pacerHome, "runs", taskId, String(attempt)) ||
      !lstatSync(run.dir).isDirectory()) return deny("worktree placement is not bound to a durable run");
    updateTask(ctx, taskId, value => {
      value.baseBranch = intent.baseSha;
      value.baseSha = intent.baseSha;
      delete value.worktreeIntent;
    });
  });
}
