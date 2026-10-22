#!/usr/bin/env bun
import { compiledNativeFixture, compiledNativeFixtureSha256 } from "./update/desktop/native-fixture";
import { compiledAppleTeamId, compiledSignerPins, compiledSigningCertSha1 } from "./update/desktop/native-os";
import { consumeNativePairedBootstrap, configuredPairedNativeBootstrap } from "./update/desktop/native-paired-bootstrap";
import { signerKind } from "./update/desktop/signer-requirement";
import { currentVersion } from "./update/version";
import { projectStrategyCmd } from "./commands/project-strategy";
import { dashboardClient as connectTaskClient } from "./dashboard/client";
import type { PruneResult } from "./tasks/retention";
import { superviseTasks } from "./tasks/api";
import { drainQueue } from "./tasks/drain";
import { uninstallAll } from "./install/uninstall-all";
import type { ClientSnapshot } from "./view-model/snapshot";
import { registeredRepo, resolveRepoInput } from "./core/repos";
import { callOp } from "./api/ops";
import { reportCommand, reportDestination, agentHook } from "./session/reports";
import { openSession, sessionInfo } from "./session/service";
import { takeoverTask } from "./session/takeover";
import { sessionHost } from "./session/host";
import { attachDirectory, attachSession } from "./session/attach";
import { createInterface } from "node:readline/promises";
import { plannerSessionStatus } from "./install/role";
import type { AgentId } from "./config/accounts";
import { resolveRunner } from "./config/runner-id";
import { readUpdateCheck, updateLine } from "./update/check";
import { runDashboard } from "./dashboard/cli";
import { setupCmd, SETUP_USAGE } from "./commands/setup";
import { parseDelegateKind } from "./commands/delegate-kind";
import * as core from "./core";
import { CoreError } from "./core/errors";
import { readFileSync, realpathSync } from "node:fs";
import { isExecutorSession } from "./install/role";
import { executorCommand } from "./executors/command";
import { use as switchStrategy } from "./strategy/service";
import { hookInput, plannerPolicyApplies } from "./install/role";
import { io } from "./install/stdin";
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
import { runStdio } from "./api/stdio";
import { StringDecoder } from "node:string_decoder";
import { renderHook } from "./render/hook";
import { lineFields, renderLine } from "./render/line";
import { renderText } from "./render/text";
import { renderRoute } from "./render/accounts";
import { DEFAULT_PORT, startServer } from "./serve/http";
import { DelegateError, EXECUTOR_DELEGATE_ERROR, parseDelegateBrief, summarizeTask, taskWait, type SpawnRunner, spawnRunner } from "./tasks/api";
import { runTask } from "./tasks/runner";
import { TERMINAL_STATES, type TaskRecord } from "./tasks/types";
import type { Ctx } from "./types";

/** Test seam: how the CLI starts a task runner. Tests swap it so they never spawn `pacer _run`. */
export const cliDeps: { spawnRunner: SpawnRunner } = { spawnRunner };

const USAGE = `usage: pacer <command>
  dashboard                                      live interactive terminal dashboard
  status [--line | --json | --hook <planner>]   budget status (default: text report)
    --line [--width N] [--no-color] [--json]     compact local status; columns default to COLUMNS or 80
  pause <for> | resume                          pause or resume delegation
  route [kind] [--repo <path-or-key>] [--json]                          executors pacer would use, in order (default repo: current directory)
  project strategy list | show | set | remove   repository executor policy (--repo, --executors, --json)
  delegate [--title <text>] [--brief-file <path|->] [--goal <text>] [--repo <dir>] [--kind <k>] [--scope <s>] [--acceptance <cmd>]
           [--constraints <s>] [--context <s>] [--executor <id>] [--timeout-min <n>] [--wait] [--json] [--force]
           [--worktree current|new|auto] [--worktree-base default|head] [--worktree-reason <text>]
  wait <task-id> [--timeout <seconds>] [--json]   wait (default 600, max 3000); exit 2 on timeout
  review <task-id> --accept|--reject|--send-back|--retry-on <executor> [--note <text>] [--kind <k>] [--json] record review
  task request-review <task-id> --note <text> [--expect-rev <n>] [--json] request a human decision
  dismiss <task-id...>                           hide settled tasks
  tasks [<task-id>] [--all] [--json]             recent tasks, including archives with --all
  tasks prune [--dry-run] [--json]               archive old settled tasks
  tasks restore <task-id> [--json]               restore archived artifacts
  executor set <id> [--enabled true|false] [--model <m>] [--max-tasks <n>]
  executor block <id> [--for <duration>] [--reason <text>] | unblock <id> | list
  report --task <task-id> --outcome done|failed|needs-input|running --summary <text>
  takeover <task-id> [--no-attach]
  attach <task-id> [--control] [--force] [--replay] [--attempt <n>] [--open [terminal|tmux|orca]]
  stop <task-id> [--json]                         stop a running task
  answer <task-id> "<text>"                       answer a question and retry on the same executor
  retry <task-id> [--executor <id>] [--json]       re-delegate a task's stored brief
  clean [--dry-run] [--force] [--json]           remove worktrees of reviewed or dismissed tasks (branches stay)
  ask "<question>" record one question and stop the delegated task
  report-limit <provider> [--until <unix-seconds>] record an executor limit
  host list [--json] | check <alias> [--repo <path>] [--json] | setup <alias> [--repo <path>] | clean <alias> [--json]
  limits check [--json]                          where each account's usage comes from, its age and freshness
  mcp                                            run the MCP server on stdio
  api --stdio                                    client protocol v2 on stdio (JSON-RPC)
  serve [--port <n>] [--internal]                local HTTP status endpoint (default ${DEFAULT_PORT})
  use <strategy>                                 switch to ~/.pacer/strategies/<strategy>.yaml ("default" = strategy.yaml)
  account list [--json] | add <kind> <name> [options] | rm <name> [--delete-home]
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
    return { code: 0, out: [renderText(st), updateLine(readUpdateCheck(ctx))].filter(Boolean).join("\n"), err: "" };
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

async function route(args: string[], ctx: Ctx): Promise<Result> {
  const { opts, pos } = parseFlags(args, ["json"]);
  try {
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
  const lines = [
    `${t.id}  ${t.state}  executor: ${r?.executor ?? t.executor ?? t.attempts.at(-1)?.executor ?? "-"}`,
    `goal: ${t.brief.goal}`,
    `repo: ${t.brief.repo}`,
  ];
  if(t.archived)lines.push(`archive: ${t.archivePath}`);
  if(t.executorFallback)lines.push(`executor: ${fallbackText(t.executorFallback)}`);
  if(t.placement?.mode)lines.push(`placement: ${t.placement.mode} (${t.placement.why})`);
  if (t.attempts.length) {
    lines.push(`attempts: ${t.attempts.map((a) => `${a.executor} (exit ${a.exitCode}${a.limitHit ? ", limit" : ""}${a.timedOut ? ", timed out" : ""})`).join(" > ")}`);
  }
  if (r) {
    lines.push(`files:\n${r.files || "(none)"}`);
    if (r.acceptance) lines.push(`acceptance: ${r.acceptance.cmd} -> ${r.acceptance.passed ? "pass" : "FAIL"}`);
    lines.push(`report:\n${r.report.slice(-1500)}`);
  }
  return lines.join("\n");
}

async function delegateCmd(args: string[], ctx: Ctx): Promise<Result> {
  const { opts } = parseFlags(args, ["wait", "json", "force"]);
  try {
    if(isExecutorSession(ctx))throw new DelegateError(EXECUTOR_DELEGATE_ERROR);
    if(opts["brief-file"]===true)throw new DelegateError("--brief-file needs a path or -");
    const file=str(opts["brief-file"]);
    let raw:Record<string,unknown>={};
    if(file){const parsed=JSON.parse(file==="-" ? await io.readBriefStdin() : readFileSync(file,"utf8"));
      if(!parsed || typeof parsed!=="object" || Array.isArray(parsed))throw new DelegateError("brief must be a JSON object");raw=parsed;}
    for(const key of ["title","goal","repo","scope","acceptance","constraints","context","kind","executor","worktree"]){if(str(opts[key])!==undefined)raw[key]=str(opts[key]);}
    if(str(opts.repo)!==undefined)raw.repo=resolve(str(opts.repo)!);
    if(str(opts["timeout-min"])!==undefined)raw.timeout_min=Number(str(opts["timeout-min"]));
    if(str(opts["worktree-base"])!==undefined)raw.worktree_base=str(opts["worktree-base"]);
    if(str(opts["worktree-reason"])!==undefined)raw.worktree_reason=str(opts["worktree-reason"]);
    if(typeof raw.kind==="string")raw.kind=parseDelegateKind(raw.kind);
    const input=parseDelegateBrief(raw,process.cwd());
    const repoRef=await resolveRepoInput(ctx,input.brief.repo);
    const t=core.tasks.delegate(ctx,{...input,brief:{...input.brief,repo:repoRef.path},source:"cli",repoRef,force:opts.force===true},cliDeps.spawnRunner);
    if (!opts.wait) return { code: 0, out: opts.json ? JSON.stringify(t, null, 1) : `${t.id} queued`, err: "" };
    const done = (await taskWait(ctx, t.id, t.timeoutS * 3 + 60)) ?? t;
    return { code: done.state === "done" ? 0 : 1, out: opts.json ? JSON.stringify(done, null, 1) : renderTask(done), err: "" };
  } catch (e) {
    return { code: 2, out: "", err: explain(e) };
  }
}

async function controlProgress(ctx:Ctx,t:TaskRecord):Promise<string> {
  if(t.state!=="running")return "";
  try {
    const info=await sessionInfo(ctx,t.id,false,false);
    return info.controller?`controlled from ${info.controller.replace(/[\x00-\x1f\x7f]/g,"")}`:"";
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
  const list = core.tasks.list(ctx, { all: opts.all === true, ...(opts.all === true ? { limit: Infinity } : {}) });
  if (opts.json) return { code: 0, out: JSON.stringify(list.map(summarizeTask), null, 1), err: "" };
  if (!list.length) return { code: 0, out: "no tasks yet", err: "" };
  return {
    code: 0,
    out: (await Promise.all(list.map(async (t) => {
      const control=await controlProgress(ctx,t);
      return `${t.id}  ${t.state.padEnd(8)}  ${(t.result?.executor ?? t.attempts.at(-1)?.executor ?? "-").padEnd(12)}  ${t.brief.goal.slice(0, 60)}${t.executorFallback?`  (requested ${t.executorFallback.requested}: ${t.executorFallback.reason})`:""}${t.placement?.mode?`  ${t.placement.mode} (${t.placement.why})`:""}${control?`  ${control}`:""}`;
    }))).join("\n"),
    err: "",
  };
}

export async function main(argv: string[], ctx: Ctx = makeCtx()): Promise<Result> {
  let nativeBootstrap;
  try {
    nativeBootstrap = consumeNativePairedBootstrap(ctx.env);
    if (nativeBootstrap && !(argv[0] === "serve" && argv.includes("--internal"))) {
      return {code:2,out:"",err:"Native bootstrap requires the internal service"};
    }
  } catch (error) { return {code:2,out:"",err:explain(error)}; }
  const [cmd = "status", ...rest] = argv;
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
    case "--pacer-identity": {
      if (rest.length) return {code:2,out:"",err:"usage: pacer --pacer-identity"};
      const appleTeamId=compiledAppleTeamId(), signingCertSha1=compiledSigningCertSha1(), pins=compiledSignerPins();
      return {code:0,err:"",out:JSON.stringify({schema:1,role:"cli",bundleId:"dev.pacer.cli",version:currentVersion(),arch:process.arch==="arm64"?"aarch64":process.arch==="x64"?"x86_64":process.arch,fixture:!!compiledNativeFixture(),otaMode:compiledNativeFixture()?"fixture":pins?"production":"disabled",appleTeamId,signingCertSha1,signer:pins?signerKind(pins):null,fixturePolicySha256:compiledNativeFixtureSha256()})};
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
        if (rest.length !== 2) throw new Error('usage: pacer answer <task> "<text>"');
        const result = await callOp(ctx,"task.answer",{id:rest[0],text:rest[1]},{spawnRunner:cliDeps.spawnRunner});
        return {code:0,out:JSON.stringify(result),err:""};
      } catch(e) {return {code:2,out:"",err:explain(e)};}
    }
    case "ask": {
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
    case "executor": return executorCommand(rest,ctx);
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
          if((opts["send-back"]||opts["retry-on"])&&isExecutorSession(ctx))throw new DelegateError(EXECUTOR_DELEGATE_ERROR);
          const verdict=opts.accept?"accept":opts.reject?"reject":opts["send-back"]?"send_back":"retry";
          const result=await core.tasks.review(ctx,pos[0],{verdict,executor:str(opts["retry-on"]),kind:str(opts.kind),note:str(opts.note)}, {delegate:(c,input)=>core.tasks.delegate(c,input,cliDeps.spawnRunner)});
          return {code:0,out:opts.json?JSON.stringify(result):`${pos[0]} reviewed`,err:""};
        }
        if(cmd==="dismiss") {
          const r=core.tasks.dismiss(ctx,pos);
          return {code:r.unknown.length?2:0,out:r.dismissed.map(t=>`${t.id} dismissed`).join("\n"),err:r.unknown.map(id=>`pacer: unknown task ${id}`).join("\n")};
        }
        if(cmd==="retry") {
          if(isExecutorSession(ctx))throw new DelegateError(EXECUTOR_DELEGATE_ERROR);
          const r=await core.tasks.retry(ctx,pos[0],{executor:str(opts.executor)},{delegate:(c,input)=>core.tasks.delegate(c,input,cliDeps.spawnRunner)});
          return {code:0,out:opts.json?JSON.stringify(summarizeTask(r.retry),null,1):`${r.retry.id} queued (retry of ${r.of.id})`,err:""};
        }
        const t=cmd==="wait" ? await core.tasks.wait(ctx,pos[0],Number(str(opts.timeout)??600)) : core.tasks.stop(ctx,pos[0]);
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
      if (pos[0] !== "check") return { code: 2, out: "", err: "usage: pacer limits check [--json]" };
      try {
        const rows = await core.limits.check(ctx);
        if (opts.json) return { code: 0, out: JSON.stringify(rows, null, 1), err: "" };
        const age = (s: number | null) => s === null ? "never" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
        const out = rows.flatMap(r => [`${r.account} (${r.kind}) · ${r.source ?? "no data"} · ${age(r.ageS)}${r.stale ? " · stale" : ""} · ${r.verdict}${r.usedPct === null ? "" : ` ${Math.round(r.usedPct)}%`}${r.window ? ` ${r.window}` : ""}`, ...(r.error || r.hint ? [`  ${r.error ?? r.hint}`] : [])]);
        return { code: 0, out: out.join("\n") || "no accounts", err: "" };
      } catch (e) { return { code: 2, out: "", err: explain(e) }; }
    }
    case "mcp":
      await runMcpStdio(() => fresh(ctx));
      return { code: 0, out: "", err: "", keepAlive: true };
    case "api": {
      if (rest.length !== 1 || rest[0] !== "--stdio") return { code: 2, out: "", err: "usage: pacer api --stdio" };
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
      await runStdio(() => fresh(ctx), lines(), line => { process.stdout.write(line); }, { opDeps: cliDeps });
      await shutdownPlugins(ctx);
      return { code: 0, out: "", err: "", keepAlive: true };
    }
    case "serve": {
      if (rest.includes("--help") || rest.includes("-h")) return { code: 0, out: `usage: pacer serve [--port <n>]\n\nLocal HTTP service (default port ${DEFAULT_PORT}).`, err: "" };
      const { opts } = parseFlags(rest, ["internal"]);
      const internal = opts.internal === true;
      const internalToken = ctx.env.PACER_INTERNAL_TOKEN;
      if (internal && (!internalToken || internalToken.length < 32)) {
        return { code: 2, out: "", err: "pacer serve --internal requires PACER_INTERNAL_TOKEN in the environment (at least 32 characters)" };
      }
      try {
        if (internal) {
          // Only this process may hold the internal credential: task runners and executors inherit the environment.
          delete process.env.PACER_INTERNAL_TOKEN;
          delete ctx.env.PACER_INTERNAL_TOKEN;
          const pairedNative = configuredPairedNativeBootstrap(ctx, Number(ctx.env.PACER_PORT ?? DEFAULT_PORT), nativeBootstrap);
          const s = startServer(() => fresh(ctx), { internal: { token: internalToken! }, ...(pairedNative ? {pairedNative} : {}) });
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
        const s = startServer(() => fresh(ctx), { port: Number(str(opts.port) ?? ctx.env.PACER_PORT ?? DEFAULT_PORT) });
        return { code: 0, out: `pacer serve listening on http://127.0.0.1:${s.port} (token: ${ctx.pacerHome}/token)`, err: "", keepAlive: true };
      } catch (e) {
        return { code: 2, out: "", err: explain(e) };
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
      const {opts,pos}=parseFlags(rest,["replay","control","force"]);
      if(pos.length!==1 || Object.keys(opts).some(k=>!["replay","control","force","attempt","open"].includes(k))) return {code:2,out:"",err:"usage: pacer attach <task> [--control] [--force] [--replay] [--attempt <n>] [--open [terminal|tmux|orca]]"};
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
        await attachSession(dir,{replay:opts.replay===true,control:opts.control===true,force:opts.force===true,attempt},`pacer ${pos[0]}`);
        return {code:0,out:"",err:""};
      } catch(e) {return {code:2,out:"",err:explain(e)};}
    }
    case "_run":
      if (!rest[0]) return { code: 2, out: "", err: USAGE };
      try {
        const t = await runTask(fresh(ctx), rest[0]);
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
  if (r.out) process.stdout.write(r.out.endsWith("\n") ? r.out : `${r.out}\n`);
  if (r.err) process.stderr.write(r.err.endsWith("\n") ? r.err : `${r.err}\n`);
  if (!r.keepAlive) process.exit(r.code);
}
