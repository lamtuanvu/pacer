import { dirname, resolve } from "node:path";
import type { RepoRef } from "../../../src/api/read-model/types";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { repos } from "../../../src/view-model/selectors";
import type { RunFn } from "../../../src/types";

/** Resolve the panel's active worktree, never the service/worker working directory. */
export async function panelRepo(s: ClientSnapshot, run: RunFn): Promise<RepoRef | null> {
 try {
  const result = await run(["orca", "worktree", "show", "--worktree", "active", "--json"], 2000);
  if (result.code !== 0) return null;
  const reply = JSON.parse(result.stdout);
  if (!reply.ok) return null;
  const worktree = reply.result?.worktree;
  const path = worktree?.path ?? worktree?.id?.split("::")[1];
  const repoPath = reply.result?.repo?.path ?? worktree?.repo?.path;
  if (repoPath) return repos(s).find(r => resolve(r.path) === resolve(repoPath)) ?? {key:repoPath,label:reply.result?.repo?.name ?? repoPath.split("/").pop(),path:repoPath};
  if (typeof path !== "string") return null;
  // A linked worktree may live outside the repo. Git's common directory identifies its owner.
  const git = await run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], 2000);
  const root = git.code === 0 ? dirname(git.stdout.trim()) : path;
  return repos(s).find(r => resolve(r.path) === resolve(root)) ?? {key:root,label:root.split("/").pop() ?? root,path:root};
 } catch { return null; }
}
