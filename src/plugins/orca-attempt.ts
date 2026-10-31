import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { beginWorkSync, bindOrcaWorkSync, finishOrcaWorkSync, finishWorkSync } from "../update/desktop/admission";
import { shellCommand } from "../install/fsx";
import { claudeConfigFile, type McpChoices, projectMcpChoices } from "../exec/claude-trust";
import { launchArgvFor, providerEnv } from "../exec/launch";
import { recordDefaultFolder } from "../exec/account-folder";
import { profileKeys, terminalEnv, type TerminalEnv } from "../exec/login-env";
import { prepareInteractive } from "../session/reports";
import { type ExecutionCfg, validateExecution } from "../config/execution";
import { type ProviderCfg, loadStrategy } from "../config/strategy";
import { readTask, tasksDir, updateTask } from "../tasks/store";
import type { LiveWorker, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import type { Backend } from "../exec/backend";
import { type AttemptOutcome, mcpNotApproved, REPORT_CHARS, runAttempt as directAttempt, runDir, tail } from "../exec/direct";
import { detectLimit } from "../exec/limits";
import { brokenReason, repoFingerprint } from "../exec/broken";
import type { ExecResult } from "../exec/process";
import { buildPrompt } from "../exec/prompt";
import { OrcaClient, type TerminalRow, type WorkerStartResult } from "../exec/orca/client";
import { closeCreatedTerminal, discardCreatedWorktree, lookupWorker, type OwnedWorktree, recordStrayRisk, recordUnclosed,
  releaseEmptyGroup, type WorkerLookup, worktreeTerminals } from "../exec/orca/cleanup";
import { ensureCoordinator, gitInfo, realpathSafe } from "../exec/orca/setup";
import { updateOrcaState, withLock } from "../exec/orca/state";
import { type WaitResult, waitForWorker } from "../exec/orca/wait";
import { CoreError } from "../core/errors";
import { checkedWorktree, findLiveAnswerWorker, liveAgentProblem, liveLaneWorktree, mapFailedStart, type Mapped, mapWait, prepareOrca,
  type Ready, releaseLive, releaseStoppedLane, settleWorker, waitLine, workerSpec } from "./orca-host";

export const ORCA_PROVIDER = "pacer-exec-orca";

export interface OrcaRouteDeps {
  loadExecution: (ctx: Ctx) => ExecutionCfg;
  admission: { begin: typeof beginWorkSync; bind: typeof bindOrcaWorkSync; finishOrca: typeof finishOrcaWorkSync; finish: typeof finishWorkSync };
  direct: Backend["runAttempt"];
  /** The user's login-shell environment, read for the default account's folder only. */
  terminalEnv: (ctx: Ctx) => Promise<TerminalEnv>;
  sliceMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const ORCA_DEFAULTS: OrcaRouteDeps = {
  loadExecution: (ctx) => validateExecution(loadStrategy(ctx).execution),
  admission: { begin: beginWorkSync, bind: bindOrcaWorkSync, finishOrca: finishOrcaWorkSync, finish: finishWorkSync },
  // Late-bound: the direct backend's module graph reaches the plugin host that loads this one.
  direct: (ctx, cfg, task, onSpawn) => directAttempt(ctx, cfg, task, onSpawn),
  terminalEnv: (ctx) => terminalEnv(ctx.env, {cwd: ctx.home}),
  sliceMs: 30_000,
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

/** Wire shape of a started worker. */
export interface StartedWire { kind: "started"; dispatchId: string; state: string | null; stage: string | null; failedStage: string | null; lastError: string | null }
type Phase = "new" | "checked" | "reattaching" | "prepared" | "placed" | "terminal" | "refused" | "uncertain" | "started" | "settled" | "fallback" | "done";

const sessions = new Map<string, OrcaAttemptSession>();
export const orcaSession = (id: string): OrcaAttemptSession | undefined => sessions.get(id);

/** The attempt outcome contract bounds each captured stream. */
const EXEC_CHARS = 262_144;
/** Wire reasons are non-empty and bounded; the attempt log keeps the full text. */
const bounded = (reason: string) => (reason.trim() || "unknown").slice(0, 4096);
const message = (e: unknown) => String(e instanceof Error ? e.message : e);
const deny = (why: string): never => { throw new CoreError("capability_denied", why); };

/**
 * One host-issued Orca attempt. Every effect checks the phase it may run in, so a provider can neither skip
 * placement nor start a second worker; the state it holds (terminal, worktree, lease, dispatch) never crosses
 * the wire as authority.
 */
export class OrcaAttemptSession {
  readonly id = randomUUID();
  readonly attempt: number;
  readonly c: OrcaClient;
  readonly lines: string[] = [];
  readonly log = (line: string) => { this.lines.push(line); };
  phase: Phase = "new";
  mode: "fresh" | "reattach" = "fresh";
  p?: Ready;
  admission?: string;
  terminal: string | null = null;
  created: OwnedWorktree | null = null;
  worktree: string | null = null;
  selector = "";
  incarnationId?: string;
  prompt = "";
  startedAt: number;
  endedAt?: number;
  dispatchId?: string;
  start?: WorkerStartResult;
  uncertain?: string;
  found?: WorkerLookup;
  lastWait?: WaitResult;
  readTail?: string;
  before: string | null = null;
  reattachLive?: LiveWorker;
  private coordinatorCache?: { coordinator: string; run: string };
  outcome?: AttemptOutcome;
  /** Another start owns this attempt: release this attempt's own resources, and never fall back. */
  duplicate = false;
  private readonly strays: string[] = [];
  private readonly unproven: string[] = [];

  constructor(readonly ctx: Ctx, readonly cfg: ProviderCfg, readonly task: TaskRecord, readonly deps: OrcaRouteDeps, readonly ex: ExecutionCfg) {
    this.attempt = task.attempts.length + 1;
    this.c = new OrcaClient(ctx.run, ctx.env);
    this.startedAt = deps.now() / 1000;
    sessions.set(this.id, this);
  }

  close(): void { sessions.delete(this.id); }

  /** Admission bookkeeping must never skip terminal close or supervision. */
  private book(what: string, f: () => unknown): void {
    try { f(); } catch (e) { this.log(`${what} failed: ${message(e)}`); }
  }
  private expect(...phases: Phase[]): void {
    if (!phases.includes(this.phase)) deny(`Orca attempt is ${this.phase}; this effect is not issued now`);
  }
  private worktreeId(): string | undefined { return this.selector ? this.selector.slice("id:".length) : undefined; }
  private logFile(): string {
    const dir = tasksDir(this.ctx);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${this.task.id}.${this.cfg.id}.log`);
  }
  /** Whether the effects so far still allow a logged direct fallback: no worker can exist. */
  get preStart(): boolean { return ["new", "checked", "prepared", "placed", "terminal", "refused", "fallback"].includes(this.phase); }
  /** Set only when the host's own placement refused the attempt; a provider cannot claim a refusal. */
  hostRefused = false;

  /** An interactive lane's escalation keeps its worker; an answer reattaches to it instead of starting a fresh one. */
  async liveAnswer(): Promise<{ kind: "none" } | { kind: "fallback"; reason: string } | { kind: "attached"; dispatchId: string }> {
    this.expect("new");
    const { ctx, c, cfg, task, deps } = this;
    const reattach = await findLiveAnswerWorker(ctx, c, task, cfg.id);
    if (!reattach) { this.phase = "checked"; return { kind: "none" }; }
    const { live, worktree } = reattach;
    const { worker: dispatchId, terminal } = live;
    // A direct attempt must never share the worktree with the lane's live agent: release it before falling back.
    const fallBack = async (reason: string) => {
      await releaseLive(ctx, c, reattach.asked, `the answer runs directly: ${reason}`, this.log).catch(() => {});
      this.phase = "fallback";
      return { kind: "fallback" as const, reason: bounded(reason) };
    };
    const git = await gitInfo(ctx.run, task.brief.repo);
    if ("error" in git) return fallBack(git.error);
    const coord = await ensureCoordinator(ctx, c, git.top);
    if ("error" in coord) return fallBack(coord.error);
    this.coordinatorCache = coord;
    this.startedAt = deps.now() / 1000;
    // From the first ownership change on, the live worker belongs to this attempt: a failure stops it, never falls back.
    this.mode = "reattach";
    this.reattachLive = live;
    this.dispatchId = dispatchId;
    this.terminal = terminal;
    this.worktree = worktree;
    this.phase = "reattaching";
    // The answering attempt takes ownership, so `pacer send` and the next answer find the worker under this task.
    const owned = { ...live, since: ctx.now };
    if (reattach.asked.id !== task.id) updateTask(ctx, reattach.asked.id, t => {
      if (t.live?.worker === dispatchId) delete t.live;
      t.state = "partial";
      if (t.result) t.result = { ...t.result, status: "partial", report: `${t.result.report}\nSuperseded by answer task ${task.id}.` };
      t.dismissed = true;
      t.settledAt = ctx.now;
    });
    updateTask(ctx, task.id, t => {
      t.live = owned;
      if (worktree) t.worktree = worktree;
      t.group = reattach.asked.group;
      t.baseBranch = reattach.asked.baseBranch;
      t.baseSha = reattach.asked.baseSha;
      t.startSha = reattach.asked.startSha;
      t.placement = reattach.asked.placement;
    });
    await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { if (s.workers[dispatchId]) s.workers[dispatchId].taskId = task.id; }); });
    const answerText = task.brief.qa?.at(-1)?.a;
    if (answerText) {
      // Checked again right before typing: setup above can take seconds, and the agent may have exited meanwhile.
      const problem = await liveAgentProblem(c, owned);
      const sent = problem ? null : await c.terminalSend(terminal, answerText);
      this.log(problem ? `did not deliver the answer: ${problem}` : `delivered the answer live to ${terminal}: ${sent!.ok ? "ok" : sent!.error.code}`);
      if (!sent?.ok) {
        await releaseLive(ctx, c, { ...task, live: owned }, problem ?? `the answer could not be delivered (${sent!.ok ? "" : sent!.error.code})`, this.log);
        // A fresh attempt follows; the released worker's lines belong to no outcome.
        this.lines.length = 0;
        this.startedAt = deps.now() / 1000;
        this.mode = "fresh";
        delete this.reattachLive; delete this.dispatchId;
        this.terminal = null; this.worktree = null;
        this.phase = "checked";
        return { kind: "none" };
      }
    } else {
      this.log(`reattached to ${dispatchId} with no live answer to deliver`);
    }
    const adm = deps.admission;
    this.admission = adm.begin(ctx, { kind: "session", id: task.id, label: `Orca session ${task.id}` });
    const admission = this.admission;
    this.book("admission binding", () => adm.bind(ctx, admission, { dispatchId, terminal, ...(live.incarnation ? { incarnationId: live.incarnation } : {}) }));
    this.prompt = buildPrompt({ ...task.brief, repo: worktree ? `the existing Orca worktree at ${worktree}` : task.brief.repo }, task.id);
    this.before = await repoFingerprint(ctx, worktree ?? task.brief.repo);
    this.start = { dispatchId, state: "ready" };
    this.phase = "started";
    return { kind: "attached", dispatchId };
  }

  async prepare(): Promise<{ ok: true; agent: "claude" | "codex"; model: string | null; placement: "new-child" | "existing"; notes: string[] }
    | { ok: false; reason: string; refuse: boolean }> {
    this.expect("checked");
    const { ctx, c, cfg, task, deps } = this;
    let p;
    try { p = await prepareOrca(ctx, c, cfg, task, this.ex); }
    catch (e) { this.phase = "fallback"; return { ok: false, reason: bounded(message(e)), refuse: false }; }
    if (!p.ok) { this.phase = "fallback"; this.hostRefused = !!p.refuse; return { ok: false, reason: bounded(p.reason), refuse: !!p.refuse }; }
    this.p = p;
    updateTask(ctx, task.id, t => { t.baseBranch = p.base; t.placement = { requested: task.placement?.requested ?? "auto", ...task.placement, ...p.resolved }; if (!task.retryOf) delete t.worktree; });
    this.startedAt = deps.now() / 1000;
    this.prompt = workerSpec(task, p);
    this.admission = deps.admission.begin(ctx, { kind: "session", id: task.id, label: `Orca session ${task.id}` });
    this.phase = "prepared";
    return { ok: true, agent: p.agent as "claude" | "codex", model: p.model, placement: p.placement.kind, notes: p.notes.slice(0, 8) };
  }

  /** Orca opens its own shell terminal in a new worktree; the create reply may not name it, so list the worktree. */
  private async closeStrays(w: OwnedWorktree, reply: TerminalRow[], when: string): Promise<void> {
    const { ctx, c, task } = this;
    const listed = await worktreeTerminals(c, w.id, [...this.strays, ...(this.terminal ? [this.terminal] : [])]);
    if (!listed) {
      this.log(`orca terminal list for ${w.id} failed or was truncated; Orca's initial terminal may stay open`);
      // Only handles known before pacer's agent terminal exists are Orca's own; a later terminal may be the user's.
      await recordStrayRisk(ctx, task.id, w, this.terminal ? [] : reply.map(t => t.handle), this.log);
    }
    const rows = [...reply, ...(listed ?? [])].filter((t, i, all) => all.findIndex(x => x.handle === t.handle) === i);
    for (const t of rows) {
      const closed = await closeCreatedTerminal(c, t.handle);
      this.log(`closed Orca initial terminal ${t.handle}${when}: ${closed.failure ?? "ok"}`);
      if (closed.proof) { this.strays.push(t.handle); continue; }
      this.unproven.push(t.handle);
      await recordUnclosed(ctx, task.id, t.handle, this.log, w.id);
    }
    if (this.unproven.length) throw Error(`orca worktree initial terminal ${this.unproven.join(", ")} could not be verified closed`);
  }

  async place(): Promise<{ ok: true; worktreeId: string; workdir: string } | { ok: false; reason: string }> {
    this.expect("prepared");
    this.phase = "placed";
    const { ctx, c, task } = this, p = this.p!;
    try {
      const kind = p.placement.kind === "new-child" ? "create" : "show";
      const placement = p.placement.kind === "new-child"
        ? await c.worktreeCreate(p.placement)
        : await c.worktreeShow(realpathSafe(p.placement.selector.slice("path:".length)));
      if (!placement.ok) throw Error(`orca worktree ${kind} failed: ${placement.error.code} ${placement.error.message}`);
      // Older Orca replies named the initial terminal; current ones do not.
      const named = placement.result.terminal?.handle ?? placement.result.initialTerminalHandle ?? placement.result.terminalHandle;
      const initial: TerminalRow[] = p.placement.kind === "new-child" && named
        ? [{handle: named, ...(placement.result.terminal?.handle === named && placement.result.terminal.incarnationId ? {incarnationId: placement.result.terminal.incarnationId} : {})}] : [];
      let checked: { id: string; path: string };
      try { checked = checkedWorktree(p, placement.result.worktree); }
      catch (e) {
        if (p.placement.kind === "new-child") this.log(`Orca worktree ${placement.result.worktree?.id ?? "(no id)"} not removed: its identity is unverified`);
        throw e;
      }
      const { id, path: root } = checked;
      if (p.placement.kind === "new-child") this.created = { id, path: root, name: p.placement.name };
      this.selector = `id:${id}`;
      this.log(`worktree ${kind} ${id}: ${root}`);
      if (this.created) await this.closeStrays(this.created, initial, "");
      this.worktree = p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo)
        : p.sub ? join(root, p.sub) : root;
      if (p.resolved.mode === "current" && !readTask(ctx, task.id)?.startSha) {
        const head = await ctx.run(["git", "-C", this.worktree, "rev-parse", "--verify", "-q", "HEAD"], 10_000);
        const sha = head.stdout.trim();
        if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
          throw Error("cannot record the current checkout's start commit");
        }
        updateTask(ctx, task.id, t => { t.startSha ??= sha; });
      }
      return { ok: true, worktreeId: id, workdir: this.worktree };
    } catch (e) { return { ok: false, reason: bounded(message(e)) }; }
  }

  /** Pacer composes the agent command from host launch policy only; the brief travels separately in --spec. */
  async createTerminal(): Promise<{ ok: true; terminal: string; incarnationId: string | null } | { ok: false; reason: string }> {
    this.expect("placed");
    if (!this.selector) deny("Orca worktree is not placed");
    this.phase = "terminal";
    const { ctx, c, cfg, task, deps } = this, p = this.p!;
    try {
      const root = this.selector.slice(this.selector.indexOf("::") + 2);
      const accountEnv = await providerEnv(ctx, cfg);
      if (Object.keys(accountEnv).some(key => key !== "CLAUDE_CONFIG_DIR" && key !== "CODEX_HOME")) {
        throw Error("account environment contains values that cannot be placed in a visible Orca terminal command");
      }
      // CLAUDE_CODE_SANDBOXED makes Claude treat the folder as trusted without writing its configuration.
      const agentRunDir = `${runDir(ctx, task.id, this.attempt)}-orca`;
      const identity = ["PACER_ROLE=executor", `PACER_TASK_ID=${task.id}`, `PACER_HOME=${ctx.pacerHome}`,
        `PACER_RUN_DIR=${agentRunDir}`, `PACER_TRANSCRIPT_REPORT=${join(agentRunDir, "transcript-report.md")}`,
        ...(ctx.env.PACER_PORT ? [`PACER_PORT=${ctx.env.PACER_PORT}`] : []), ...(p.agent === "claude" ? ["CLAUDE_CODE_SANDBOXED=1"] : [])];
      // As in a direct launch, a default account uses the folder the user's login profile sets. Orca's shell environment
      // is not the service's, so without a profile folder a default account must not inherit another account's home.
      const agent = p.agent === "claude" ? "claude-code" : "codex", home = p.agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const base = await deps.terminalEnv(ctx).catch((e): TerminalEnv => ({env: ctx.env, source: "service", reason: String(e)}));
      recordDefaultFolder(ctx, agent, accountEnv, base);
      const profileHome = !(home in accountEnv) && profileKeys(base).includes(home) ? base.env[home] : undefined;
      const folders: Record<string, string> = {...(profileHome?.startsWith("/") ? {[home]: profileHome} : {}), ...accountEnv};
      const unset = home in folders ? [] : ["-u", home];
      // As in a direct launch in a pacer task worktree, a worktree pacer created for this task (new-child, identity
      // verified above) carries the source checkout's MCP answers, so project servers are approved and rejected ones stay
      // off. Read-only, from the account Claude uses in this terminal; .claude.json is never written (trust is
      // CLAUDE_CODE_SANDBOXED). An existing or retry placement keeps Claude's MCP prompt.
      let mcp: McpChoices | undefined;
      if (agent === "claude-code") {
        const answers = this.created
          ? projectMcpChoices(claudeConfigFile({...base.env, CLAUDE_CONFIG_DIR: folders.CLAUDE_CONFIG_DIR}, ctx.home), [task.brief.repo, p.top, p.main])
          : {reason: "only pacer-created task worktrees are"};
        if ("reason" in answers) this.log(mcpNotApproved(answers.reason));
        else mcp = answers;
      }
      // The direct interactive launch for this runner and worktree, with its per-run settings file (bypass-permissions
      // acknowledgement, MCP answers). pacer's PTY session hooks stay out: Orca supervises this terminal.
      const launch = prepareInteractive(agent, agentRunDir,
        {cwd: root, argv: launchArgvFor(cfg, root, tasksDir(ctx), p.top)}, {sessionHooks: false, ...(mcp ? {mcp} : {})}).argv;
      // `exec` replaces the terminal's login shell with the agent: when the agent exits the terminal ends, so no shell is
      // ever left behind it to receive text typed for the agent (`task.send`, a live answer).
      const command = shellCommand(["exec", "env", ...unset, ...identity, ...Object.entries(folders).map(([key, value]) => `${key}=${value}`), ...launch]);
      const shown = shellCommand(["exec", "env", ...unset, ...identity.map(value => value.startsWith("PACER_HOME=") ? "PACER_HOME=<PACER_HOME>"
        : value.startsWith("PACER_RUN_DIR=") ? "PACER_RUN_DIR=<PACER_RUN_DIR>"
        : value.startsWith("PACER_TRANSCRIPT_REPORT=") ? "PACER_TRANSCRIPT_REPORT=<PACER_TRANSCRIPT_REPORT>" : value),
        ...Object.keys(folders).map(key => `${key}=<${key}>`), ...launch]);
      const made = await c.terminalCreate(this.selector, `pacer ${task.id}`, command);
      if (!made.ok || !made.result.terminal?.handle) throw Error(`orca terminal create failed: ${made.ok ? "no handle" : `${made.error.code} ${made.error.message}`}`);
      this.terminal = made.result.terminal.handle;
      this.log(`terminal create ${this.terminal}: ${shown}`);
      this.incarnationId = made.result.terminal.incarnationId;
      deps.admission.bind(ctx, this.admission!, {dispatchId: "pending", terminal: this.terminal, ...(this.incarnationId ? {incarnationId: this.incarnationId} : {})});
      const idle = await c.terminalWait(this.terminal);
      const state = idle.ok ? (idle.result.wait?.satisfied === true ? "idle" : idle.result.wait?.blockedReason ?? idle.result.wait?.status ?? "timeout") : `${idle.error.code} ${idle.error.message}`;
      this.log(`terminal wait ${this.terminal}: ${state}`);
      if (state !== "idle") throw Error(`orca terminal did not become idle: ${state}`);
      return { ok: true, terminal: this.terminal, incarnationId: this.incarnationId ?? null };
    } catch (e) { return { ok: false, reason: bounded(message(e)) }; }
  }

  /** A fallback leaves nothing in Orca: the lane's worktree, then its group parent once no other lane uses it. */
  private async discard(): Promise<void> {
    if (!this.created) return;
    const p = this.p!;
    await discardCreatedWorktree(this.ctx, this.c, this.task.id, this.created, this.log, { sleep: this.deps.sleep });
    if (this.task.group && p.placement.kind === "new-child") await releaseEmptyGroup(this.ctx, this.c, p.placement.repoId, this.task.group, this.log, { sleep: this.deps.sleep });
  }

  /** Before any worker exists: close the exact created terminal, discard the created worktree, then fall back. */
  async abandon(reason: string): Promise<{ reason: string }> {
    this.expect("prepared", "placed", "terminal", "refused");
    const { ctx, c, task, deps } = this;
    let closed = !this.terminal;
    if (this.terminal) {
      const result = await closeCreatedTerminal(c, this.terminal);
      this.log(`closed pacer terminal ${this.terminal}: ${result.failure ?? "ok"}`);
      closed = result.proof;
      if (result.failure) reason += `; terminal close failed ${this.terminal}: ${result.failure}`;
      if (!result.proof && !this.unproven.includes(this.terminal)) await recordUnclosed(ctx, task.id, this.terminal, this.log, this.worktreeId());
    }
    await this.discard();
    if (closed && this.admission) { const admission = this.admission; this.book("admission release", () => deps.admission.finish(ctx, admission)); }
    this.phase = "fallback";
    return { reason: bounded(reason) };
  }

  /** The deterministic per-attempt start key recorded with the intent; Orca's replay of it is not relied on. */
  private requestId(): string {
    return createHash("sha256").update(`${realpathSafe(this.ctx.pacerHome)}\0${this.task.id}\0${this.attempt}`).digest("hex").slice(0, 32);
  }

  /** One worker per attempt: the intent is durable before the only mutating worker-start effect. */
  async startWorker(): Promise<StartedWire | { kind: "refused"; code: string; message: string } | { kind: "uncertain"; reason: string }> {
    this.expect("terminal");
    const { ctx, c, task } = this, p = this.p!, terminal = this.terminal!;
    const requestId = this.requestId();
    await withLock(ctx, "coordinator", async () => {
      updateOrcaState(ctx, s => {
        const prior = Object.values(s.starting).find(x => x.taskId === task.id && x.attempt === this.attempt)
          ?? Object.values(s.uncertain).find(x => x.taskId === task.id && x.attempt === this.attempt)
          ?? Object.values(s.workers).find(x => x.taskId === task.id && x.attempt === this.attempt);
        if (prior) {
          this.duplicate = true;
          throw new CoreError("conflict", "an Orca worker start for this attempt is already recorded; a second start is refused");
        }
        s.starting[terminal] = { taskId: task.id, attempt: this.attempt, terminal, run: p.run, requestId, worktree: this.created, at: ctx.now, pid: process.pid };
      });
    });
    this.phase = "uncertain";
    this.log(`start intent ${requestId} recorded for ${terminal}`);
    const forgetIntent = () => withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.starting[terminal]; delete s.uncertain[terminal]; }); });
    let ws: Awaited<ReturnType<OrcaClient["workerStart"]>> | null = null;
    try { ws = await c.workerStart({ spec: this.prompt, terminal, worktree: this.selector, run: p.run, from: p.coordinator }); }
    catch (e) { this.uncertain = message(e); }
    if (ws?.ok && ws.result.dispatchId) {
      await this.bind(ws.result);
      await forgetIntent().catch(e => this.log(`clearing the start intent failed: ${message(e)}`));
      return this.started();
    }
    if (ws && !ws.ok && ws.error.code === "task_not_startable") {
      this.log(`worker-start refused: ${ws.error.code} ${ws.error.message}`);
      await forgetIntent();
      this.phase = "refused";
      return { kind: "refused", code: ws.error.code, message: ws.error.message };
    }
    if (ws) this.uncertain = ws.ok ? "orca worker-start returned no dispatch id" : `${ws.error.code}: ${ws.error.message}`;
    this.log(`worker-start uncertain: ${this.uncertain}`);
    return { kind: "uncertain", reason: bounded(this.uncertain ?? "") };
  }

  private started(): StartedWire {
    const start = this.start!;
    return { kind: "started", dispatchId: this.dispatchId!, state: start.state ?? null, stage: start.stage ?? null,
      failedStage: start.failedStage ?? null, lastError: start.lastError ?? null };
  }

  /** Never fall back while a worker may exist: look the terminal's dispatch up. Read-only. */
  async lookup(): Promise<WorkerLookup> {
    this.expect("uncertain");
    this.found = await lookupWorker(this.c, this.p!.run, this.terminal!);
    const found = this.found;
    this.log(`worker-list ${this.p!.run} for ${this.terminal}: ${found.kind === "found" ? `${found.dispatchId} ${found.state}` : found.kind === "none" ? "no worker" : found.reason}`);
    return found.kind === "unknown" ? { kind: "unknown", reason: bounded(found.reason) }
      : found.kind === "found" ? { kind: "found", dispatchId: found.dispatchId, state: found.state.slice(0, 256) } : found;
  }

  async adopt(): Promise<StartedWire> {
    this.expect("uncertain");
    const found = this.found;
    if (found?.kind !== "found") deny("no worker was found for this terminal");
    const dispatchId = (found as Extract<WorkerLookup, { kind: "found" }>).dispatchId;
    await this.bind({ dispatchId, state: (found as Extract<WorkerLookup, { kind: "found" }>).state === "failed" ? "failed" : "ready" });
    await withLock(this.ctx, "coordinator", async () => { updateOrcaState(this.ctx, s => { delete s.starting[this.terminal!]; delete s.uncertain[this.terminal!]; }); })
      .catch(e => this.log(`clearing the start intent failed: ${message(e)}`));
    return this.started();
  }

  private async keep(why: string): Promise<void> {
    const { ctx, task } = this, terminal = this.terminal!, p = this.p!;
    try {
      await withLock(ctx, "coordinator", async () => {
        updateOrcaState(ctx, s => {
          s.uncertain[terminal] = { taskId: task.id, attempt: this.attempt, terminal, run: p.run, worktree: this.created, at: ctx.now };
          delete s.starting[terminal];
        });
      });
    } catch (e) { this.log(`recording uncertain start failed: ${String(e)}`); }
    this.log(`kept terminal ${terminal} (run ${p.run}) and its work lease for later reconciliation: ${why}`);
  }

  private async unstartedOutcome(report: string): Promise<AttemptOutcome> {
    const logFile = this.logFile();
    await Bun.write(logFile, [...this.lines, "--- summary", report].join("\n") + "\n");
    this.phase = "done";
    this.outcome = {
      exec: { code: 1, stdout: report, stderr: "", timedOut: false }, report, backend: "orca",
      attempt: {
        executor: this.cfg.id, model: this.cfg.model ?? null, startedAt: this.startedAt, endedAt: this.deps.now() / 1000,
        exitCode: 1, timedOut: false, limitHit: false, log: logFile,
      },
    };
    return this.outcome;
  }

  /** No proven worker: close and discard only on a complete absent listing and closure proof; otherwise retain. */
  async unstarted(): Promise<AttemptOutcome> {
    this.expect("uncertain");
    const { ctx, c, deps } = this, terminal = this.terminal!, found = this.found ?? { kind: "unknown" as const, reason: "not checked" };
    if (found.kind === "found") deny("a worker was found; adopt it");
    if (found.kind === "none") {
      const closed = await closeCreatedTerminal(c, terminal);
      this.log(`closed pacer terminal ${terminal}: ${closed.failure ?? "ok"}`);
      if (closed.proof) {
        const admission = this.admission!;
        this.book("admission release", () => deps.admission.finish(ctx, admission));
        await this.discard();
        await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.starting[terminal]; delete s.uncertain[terminal]; }); })
          .catch(e => this.log(`clearing the start intent failed: ${message(e)}`));
      } else await this.keep(`terminal close failed: ${closed.failure}`);
      return this.unstartedOutcome(`Orca did not create the worker (${this.uncertain}). Direct fallback was skipped.`);
    }
    await this.keep((found as Extract<WorkerLookup, { kind: "unknown" }>).reason);
    return this.unstartedOutcome(`pacer cannot tell whether Orca created the worker: ${this.uncertain}. Direct fallback was skipped to avoid duplicate execution; terminal ${terminal} is kept for reconciliation.`);
  }

  /** Bind the dispatch to the lease, task and Orca state; registration failures keep supervision active. */
  private async bind(start: WorkerStartResult): Promise<void> {
    const { ctx, cfg, task, deps } = this, p = this.p!, terminal = this.terminal!;
    this.start = start;
    this.startedAt = deps.now() / 1000;
    const dispatchId = start.dispatchId!;
    this.dispatchId = dispatchId;
    this.phase = "started";
    const adm = deps.admission, admission = this.admission!;
    // Every rebind keeps the create-time incarnation, so a later pass can still prove the terminal closed.
    this.book("admission binding", () => adm.bind(ctx, admission, { dispatchId, terminal, ...(this.incarnationId ? { incarnationId: this.incarnationId } : {}) }));
    if (!this.incarnationId) {
      try {
        const shown = await this.c.terminalShow(terminal);
        if (shown.ok && shown.result.terminal?.handle === terminal && shown.result.terminal.incarnationId) {
          const shownId = shown.result.terminal.incarnationId;
          this.incarnationId = shownId;
          this.book("admission binding", () => adm.bind(ctx, admission, { dispatchId, terminal, incarnationId: shownId }));
        }
      } catch { /* No precise terminal identity: retain the lease until a closure receipt. */ }
    }
    this.log(`worker-start ${dispatchId}: ${start.state ?? "unknown"} (agent ${p.agent}${p.model ? `, model ${p.model}` : ""}, worktree ${this.worktree ?? "-"})`);
    try {
      // Once started, even a task/worker registration failure must keep supervision active.
      const worktree = this.worktree;
      if (worktree) updateTask(ctx, task.id, t => { t.worktree = worktree; });
      await withLock(ctx, "coordinator", async () => {
        updateOrcaState(ctx, (s) => {
          s.workers[dispatchId] = { dispatchId, taskId: task.id, attempt: this.attempt, executor: cfg.id, worktree, terminal, startedAt: this.startedAt };
        });
      });
      // An interactive lane's worker is owned through the task, so `pacer send` and `task.stop` can reach it.
      if (task.interactionMode === "conversation") updateTask(ctx, task.id, t => {
        t.live = { backend: "orca", worker: dispatchId, terminal, executor: cfg.id, agent: p.agent, ...(this.incarnationId ? { incarnation: this.incarnationId } : {}), since: this.startedAt };
      });
    } catch (e) {
      this.log(`worker registration failed; continuing supervision: ${String(e)}`);
    }
  }

  /** Supervise until worker_done, settlement, the task timeout or a stop; a cancelled owning call counts as a stop. */
  async wait(signal: AbortSignal): Promise<Record<string, unknown>> {
    this.expect("started");
    if (this.lastWait) deny("Orca worker supervision already ended for this attempt");
    const { ctx, c, cfg, task, deps } = this, dispatchId = this.dispatchId!;
    if (this.mode === "fresh") {
      if (this.start?.state !== "ready") deny("the Orca worker did not start ready");
      this.before = await repoFingerprint(ctx, this.worktree ?? task.brief.repo);
    }
    const coordinator = this.mode === "fresh" ? this.p!.coordinator : (await this.coordinator()).coordinator;
    const run = this.mode === "fresh" ? this.p!.run : (await this.coordinator()).run;
    const waited = await waitForWorker(ctx, c, {
      taskId: task.id, providerId: cfg.id, prompt: this.prompt, coordinator, run, dispatchId, terminal: this.terminal,
      deadlineMs: deps.now() + task.timeoutS * 1000,
      isStopped: () => signal.aborted || readTask(ctx, task.id)?.state === "stopped",
      sliceMs: deps.sliceMs, now: deps.now, sleep: deps.sleep, log: this.log,
    });
    this.log(waitLine(dispatchId, waited));
    this.lastWait = waited;
    this.endedAt = deps.now() / 1000;
    const text = (value: string) => value.slice(-65_536);
    switch (waited.kind) {
      // Each half stays small enough that the provider's joined summary fits the finish contract.
      case "done": return { kind: "done", outcome: waited.outcome.slice(0, 256), subject: waited.subject.slice(-32_000), body: waited.body.slice(-32_000) };
      case "settled": return { kind: "settled", state: waited.state.slice(0, 256), error: waited.error === null ? null : waited.error.slice(0, 4096),
        ...(waited.tail === undefined ? {} : { tail: text(waited.tail) }), ...(waited.needsStop === undefined ? {} : { needsStop: waited.needsStop }) };
      default: return waited;
    }
  }

  private async coordinator(): Promise<{ coordinator: string; run: string }> {
    if (this.coordinatorCache) return this.coordinatorCache;
    const git = await gitInfo(this.ctx.run, this.task.brief.repo);
    if ("error" in git) throw Error(git.error);
    const coord = await ensureCoordinator(this.ctx, this.c, git.top);
    if ("error" in coord) throw Error(coord.error);
    this.coordinatorCache = coord;
    return coord;
  }

  /** A failed or unreported worker's terminal tail, read before release or stop can drop it. */
  private async failureTail(): Promise<void> {
    if (this.readTail !== undefined) return;
    const w = this.lastWait;
    const succeeded = w?.kind === "done" ? w.outcome === "succeeded" : w?.kind === "settled" ? w.state === "succeeded" : false;
    if (succeeded || (w?.kind === "settled" && w.tail !== undefined)) return;
    const rd = await this.c.workerRead(this.dispatchId!, 60);
    this.readTail = rd.ok ? (rd.result.terminal?.tail ?? []).join("\n") : "";
  }

  /** The host's own reading of the worker's end; the provider's mapping must agree with it. */
  private mapped(): Mapped {
    if (this.mode === "fresh" && this.start?.state !== "ready") return mapFailedStart(this.start ?? {});
    if (!this.lastWait) deny("the Orca worker is still supervised");
    return mapWait(this.lastWait!);
  }

  /** Release a settled worker or stop an unsettled one; the receipt goes to the lease. */
  async settle(settled: boolean): Promise<void> {
    this.expect("started");
    if (settled !== this.mapped().settled) throw new CoreError("conflict", "Orca provider settlement does not match the supervised worker");
    if (this.mode === "fresh" && this.start?.state === "ready" && !this.lastWait) deny("the Orca worker is still supervised");
    if (this.mode === "reattach" && !this.lastWait) deny("the Orca worker is still supervised");
    if (this.endedAt === undefined) this.endedAt = this.deps.now() / 1000;
    await this.failureTail();
    const adm = this.deps.admission, admission = this.admission!;
    await settleWorker(this.c, this.dispatchId!, settled, this.log, receipt => this.book("admission receipt", () => adm.finishOrca(this.ctx, admission, receipt)));
    this.phase = "settled";
  }

  /** Kept alive only while the task records it as its owner; otherwise stop, release and the reaper could not reach it. */
  private keepAliveAllowed(): boolean {
    const w = this.lastWait;
    if (w?.kind !== "settled" || w.state !== "needs_input") return false;
    if (this.mode === "reattach") return true;
    return this.task.interactionMode === "conversation" && readTask(this.ctx, this.task.id)?.live?.worker === this.dispatchId;
  }

  async finish(m: Mapped & { keepAlive: boolean }): Promise<AttemptOutcome> {
    this.expect("started", "settled");
    const { ctx, c, cfg, task, deps } = this, dispatchId = this.dispatchId!, terminal = this.terminal!;
    const adm = deps.admission, admission = this.admission!;
    // The outcome is the host's reading of its own supervision; the provider's mapping is checked, not trusted.
    const own = this.mapped();
    if (m.code !== own.code || m.timedOut !== own.timedOut || m.settled !== own.settled || (m.launchBroken ?? null) !== (own.launchBroken ?? null))
      throw new CoreError("conflict", "Orca provider outcome does not match the supervised worker");
    m = { ...own, keepAlive: m.keepAlive };
    const keepAlive = m.keepAlive && this.phase === "started" && this.keepAliveAllowed();
    if (!keepAlive && this.phase === "started") await this.settle(m.settled);
    if (keepAlive && m.code !== 0 && m.tail === undefined) await this.failureTail();
    const endedAt = this.endedAt ?? deps.now() / 1000;
    const tailText = m.tail ?? (m.code !== 0 ? this.readTail ?? "" : "");
    if (keepAlive) {
      this.log(this.mode === "reattach" ? `keeping orca worker ${dispatchId} alive for another live answer; task is needs_input`
        : `keeping orca worker ${dispatchId} alive for a live answer; task is needs_input`);
      // The worker stays registered and owned by the task (`live`), holding its slot, until an answer reattaches to it
      // or task.stop, settlement or the idle limit releases it (src/exec/live.ts).
      this.book("live worker", () => updateTask(ctx, task.id, t => { if (t.live?.worker === dispatchId) t.live.since = deps.now() / 1000; }));
      this.book("admission release", () => adm.finish(ctx, admission));
    } else {
      // Always close the exact terminal pacer created; nothing above may skip this.
      const closed = await closeCreatedTerminal(c, terminal);
      this.log(`closed pacer terminal ${terminal}: ${closed.failure ?? "ok"}`);
      if (closed.proof) this.book("admission release", () => adm.finish(ctx, admission));
      else await recordUnclosed(ctx, task.id, terminal, this.log, this.mode === "fresh" ? this.worktreeId() : undefined);
      try {
        await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.workers[dispatchId]; }); });
      } catch (e) { this.log(`worker state cleanup failed: ${String(e)}`); }
      this.book("live worker", () => updateTask(ctx, task.id, t => { if (t.live?.worker === dispatchId) delete t.live; }));
    }
    const exec: ExecResult = { code: m.code, stdout: tail(m.summary, EXEC_CHARS), stderr: tail(tailText, EXEC_CHARS), timedOut: m.timedOut };
    let summary = m.summary, removed = false;
    if (this.mode === "reattach") {
      const lane = !keepAlive ? await liveLaneWorktree(ctx, c, task, this.reattachLive!).catch(() => null) : null;
      removed = !keepAlive && await releaseStoppedLane(ctx, c, task, lane, this.log, deps.sleep, m.settled);
    } else {
      // A stopped lane's unused worktree (and its empty group parent) goes; the outcome then names no worktree.
      removed = !keepAlive && await releaseStoppedLane(ctx, c, task, this.created, this.log, deps.sleep);
      if (removed) summary = `${summary}\nremoved the stopped lane's unused Orca worktree ${this.created!.path}`;
    }
    const after = await repoFingerprint(ctx, this.worktree ?? task.brief.repo);
    const before = this.before;
    const durable = before === null && after === null ? null : before !== null && before === after;
    const transient = this.mode === "fresh" && summary.includes("transient provider busy after three retries") ? "transient provider busy after three retries" : null;
    const reason = transient ?? m.launchBroken ?? brokenReason(exec, endedAt - this.startedAt, durable);
    const logFile = this.logFile();
    await Bun.write(logFile, `${this.lines.join("\n")}\n--- summary\n${summary}\n--- worker output (tail)\n${tailText}\n`);
    this.phase = "done";
    const report = this.mode === "fresh" ? tail([...this.p!.notes, summary].join("\n\n"), REPORT_CHARS) : tail(summary, REPORT_CHARS);
    this.outcome = {
      exec, report, backend: "orca",
      ...(this.worktree && !removed ? { worktree: this.worktree } : {}),
      attempt: {
        executor: cfg.id, model: cfg.model ?? null, startedAt: this.startedAt, endedAt,
        ...(reason ? { brokenReason: reason } : {}),
        exitCode: m.code, timedOut: m.timedOut,
        limitHit: this.mode === "fresh" ? !transient && detectLimit(cfg.id, exec) : !reason && detectLimit(cfg.id, exec), log: logFile,
      },
    };
    return this.outcome;
  }

  /** The host's own closure when the provider fails while a worker may run: stop it, close the exact terminal. */
  async abort(): Promise<void> {
    if (!this.dispatchId || !this.terminal) return;
    const { ctx, c, deps } = this, dispatchId = this.dispatchId, terminal = this.terminal, admission = this.admission;
    try {
      const receipt = await c.workerStop(dispatchId);
      this.log(`worker-stop: ${receipt.ok ? (receipt.result.state ?? "ok") : receipt.error.code}`);
      if (admission) this.book("admission receipt", () => deps.admission.finishOrca(ctx, admission, receipt));
    } catch (stopError) {
      this.log(`worker-stop failed: ${String(stopError)}`);
    }
    const closed = await closeCreatedTerminal(c, terminal);
    this.log(`closed pacer terminal ${terminal}: ${closed.failure ?? "ok"}`);
    if (closed.proof && admission) this.book("admission release", () => deps.admission.finish(ctx, admission));
    else if (!closed.proof) await recordUnclosed(ctx, this.task.id, terminal, this.log, this.mode === "fresh" ? this.worktreeId() : undefined);
    try {
      await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.workers[dispatchId]; }); });
    } catch (e) { this.log(`worker state cleanup failed: ${String(e)}`); }
    this.book("live worker", () => updateTask(ctx, this.task.id, t => { if (t.live?.worker === dispatchId) delete t.live; }));
    this.phase = "done";
  }

  /** The provider failed: settle the host-owned effects by phase, never starting or duplicating a worker. */
  async rescue(error: unknown): Promise<{ fallback: string } | { outcome: AttemptOutcome }> {
    const why = message(error);
    if (this.phase === "done" && this.outcome) return { outcome: this.outcome };
    if (this.duplicate && this.phase === "terminal") { await this.abandon(why); throw error; }
    // Never checked: a live worker this answer would have reattached to must not share the worktree with a direct agent.
    if (this.phase === "new") {
      const live = await findLiveAnswerWorker(this.ctx, this.c, this.task, this.cfg.id).catch(() => null);
      if (live) await releaseLive(this.ctx, this.c, live.asked, `the answer runs directly: ${why}`, this.log).catch(() => {});
      return { fallback: `the Orca executor plugin failed: ${why}` };
    }
    if (this.phase === "checked" || this.phase === "fallback") return { fallback: `the Orca executor plugin failed: ${why}` };
    if (["prepared", "placed", "terminal", "refused"].includes(this.phase)) {
      const { reason } = await this.abandon(`the Orca executor plugin failed: ${why}`);
      return { fallback: reason };
    }
    if (this.phase === "uncertain") {
      this.found ??= { kind: "unknown", reason: `the Orca executor plugin failed: ${why}` };
      if (this.found.kind === "found") { await this.adopt().catch(() => {}); await this.abort(); throw error; }
      return { outcome: await this.unstarted() };
    }
    await this.abort();
    throw error;
  }

  appendFallback(log: string | undefined, reason: string): void {
    if (log) appendFileSync(log, [...this.lines, `direct backend: Orca fallback (${reason.replace(/\s+/g, " ").trim()})`].join("\n") + "\n");
  }
}
