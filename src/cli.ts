#!/usr/bin/env bun
import { apiCommand } from "./commands/api";
import { coreBuildDescriptor } from "./update/desktop/build-identity";
import { askCommand } from "./commands/ask";
import { compiledNativeFixture, compiledNativeFixtureSha256 } from "./update/desktop/native-fixture";
import { DESKTOP_IDENTIFIERS } from "./update/desktop/bundle-identity";
import { compiledAppleTeamId, compiledSignerPins, compiledSigningCertSha1 } from "./update/desktop/native-os";
import { consumeNativePairedBootstrap, configuredPairedNativeBootstrap } from "./update/desktop/native-paired-bootstrap";
import { signerKind } from "./update/desktop/signer-requirement";
import { currentVersion } from "./update/version";
import { projectStrategyCmd } from "./commands/project-strategy";
import { dashboardClient as connectTaskClient } from "./dashboard/client";
import type { PruneResult } from "./tasks/retention";
import { settleLiveReleases, superviseTasks } from "./tasks/api";
import { drainQueue } from "./tasks/drain";
import { uninstallAll } from "./install/uninstall-all";
import type { ClientSnapshot } from "./view-model/snapshot";
import { registeredRepo, resolveRepoInput } from "./core/repos";
import { callOp } from "./api/ops";
import { recheckDiagnostic } from "./core/doctor-fix";
import { doctor as setupDoctor } from "./core/setup";
import { readTask } from "./tasks/store";
import { isEngineOwnedKind } from "./tasks/engine-owned";
import { connectClient } from "./api/client";
import { reportCommand, reportDestination, agentHook } from "./session/reports";
import { openSession, sessionInfo } from "./session/service";
import { handBackTask, takeoverTask } from "./session/takeover";
import { sessionHost } from "./session/host";
import { attachDirectory, attachSession } from "./session/attach";
import { viewerName } from "./session/viewers";
import { createInterface } from "node:readline/promises";
import { plannerSessionStatus } from "./install/role";
import type { AgentId } from "./config/accounts";
import { resolveRunner } from "./config/runner-id";
import { readUpdateCheck, updateLine } from "./update/check";
import { runningWork, runningWorkLines } from "./service/running-work";
import { runDashboard } from "./dashboard/cli";
import { setupCmd, SETUP_USAGE } from "./commands/setup";
import { parseDelegateKind } from "./commands/delegate-kind";
import { callerParticipant, localHuman } from "./messaging/participants";
import { callerReach } from "./messaging/caller-reach";
import * as core from "./core";
import { CoreError } from "./core/errors";
import { readFileSync, realpathSync } from "node:fs";
import { assertCallerCanInvoke, executorMayReview, TASK_REVIEW_REFUSAL } from "./api/caller-policy";
import type { RouteExplanation } from "./core/dispatch-explain";
import { isExecutorSession, isOrchestratorSession } from "./install/role";
import { authorizeWorkOperation } from "./core/work";
import { executorCommand } from "./executors/command";
import { use as switchStrategy } from "./strategy/service";
import { hookInput, plannerPolicyApplies } from "./install/role";
import { io } from "./install/stdin";
import { pruneUndoSnapshotsAtStartup } from "./install/undo-store";
import { isAbsolute, join, resolve } from "node:path";
import { EXTRA_COMMANDS, findCommand } from "./commands/index";
import type { Result } from "./commands/types";
import { MissingStrategyError, PLANNERS, StrategyError, loadStrategy, strategyPath } from "./config/strategy";
import { configCmd } from "./commands/config";
import { accountCmd, runnerCmd } from "./commands/accounts";
import { makeCtx } from "./ctx";
import { computeStatus, displayName } from "./engine/status";
import { runMcpStdio } from "./mcp/server";
import { shutdownPlugins } from "./plugins";
import { holdOwnerKey } from "./plugins/host-bridge";
import { CORE_SECRETS_ENV, CORE_SECRETS_STDIN, LEGACY_CORE_SECRETS, legacyCoreSecrets, readCoreSecrets, scrubCoreSecrets, type CoreSecrets } from "./core-secrets";
import { runStdio } from "./api/stdio";
import { StringDecoder } from "node:string_decoder";
import { renderHook } from "./render/hook";
import { lineFields, renderLine } from "./render/line";
import { renderText } from "./render/text";
import { renderRoute } from "./render/accounts";
import { DEFAULT_PORT, startServer } from "./serve/http";
import { DelegateError, EXECUTOR_DELEGATE_ERROR, parseDelegateBrief, summarizeTask, attemptLine, taskWait, type SpawnRunner, spawnRunner } from "./tasks/api";
import { runTask } from "./tasks/runner";
import { terminalEnv } from "./exec/login-env";
import { TERMINAL_STATES, type TaskRecord } from "./tasks/types";
import type { Ctx } from "./types";
import { ensureIdentity } from "./identity/store";
import { readRunnerModels, saveRunnerModels, modelDeclarationWarnings, type ModelDeclaration } from "./core/runner-models";
import { availableModels } from "./models/available";
import { tierSchema } from "./dispatch/types";

/** Test seam: how the CLI starts a task runner. Tests swap it so they never spawn `pacer _run`.
 *  `runTask` lets a test exercise the real `_run` allow-list hop without launching a planner. */
export const cliDeps: { spawnRunner: SpawnRunner; runTask?: typeof runTask } = { spawnRunner };

const USAGE = `usage: pacer <command>
  dashboard                                      live interactive terminal dashboard
  status [--line | --json | --hook <planner>]   budget status (default: text report)
    --line [--width N] [--no-color] [--json]     compact local status; columns default to COLUMNS or 80
  pause <for> | resume                          pause or resume delegation
  route [kind] [--repo <path-or-key>] [--json]                          executors pacer would use, in order (default repo: current directory)
  route --explain [--repo <r>] [--kind <k>] [--goal <text> | --goal-file <path>] [--executor <id>] [--via delegate|dispatch] [--json]
                                                 read-only: where this request would go, and why
  project strategy list | show | set | remove   repository executor policy (--repo, --executors, --json)
  delegate [--title <text>] [--brief-file <path|->] [--goal <text>] [--repo <dir>] [--kind <k>] [--scope <s>] [--acceptance <cmd>]
           [--acceptance-timeout-min <n>] [--acceptance-pipefail] [--constraints <s>] [--context <s>] [--executor <id>] [--difficulty <simple|standard|complex>] [--model <id>] [--timeout-min <n>] [--wait] [--json] [--force]
           [--worktree current|new|auto] [--worktree-base default|head] [--worktree-reason <text>]
           [--interactive] [--group <name>]        interactive: routed/reviewed like any delegated task, with a live terminal;
                                                     group: lanes nested under one named Orca parent worktree
  wait <task-id> [--timeout <seconds>] [--json]   wait (default 600, max 3000); exit 2 on timeout
  review <task-id> --accept|--reject|--send-back|--retry-on <executor> [--note <text>] [--kind <k>] [--json] record review
  task request-review <task-id> --note <text> [--expect-rev <n>] [--json] request a human decision
  dismiss <task-id...>                           hide settled tasks
  tasks [<task-id>] [--all] [--json]             recent tasks, including archives with --all
  tasks prune [--dry-run] [--json]               archive old settled tasks
  tasks restore <task-id> [--json]               restore archived artifacts
  executor set <id> [--enabled true|false] [--model <m>] [--max-tasks <n>]
  executor models <id>                            print available and allowed models
                    [--default <m>] [--allow <m>:<tier>] [--remove <m>]  save them
  executor block <id> [--for <duration>] [--reason <text>] | unblock <id> | list
  report --task <task-id> --outcome done|failed|needs-input|running --summary <text>
  takeover <task-id> [--no-attach]
  attach <task-id> [--read-only] [--control] [--force] [--replay] [--attempt <n>] [--open [terminal|tmux|orca]]
  stop <task-id> [--json]                         stop a running task
  answer <task-id> "<text>"                       answer a question; resumes the session or retries
  send <task-id> "<message>" [--force] [--json]  deliver a message into a running interactive lane's live terminal
  retry <task-id> [--executor <id>] [--json]       re-delegate a task's stored brief
  clean [--dry-run] [--force] [--json]           remove worktrees of reviewed or dismissed tasks (branches stay)
  ask "<question>" [--scope ..] [--json]       ask the assistant (executors: record one question and stop the task)
  report-limit <provider> [--until <unix-seconds>] record an executor limit
  host list [--json] | check <alias> [--repo <path>] [--json] | setup <alias> [--repo <path>] | clean <alias> [--json]
  limits check [--json] | refresh [account] [--json]  inspect or refresh account usage
  mcp [--assistant]                               run the MCP server on stdio; --assistant serves only the assistant's tools for one turn
  api list|describe <op>|call <op> [--json]       discover and invoke protocol v3 operations
  api --stdio                                    JSON-RPC (v2 default, v3 negotiation)
  serve [--port <n>] [--internal]                local HTTP status endpoint (default ${DEFAULT_PORT})
  use <strategy>                                 switch to ~/.pacer/strategies/<strategy>.yaml ("default" = strategy.yaml)
  account list [--json] | add <kind> <name> [options] | set <name> --allow-paid true|false | rm <name> [--delete-home]
  runner list [--json] | add <agent#account> [--model <m>] | rm <agent#account>
  config get [key] [--json] | set <key> <value> | migrate
  ${SETUP_USAGE}                connect detected agent CLIs
  help                                           this message
JSON: status: generatedAt, strategy, planner, mode, disabled, calendarPace, providers, executors.
status --line --json: online, planner, agent, usedPct, pacePct, verdict, resetsAt, running, attention, mode.
route: kind, ranked, excluded. delegate: TaskRecord (id, createdAt, kind, requestedExecutor, timeoutS, brief, state, attempts, placement; optional runtime fields).
tasks <id>, wait, stop, retry: task_id, state, kind, requested_executor, placement, attempts, result, review, resolved.
tasks: array of those task summaries. review: { task, retry? }. Flags override brief-file fields; repo defaults to cwd.
install <planner> [--mcp|--no-mcp]: skill and hooks; MCP is optional.
update refreshes installed skills, policy and hooks; --no-reinstall skips refresh.
Cursor and OpenCode also read ~/.claude/skills; Cursor also reads ~/.codex/skills.
Identical pacer skill copies may appear; update refresh keeps them identical.`;

function help(): string {
  const builtins = new Set(["status", "route", "delegate", "tasks", "stop", "retry", "answer", "clean", "host", "limits", "mcp", "api", "serve", "use", "help", "--help", "-h", "_run"]);
  const extras = EXTRA_COMMANDS.filter((c) => !builtins.has(c.name));
  return extras.length ? `${USAGE}\n${extras.map((c) => `  ${c.usage}`).join("\n")}` : USAGE;
}

function explain(e: unknown): string {
  if (e instanceof MissingStrategyError) {
    return `pacer: no strategy at ${e.path}. Run: pacer init`;
  }
  if (e instanceof StrategyError || e instanceof DelegateError || e instanceof CoreError) return `pacer: ${e.message}`;
  return `pacer: ${(e as Error).message ?? String(e)}`;
}

/** --key value pairs; names in `booleans` take no value. */
function parseFlags(args: string[], booleans: string[]): { opts: Record<string, string | true>; pos: string[] } {
  const opts: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    if (booleans.includes(key) || i + 1 >= args.length) opts[key] = true;
    else opts[key] = args[++i];
  }
  return { opts, pos };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const fresh = (ctx: Ctx): Ctx => ({ ...ctx, now: Date.now() / 1000 });

async function status(args: string[], ctx: Ctx): Promise<Result> {
  const modes: ("line" | "json" | "hook")[] = [];
  let planner: string | undefined;
  let width = Number(ctx.env.COLUMNS) || 80;
  let noColor = ctx.env.NO_COLOR !== undefined;
  const bad: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--line") modes.push("line");
    else if (a === "--json") modes.push("json");
    else if (a === "--hook") {
      modes.push("hook");
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        planner = v;
        i++;
      }
    } else if (a === "--width") {
      const value = args[i + 1];
      if (value && !value.startsWith("--")) i++;
      if (value && /^\d+$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0) width = Number(value);
      else bad.push("--width needs a positive integer");
    } else if (a === "--no-color") noColor = true;
    else bad.push(a);
  }
  const usage = "usage: pacer status [--line | --json | --hook <planner>]";
  if (!modes.includes("line") && bad.length) return { code: 2, out: "", err: `pacer status: unknown argument ${bad.map((b) => `"${b}"`).join(", ")}\n${usage}` };
  if (!modes.includes("line") && modes.length > 1) return { code: 2, out: "", err: `pacer status: give only one of --line, --json, --hook <planner>\n${usage}` };
  const mode = modes.includes("line") ? "line" : modes[0] ?? "text";
  const lineJson = modes.includes("json");
  const lineResult = (snapshot: ClientSnapshot | null): Result => ({ code: 0, out: lineJson ? JSON.stringify(lineFields(snapshot)) : renderLine(snapshot, { width, color: !noColor }), err: "" });
  if (mode === "hook" && !(PLANNERS as readonly string[]).includes(planner ?? "")) {
    return { code: 2, out: "", err: `pacer status: --hook needs a planner: ${PLANNERS.join(", ")}` };
  }
  try {
    if (mode === "hook" && !plannerPolicyApplies(ctx, planner!, hookInput(process.stdin.isTTY ? "" : await io.readStdin().catch(() => "")))) {
      return { code: 0, out: "", err: "" };
    }
    if (mode === "line") {
      try {
        const token = readFileSync(join(ctx.pacerHome, "token"), "utf8").trim();
        if (!token) throw Error("token missing");
        const response = await fetch(`http://127.0.0.1:${ctx.env.PACER_PORT ?? DEFAULT_PORT}/v2/snapshot`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300), redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); throw Error("service unavailable"); }
        const body = await response.json() as { snapshot?: ClientSnapshot };
        if (body.snapshot && lineFields(body.snapshot).online) return lineResult(body.snapshot);
      } catch { /* The local link is also available while the service restarts. */ }
      try {
        const snapshot = JSON.parse(readFileSync(join(ctx.pacerHome, "link", "latest.json"), "utf8")) as ClientSnapshot;
        if (Number.isFinite(snapshot.at) && ctx.now - snapshot.at <= 120 && lineFields(snapshot).online) return lineResult(snapshot);
      } catch { /* Missing or torn local link. */ }
      return lineResult(null);
    }
    const st = mode === "hook" ? await plannerSessionStatus(ctx, planner as AgentId) : await computeStatus(ctx, loadStrategy(ctx));
    if (mode === "json") return { code: 0, out: JSON.stringify(st, null, 1), err: "" };
    if (mode === "hook") return { code: 0, out: renderHook(st, planner!), err: "" };
    const work = await runningWork(ctx).then(runningWorkLines, () => ["running work: unavailable"]);
    return { code: 0, out: [renderText(st), ...work, updateLine(readUpdateCheck(ctx))].filter(Boolean).join("\n"), err: "" };
  } catch (e) {
    // Status line and hooks run inside other tools: never fail them.
    if (mode === "line") return lineResult(null);
    if (mode === "hook") return { code: 0, out: "{}", err: "" };
    return { code: 2, out: "", err: explain(e) };
  }
}

function currentRepoKey(ctx: Ctx): string | undefined {
  try { return registeredRepo(ctx, realpathSync(process.cwd()))?.key; }
  catch { return undefined; }
}

async function routeExplain(opts: Record<string, string | true | undefined>, pos: string[], ctx: Ctx): Promise<Result> {
  assertCallerCanInvoke(ctx, "dispatch.explain", {});
  const goalFile = str(opts["goal-file"]);
  const goal = goalFile ? readFileSync(goalFile === "-" ? 0 : goalFile, "utf8") : str(opts.goal);
  if (!goal?.trim()) throw new Error("--explain needs --goal <text> or --goal-file <path>");
  const params = { via: str(opts.via) ?? "delegate", repo: str(opts.repo) ?? currentRepoKey(ctx) ?? realpathSync(process.cwd()), goal, ...(str(opts.kind) ?? pos[0] ? { kind: str(opts.kind) ?? pos[0] } : {}), ...(str(opts.executor) ? { executor: str(opts.executor) } : {}) };
  const client = await connectTaskClient(ctx);
  let r: RouteExplanation;
  try { r = client.kind === "inprocess" ? await callOp(ctx, "dispatch.explain", params) as RouteExplanation : await client.call<RouteExplanation>("dispatch.explain", params); }
  finally { client.close(); }
  if (opts.json) return { code: 0, out: JSON.stringify(r, null, 1), err: "" };
  const mark = (o: string) => (o === "pass" ? "✓" : o === "fail" ? "✕" : "!");
  const lines = [r.chosen ? `${r.outcome === "override" ? "Chosen by you" : "Will go to"}: ${r.chosen.executor} (${r.chosen.account})${r.step ? ` · step ${r.step.index + 1} ${r.step.id}` : ""} · strategy ${r.strategy.name}` : `Nothing would run now (${r.outcome}).`,
    `kind: ${r.kind.value ?? "unknown"} (${r.kind.source})`,
    ...r.reasons.map(x => `${mark(x.outcome)} ${x.text}`)];
  if (r.fallbacks.length) lines.push("If it can't:", ...r.fallbacks.map(f => `  ${f.executor}${f.state === "excluded" ? ` — ${f.reason?.text ?? "excluded"}` : f.step ? ` (step ${f.step})` : ""}`));
  lines.push(r.planner.state === "unknown" ? `Planner: ${r.planner.reason === "planner_is_executor" ? "same account as the executor" : "not measured yet"}` : `Planner: about ${r.planner.tokens.median} tokens`);
  if (r.uncertainty.length) lines.push("Could differ:", ...r.uncertainty.map(x => `  ${x.text}`));
  return { code: 0, out: lines.join("\n"), err: "" };
}

async function route(args: string[], ctx: Ctx): Promise<Result> {
  const { opts, pos } = parseFlags(args, ["json", "explain"]);
  try {
    if (opts.explain) return await routeExplain(opts, pos, ctx);
    if (opts.repo === true) throw new Error("--repo requires a path or repository key");
    // Like delegate, default to the repository in the current directory, but
    // only when it is already registered: a read never probes Git or registers it.
    const repo = str(opts.repo) ?? currentRepoKey(ctx);
    const client = await connectTaskClient(ctx);
    let r: Awaited<ReturnType<typeof core.routing.route>>;
    try {
      const params = { kind: pos[0], repo };
      r = client.kind === "inprocess" ? await callOp(ctx, "routing.route", params) as typeof r : await client.call("routing.route", params);
    }
    finally { client.close(); }
    if (opts.json) return { code: 0, out: JSON.stringify(r, null, 1), err: "" };
    const rows = r.ranked.map((e, i) => ({ ...e, index: i }));
    const lines = renderRoute(rows);
    if (!lines.length) lines.push("no executor available");
    if (r.policy) lines.unshift(`Project order · ${r.policy.repoKey} · revision ${r.policy.rev}`);
    if (r.excluded.length) lines.push(`excluded: ${r.excluded.map((e) => `${e.id} (${e.reason})`).join(", ")}`);
    return { code: 0, out: lines.join("\n"), err: "" };
  } catch (e) {
    return { code: 2, out: "", err: explain(e) };
  }
}

const fallbackText = (f: NonNullable<TaskRecord["executorFallback"]>) => `requested ${f.requested}, ran on ${f.executor}: ${f.reason}`;

function renderTask(t: TaskRecord): string {
  const r = t.result;
  const shown = attemptLine(t), detail = [shown.account, shown.model].filter(Boolean).join(" · ");
  const lines = [
    `${t.id}  ${t.state}  executor: ${shown.executor}${detail ? ` · ${detail}` : ""}`,
    `goal: ${t.brief.goal}`,
    `repo: ${t.brief.repo}`,
  ];
  if(t.archived)lines.push(`archive: ${t.archivePath}`);
  if(t.executorFallback)lines.push(`executor: ${fallbackText(t.executorFallback)}`);
  if(t.placement?.mode)lines.push(`placement: ${t.placement.requested === "current" && t.placement.mode === "new" ? "current overridden to " : ""}${t.placement.mode} (${t.placement.why})`);
  if (t.attempts.length) {
    lines.push(`attempts: ${t.attempts.map((a) => `${a.executor} (exit ${a.exitCode}${a.limitHit ? ", limit" : ""}${a.timedOut ? ", timed out" : ""})`).join(" > ")}`);
  }
  if (r) {
    lines.push(`files:\n${r.files || "(none)"}`);
    if (r.acceptance) {
      const detail = [r.acceptance.exitCode !== undefined ? `exit ${r.acceptance.exitCode}` : undefined, r.acceptance.shell].filter(Boolean).join(", ");
      lines.push(`acceptance: ${r.acceptance.cmd} -> ${r.acceptance.passed ? "pass" : "FAIL"}${detail ? ` (${detail})` : ""}`);
      if (r.acceptance.hint) lines.push(`  hint: ${r.acceptance.hint}`);
    }
    lines.push(`report:\n${r.report.slice(-1500)}`);
  }
  return lines.join("\n");
}

async function delegateCmd(args: string[], ctx: Ctx): Promise<Result> {
  const { opts } = parseFlags(args, ["wait", "json", "force", "interactive", "acceptance-pipefail", "no-grant"]);
  try {
    if(isExecutorSession(ctx))throw new DelegateError(EXECUTOR_DELEGATE_ERROR);
    if(opts["brief-file"]===true)throw new DelegateError("--brief-file needs a path or -");
    const file=str(opts["brief-file"]);
    let raw:Record<string,unknown>={};
    if(file){const parsed=JSON.parse(file==="-" ? await io.readBriefStdin() : readFileSync(file,"utf8"));
      if(!parsed || typeof parsed!=="object" || Array.isArray(parsed))throw new DelegateError("brief must be a JSON object");raw=parsed;}
    for(const key of ["title","goal","repo","scope","acceptance","constraints","context","kind","executor","difficulty","model","worktree","group"]){if(str(opts[key])!==undefined)raw[key]=str(opts[key]);}
    if(opts["acceptance-pipefail"]===true)raw.acceptance_pipefail=true;
    if(str(opts.repo)!==undefined)raw.repo=resolve(str(opts.repo)!);
    if(opts["acceptance-timeout-min"]!==undefined)raw.acceptance_timeout_min=Number(str(opts["acceptance-timeout-min"]));
    if(str(opts["timeout-min"])!==undefined)raw.timeout_min=Number(str(opts["timeout-min"]));
    if(str(opts["worktree-base"])!==undefined)raw.worktree_base=str(opts["worktree-base"]);
    if(str(opts["worktree-reason"])!==undefined)raw.worktree_reason=str(opts["worktree-reason"]);
    if(opts.interactive===true)raw.interactive=true;
    if(opts["no-grant"]===true)raw.grant=false;
    if(typeof raw.kind==="string")raw.kind=parseDelegateKind(raw.kind);
    const input=parseDelegateBrief(raw,process.cwd());
    const repoRef=await resolveRepoInput(ctx,input.brief.repo);
    // This process is the caller's own, so its env can record how to reach it again.
    const origin=localHuman(ctx), reach=origin?null:callerReach(ctx,callerParticipant(ctx).id);
    const t=await core.tasks.delegate(ctx,{...input,brief:{...input.brief,repo:repoRef.path},source:"cli",repoRef,force:opts.force===true,origin,...(reach?{callerReach:reach}:{})},cliDeps.spawnRunner);
    const warning = t.difficultySource === "unspecified" ? JSON.stringify({code:"difficulty_missing",field:"difficulty",values:["simple","standard","complex"]}) : "";
    // The caller reach is a delivery hint for the broker, not part of the task the caller sees.
    const shown = ({ callerReach: _reach, ...rest }: typeof t) => rest;
    if (!opts.wait) return { code: 0, out: opts.json ? JSON.stringify(shown(t), null, 1) : `${t.id} queued${t.placement?.requested === "current" && t.placement.mode === "new" ? `\nplacement: current overridden to new (${t.placement.why})` : ""}`, err: warning };
    const done = (await taskWait(ctx, t.id, t.timeoutS * 3 + 60)) ?? t;
    return { code: done.state === "done" ? 0 : 1, out: opts.json ? JSON.stringify(shown(done), null, 1) : renderTask(done), err: warning };
  } catch (e) {
    return { code: 2, out: "", err: explain(e) };
  }
}

async function controlProgress(ctx:Ctx,t:TaskRecord):Promise<string> {
  if(t.state!=="running")return "";
  try {
    const info=await sessionInfo(ctx,t.id,false,false),clean=(label:string)=>label.replace(/[\x00-\x1f\x7f]/g,"");
    return info.active?`last input from ${clean(viewerName(info.active))}`:info.controller?`controlled from ${clean(viewerName(info.controller))}`:"";
  }catch{return "";}
}

async function tasksCmd(args: string[], ctx: Ctx): Promise<Result> {
  const { opts, pos } = parseFlags(args, ["json", "all", "dry-run"]);
  if (pos[0] === "prune" || pos[0] === "restore") {
    const client = await connectTaskClient(ctx);
    try {
      if (pos[0] === "restore") {
        if (pos.length !== 2) throw new Error("usage: pacer tasks restore <task-id>");
        const task = await client.call<Record<string, unknown>>("task.restore", { id: pos[1] });
        return { code: 0, out: opts.json ? JSON.stringify(task, null, 1) : `restored ${pos[1]}`, err: "" };
      }
      if (pos.length !== 1) throw new Error("usage: pacer tasks prune [--dry-run]");
      const result = await client.call<PruneResult>("task.prune", { dry_run: opts["dry-run"] === true });
      return { code: 0, out: opts.json ? JSON.stringify(result, null, 1) : [
        ...result.tasks.flatMap(t => [`${t.id} -> ${t.archivePath}`, ...t.files.map(f => `  ${f}`)]),
        `${result.dryRun ? "would archive" : "archived"} ${result.tasks.length} tasks; ${result.bytesSaved} bytes saved; ${result.workingSetBytes} bytes removed from working set`,
      ].join("\n"), err: "" };
    } catch (e) { return { code: 2, out: "", err: explain(e) }; }
    finally { client.close(); }
  }
  await superviseTasks(ctx, cliDeps.spawnRunner);
  await drainQueue(ctx, cliDeps.spawnRunner);
  if (pos[0]) {
    try {
      const t = core.tasks.get(ctx, pos[0]);
      return { code: 0, out: opts.json ? JSON.stringify(summarizeTask(t), null, 1) : [renderTask(t),(await controlProgress(ctx,t))].filter(Boolean).join("\n"), err: "" };
    } catch (e) { return { code: 2, out: "", err: explain(e) }; }
  }
  const list = core.tasks.list(ctx, { all: opts.all === true, ...(opts.all === true ? { limit: Infinity } : {}) })
    .filter(t => !isEngineOwnedKind(t.kind));
  if (opts.json) return { code: 0, out: JSON.stringify(list.map(summarizeTask), null, 1), err: "" };
  if (!list.length) return { code: 0, out: "no tasks yet", err: "" };
  return {
    code: 0,
    out: (await Promise.all(list.map(async (t) => {
      const control=await controlProgress(ctx,t);
      const shown=attemptLine(t), detail=[shown.account,shown.model].filter(Boolean).join(" · ");
      return `${t.id}  ${t.state.padEnd(8)}  ${shown.executor.padEnd(12)}${detail?`  ${detail}`:""}  ${t.brief.goal.slice(0, 60)}${t.executorFallback?`  (requested ${t.executorFallback.requested}: ${t.executorFallback.reason})`:""}${t.placement?.mode?`  ${t.placement.mode} (${t.placement.why})`:""}${control?`  ${control}`:""}`;
    }))).join("\n"),
    err: "",
  };
}

 /** Show and edit one executor's allowed models: the CLI face of `runner.models.get/set`. */
 async function executorModelsCommand(args: string[], ctx: Ctx): Promise<Result> {
   try {
     const [id, ...flags] = args;
     if (!id) throw new Error("usage: pacer executor models <id> [--default <m>] [--allow <m>:<tier>] [--remove <m>]");
     if (!flags.length) {
       const m = readRunnerModels(ctx, id);
       const s = loadStrategy(ctx), runner = s.runners[m.runner];
       const available = await availableModels(ctx, m.runner);
       const lines = [
         `${m.runner}`,
         `Default model: ${m.default ?? "(agent default)"}`,
         m.models.length ? `Allowed models:\n${m.models.map(x => `  ${x.id} (${x.tier})`).join("\n")}` : "Allowed models: none declared; the default model always launches",
         `Available models: ${available.models === null ? `unknown${available.note ? ` (${available.note})` : ""}` : available.models.length ? available.models.map(x => x.id).join(", ") : "none"}`,
         ...(runner ? modelDeclarationWarnings(runner) : []),
       ];
       return {code: 0, out: lines.join("\n"), err: ""};
     }
     const current = readRunnerModels(ctx, id);
     let appliedDefault: string | undefined;
     const declared: ModelDeclaration[] = [...current.models];
     for (let i = 0; i < flags.length; i += 2) {
       const key = flags[i], value = flags[i + 1];
       if (value === undefined) throw new Error(`missing value for ${key}`);
       if (key === "--default") appliedDefault = value;
       else if (key === "--allow") {
         const at = value.lastIndexOf(":");
         const tier = at < 0 ? "" : value.slice(at + 1);
         if (at < 1 || !tierSchema.safeParse(tier).success) throw new Error("--allow expects <model>:<tier>, tier one of small, medium, frontier, unknown");
         const mid = value.slice(0, at), found = declared.find(x => x.id === mid);
         if (found) found.tier = tier as ModelDeclaration["tier"];
         else declared.push({id: mid, tier: tier as ModelDeclaration["tier"]});
       }
       else if (key === "--remove") {
         const at = declared.findIndex(x => x.id === value);
         if (at === -1) throw new Error(`${value} is not a declared model for ${current.runner}`);
         declared.splice(at, 1);
       }
       else throw new Error(`unknown option ${key}`);
     }
     if (appliedDefault === undefined) {
       if (current.default === null) throw new Error("this executor has no default model; provide --default");
       appliedDefault = current.default;
     }
     const result = await saveRunnerModels(ctx, {id: current.runner, expectedRevision: current.revision, default: appliedDefault, models: declared});
     return {code: 0, out: [`${result.runner}: updated`, ...result.warnings].join("\n"), err: ""};
   } catch (e) { return {code: 2, out: "", err: `pacer: ${(e as Error).message}`}; }
 }

 export async function main(argv: string[], ctx: Ctx = makeCtx()): Promise<Result> {
  // Only this Core may hold its secrets: no environment it passes on carries them.
  let secretsOnStdin: boolean;
  let secrets: CoreSecrets = {};
  let nativeBootstrap;
  const legacySecrets = legacyCoreSecrets(ctx.env);
  try {
    secretsOnStdin = scrubCoreSecrets(ctx.env);
    nativeBootstrap = consumeNativePairedBootstrap(ctx.env);
    if (nativeBootstrap && !(argv[0] === "serve" && argv.includes("--internal"))) {
      return {code:2,out:"",err:"Native bootstrap requires the internal service"};
    }
    // A paired native Core authenticates its parent channel before it reads a byte from it.
    if (secretsOnStdin && !nativeBootstrap) secrets = readCoreSecrets();
  } catch (error) { return {code:2,out:"",err:explain(error)}; }
  if (secrets.ownerKey) holdOwnerKey(secrets.ownerKey);
  const [cmd = "status", ...rest] = argv;
  if (ctx.env.PACER_WORK_GRANT && !["dispatch", "mcp", "api", "review"].includes(cmd)
    && !(cmd === "guard" && ctx.env.PACER_ENFORCEMENT_MODE === "strict" && !!ctx.env.PACER_ENFORCEMENT_TOKEN))
    return {code:2,out:"",err:"pacer: work grants only allow scoped dispatch commands"};
  if (ctx.env.PACER_ASSISTANT_GRANT && cmd !== "mcp")
    return {code:2,out:"",err:"pacer: an assistant grant only allows the MCP server"};
  // Orchestrator turns: review/stop/step result|skip|retry|artifact / run decide|choose|submit-graph|sync|publish,
  // plus structured question answer/escalate/ask (Phase 4). Never delegate or run.answer.
  // run.cleanup stays person-only (refused here and in the op).
  if (ctx.env.PACER_ROLE === "orchestrator" || ctx.env.PACER_RUN_GRANT) {
    const sub = rest[0];
    const allowed =
      cmd === "review" || cmd === "stop"
      || (cmd === "step" && (sub === "result" || sub === "skip" || sub === "retry" || sub === "artifact"))
      || (cmd === "run" && (sub === "decide" || sub === "choose" || sub === "submit-graph" || sub === "sync" || sub === "publish"))
      || cmd === "answer" || cmd === "question" || cmd === "ask"
      || cmd === "api" || cmd === "mcp";
    if (!allowed) {
      return {
        code: 2, out: "",
        err: "pacer: orchestrator role only allows review, stop, step result|skip|retry|artifact, run decide|choose|submit-graph|sync|publish, answer, question, ask --type ...",
      };
    }
  }
  if (cmd === "--pacer-fixture-startup-cleanup" && compiledNativeFixture()) {
    if (rest.length) return {code:2,out:"",err:"Fixture cleanup accepts no arguments"};
    try {
      const {reserveFixtureStartupCleanup}=await import("./update/desktop/native-fixture-cleanup");
      return {code:0,out:JSON.stringify(await reserveFixtureStartupCleanup()),err:""};
    } catch { return {code:2,out:"",err:"Fixture startup cleanup proof is unavailable"}; }
  }
  if (cmd === "--pacer-native-transport-test") {
    if (rest.length) return {code:2,out:"",err:"Native transport smoke accepts no arguments"};
    try {
      const {nativeTransportSelfTest}=await import("./update/desktop/native-transport-test");
      return {code:0,out:JSON.stringify(await nativeTransportSelfTest()),err:""};
    } catch { return {code:2,out:"",err:"Verified native transport unavailable"}; }
  }
  switch (cmd) {
    case "--pacer-component-descriptor": {
      if (rest.length) return {code:2,out:"",err:"usage: pacer --pacer-component-descriptor"};
      return {code:0,err:"",out:JSON.stringify(coreBuildDescriptor())};
    }
    case "--pacer-identity": {
      if (rest.length) return {code:2,out:"",err:"usage: pacer --pacer-identity"};
      const appleTeamId=compiledAppleTeamId(), signingCertSha1=compiledSigningCertSha1(), pins=compiledSignerPins();
      return {code:0,err:"",out:JSON.stringify({schema:1,role:"cli",bundleId:DESKTOP_IDENTIFIERS.cli,version:currentVersion(),arch:process.arch==="arm64"?"aarch64":process.arch==="x64"?"x86_64":process.arch,fixture:!!compiledNativeFixture(),otaMode:compiledNativeFixture()?"fixture":pins?"production":"disabled",appleTeamId,signingCertSha1,signer:pins?signerKind(pins):null,fixturePolicySha256:compiledNativeFixtureSha256()})};
    }
    case "pause":
    case "resume": {
      if (rest.length !== (cmd === "pause" ? 1 : 0)) return {code: 2, out: "", err: `usage: pacer ${cmd === "pause" ? "pause <for>" : "resume"}`};
      try {
        const result = await callOp(ctx, cmd === "pause" ? "delegation.pause" : "delegation.resume", cmd === "pause" ? {for: rest[0]} : {});
        return {code: 0, out: JSON.stringify(result), err: ""};
      } catch (e) { return {code: 2, out: "", err: explain(e)}; }
    }
    case "uninstall":
      return rest.includes("--all") ? uninstallAll(rest, ctx) : findCommand(cmd)!.run(rest, ctx);
    case "account": return accountCmd(rest, ctx);
    case "runner": return runnerCmd(rest, ctx);
    case "config": return configCmd(rest, ctx);
    case "project": return projectStrategyCmd(rest, ctx);
    case "dashboard": return runDashboard(rest, ctx);
    case "setup": return setupCmd(rest, ctx);
    case "answer": {
      try {
        const pos: string[] = [];
        let json = false, options = true, note: string | undefined, expectRev: number | undefined;
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i]!;
          if (options && a === "--") { options = false; continue; }
          if (options && a === "--json") json = true;
          else if (options && (a === "--note" || a.startsWith("--note="))) {
            note = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++i];
          } else if (options && (a === "--expect-rev" || a.startsWith("--expect-rev="))) {
            const raw = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++i];
            expectRev = Number(raw);
          } else if (options && a.startsWith("--")) throw new Error(`unknown option: ${a}`);
          else pos.push(a);
        }
        if (pos.length !== 2) throw new Error('usage: pacer answer <task|question> "<text>" [--note] [--expect-rev] [--json] [--]');
        if (pos[0]!.startsWith("q_")) {
          const current = await callOp(ctx, "question.get", { id: pos[0] }) as { rev: number };
          const result = await callOp(ctx, "question.answer", {
            id: pos[0],
            answer: pos[1],
            ...(note !== undefined ? { note } : {}),
            expect_rev: expectRev ?? current.rev,
          }, { spawnRunner: cliDeps.spawnRunner });
          return { code: 0, out: JSON.stringify(result, null, json ? 2 : undefined), err: "" };
        }
        const result = await callOp(ctx,"task.answer",{id:pos[0],text:pos[1]},{spawnRunner:cliDeps.spawnRunner,participant:localHuman(ctx)});
        return {code:0,out:JSON.stringify(result,null,json?2:undefined),err:""};
      } catch(e) {return {code:2,out:"",err:explain(e)};}
    }
    case "send": {
      const { opts, pos } = parseFlags(rest, ["json", "force"]);
      try {
        if (pos.length !== 2) throw new Error('usage: pacer send <task> "<message>" [--force] [--json]');
        const result = await callOp(ctx, "task.send", { id: pos[0], text: pos[1], force: opts.force === true });
        return { code: 0, out: opts.json ? JSON.stringify(result) : `sent to ${pos[0]}`, err: "" };
      } catch (e) { return { code: 2, out: "", err: explain(e) }; }
    }
    case "ask": {
      // Structured flags → question.ask; executors without flags use task.ask; else assistant.
      const structured = rest.some(a => a === "--type" || a.startsWith("--type=")
        || a === "--option" || a.startsWith("--option=")
        || a === "--recommend" || a.startsWith("--recommend=")
        || a === "--blocks" || a.startsWith("--blocks=")
        || a === "--artifact" || a.startsWith("--artifact=")
        || a === "--step" || a.startsWith("--step=")
        || a === "--attempt" || a.startsWith("--attempt="));
      if (structured) {
        try {
          const options: { value: string }[] = [];
          let type: string | undefined, recommend: string | undefined, blocks = "step", text: string | undefined;
          let artifact: string | undefined, stepId: string | undefined, attempt: number | undefined;
          for (let i = 0; i < rest.length; i++) {
            const a = rest[i]!;
            if (a === "--type" || a.startsWith("--type=")) type = a.includes("=") ? a.slice(7) : rest[++i];
            else if (a === "--option" || a.startsWith("--option=")) {
              const v = a.includes("=") ? a.slice(9) : rest[++i];
              if (v) options.push({ value: v });
            } else if (a === "--recommend" || a.startsWith("--recommend=")) {
              recommend = a.includes("=") ? a.slice(12) : rest[++i];
            } else if (a === "--blocks" || a.startsWith("--blocks=")) {
              blocks = (a.includes("=") ? a.slice(9) : rest[++i]) ?? "step";
            } else if (a === "--artifact" || a.startsWith("--artifact=")) {
              artifact = a.includes("=") ? a.slice(11) : rest[++i];
            } else if (a === "--step" || a.startsWith("--step=")) {
              stepId = a.includes("=") ? a.slice(7) : rest[++i];
            } else if (a === "--attempt" || a.startsWith("--attempt=")) {
              const raw = a.includes("=") ? a.slice(10) : rest[++i];
              attempt = Number(raw);
              if (!Number.isInteger(attempt) || attempt < 1) {
                throw new Error('usage: pacer ask --type <kind> [--option ...] [--recommend] [--blocks] [--artifact] [--step] [--attempt] "<text>"');
              }
            } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
            else if (text === undefined) text = a;
            else throw new Error('usage: pacer ask --type <kind> [--option ...] [--recommend] [--blocks] [--artifact] [--step] [--attempt] "<text>"');
          }
          if (!type || !text?.trim()) {
            throw new Error('usage: pacer ask --type <kind> [--option ...] [--recommend] [--blocks] [--artifact] [--step] [--attempt] "<text>"');
          }
          const result = await callOp(ctx, "question.ask", {
            text,
            answerType: type,
            blocks,
            ...(options.length ? { options } : {}),
            ...(recommend ? { recommended: recommend } : {}),
            ...(artifact ? { artifact } : {}),
            ...(stepId ? { stepId } : {}),
            ...(attempt !== undefined ? { attempt } : {}),
          });
          return { code: 0, out: JSON.stringify(result), err: "" };
        } catch (e) { return { code: 2, out: "", err: e instanceof Error ? e.message : String(e) }; }
      }
      if (!isExecutorSession(ctx)) return askCommand(rest, ctx);
      try {
        const id = core.tasks.requireAskingExecutor(ctx);
        if (rest.length !== 1) throw new Error("usage: pacer ask \"<one question>\"");
        await core.tasks.ask(ctx, id, rest[0]);
        return {code:0, out:"Question recorded; stop and wait for the answer.", err:""};
      } catch (e) { return {code:2, out:"", err:e instanceof Error ? e.message : String(e)}; }
    }
    case "report-limit": {
      const {opts,pos}=parseFlags(rest,[]);
      try{const raw=str(opts.until);const r=core.limits.report(ctx,pos[0],raw===undefined?undefined:Number(raw));
        return {code:0,out:`${r.provider} exhausted until ${r.exhaustedUntil}`,err:""};
      }catch(e){return {code:2,out:"",err:explain(e)};}
    }
    case "executor": return rest[0] === "models" ? executorModelsCommand(rest.slice(1), ctx) : executorCommand(rest, ctx);
    case "status":
      return status(rest, ctx);
    case "route":
      return route(rest, ctx);
    case "delegate":
      return delegateCmd(rest, ctx);
    case "task": {
      if (rest[0] !== "request-review") return {code:2,out:"",err:USAGE};
      const {opts,pos} = parseFlags(rest.slice(1), ["json"]);
      if (!pos[0]) return {code:2,out:"",err:USAGE};
      const client = await connectTaskClient(ctx);
      try {
        const params = {id:pos[0],note:str(opts.note),...(opts["expect-rev"] !== undefined ? {expect_rev:Number(opts["expect-rev"])} : {})};
        const result = client.kind === "inprocess" ? await callOp(ctx, "task.request_review", params) : await client.call("task.request_review", params);
        return {code:0,out:opts.json ? JSON.stringify(result) : `${pos[0]} review requested`,err:""};
      } catch (e) { return {code:2,out:"",err:explain(e)}; }
      finally { client.close(); }
    }
    case "tasks":
      return tasksCmd(rest, ctx);
    case "wait":
    case "review":
    case "dismiss":
    case "retry":
    case "stop": {
      const {opts,pos}=parseFlags(rest,["json","accept","reject","send-back"]);
      if(!pos[0])return {code:2,out:"",err:USAGE};
      try {
        if(cmd==="review") {
          if([opts.accept,opts.reject,opts["send-back"],opts["retry-on"]].filter(Boolean).length!==1)throw new Error("give exactly one of --accept, --reject, --send-back or --retry-on <executor>");
          if(opts["retry-on"]===true)throw new Error("--retry-on requires an executor");
          // Orchestrator turns never delegate (round-2 B2).
          if((opts["send-back"]||opts["retry-on"])&&(isExecutorSession(ctx)||isOrchestratorSession(ctx)||!!ctx.env.PACER_RUN_GRANT))
            throw new DelegateError(isOrchestratorSession(ctx)||ctx.env.PACER_RUN_GRANT
              ? "pacer: orchestrator cannot delegate via --send-back or --retry-on"
              : EXECUTOR_DELEGATE_ERROR);
          if(isExecutorSession(ctx)&&!executorMayReview(ctx,{id:pos[0]}))throw new DelegateError(TASK_REVIEW_REFUSAL);
          const verdict=opts.accept?"accept":opts.reject?"reject":opts["send-back"]?"send_back":"retry";
          // Run-grant sessions must pass authorizeWorkOperation (same as task.review over HTTP).
          if(isOrchestratorSession(ctx)||ctx.env.PACER_RUN_GRANT){
            const task=readTask(ctx,pos[0]);
            if(!task)throw new Error(`unknown task ${pos[0]}`);
            authorizeWorkOperation(ctx,"task.review",{id:pos[0],verdict,expect_rev:task.rev});
            const result=await callOp(ctx,"task.review",{id:pos[0],verdict,executor:str(opts["retry-on"]),kind:str(opts.kind),note:str(opts.note),expect_rev:task.rev},{spawnRunner:cliDeps.spawnRunner,participant:"orchestrator"}) as {merge?:string;resolution_task?:string};
            if(result.merge==="conflict"){
              return {code:1,out:opts.json?JSON.stringify(result):`${pos[0]} merge conflict  ${result.resolution_task ?? ""}`.trimEnd(),err:""};
            }
            return {code:0,out:opts.json?JSON.stringify(result):`${pos[0]} reviewed`,err:""};
          }
          const result=await core.tasks.review(ctx,pos[0],{verdict,executor:str(opts["retry-on"]),kind:str(opts.kind),note:str(opts.note)}, {delegate:(c,input)=>core.tasks.delegate(c,input,cliDeps.spawnRunner),spawnRunner:cliDeps.spawnRunner,participant:localHuman(ctx)});
          if(result.merge==="conflict"){
            // Spec: non-zero exit, print resolution task id; skip diagnostic recheck.
            return {code:1,out:opts.json?JSON.stringify(result):`${pos[0]} merge conflict  ${result.resolution_task ?? ""}`.trimEnd(),err:""};
          }
          const recheck=verdict==="accept"?await recheckDiagnostic(ctx,pos[0],setupDoctor).then(()=>"",e=>`pacer: diagnostics recheck failed: ${e instanceof Error?e.message:String(e)}`):"";
          return {code:0,out:opts.json?JSON.stringify(result):`${pos[0]} reviewed`,err:recheck};
        }
        if(cmd==="dismiss") {
          const r=await core.tasks.dismiss(ctx,pos);
          return {code:r.unknown.length?2:0,out:r.dismissed.map(t=>`${t.id} dismissed`).join("\n"),err:r.unknown.map(id=>`pacer: unknown task ${id}`).join("\n")};
        }
        if(cmd==="retry") {
          if(isExecutorSession(ctx))throw new DelegateError(EXECUTOR_DELEGATE_ERROR);
          const own=readTask(ctx,pos[0]);
          if(own&&core.tasks.userStartedRoot(ctx,own)){
            // A work root a person started restarts as managed work in place (dispatch.retry semantics).
            const r=await callOp(ctx,"task.retry",{id:pos[0],...(str(opts.executor)?{executor:str(opts.executor)}:{})},{spawnRunner:cliDeps.spawnRunner}) as {retry:ReturnType<typeof summarizeTask>};
            return {code:0,out:opts.json?JSON.stringify(r.retry,null,1):`${pos[0]} queued (managed retry)`,err:""};
          }
          const r=await core.tasks.retry(ctx,pos[0],{executor:str(opts.executor)},{delegate:(c,input)=>core.tasks.delegate(c,input,cliDeps.spawnRunner)});
          return {code:0,out:opts.json?JSON.stringify(summarizeTask(r.retry),null,1):`${r.retry.id} queued (retry of ${r.of.id})`,err:""};
        }
        if(cmd==="stop"&&(isOrchestratorSession(ctx)||ctx.env.PACER_RUN_GRANT)){
          const task=readTask(ctx,pos[0]);
          if(!task)throw new Error(`unknown task ${pos[0]}`);
          authorizeWorkOperation(ctx,"task.stop",{id:pos[0],expect_rev:task.rev});
          const stopped=await callOp(ctx,"task.stop",{id:pos[0],expect_rev:task.rev},{spawnRunner:cliDeps.spawnRunner,participant:"orchestrator"}) as ReturnType<typeof summarizeTask> & { id?: string; state?: string };
          await settleLiveReleases();
          // task.stop may return a bare state; never print "undefined stopped" (M4).
          const id = stopped?.id ?? pos[0];
          const state = stopped?.state ?? "stopped";
          return {code:0,out:opts.json?JSON.stringify(stopped,null,1):`${id} ${state}`,err:""};
        }
        const t=cmd==="wait" ? await core.tasks.wait(ctx,pos[0],Number(str(opts.timeout)??600)) : core.tasks.stop(ctx,pos[0]);
        if(cmd==="stop")await settleLiveReleases();
        return {code:cmd==="wait"&&!TERMINAL_STATES.includes(t.state)?2:0,out:opts.json?JSON.stringify(summarizeTask(t),null,1):cmd==="stop"?`${t.id} ${t.state}`:renderTask(t),err:""};
      }catch(e){return {code:2,out:"",err:explain(e)};}
    }
    case "clean": {
      const {opts}=parseFlags(rest,["json","dry-run","force"]);
      try{const r=await core.tasks.clean(ctx,{dryRun:opts["dry-run"]===true,force:opts.force===true});
        if(opts.json)return {code:0,out:JSON.stringify(r),err:""};
        const lines=[...r.removed.map(id=>`${id} ${opts["dry-run"]?"would be removed":"removed"}`),...r.kept.map(k=>`${k.id} kept: ${k.reason}`)];
        return {code:0,out:lines.join("\n")||"nothing to clean",err:""};
      }catch(e){return {code:2,out:"",err:explain(e)};}
    }
    case "host": {
      const { opts, pos } = parseFlags(rest, ["json"]);
      const [action, alias] = pos;
      const usage = "usage: pacer host list|check|setup|clean [alias] [--repo <path>] [--json]";
      if (!["list", "check", "setup", "clean"].includes(action) || (action !== "list" && !alias) || pos.length !== (action === "list" ? 1 : 2) || Object.keys(opts).some(k => !["json", "repo"].includes(k)) || opts.repo === true || (opts.repo && !["check", "setup"].includes(action)) || (action === "setup" && opts.json)) return { code: 2, out: "", err: usage };
      try {
        if (action === "list") {
          const rows = core.hosts.list(ctx);
          return { code: 0, out: opts.json ? JSON.stringify(rows) : rows.map(h => `${h.alias}  ${h.running}/${h.maxTasks} running  ${h.repos.join(", ")}`).join("\n") || "no hosts", err: "" };
        }
        if (action === "clean") {
          const r = await core.hosts.clean(ctx, alias);
          return { code: 0, out: opts.json ? JSON.stringify(r) : [...r.removed.map(id => `${id} removed`), ...r.kept.map(k => `${k.id} kept: ${k.reason}`)].join("\n") || "nothing to clean", err: "" };
        }
        const r = action === "setup" ? await core.hosts.confirmSetup(ctx, alias, str(opts.repo) ?? process.cwd(), async question => {
          if (!process.stdin.isTTY) { process.stdout.write(`${question} [y/N] (confirmation required)\n`); return false; }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try { return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
        }) : await core.hosts.check(ctx, alias, { repo: str(opts.repo) });
        return { code: r.ok ? 0 : 1, out: opts.json ? JSON.stringify(r) : r.checks.map(c => `${c.ok ? "ok " : "FAIL"} ${c.name}${!c.ok && c.detail ? `: ${c.detail}` : ""}`).join("\n"), err: "" };
      } catch (e) { return { code: 2, out: "", err: explain(e) }; }
    }
    case "limits": {
      const { opts, pos } = parseFlags(rest, ["json"]);
      if (pos[0] === "refresh" && pos.length <= 2) {
        let client: Awaited<ReturnType<typeof connectClient>> | undefined;
        try {
          client = await connectClient(ctx, { protocol: 3, allowFallback: false });
          const result = await client.call<{ accounts: { account: string; outcome: string; error: string | null }[] }>("limits.refresh", pos[1] ? { account: pos[1] } : {});
          return { code: 0, out: opts.json ? JSON.stringify(result, null, 2)
            : result.accounts.map(row => `${row.account}: ${row.outcome}${row.error ? ` · ${row.error}` : ""}`).join("\n"), err: "" };
        } catch (error) { return { code: 1, out: "", err: explain(error) }; }
        finally { client?.close(); }
      }
      if (pos[0] !== "check" || pos.length !== 1) return { code: 2, out: "", err: "usage: pacer limits check [--json] | refresh [account] [--json]" };
      try {
        const rows = await core.limits.check(ctx);
        if (opts.json) return { code: 0, out: JSON.stringify(rows, null, 1), err: "" };
        const age = (s: number | null) => s === null ? "never" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
        const out = rows.flatMap(r => [`${r.account} (${r.kind}) · ${r.source ?? "no data"} · ${age(r.ageS)}${r.stale ? " · stale" : ""} · ${r.verdict}${r.usedPct === null ? "" : ` ${Math.round(r.usedPct)}%`}${r.window ? ` ${r.window}` : ""}`, ...(r.error || r.hint ? [`  ${r.error ?? r.hint}`] : [])]);
        return { code: 0, out: out.join("\n") || "no accounts", err: "" };
      } catch (e) { return { code: 2, out: "", err: explain(e) }; }
    }
    case "mcp": {
      if (rest.length > 1 || (rest[0] !== undefined && rest[0] !== "--assistant"))
        return { code: 2, out: "", err: "usage: pacer mcp [--assistant]" };
      await runMcpStdio(() => fresh(ctx), { assistant: rest[0] === "--assistant" });
      return { code: 0, out: "", err: "", keepAlive: true };
    }
    case "api": {
      if (rest[0] !== "--stdio") return apiCommand(rest, ctx);
      if (rest.length !== 1) return { code: 2, out: "", err: "usage: pacer api --stdio" };
      if (legacySecrets) console.error(`pacer: ${LEGACY_CORE_SECRETS}`);
      async function* lines() {
        const decoder = new StringDecoder("utf8");
        let remainder = "";
        for await (const chunk of process.stdin) {
          remainder += typeof chunk === "string" ? chunk : decoder.write(chunk);
          let newline: number;
          while ((newline = remainder.indexOf("\n")) !== -1) {
            yield remainder.slice(0, newline);
            remainder = remainder.slice(newline + 1);
          }
        }
        remainder += decoder.end();
        if (remainder) yield remainder;
      }
      // Only Root's private post-edit hook holds this key.
      const nativeConfigKey = secrets.nativeConfigSyncKey;
      const rechecks: Promise<void>[] = [];
      await runStdio(() => fresh(ctx), lines(), line => { process.stdout.write(line); }, { opDeps: { ...cliDeps, diagnosticRecheck: pending => { rechecks.push(pending); } }, nativeConfigKey });
      // A diagnostics recheck started by an accepted fix still uses the plugins.
      await Promise.all(rechecks);
      await shutdownPlugins(ctx);
      return { code: 0, out: "", err: "", keepAlive: true };
    }
    case "serve": {
      if (rest.includes("--help") || rest.includes("-h")) return { code: 0, out: `usage: pacer serve [--port <n>]\n\nLocal HTTP service (default port ${DEFAULT_PORT}).`, err: "" };
      const { opts } = parseFlags(rest, ["internal"]);
      const internal = opts.internal === true;
      const tokenRequired = `pacer serve --internal requires its credential in the secrets frame on stdin (${CORE_SECRETS_ENV}=${CORE_SECRETS_STDIN}); start it through the pacer front door${legacySecrets ? `; ${LEGACY_CORE_SECRETS}` : ""}`;
      if (internal && !nativeBootstrap && !secrets.internalToken) return { code: 2, out: "", err: tokenRequired };
      // Load or create the machine identity once so activity and task records carry its id; stamping never creates it.
      // Loads are single-flight per home, so identity operations that arrive first share this load.
      void ensureIdentity(ctx).catch(e => console.error(`pacer: machine identity unavailable: ${e instanceof Error ? e.message : String(e)}`));
      try {
        if (internal) {
          const pairedNative = configuredPairedNativeBootstrap(ctx, Number(ctx.env.PACER_PORT ?? DEFAULT_PORT), nativeBootstrap);
          // The authenticated parent channel carries the frame after its descriptors.
          if (pairedNative && secretsOnStdin) {
            secrets = readCoreSecrets();
            if (secrets.ownerKey) holdOwnerKey(secrets.ownerKey);
          }
          const internalToken = secrets.internalToken;
          if (!internalToken) return { code: 2, out: "", err: tokenRequired };
          const s = startServer(() => fresh(ctx), { internal: { token: internalToken }, supervisionWorker: true, backgroundWorker: true, ...(pairedNative ? {pairedNative} : {}) });
          // Best-effort cleanup starts only after the listener binds; the helper logs errors.
          void pruneUndoSnapshotsAtStartup(ctx);
          void terminalEnv(ctx.env, { cwd: ctx.home }).catch(() => undefined);
          process.stdout.write(`${JSON.stringify({ internal: { port: s.port } })}\n`);
          if (ctx.env.PACER_INTERNAL_PARENT_PIPE === "1") {
            // The front door owns the write end. EOF also arrives after SIGKILL,
            // when signal handlers in the parent cannot clean up its child.
            process.stdin.once("end", () => {
              void s.stop().finally(() => process.exit(0));
            });
            process.stdin.resume();
          }
          return { code: 0, out: "", err: "", keepAlive: true };
        }
        const s = startServer(() => fresh(ctx), { port: Number(str(opts.port) ?? ctx.env.PACER_PORT ?? DEFAULT_PORT), supervisionWorker: true, backgroundWorker: true });
        // Best-effort cleanup starts only after the listener binds; the helper logs errors.
        void pruneUndoSnapshotsAtStartup(ctx);
        ctx.env.PACER_PORT=String(s.port);
        // Routing's installed check reads the cached login PATH and never waits on a shell, so read it now.
        void terminalEnv(ctx.env, { cwd: ctx.home }).catch(() => undefined);
        return { code: 0, out: `pacer serve listening on http://127.0.0.1:${s.port} (token: ${ctx.pacerHome}/token)`, err: "", keepAlive: true };
      } catch (e) {
        return { code: 2, out: "", err: explain(e) };
      }
    }
    case "_task-history": {
      if (rest.length) return { code: 2, out: "", err: "usage: pacer _task-history" };
      const parentClosed = () => process.exit(0);
      if (ctx.env.PACER_HISTORY_PARENT_PIPE === "1") {
        process.stdin.once("end", parentClosed);
        process.stdin.resume();
      }
      try {
        await (await import("./tasks/history")).maintainTaskHistory(ctx);
        return { code: 0, out: "", err: "" };
      } catch (error) {
        return { code: 1, out: "", err: `pacer: task history maintenance failed: ${explain(error)}` };
      } finally {
        process.stdin.removeListener("end", parentClosed);
        process.stdin.pause();
      }
    }
    case "report": return reportCommand(rest, ctx);
    case "_session-hook":
      if (rest.length !== 1) return {code: 2, out: "", err: "usage: pacer _session-hook <run-dir>"};
      try {
        const {dir, source} = reportDestination(ctx);
        if (source !== "agent" || (await import("node:fs")).realpathSync(rest[0]) !== dir) throw Error("invalid hook destination");
        agentHook(dir, JSON.parse(await Bun.stdin.text()));
        return {code: 0, out: "", err: ""};
      } catch (e) { return {code: 2, out: "", err: explain(e)}; }
    case "_session":
      if(rest.length!==1) return {code:2,out:"",err:"usage: pacer _session <run-dir>"};
      try {return {code:await sessionHost(rest[0]),out:"",err:""};}
      catch(e) {return {code:2,out:"",err:explain(e)};}
    case "takeover": {
      const {opts,pos}=parseFlags(rest,["no-attach"]);
      if(pos.length!==1 || Object.keys(opts).some(k=>k!=="no-attach")) return {code:2,out:"",err:"usage: pacer takeover <task-id> [--no-attach]"};
      try {
        process.stderr.write("Taking over the headless run…\n");
        const result=await takeoverTask(ctx,pos[0]);
        process.stderr.write(`Take over: ${result.state}.\n`);
        if(opts["no-attach"]===true || result.state!=="driving")return {code:result.state==="ended"?1:0,out:result.attach.cli,err:""};
        return main(["attach",pos[0],"--control"],ctx);
      }catch(e){return {code:2,out:"",err:explain(e)};}
    }
    case "attach": {
      const {opts,pos}=parseFlags(rest,["replay","control","force","read-only"]);
      if(pos.length!==1 || Object.keys(opts).some(k=>!["replay","control","force","read-only","attempt","open"].includes(k))) return {code:2,out:"",err:"usage: pacer attach <task> [--read-only] [--control] [--force] [--replay] [--attempt <n>] [--open [terminal|tmux|orca]]"};
      if(opts.attempt!==undefined && (typeof opts.attempt!=="string" || !/^[1-9]\d*$/.test(opts.attempt))) return {code:2,out:"",err:"--attempt requires a positive integer"};
      try {
        if(opts.open!==undefined){
          const target=opts.open===true?'terminal':opts.open;
          if(!['terminal','tmux','orca'].includes(String(target)))throw Error('--open requires terminal, tmux or orca');
          const result=await openSession(ctx,pos[0],target as 'terminal'|'tmux'|'orca');
          return {code:0,out:result.opened?'Opened task session.':result.command??'',err:''};
        }
        if((await sessionInfo(ctx,pos[0],undefined,false)).host==='orca'){
          const result=await openSession(ctx,pos[0],'orca');return {code:result.opened?0:2,out:result.opened?'Opened task session.':'',err:result.opened?'':'This task no longer has an Orca terminal.'};
        }
        const attempt=opts.attempt===undefined?undefined:Number(opts.attempt);
        const dir=attachDirectory(ctx,pos[0],attempt);
        // Executors cannot send or answer (API-5); attaching must not type around that.
        const readOnly=opts["read-only"]===true||isExecutorSession(ctx);
        await attachSession(dir,{replay:opts.replay===true,control:opts.control===true,force:opts.force===true,readOnly,attempt,handBack:by=>Promise.resolve().then(()=>handBackTask(ctx,pos[0],by))},`pacer ${pos[0]}`);
        return {code:0,out:"",err:""};
      } catch(e) {return {code:2,out:"",err:explain(e)};}
    }
    case "_run":
      if (!rest[0]) return { code: 2, out: "", err: USAGE };
      try {
        const t = await (cliDeps.runTask ?? runTask)(fresh(ctx), rest[0]);
        return { code: t.state === "done" ? 0 : 1, out: "", err: "" };
      } catch (e) {
        return { code: 2, out: "", err: explain(e) };
      }
    case "use":
      if (!rest[0]) return { code: 2, out: "", err: USAGE };
      try {
        return { code: 0, out: `active strategy: ${rest[0]} (${await switchStrategy(ctx, rest[0])})`, err: "" };
      } catch (e) {
        return { code: 2, out: "", err: explain(e) };
      }
    case "help":
    case "--help":
    case "-h":
      return { code: 0, out: help(), err: "" };
    default: {
      const extra = findCommand(cmd);
      if (extra) return extra.run(rest, ctx);
      return { code: 2, out: "", err: `pacer: unknown command "${cmd}"\n${help()}` };
    }
  }
}

if (import.meta.main) {
  const r = await main(process.argv.slice(2));
  // Any command that stopped a kept-alive lane (stop, dispatch stop, session end) finishes releasing its worker first.
  await settleLiveReleases();
  const writes = await Promise.allSettled([
    ...(r.out ? [Bun.write(Bun.stdout, r.out.endsWith("\n") ? r.out : `${r.out}\n`)] : []),
    ...(r.err ? [Bun.write(Bun.stderr, r.err.endsWith("\n") ? r.err : `${r.err}\n`)] : []),
  ]);
  if (writes.some(result => result.status === "rejected")) process.exit(1);
  if (!r.keepAlive) process.exit(r.code);
}
