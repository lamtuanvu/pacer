import type { RunFn } from "../../types";
import { isObj } from "../../util";
import { sanitizedOrcaEnv } from "../attestation-env";
export { sanitizedOrcaEnv } from "../attestation-env";

export interface OrcaError { code: string; message: string }
export type OrcaReply<T> = { ok: true; result: T } | { ok: false; error: OrcaError };

export interface OrcaEffect { kind: string; role?: string; action?: string; id?: string }
export interface StatusResult {
  app?: { running?: boolean };
  runtime?: { state?: string; reachable?: boolean; appVersion?: string };
}
export interface RepoRow { id: string; path: string }
/** `agentIdentity` is the agent Orca sees in the terminal's foreground (`claude`, `codex`), or null for a plain shell. */
export interface TerminalRow { handle: string; incarnationId?: string; exitCause?: { kind: string }; connected?: boolean; writable?: boolean; preview?: string; worktreeId?: string; worktreePath?: string; agentIdentity?: string | null }
export interface RunRow { id: string; coordinator_handle?: string; objective?: string }
export interface WorkerStartResult {
  runId?: string;
  taskId?: string;
  dispatchId?: string;
  state?: string;
  stage?: string;
  failedStage?: string;
  lastError?: string | null;
  effects?: OrcaEffect[];
  recovery?: string;
}
export interface WorkerClosureResult { dispatchId?: string; state?: string; processAction?: string; close?: { handle?: string; ptyKilled?: boolean } }
export interface WorkerRow { state?: string; stage?: string; worktreeId?: string; agentTerminalHandle?: string; lastError?: string | null }
export interface WorkerListRow { dispatchId?: string; workerState?: string; agentTerminalHandle?: string; resource?: { terminalHandle?: string } }
export interface WorktreeRow { id?: string; path?: string; repoId?: string; displayName?: string; isMainWorktree?: boolean }
export interface OrcaMessage { id: string; type: string; from_handle?: string; subject?: string; body?: string; payload?: string | null }
export interface CheckResult { deliveryId?: string | null; messages: OrcaMessage[]; timedOut?: boolean; acknowledged?: string | null }

export type Placement =
  | { kind: "new-child"; repoId: string; baseBranch: string; name: string; parentWorktree?: string }
  | { kind: "existing"; selector: string };
export interface WorkerStartOpts { spec: string; terminal: string; worktree: string; run: string; from: string }

export const WAKE_TYPES = "worker_done,escalation,question";
export const CALL_TIMEOUT_MS = 30_000;
export const START_TIMEOUT_MS = 240_000;

/** `check --wait` prints `{"_keepalive":...}` lines every 15 s (to stderr; to stdout when streams are merged). */
export function dropKeepalive(s: string): string {
  return s.split("\n").filter((l) => !l.trimStart().startsWith('{"_keepalive"')).join("\n").trim();
}

/** The final JSON envelope of an orca --json call, or null when there is none. */
export function parseOrcaOutput(stdout: string): unknown {
  const body = dropKeepalive(stdout);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function workerStartArgs(o: WorkerStartOpts): string[] {
  return [
    "orchestration", "worker-start", "--spec", o.spec, "--terminal", o.terminal,
    "--worktree", o.worktree, "--run", o.run, "--from", o.from,
  ];
}

/** Worktree ids look like `<repoId>::<absolute path>`. */
export function worktreePathOf(effects: OrcaEffect[] | undefined): string | null {
  const id = effects?.find((e) => e.kind === "worktree")?.id;
  if (!id) return null;
  const i = id.indexOf("::");
  return i >= 0 ? id.slice(i + 2) : null;
}

export function agentTerminalOf(effects: OrcaEffect[] | undefined): string | null {
  return effects?.find((e) => e.kind === "terminal" && e.role === "agent")?.id ?? null;
}

/** Message payloads are JSON strings (e.g. worker_done: taskId, dispatchId, outcome, filesModified, reportPath). */
export function parsePayload(m: OrcaMessage): Record<string, unknown> | null {
  if (typeof m.payload !== "string") return null;
  try {
    const v: unknown = JSON.parse(m.payload);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export function isReady(r: OrcaReply<StatusResult>): boolean {
  return r.ok && r.result.runtime?.state === "ready" && r.result.runtime?.reachable === true;
}

export function isLiveTerminal(r: OrcaReply<{ terminal?: TerminalRow }>): boolean {
  return r.ok && r.result.terminal?.connected === true && r.result.terminal?.writable === true;
}

/** Every orca CLI call pacer makes. `run` is injectable (Ctx.run), so tests answer from recorded receipts. */
export class OrcaClient {
  constructor(private readonly run: RunFn, private readonly env: Record<string,string|undefined> = process.env) {}

  async call<T>(args: string[], timeoutMs = CALL_TIMEOUT_MS): Promise<OrcaReply<T>> {
    const r = await this.run(["orca", ...args, "--json"], timeoutMs, {env: sanitizedOrcaEnv(this.env)});
    const env = parseOrcaOutput(r.stdout);
    if (isObj(env)) {
      const { ok, result, error } = env;
      if (ok === true && isObj(result)) return { ok: true, result: result as T };
      if (ok === false && isObj(error)) {
        return { ok: false, error: { code: String(error.code ?? "error"), message: String(error.message ?? "") } };
      }
    }
    const detail = (dropKeepalive(r.stderr) || r.stdout.trim()).slice(0, 500);
    return {
      ok: false,
      error: { code: r.code === 127 ? "not_installed" : "bad_output", message: detail || `orca exited with code ${r.code}` },
    };
  }

  status() { return this.call<StatusResult>(["status"], 15_000); }
  repoList() { return this.call<{ repos?: RepoRow[] }>(["repo", "list"]); }
  repoAdd(path: string) { return this.call<{ repo: RepoRow }>(["repo", "add", "--path", path]); }
  terminalCreate(worktree: string, title: string, command?: string) {
    return this.call<{ terminal: TerminalRow }>(["terminal", "create", "--worktree", worktree, "--title", title,
      ...(command ? ["--command", command] : [])]);
  }
  terminalWait(handle: string) { return this.call<{ wait?: { satisfied?: boolean; blockedReason?: string | null; status?: string } }>(
    ["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "60000"], 65_000); }
  /** `parentWorktree` nests the new worktree under a `--group`'s shared parent; `noParent` creates a top-level one. */
  worktreeCreate(p: Extract<Placement, {kind: "new-child"}> & { noParent?: boolean }) { return this.call<{worktree?: WorktreeRow; terminal?: TerminalRow; terminalHandle?: string; initialTerminalHandle?: string}>(
    ["worktree", "create", "--name", p.name, "--repo", `id:${p.repoId}`, "--base-branch", p.baseBranch, "--setup", "skip",
      ...(p.parentWorktree ? ["--parent-worktree", p.parentWorktree] : p.noParent ? ["--no-parent"] : [])]); }
  worktreeShow(path: string) { return this.worktreeShowBy(`path:${path}`); }
  worktreeShowBy(selector: string) { return this.call<{worktree?: WorktreeRow; terminal?: TerminalRow; terminalHandle?: string; initialTerminalHandle?: string}>(["worktree", "show", "--worktree", selector]); }
  worktreeRemove(id: string, force: boolean) { return this.call<Record<string, unknown>>(["worktree", "rm", "--worktree", `id:${id}`, ...(force ? ["--force"] : [])], 60_000); }
  terminalList(worktree: string) { return this.call<{ terminals?: TerminalRow[]; truncated?: boolean }>(["terminal", "list", "--worktree", worktree]); }
  terminalShow(handle: string) { return this.call<{ terminal?: TerminalRow }>(["terminal", "show", "--terminal", handle]); }
  terminalClose(handle: string) { return this.call<Record<string, unknown>>(["terminal", "close", "--terminal", handle]); }
  terminalSend(handle: string, text: string) { return this.call<Record<string, unknown>>(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]); }
  terminalEnter(handle: string) { return this.call<Record<string, unknown>>(["terminal", "send", "--terminal", handle, "--enter"]); }
  runCreate(objective: string, from: string) {
    return this.call<{ run: RunRow }>(["orchestration", "run-create", "--objective", objective, "--from", from]);
  }
  runShow(id: string) { return this.call<{ run: RunRow }>(["orchestration", "run-show", "--id", id]); }
  workerStart(o: WorkerStartOpts) { return this.call<WorkerStartResult>(workerStartArgs(o), START_TIMEOUT_MS); }
  workerList(run: string, cursor?: string) {
    return this.call<{ workers?: WorkerListRow[]; page?: { hasMore?: boolean; nextCursor?: string | null }; scope?: { run?: string } }>(
      ["orchestration", "worker-list", "--run", run, ...(cursor ? ["--cursor", cursor] : [])]);
  }
  workerShow(dispatch: string) { return this.call<{ worker?: WorkerRow }>(["orchestration", "worker-show", "--dispatch", dispatch]); }
  workerRead(dispatch: string, limit: number) {
    return this.call<{ terminal?: { tail?: string[] } }>(["orchestration", "worker-read", "--dispatch", dispatch, "--limit", String(limit)]);
  }
  workerStop(dispatch: string) { return this.call<WorkerClosureResult>(["orchestration", "worker-stop", "--dispatch", dispatch]); }
  workerRelease(dispatch: string) { return this.call<WorkerClosureResult>(["orchestration", "worker-release", "--dispatch", dispatch]); }
  reply(o: { id: string; body: string; run: string; from: string }) {
    return this.call<Record<string, unknown>>(["orchestration", "reply", "--id", o.id, "--body", o.body, "--run", o.run, "--from", o.from]);
  }
  /** waitMs null = no --wait (used to ack the last batch). The ack call also returns the next batch. */
  check(o: { terminal: string; run: string; waitMs: number | null; ack?: string | null }) {
    const args = [
      "orchestration", "check",
      ...(o.ack ? ["--ack", o.ack] : []),
      ...(o.waitMs !== null ? ["--wait", "--types", WAKE_TYPES, "--timeout-ms", String(o.waitMs)] : []),
      "--terminal", o.terminal, "--run", o.run,
    ];
    return this.call<CheckResult>(args, (o.waitMs ?? 0) + CALL_TIMEOUT_MS);
  }
}
