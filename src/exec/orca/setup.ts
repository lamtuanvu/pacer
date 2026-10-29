import { realpathSafe } from "../../core/git";
import type { Ctx } from "../../types";
import { type OrcaClient, isLiveTerminal } from "./client";
import { loadOrcaState, updateOrcaState, withLock } from "./state";

const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * A worktree shared by every lane in a named `--group`, so Orca nests each lane's own worktree
 * under one visible parent (through `worktree create --parent-worktree`). Cached per repo+group in `~/.pacer/orca.json` once
 * created. The cache is never invalidated: if the group's parent worktree is later removed outside
 * pacer, every lane in that group fails the same way until the cache entry is cleared by hand.
 */
export async function ensureGroupWorktree(
  ctx: Ctx, c: OrcaClient, repoId: string, group: string, baseBranch: string,
): Promise<{ selector: string } | { error: string }> {
  if (!GROUP_NAME.test(group)) return { error: "group must be 1–40 characters, starting alphanumeric, of letters, digits, - and _" };
  const key = `${repoId}:${group}`;
  return withLock(ctx, "orca-group", async () => {
    const cached = loadOrcaState(ctx).groups[key];
    if (cached) return cached;
    const r = await c.worktreeCreate({ kind: "new-child", repoId, name: `pacer-group-${group}`, baseBranch, noParent: true });
    if (!r.ok) return { error: `orca worktree create failed for group "${group}": ${r.error.code} ${r.error.message}` };
    const path = r.result.worktree?.path;
    if (!path) return { error: `orca worktree create for group "${group}" returned no path` };
    const entry = { selector: `path:${path}` };
    updateOrcaState(ctx, s => { s.groups[key] = entry; });
    return entry;
  });
}

export { gitInfo, realpathSafe, type RepoInfo } from "../../core/git";

export const COORDINATOR_TITLE = "pacer coordinator";
export const RUN_OBJECTIVE = "pacer executors";

/** The Orca repo id for a git top level, registering the repo when Orca doesn't know it yet. */
export async function ensureRepo(c: OrcaClient, top: string, options: {main?:string;linked?:boolean;registerRepos?:boolean} = {}): Promise<string | { error: string }> {
  const list = await c.repoList();
  if (!list.ok) return { error: `orca repo list failed: ${list.error.code} ${list.error.message}` };
  const hit = (list.result.repos ?? []).find((r) => realpathSafe(r.path) === realpathSafe(options.main??top));
  if (hit) return hit.id;
  const owner=await c.call<{repo?:{id?:string};worktree?:{repoId?:string;repo_id?:string;repo?:{id?:string}}}>(["worktree","show","--worktree",`path:${top}`]);
  if(owner.ok){const id=owner.result.repo?.id??owner.result.worktree?.repoId??owner.result.worktree?.repo_id??owner.result.worktree?.repo?.id;if(id)return id;}
  if(!options.registerRepos||options.linked)return {error:"repository is not an Orca project"};
  const add = await c.repoAdd(options.main??top);
  return add.ok ? add.result.repo.id : { error: `orca repo add failed: ${add.error.code} ${add.error.message}` };
}

/** A live coordinator sender terminal and a run bound to it, persisted in ~/.pacer/orca.json; recreated when gone. */
export async function ensureCoordinator(
  ctx: Ctx, c: OrcaClient, top: string,
): Promise<{ coordinator: string; run: string } | { error: string }> {
  try {
    return await withLock(ctx, "coordinator", async () => {
      const s = loadOrcaState(ctx);
      let handle: string;
      let runId: string | null = s.run;
      const terminal = s.coordinator ? await c.terminalShow(s.coordinator) : null;
      if (terminal && !terminal.ok && terminal.error.code !== "terminal_handle_stale") {
        return { error: `orca terminal show failed: ${terminal.error.code} ${terminal.error.message}` };
      }
      if (s.coordinator && terminal && isLiveTerminal(terminal)) {
        handle = s.coordinator;
      } else {
        const t = await c.terminalCreate(`path:${top}`, COORDINATOR_TITLE);
        if (!t.ok) return { error: `orca terminal create failed: ${t.error.code} ${t.error.message}` };
        handle = t.result.terminal.handle;
        runId = null;
      }
      if (runId) {
        const r = await c.runShow(runId);
        if (!r.ok || r.result.run.coordinator_handle !== handle) runId = null;
      }
      if (!runId) {
        let r = await c.runCreate(RUN_OBJECTIVE, handle);
        if (!r.ok && (r.error.code === "consumer_fenced" || /consumer_fenced|This terminal is attested as .* cannot act as/.test(r.error.message))) {
          updateOrcaState(ctx, x => { x.coordinator = null; x.run = null; });
          const fresh = await c.terminalCreate(`path:${top}`, COORDINATOR_TITLE);
          if (!fresh.ok) return { error: `orca terminal create failed: ${fresh.error.code} ${fresh.error.message}` };
          const oldHandle = handle;
          handle = fresh.result.terminal.handle;
          if (oldHandle !== handle) await c.terminalClose(oldHandle);
          r = await c.runCreate(RUN_OBJECTIVE, handle);
        }
        if (!r.ok) {
          updateOrcaState(ctx, (x) => { x.coordinator = handle; x.run = null; });
          return { error: `orca run-create failed: ${r.error.code} ${r.error.message}` };
        }
        runId = r.result.run.id;
      }
      const run = runId;
      updateOrcaState(ctx, (x) => { x.coordinator = handle; x.run = run; });
      return { coordinator: handle, run };
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
}
