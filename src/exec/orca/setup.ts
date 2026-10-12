import { realpathSync } from "node:fs";
import { isAbsolute, relative, dirname, resolve } from "node:path";
import type { Ctx, RunFn } from "../../types";
import { type OrcaClient, isLiveTerminal } from "./client";
import { loadOrcaState, updateOrcaState, withLock } from "./state";

export interface RepoInfo { top: string; branch: string; sub: string; dirty: boolean; main: string; linked: boolean }

export const COORDINATOR_TITLE = "pacer coordinator";
export const RUN_OBJECTIVE = "pacer executors";

export function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The repo's git top level, current branch ("HEAD" when detached), sub-path of `repo` inside it, and dirtiness. */
export async function gitInfo(run: RunFn, repo: string): Promise<RepoInfo | { error: string }> {
  const r = await run(["git", "-C", repo, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-common-dir"], 10_000);
  const [top = "", branch = "", common = ""] = r.stdout.trim().split("\n").map((l) => l.trim());
  if (r.code !== 0 || !top || !branch) {
    const why = r.stderr.trim().split("\n")[0] || `git exited with code ${r.code}`;
    return { error: `${repo} is not a git repository with at least one commit (${why})` };
  }
  const rel = relative(top, realpathSafe(repo));
  const sub = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : "";
  const st = await run(["git", "-C", top, "status", "--porcelain"], 10_000);
  if(st.code!==0)return {error:`cannot inspect working tree: ${st.stderr.trim()||st.code}`};
  const main=realpathSafe(dirname(common?resolve(top,common):resolve(top,".git")));
  return { top, branch, sub, main, linked:realpathSafe(top)!==main, dirty: st.code === 0 && st.stdout.trim() !== "" };
}

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
          handle = fresh.result.terminal.handle;
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
