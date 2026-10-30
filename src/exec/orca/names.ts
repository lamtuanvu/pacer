/**
 * The name Orca stores a new worktree under: Orca replaces every run of characters other than letters, digits, `.`,
 * `_` and `-` with `-` (so `claude-code#claude2` becomes `claude-code-claude2`) and names the directory after the
 * result. pacer asks for the stored name, so the path it checks and the name it asked for agree.
 */
export function orcaWorktreeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/-+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "");
}

/** A lane's new-child worktree: pacer-<taskId>-<runner id as Orca stores it>. Executor hooks recognise it by this name. */
export function laneWorktreeName(taskId: string, runnerId: string): string {
  return orcaWorktreeName(`pacer-${taskId}-${runnerId}`);
}
