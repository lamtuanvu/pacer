import { realpathSync } from "node:fs";
import { isAbsolute, relative, dirname, resolve } from "node:path";
import type { RunFn } from "../types";

export interface RepoInfo { top: string; branch: string; sub: string; dirty: boolean; main: string; linked: boolean }

export function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The repo's git top level, current branch ("HEAD" when detached), sub-path of `repo` inside it, and dirtiness. */
export async function gitInfo(run: RunFn, repo: string): Promise<RepoInfo | { error: string }> {
  const r = await run(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-common-dir"], 10_000);
  const [top = "", branch = "", common = ""] = r.stdout.trim().split("\n").map((l) => l.trim());
  if (r.code !== 0 || !top || !branch) {
    const why = r.stderr.trim().split("\n")[0] || `git exited with code ${r.code}`;
    return { error: `${repo} is not a git repository with at least one commit (${why})` };
  }
  const rel = relative(top, realpathSafe(repo));
  const sub = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : "";
  const st = await run(["git", "-C", top, "status", "--porcelain"], 10_000);
  if(st.code!==0)return {error:`cannot inspect working tree: ${st.stderr.trim()||st.code}`};
  const main=realpathSafe(dirname(common?resolve(repo,common):resolve(top,".git")));
  return { top, branch, sub, main, linked:realpathSafe(top)!==main, dirty: st.code === 0 && st.stdout.trim() !== "" };
}

/** UI-only reads must finish even when a RunFn does not enforce its timeout. */
export async function boundedGitRead(run: RunFn, argv: string[], timeoutMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(argv, timeoutMs)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("git read timed out")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
