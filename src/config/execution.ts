import { isObj } from "../util";

export const EXEC_BACKENDS = ["auto", "orca", "direct"] as const;
export const WORKTREE_MODES = ["child-of-current", "new-child", "current"] as const;
export const IDLE_AFTER_S = 600;
export const IDLE_FAIL_S = 1800;
export type ExecBackend = (typeof EXEC_BACKENDS)[number];
export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export interface ExecutionCfg {
  localMaxTasks?: number;
  session?: "pty" | "pipe";
  sessionLogMb?: number;
  sessionRetentionDays?: number;
  backend: ExecBackend;
  worktree: WorktreeMode;
  baseBranch: string | null;
  registerRepos?: boolean;
  idleAfterS?: number;
  idleFailS?: number;
}

export const DEFAULT_EXECUTION: ExecutionCfg = { localMaxTasks: 2, backend: "auto", worktree: "child-of-current", baseBranch: null };

const KEYS = ["local_max_tasks", "session", "session_log_mb", "session_retention_days", "backend", "worktree", "base_branch", "registerRepos", "register_repos", "idle_after_min", "idle_fail_min"];

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
  const localMaxTasks = raw.local_max_tasks ?? 2;
  if (typeof localMaxTasks !== "number" || !Number.isInteger(localMaxTasks) || localMaxTasks < 1 || localMaxTasks > 16) p.push("execution.local_max_tasks must be 1..16");
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
  const mins = (k: string): number | undefined => {
    const v = raw[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1440) {
      p.push(`execution.${k} must be a whole number of minutes between 1 and 1440`);
      return undefined;
    }
    return v;
  };
  const idleAfter = mins("idle_after_min"), idleFail = mins("idle_fail_min");
  if ((idleFail ?? IDLE_FAIL_S / 60) <= (idleAfter ?? IDLE_AFTER_S / 60)) p.push("execution.idle_fail_min must be greater than execution.idle_after_min");
  if (raw.session !== undefined && raw.session !== "pty" && raw.session !== "pipe") p.push("execution.session must be pipe or pty");
  for (const [key, max] of [["session_log_mb", 256], ["session_retention_days", 3650]] as const) {
    const v = raw[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max)) p.push(`execution.${key} must be an integer between 1 and ${max}`);
  }
  if (p.length) throw new ExecutionError(p);
  return {
    ...(raw.session !== undefined ? {session: raw.session as "pty" | "pipe"} : {}),
    ...(raw.session_log_mb !== undefined ? {sessionLogMb: raw.session_log_mb as number} : {}),
    ...(raw.session_retention_days !== undefined ? {sessionRetentionDays: raw.session_retention_days as number} : {}),
    localMaxTasks: localMaxTasks as number, backend: backend as ExecBackend, worktree: worktree as WorktreeMode, baseBranch,
    ...(registerRepos !== undefined ? { registerRepos: registerRepos as boolean } : {}),
    ...(idleAfter !== undefined ? { idleAfterS: idleAfter * 60 } : {}),
    ...(idleFail !== undefined ? { idleFailS: idleFail * 60 } : {}),
  };
}
