import type { OrcaHost } from "./orca-api";
export type OrcaExec = (bin: string, args: string[]) => Promise<string>;
/** Resolve host focus, never the worker process's CWD. */
export async function resolveFocusedWorktree(host: OrcaHost, exec: OrcaExec, cli: string): Promise<{ id: string } | null> {
  const context = await host.call("workspace.readContext");
  if (!context?.branch) return null;
  if (context.worktreeId) return { id: context.worktreeId };
  const reply = JSON.parse(await exec(cli, ["worktree", "list", "--json"]));
  if (reply.ok === false) throw new Error(reply.error?.message || "Could not list Orca worktrees");
  const matches = (reply.result?.worktrees ?? []).filter((w: any) => typeof w.id === "string" && w.branch === context.branch && w.displayName === context.displayName);
  const activity = (at: unknown) => typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) || 0 : 0;
  matches.sort((a: any, b: any) => activity(b.lastActivityAt) - activity(a.lastActivityAt));
  return matches.length ? { id: matches[0].id } : null;
}
