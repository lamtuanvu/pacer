import { isObj } from "../util";

export const EXEC_BACKENDS = ["auto", "orca", "direct"] as const;
export const WORKTREE_MODES = ["child-of-current", "new-child", "current"] as const;
export type ExecBackend = (typeof EXEC_BACKENDS)[number];
export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export interface ExecutionCfg {
  backend: ExecBackend;
  worktree: WorktreeMode;
  baseBranch: string | null;
  registerRepos?: boolean;
}

export const DEFAULT_EXECUTION: ExecutionCfg = { backend: "auto", worktree: "child-of-current", baseBranch: null };

const KEYS = ["backend", "worktree", "base_branch", "registerRepos", "register_repos"];

export class ExecutionError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid execution section in the strategy:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ExecutionError";
  }
}

/** Validate the strategy's `execution:` section. Plan 0 passes it through raw (`{}` when absent). */
export function validateExecution(raw: unknown): ExecutionCfg {
  if (raw === undefined || raw === null) return { ...DEFAULT_EXECUTION };
  if (!isObj(raw)) throw new ExecutionError(["execution must be a mapping"]);
  const p: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!KEYS.includes(k)) p.push(`execution: unknown key "${k}" (allowed: ${KEYS.join(", ")})`);
  }
  const backend = String(raw.backend ?? DEFAULT_EXECUTION.backend);
  if (!(EXEC_BACKENDS as readonly string[]).includes(backend)) {
    p.push(`execution.backend must be one of ${EXEC_BACKENDS.join(", ")} (got "${backend}")`);
  }
  const worktree = String(raw.worktree ?? (raw.base_branch != null ? "new-child" : DEFAULT_EXECUTION.worktree));
  if (!(WORKTREE_MODES as readonly string[]).includes(worktree)) {
    p.push(`execution.worktree must be one of ${WORKTREE_MODES.join(", ")} (got "${worktree}")`);
  }
  let baseBranch: string | null = null;
  if (raw.base_branch !== undefined && raw.base_branch !== null) {
    const b = raw.base_branch;
    if (typeof b !== "string" || !/^[^\s-]\S*$/.test(b)) {
      p.push('execution.base_branch must be a branch or ref name without spaces that does not start with "-"');
    } else {
      baseBranch = b;
    }
  }
  const registerRepos=raw.registerRepos??raw.register_repos;
  if(registerRepos!==undefined&&typeof registerRepos!=="boolean")p.push("execution.registerRepos must be a boolean");
  if (p.length) throw new ExecutionError(p);
  return { backend: backend as ExecBackend, worktree: worktree as WorktreeMode, baseBranch, ...(registerRepos!==undefined?{registerRepos:registerRepos as boolean}:{}) };
}
