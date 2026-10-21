import { desktopUpdateOps } from "./ops-desktop-update";
import { desktopOps } from "./ops-desktop";
import type { DesktopUpdateRuntime } from "../update/desktop/service";
import { resolvePolicyRepoInput } from "../core/project-policy";
import * as projectStrategies from "../core/project-strategies";
import { pruneTasks, restoreTask } from "../tasks/retention";
import { parseRunnerId } from "../config/runner-id";
import { pacerArgv } from "../install/self";
import * as plugins from "../core/plugins";
import * as attention from "../core/attention";
import { taskDetail, retryOptions } from "../core/task-detail";
import { isAbsolute } from "node:path";
import { requireRepoDirectory, resolveRepo, resolveRepoInput, listReposWithBranches, addRepo, removeRepo } from "../core/repos";
import { apiTask } from "./read-model/tasks";
import { appendActivity, readActivity } from "../activity/log";
import { ACTIVITY_KINDS } from "../activity/types";
import * as delegationPause from "../core/pause";
import * as modeHold from "../core/mode-hold";
import { checkRunner, type RunnerCheckDeps } from "../core/runner-check";
import { sessionOps } from "./ops-session";
import { z } from "zod";
import type { TerminalDeps } from "../terminal/open";
import { openInTerminal } from "../terminal/open";
import { detectAgents } from "../install/detection";
import { getJob, listJobs, cancelJob, startJob } from "../jobs/registry";
import { build as buildStrategy } from "../strategy/launcher";
import * as core from "../core";
import * as accounts from "../core/accounts";
import * as endpoints from "../core/endpoints";
import * as opencodeSetup from "../core/opencode-setup";
import { redactEndpointMessage } from "../endpoints/state";
import * as runnersConfig from "../core/runners-config";
import * as routingConfig from "../core/routing-config";
import { AGENTS } from "../config/accounts";
import * as config from "../core/config";
import * as setup from "../core/setup";
import * as notify from "../core/notify";
import * as clients from "../clients/registry";
import { publishConfigChange } from "../core/events";
import { KINDS, loadStrategy } from "../config/strategy";
import { CoreError, toCoreError } from "../core/errors";
import { isExecutorSession } from "../install/role";
import * as strategy from "../strategy/service";
import { publish } from "../link/publish";
import { checkForUpdate, updateAvailable } from "../update/check";
import { defaultUpdateDeps, runUpdate, type UpdateDeps } from "../update/update";
import { currentVersion } from "../update/version";
import { EXECUTOR_DELEGATE_ERROR, type SpawnRunner, delegateSchema, parseDelegateBrief, spawnRunner, summarizeTask } from "../tasks/api";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { Ctx } from "../types";

export const LEGACY_TASK_LIST = Symbol("legacy task summaries");

export interface OpDeps {
  desktopUpdates?: DesktopUpdateRuntime;
  onboardingRoute?: import("../onboarding/try").TryDeps["route"];
  snapshotProbe?: boolean;
  terminalPresetsOnly?: boolean;
  client?: string;
  delegate?: typeof core.tasks.delegate;
  runnerCheck?: RunnerCheckDeps;
  terminal?: Partial<TerminalDeps>;
  openInTerminal?: typeof openInTerminal;
  spawnRunner?: SpawnRunner;
  endpoint?: endpoints.EndpointDeps;
  openTerminal?: typeof openInTerminal;
  runUpdate?: typeof runUpdate;
  update?: Partial<Pick<UpdateDeps, "standalone" | "execPath">>;
}
export interface OpDef<P extends z.ZodTypeAny = z.ZodTypeAny> { description: string; params: P; handler: (ctx: Ctx, p: z.infer<P>, deps: OpDeps) => unknown }

const expect_rev = z.number().int().positive().optional();
const pluginId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const id = z.string().min(1).max(128);
const op = <P extends z.ZodTypeAny>(d: OpDef<P>) => d as unknown as OpDef;

const agent = z.enum(["claude-code", "codex", "cursor", "opencode"]);
const level = z.enum(["off", "important", "all"]);
const draft = z.object({from: id, set: z.record(z.string(), z.json()).optional(), unset: z.array(z.string()).optional(), description: z.string().optional()});
const endpointModel = z.object({id: z.string().min(1), name: z.string().optional(), context: z.number().int().positive(), output: z.number().int().positive(), tools: z.boolean()});
const endpointFields = {
  base_url: z.url().refine(value => /^https?:\/\//.test(value), "base URL must be HTTP(S)"),
  key_source: z.enum(["keychain", "file", "env", "none"]),
  key: z.string().optional(), env_var: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  models: z.array(endpointModel).min(1), usage: z.enum(["quota", "metered", "unmetered"]),
  weekly_tokens: z.number().int().positive().optional(), quota_source: z.string().min(1).optional(), test: z.boolean().optional(),
};
const endpointEdit = z.object({name: id, ...endpointFields}).partial().required({name: true});
const setupGroup = z.enum(["signed_in", "local", "catalog"]);
const opencodeProvider = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
/** An executor that refers to a provider OpenCode is already signed in to; pacer never stores its key. */
const opencodeAccount = z.object({kind: z.literal("endpoint"), source: z.literal("opencode"), provider: opencodeProvider, model: z.string().min(1),
  name: id.regex(/^[a-z0-9][a-z0-9-]*$/).optional(), cap_usd: z.number().positive().optional(), usage: z.enum(["quota", "metered", "unmetered"]).optional(), test: z.boolean().optional()});
async function endpointAction<T>(key: string | undefined, action: () => T | Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const safe = toCoreError(error);
    throw new CoreError(safe.code, redactEndpointMessage(safe.message, [key ?? ""]));
  }
}
async function strategyAction<T>(action: () => T | Promise<T>): Promise<T> {
  try { return await action(); } catch (e) {
    const error = toCoreError(e);
    throw new CoreError(error.code, error.message, error.hint ?? "Use strategy.list to choose a strategy and strategy.preview to validate a draft.");
  }
}
async function applyUpdate(ctx: Ctx, deps: OpDeps) {
  const update = {...defaultUpdateDeps(ctx), ...deps.update};
  // Reuse the CLI's install-method checks without letting it replace the daemon
  // binary in-process. With standalone:false it always stops before fetching.
  const preflight = await runUpdate({check: false}, {...update, standalone: false});
  if (!update.standalone || !preflight.err.startsWith("pacer update: this pacer runs from source")) {
    const message = preflight.err.replace(/^pacer update: /, "");
    throw new CoreError("not_allowed", message, message);
  }
  const job=await startJob(ctx,"update.apply","pacer",["Download","Verify","Replace","Refresh integrations","Restart"],async step=>{
    const result=await (deps.runUpdate ?? runUpdate)({check:false},{...update,progress:(name,state,detail)=>{
      if(state==='running') step.start(name,detail);
      else if(state==='passed') step.pass(name,detail);
      else step.skip(name,detail);
    }});
    if(result.code!==0) throw new Error(result.err);
  },{awaitRestart:true});
  return {job};
}

async function mutation<T>(ctx: Ctx, area: string, action: () => T | Promise<T>): Promise<T> {
  const result = await action();
  await publishConfigChange(ctx, area);
  return result;
}

/** Check before any liveness refresh, label write, process signal or spawn. */
function taskMutation<T>(ctx: Ctx, id: string, expect: number | undefined, action: () => T): T {
  return withTaskLock(ctx, id, () => {
    const task = readTask(ctx, id);
    if (!task) throw new CoreError("unknown_task", `unknown task ${id}`);
    core.tasks.checkRev(ctx, task, expect);
    return action();
  });
}

const interactive = z.object({
  interactive: z.enum(["account-add", "account-add-orca", "runner-add", "init"]),
  worktree: z.string().min(1).max(4096).optional(),
});

async function interactiveTerminal(ctx: Ctx, p: z.infer<typeof interactive>, deps: OpDeps) {
  const commands = {
    "account-add": ["account", "add"], "account-add-orca": ["account", "add", "--orca"],
    "runner-add": ["runner", "add"], init: ["init"],
  };
  return (deps.openTerminal ?? openInTerminal)(ctx, {
    argv: [...pacerArgv(ctx.env), ...commands[p.interactive]], title: "pacer settings", worktree: p.worktree,
  }, deps.terminal);
}

export const OPS: Record<string, OpDef> = { ...sessionOps, ...desktopOps,
  ...desktopUpdateOps,
  "project.strategy.list": op({
    description: "List repository executor overrides, including policies for absent checkouts.", params: z.object({}),
    handler: ctx => projectStrategies.list(ctx),
  }),
  "project.strategy.get": op({
    description: "Read a repository executor override and revision; null executors inherit global routing.", params: z.object({ repo: z.string().min(1).max(4096) }),
    handler: (ctx, p) => projectStrategies.get(ctx, p.repo),
  }),
  "project.strategy.set": op({
    description: "Set an ordered repository executor allowlist. Requires the current revision (0 for a new policy).",
    params: z.object({ repo: z.string().min(1).max(4096), executors: z.array(id).min(1), expect_rev: z.number().int().nonnegative().safe() }),
    handler: (ctx, p) => mutation(ctx, "project-strategies", () => projectStrategies.set(ctx, p.repo, p.executors, p.expect_rev)),
  }),
  "project.strategy.remove": op({
    description: "Remove a repository override and restore global routing, preserving its revision.",
    params: z.object({ repo: z.string().min(1).max(4096), expect_rev: z.number().int().nonnegative().safe() }),
    handler: (ctx, p) => mutation(ctx, "project-strategies", () => projectStrategies.remove(ctx, p.repo, p.expect_rev)),
  }),
  "activity.list": op({
    description: "Activity log, newest first, with optional repo, kind and task filters.",
    params: z.object({ before: z.string().min(1).optional(), limit: z.number().int().min(1).max(500).optional(), repo: z.string().min(1).optional(), kinds: z.array(z.enum(ACTIVITY_KINDS)).optional(), taskId: id.optional() }),
    handler: (ctx, p) => readActivity(ctx, p),
  }),
  "delegation.pause": op({description: "Pause new delegation for up to seven days.", params: z.object({for: z.string(), reason: z.string().optional()}), handler: (ctx, p) => mutation(ctx, "delegation", async () => {const result=delegationPause.pause(ctx,p);await publish(ctx,[{type:"pause",data:result}]);appendActivity(ctx,{kind:"config",level:"info",text:`Delegation paused for ${p.for}`});return result;})}),
  "delegation.resume": op({description: "Resume delegation.", params: z.object({}), handler: ctx => mutation(ctx, "delegation", async () => {const result=delegationPause.resume(ctx);await publish(ctx,[{type:"pause",data:{removed:true}}]);appendActivity(ctx,{kind:"config",level:"info",text:"Delegation resumed"});return result;})}),
  "mode.hold": op({description: "Hold a mode until a timestamp or the planner window resets.", params: z.object({mode: z.enum(["strict", "normal", "relaxed", "emergency"]), until: z.number().optional()}), handler: (ctx, p) => mutation(ctx, "mode", () => modeHold.holdMode(ctx, p))}),
  "mode.release": op({description: "Release the held mode and return to pace-derived mode.", params: z.object({}), handler: ctx => mutation(ctx, "mode", () => modeHold.releaseMode(ctx))}),
  "agent.detect": op({ description: "Detect installed agent CLIs and their versions.", params: z.object({host: id.optional()}), handler: (ctx, p) => detectAgents(ctx, p) }),
  "job.get": op({ description: "Read a shared job.", params: z.object({id}), handler: (ctx, p) => getJob(ctx, p.id) }),
  "job.list": op({ description: "List retained shared jobs, optionally for a target.", params: z.object({target: id.optional()}), handler: (ctx, p) => listJobs(ctx, p) }),
  "job.cancel": op({ description: "Cancel a job that supports cancellation.", params: z.object({id}), handler: (ctx, p) => cancelJob(ctx, p.id) }),
  "task.ask": op({ description: "Record one question from the current executor, then stop.", params: z.object({id, text:z.string().min(1).max(1000)}), handler: (ctx,p) => {
    core.tasks.requireAskingExecutor(ctx,p.id);
    return core.tasks.ask(ctx,p.id,p.text);
  }}),
  "client.register": op({ description: "Register a client with an optional notifier lease; heartbeat every 30 seconds.", params: z.object({kind: z.enum(clients.CLIENT_KINDS), version: z.string().min(1), notifier: z.boolean().optional()}), handler: (ctx, p) => clients.register(ctx, p) }),
  "client.heartbeat": op({ description: "Renew a client lease, which lapses after 45 seconds without a heartbeat.", params: z.object({client_id: id}), handler: (ctx, p) => clients.heartbeat(ctx, p.client_id) }),
  "client.list": op({ description: "Registered clients with live leases.", params: z.object({}), handler: ctx => clients.list(ctx) }),
  "account.list": op({ description: "Accounts, usage and sign-in commands without account emails.", params: z.object({}), handler: ctx => accounts.list(ctx) }),
  "account.signin": op({ description: "Open the account login in an available terminal, or return its command.", params: z.union([z.object({name: id, target: z.enum(["auto", "orca", "terminal", "tmux"]).optional()}),interactive.omit({interactive:true}).extend({interactive:z.enum(["account-add","account-add-orca","init"])})]), handler: (ctx, p, deps) => "interactive" in p ? interactiveTerminal(ctx,p,deps) : accounts.signin(ctx, p.name, p, deps.terminal) }),
  "account.add": op({
    description: "Create a Claude or Codex account home, configure and test a model endpoint, or add an executor for a provider OpenCode is signed in to (source: opencode).",
    // `source: opencode` is tried first so it is not read as a pacer-managed endpoint.
    params: z.union([opencodeAccount, z.discriminatedUnion("kind", [
      z.object({kind: z.literal("claude"), name: id, home: z.string().min(1).optional()}),
      z.object({kind: z.literal("codex"), name: id, home: z.string().min(1).optional()}),
      z.object({kind: z.literal("endpoint"), name: id, ...endpointFields}),
    ])]),
    handler: (ctx, p, deps) => mutation(ctx, "accounts", async () => {
      if ("source" in p) return opencodeSetup.addOpencodeAccount(ctx, p, deps.endpoint);
      if (p.kind === "endpoint") return endpointAction(p.key, () => endpoints.addEndpoint(ctx, p, deps.endpoint));
      const {migrated} = await accounts.add(ctx, p);
      return {...(migrated ? {migrated} : {}), account: (await accounts.list(ctx)).find(a => a.name === p.name)!};
    }),
  }),
  "executor.setup.candidates": op({ description: "OpenCode providers, local model servers and catalog providers that can become executors; no secrets.", params: z.object({}), handler: (ctx, _p, deps) => opencodeSetup.setupCandidates(ctx, deps.endpoint) }),
  "executor.setup.models": op({ description: "Usable models for one setup candidate, with a recommended pick and usage type.", params: z.object({provider: z.string().min(1), group: setupGroup, base_url: endpointFields.base_url.optional()}), handler: (ctx, p, deps) => opencodeSetup.setupModels(ctx, p, deps.endpoint) }),
  "executor.setup.connect": op({ description: "Connect a catalog provider through OpenCode, which stores the key (never pacer). This release runs nothing and returns the opencode auth login command to run in a terminal; an optional key is accepted for later releases and never used or stored.", params: z.object({provider: opencodeProvider, key: z.string().min(1).optional()}), handler: (ctx, p) => endpointAction(p.key, () => opencodeSetup.connectWithKey(ctx, p.provider)) }),
  "account.models": op({ description: "Discover endpoint models using a supplied or stored key.", params: z.object({name: id.optional(), base_url: endpointFields.base_url.optional(), key: z.string().optional()}), handler: (ctx, p, deps) => endpointAction(p.key, () => endpoints.listModels(ctx, p, deps.endpoint)) }),
  "account.edit": op({ description: "Edit a managed endpoint and regenerate its OpenCode provider.", params: endpointEdit, handler: (ctx, p, deps) => mutation(ctx, "accounts", () => endpointAction(p.key, () => endpoints.editEndpoint(ctx, p, deps.endpoint))) }),
  "account.test": op({ description: "Run an endpoint test task in an isolated temporary git repository.", params: z.object({name: id}), handler: (ctx, p, deps) => mutation(ctx, "accounts", () => endpointAction(undefined, () => endpoints.testEndpoint(ctx, p.name, deps.endpoint))) }),
  "account.adopt": op({ description: "Adopt an external OpenCode provider's URL and model ids, supplying a new key source.", params: z.object({name: id, key_source: endpointFields.key_source, key: endpointFields.key, env_var: endpointFields.env_var}), handler: (ctx, p, deps) => mutation(ctx, "accounts", () => endpointAction(p.key, () => endpoints.adoptEndpoint(ctx, p, deps.endpoint))) }),
  "account.remove": op({ description: "Remove an unused account, optionally deleting its protected-path-checked home.", params: z.object({name: id.regex(/^[a-z0-9][a-z0-9-]*$/, "invalid account name"), delete_home: z.boolean().optional()}), handler: (ctx, p) => mutation(ctx, "accounts", () => { const {migrated} = accounts.remove(ctx, p.name, {deleteHome: p.delete_home}); return {removed: true, ...(migrated ? {migrated} : {})}; }) }),
  "runner.add": op({ description: "Add an agent/account runner to the default routing rule.", params: z.union([interactive.omit({interactive:true}).extend({interactive:z.literal("runner-add")}),z.object({agent: z.enum(AGENTS), account: id.optional(), host: id.optional(), model: z.string().min(1).optional(), rank: z.number().int().nonnegative().optional(), kinds: z.array(z.enum(KINDS)).min(1).optional(), max_tasks: z.number().int().positive().optional(), test: z.boolean().optional()})]), handler: (ctx, p, deps) => "interactive" in p ? interactiveTerminal(ctx,p,deps) : mutation(ctx, "runners", async () => {
    const {id, migrated} = runnersConfig.add(ctx, p);
    return {id, ...(migrated ? {migrated} : {}), ...(p.test !== false ? {job: await checkRunner(ctx, id, deps.runnerCheck)} : {})};
  }) }),
  "runner.check": op({description: "Check executor CLI, sign-in, usage and a scratch test task.", params: z.object({id}), handler: (ctx, p, deps) => checkRunner(ctx, p.id, deps.runnerCheck)}),
  "runner.set": op({description:"Edit an executor's settings and rank.",params:z.object({id,enabled:z.boolean().optional(),model:z.string().min(1).nullable().optional(),max_tasks:z.number().int().positive().optional(),rank:z.number().int().nonnegative().optional()}),handler:(ctx,p)=>mutation(ctx,"runners",()=>runnersConfig.set(ctx,p.id,p))}),
  "runner.reorder": op({description:"Replace executor priority order.",params:z.object({ids:z.array(id)}),handler:(ctx,p)=>mutation(ctx,"runners",()=>runnersConfig.reorder(ctx,p.ids))}),
  "runner.remove": op({ description: "Remove a runner and its routing and pacing order references.", params: z.object({id:id.refine(value=>!!parseRunnerId(value),"invalid runner id")}), handler: (ctx, p) => mutation(ctx, "runners", () => { const {migrated} = runnersConfig.remove(ctx, p.id); return {removed: true, ...(migrated ? {migrated} : {})}; }) }),
  "routing.get": op({ description: "Routing rules and available executor ids.", params: z.object({}), handler: ctx => routingConfig.get(ctx) }),
  "routing.set": op({ description: "Validate and replace routing rules, keeping the default last and preserving comments.", params: z.object({rules: z.array(z.object({kinds: z.array(z.string()).optional(), executors: z.array(id)}))}), handler: (ctx, p) => mutation(ctx, "routing", () => routingConfig.set(ctx, p.rules)) }),
  "host.add": op({ description: "Add an SSH host alias without connecting to it.", params: z.object({alias: id, ssh: z.string().min(1)}), handler: (ctx, p) => mutation(ctx, "hosts", () => core.hosts.add(ctx, p)) }),
  "host.suggest": op({ description: "SSH aliases not already configured as hosts.", params: z.object({}), handler: ctx => core.hosts.suggest(ctx) }),
  "host.get": op({ description: "Host facts, checks, capacity and recent work.", params: z.object({alias: id}), handler: (ctx, p) => core.hosts.detail(ctx, p.alias) }),
  "host.set": op({ description: "Set host capacity, pause new work, or choose recording-only or full live sessions.", params: z.object({alias: id, max_tasks: z.number().int().min(1).max(16).optional(), paused: z.boolean().optional(), session: z.enum(["recording", "full"]).optional()}), handler: (ctx, p) => mutation(ctx, "hosts", () => core.hosts.set(ctx, p.alias, p)) }),
  "host.repo.map": op({ description: "Map a canonical repo key to a host checkout.", params: z.object({alias: id, key: id, path: z.string().trim().min(1)}), handler: (ctx, p) => mutation(ctx, "hosts", () => core.hosts.mapRepo(ctx, p.alias, p.key, p.path)) }),
  "host.repo.setup": op({ description: "Clone and set repo identity with explicit consent, as a job.", params: z.object({alias: id, key: id, clone: z.boolean().optional(), identity: z.boolean().optional(), consent: z.literal(true)}), handler: async (ctx, p) => ({job: await core.hosts.setupJob(ctx, p.alias, p.key, p)}) }),
  "host.account.add": op({ description: "Map a host account folder and return its login command.", params: z.object({alias: id, account: id, home: z.string().trim().min(1)}), handler: (ctx, p) => mutation(ctx, "hosts", () => core.hosts.addAccount(ctx, p.alias, p.account, p.home)) }),
  "host.clean": op({ description: "Preview host branch fates or clean worktrees as a job.", params: z.object({alias: id, dry_run: z.boolean().optional()}), handler: async (ctx, p) => p.dry_run ? core.hosts.clean(ctx, p.alias, {dryRun: true}) : {job: await core.hosts.cleanJob(ctx, p.alias)} }),
  "host.terminal": op({ description: "Open an SSH terminal for a host.", params: z.object({alias: id}), handler: (ctx, p, deps) => core.hosts.terminal(ctx, p.alias, deps.openInTerminal) }),
  "host.remove": op({ description: "Remove an SSH host unless a runner uses it; local is reserved.", params: z.object({alias: id}), handler: (ctx, p) => mutation(ctx, "hosts", () => core.hosts.remove(ctx, p.alias)) }),
  "config.get": op({ description: "Allow-listed settings with their sources and compatible planner candidates.", params: z.object({}), handler: ctx => config.get(ctx) }),
  "config.set": op({ description: "Change a setting with validation, rollback and an undo command; planner requires an integration choice.", params: z.object({ key: z.enum(config.CONFIG_KEYS), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]), integrations: z.enum(["install", "skip"]).optional() }), handler: async (ctx, p, deps) => { const {notes, ...result} = await config.set(ctx, p.key, p.value, {...p, terminalPresetsOnly: deps.terminalPresetsOnly}); return result; } }),
  "notifications.get": op({ description: "Current notification level.", params: z.object({}), handler: ctx => notify.getLevel(ctx) }),
  "notifications.set": op({ description: "Set notifications to off, important or all.", params: z.object({level}), handler: (ctx, p) => mutation(ctx, "config", () => notify.setLevel(ctx, p.level)) }),
  "doctor.run": op({ description: "Run setup, service, account and integration diagnostics with fixed isolated Claude handler probes. Configuration and tested handlers do not prove host invocation. No repairs are performed.", params: z.object({}), handler: (ctx) => setup.doctor(ctx) }),
  "setup.check": op({ description: "Read the setup checklist and outstanding steps.", params: z.object({}), handler: (ctx, _p, deps) => setup.check(ctx, {snapshotProbe:deps.snapshotProbe}) }),
  "setup.init": op({ description: "Create a missing strategy and select a planner without connecting agents.", params: z.object({planner: id}), handler: (ctx, p) => mutation(ctx, "setup", () => setup.init(ctx, p.planner)) }),
  "service.install": op({ description: "Run pacer in the background at login to keep budgets fresh and run delegated tasks, after explicit consent.", params: z.object({consent: z.literal(true)}), handler: (ctx, p) => mutation(ctx, "setup", () => setup.serviceInstall(ctx, p.consent)) }),
  "onboarding.try": op({ description: "Start a tiny docs delegation in a scratch git repository; returns task_id, executor and repo.", params: z.object({}), handler: (ctx, _p, deps) => mutation(ctx, "setup", () => setup.onboardingTry(ctx, {route: deps.onboardingRoute, delegate: deps.delegate, spawnRunner: deps.spawnRunner})) }),
  "onboarding.skip": op({ description: "Skip the first delegation and record the onboarding choice.", params: z.object({}), handler: ctx => mutation(ctx, "setup", () => setup.onboardingSkip(ctx)) }),
  "service.status": op({ description: "Whether the login service is installed and running, with its process id when known.", params: z.object({}), handler: ctx => setup.serviceStatus(ctx) }),
  "plugin.install": op({ description: "Retired: pacer no longer ships an Orca plugin. Always fails with not_allowed; removed in the next protocol major.", params: z.object({}), handler: () => setup.pluginInstall() }),
  "agent.preview": op({ description: "Preview agent integration files and the undo command before consenting.", params: z.object({agent}), handler: (ctx, p) => setup.agentPreview(ctx, p.agent) }),
  "agent.connect": op({ description: "Connect an agent after explicit consent to write its integration files.", params: z.object({agent, consent: z.boolean().optional()}), handler: (ctx, p) => mutation(ctx, "setup", () => setup.agentConnect(ctx, p.agent, p)) }),
  "agent.disconnect": op({ description: "Remove an agent integration using its recorded undo actions.", params: z.object({agent}), handler: (ctx, p) => mutation(ctx, "setup", () => setup.agentDisconnect(ctx, p.agent)) }),
  "version.get": op({ description: "Pacer, protocol and service versions or status.", params: z.object({}), handler: ctx => setup.version(ctx) }),
  "host.list": op({ description: "Configured SSH hosts and running task counts.", params: z.object({}), handler: ctx => core.hosts.list(ctx) }),
  "host.check": op({ description: "Check SSH host prerequisites, checkouts and identity.", params: z.object({ alias: id, repo: z.string().min(1).optional() }), handler: async (ctx, p) => ({ job: await core.hosts.checkJob(ctx, p.alias, { repo: p.repo }) }) }),
  "task.get": op({ description: "One task's state and result.", params: z.object({ id }), handler: (ctx, p) => taskDetail(ctx, p.id) }),
  "task.retry_options": op({ description: "Executors available for retry in routing order.", params: z.object({ id }), handler: (ctx, p) => retryOptions(ctx, p.id) }),
  "repo.list": op({ description: "Registered repos with local branches, current first.", params: z.object({}), handler: ctx => listReposWithBranches(ctx) }),
  "repo.add": op({ description: "Register a git repository.", params: z.object({path:z.string().min(1).max(4096)}), handler: (ctx,p) => addRepo(ctx,p.path) }),
  "repo.remove": op({ description: "Remove a repository from the registry.", params: z.object({key:z.string().min(1)}), handler: (ctx,p) => removeRepo(ctx,p.key) }),
  "task.prune": op({ description: "Archive old reviewed or dismissed settled tasks; dry_run reports files and bytes without moving them.", params: z.object({ dry_run: z.boolean().optional() }), handler: (ctx, p) => pruneTasks(ctx, { dryRun: p.dry_run }) }),
  "task.restore": op({ description: "Restore an archived task and its artifacts; conflicting files are never overwritten.", params: z.object({ id }), handler: async (ctx, p) => summarizeTask(await restoreTask(ctx, p.id)) }),
  "task.list": op({ description: "Recent tasks, newest first, always returned as a cursor page.", params: z.object({
    all:z.boolean().optional(), limit:z.number().int().min(1).max(200).optional(), before:id.optional(), repo:z.string().min(1).optional(),
    states:z.array(z.enum(["queued","running","done","partial","failed","limit","stopped","needs_input"])).optional(), executor:id.optional(), since:z.number().nonnegative().optional(),
  }), handler: (ctx,p) => {
    const limit=p.limit??20, rows=core.tasks.list(ctx,{...p,limit:limit+1});
    const page={tasks:rows.slice(0,limit).map(t=>apiTask(ctx,t)),next:rows.length>limit?rows[limit-1].id:null};
    if([p.before,p.repo,p.states,p.executor,p.since].every(v=>v===undefined))Object.defineProperty(page,LEGACY_TASK_LIST,{value:rows.slice(0,limit).map(summarizeTask)});
    return page;
  } }),
  "task.delegate": op({
    description: "Hand a brief to an executor chosen by budget and priority (or `executor`).",
    params: z.object({ ...delegateSchema, repo: z.string().min(1) }),
    handler: async (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      const repoRef=await resolvePolicyRepoInput(ctx,p.repo);
      const input=parseDelegateBrief({...p,repo:repoRef.path},repoRef.path);
      await requireRepoDirectory(input.brief.repo);
      const source=input.source ?? (/^(app|desktop|orca|tui|tray)/i.test(deps.client??"") ? "ui" : "planner");
      const task = (deps.delegate ?? core.tasks.delegate)(ctx, {...input, repoRef, repoValidated:true, client: deps.client, source}, deps.spawnRunner ?? spawnRunner);
      // The v1 notifier still uses this marker for short tasks started in a UI.
      const result = source === "ui" && readTask(ctx, task.id)
        ? updateTask(ctx, task.id, task => { task.fromPanel = true; }) : task;
      return summarizeTask(result);
    },
  }),
  "task.wait": op({ description: "Block until the task settles or timeout_s passes.", params: z.object({ id, timeout_s: z.number().int().min(1).max(3000).optional() }), handler: async (ctx, p) => summarizeTask(await core.tasks.wait(ctx, p.id, p.timeout_s ?? 600)) }),
  "task.stop": op({ description: "Stop a task and its executor.", params: z.object({ id, expect_rev }), handler: (ctx, p) => taskMutation(ctx, p.id, p.expect_rev, () => summarizeTask(core.tasks.stop(ctx, p.id))) }),
  "task.answer": op({
    description: "Answer an executor question and retry on the same executor. Conflicts unless awaiting input.",
    params: z.object({ id, text: z.string().min(1).max(2000), expect_rev }),
    handler: (ctx,p,deps) => core.tasks.answer(ctx,p.id,p.text,{expectRev:p.expect_rev},{delegate:(c,input)=>core.tasks.delegate(c,input,deps.spawnRunner ?? spawnRunner)}),
  }),
  "task.retry": op({
    description: "Re-delegate a task's stored brief (one active retry per task).",
    params: z.object({ id, expect_rev, executor: z.string().min(1).max(128).optional(), from_panel: z.boolean().optional() }),
    handler: async (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      const r = await core.tasks.retry(ctx, p.id, { executor: p.executor, fromPanel: p.from_panel, expectRev: p.expect_rev }, { delegate: (c, input) => core.tasks.delegate(c, input, deps.spawnRunner ?? spawnRunner) });
      return { retry: summarizeTask(r.retry), of: summarizeTask(r.of) };
    },
  }),
  "task.retry_all": op({
    description: "Retry stored briefs, reporting skipped tasks individually.",
    params: z.object({ ids: z.array(id).min(1).max(100), executor: id.optional(), from_panel: z.boolean().optional() }),
    handler: async (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      const retried: { of: ReturnType<typeof summarizeTask>; retry: ReturnType<typeof summarizeTask> }[] = [];
      const skipped: { id: string; reason: string }[] = [];
      for (const id of [...new Set<string>(p.ids)]) {
        try {
          const r = await core.tasks.retry(ctx, id, { executor: p.executor, fromPanel: p.from_panel }, {
            delegate: (c, input) => core.tasks.delegate(c, input, deps.spawnRunner ?? spawnRunner),
          });
          retried.push({ of: summarizeTask(r.of), retry: summarizeTask(r.retry) });
        } catch (error) {
          if (!(error instanceof CoreError)) throw error;
          skipped.push({ id, reason: error.code === "conflict" ? "retry already running" : error.message });
        }
      }
      return { retried, skipped };
    },
  }),
  "task.request_review": op({
    description: "Request a human decision on a completed result without accepting it.",
    params: z.object({ id, note: z.string().trim().min(1).max(2000), expect_rev }),
    handler: (ctx, p) => ({ task: apiTask(ctx, core.tasks.requestReview(ctx, p.id, p)) }),
  }),
  "task.review": op({
    description: "Record the planner's verdict on a task.",
    params: z.object({
      id, expect_rev,
      verdict: z.enum(["accept", "reject", "send_back", "retry"]), executor: z.string().optional(), kind: z.string().optional(),
      note: z.string().max(2000).optional(),
      expect_state: z.enum(["queued", "running", "done", "partial", "failed", "limit", "stopped"]).optional(),
    })
      .refine(p => p.verdict !== "send_back" || !!p.note?.trim(), "send_back requires a note")
      .refine(p => p.verdict !== "retry" || !!p.executor?.trim(), "retry requires an executor"),
    handler: (ctx, p, deps) => {
      if ((p.verdict === "send_back" || p.verdict === "retry") && isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      return taskMutation(ctx, p.id, p.expect_rev, () => core.tasks.review(ctx, p.id, p, { delegate: (c, input) => core.tasks.delegate(c, input, deps.spawnRunner ?? spawnRunner) }));
    },
  }),
  "attention.dismiss": op({ description: "Dismiss a raised attention item.", params: z.object({id:z.string().min(1).max(256)}), handler: (ctx,p) => attention.dismiss(ctx,p.id) }),
  "attention.snooze": op({ description: "Snooze a raised attention item.", params: z.object({id:z.string().min(1).max(256),for:z.enum(["1h","4h","1d"])}), handler: (ctx,p) => attention.snooze(ctx,p.id,p.for) }),
  "task.dismiss": op({ description: "Hide settled tasks; unknown ids are reported.", params: z.object({ ids: z.array(id).min(1).max(100), expect_rev }), handler: (ctx, p) => {
    const dismissed: string[] = [], unknown: string[] = [];
    // Lock in a stable order and check every revision before dismissing any task.
    const ids = [...new Set<string>(p.ids)].sort();
    const locked = (index: number): void => {
      if (index < ids.length) { withTaskLock(ctx, ids[index]!, () => locked(index + 1)); return; }
      for (const id of p.ids) { const t = readTask(ctx, id); if (t) core.tasks.checkRev(ctx, t, p.expect_rev); }
      const r = core.tasks.dismiss(ctx, p.ids);
      dismissed.push(...r.dismissed.map(t => t.id)); unknown.push(...r.unknown);
    };
    locked(0);
    return { dismissed, unknown };
  } }),
  "task.log": op({ description: "Read up to 256 KiB per output stream from byte offsets. Returns an opaque source identity; reset offsets when it changes.", params: z.object({ id, stdout: z.number().int().nonnegative().optional(), stderr: z.number().int().nonnegative().optional() }), handler: (ctx, p) => core.tasks.log(ctx, p.id, p) }),
  "task.diff": op({ description: "Tracked changes against the task's base, plus untracked filenames.", params: z.object({ id, path: z.string().min(1).max(4096).refine(path => !path.includes("\0"), "path must not contain NUL").optional() }), handler: async (ctx, p) => { const {diff:_,...result}=await core.tasks.diff(ctx,p.id,{path:p.path});return result; } }),
  "runner.list": op({ description: "Configured executors and their availability.", params: z.object({}), handler: (ctx) => core.runners.list(ctx) }),
  "runner.block": op({ description: "Block an executor for a duration, with an optional reason.", params: z.object({ id, for: z.string().optional(), reason: z.string().optional() }), handler: (ctx, p) => { core.runners.block(ctx, p.id, p); return { ok: true }; } }),
  "runner.unblock": op({ description: "Remove an executor's manual block.", params: z.object({ id }), handler: (ctx, p) => { core.runners.unblock(ctx, p.id); return { ok: true }; } }),
  "limits.check": op({ description: "Provider limits, freshness and usage sources.", params: z.object({}), handler: (ctx) => core.limits.check(ctx) }),
  "limits.report": op({ description: "Mark a provider's account exhausted until unix seconds or its cooldown.", params: z.object({ provider: id, until: z.number().optional() }), handler: (ctx, p) => core.limits.report(ctx, p.provider, p.until) }),
  "routing.status": op({ description: "Current budget and routing status.", params: z.object({}), handler: (ctx) => core.routing.status(ctx) }),
  "routing.route": op({ description: "Rank confirmed eligible executors before labelled uncertain fallbacks for an optional task kind.", params: z.object({ kind: z.enum(KINDS).optional(), goal:z.string().min(1).optional(), repo:z.string().min(1).optional() }), handler: (ctx, p) => core.routing.route(ctx, p.kind ?? null, undefined, {goal:p.goal,repo:p.repo}) }),
  "strategy.build": op({description:"Open a strategy planning session.",params:z.object({agent:agent.optional(),from:id.optional(),brief:z.string().max(2000).optional(),worktree:z.string().min(1).max(4096).optional()}),handler:(ctx,p,deps)=>strategyAction(async()=>{const result=await buildStrategy(ctx,p,{open:deps.openTerminal});await publish(ctx,[{type:"alert",data:{key:"strategy-build",level:result.opened?"info":"error",title:result.opened?"Strategy session opened":"Strategy session failed",body:result.opened?"":result.message,at:ctx.now}}]);return {opened:result.opened,target:result.target,command:result.command};})}),
  "strategy.list": op({ description: "Available strategies and the active strategy.", params: z.object({}), handler: (ctx) => { try { return strategy.list(ctx); } catch (e) { throw toCoreError(e); } } }),
  "strategy.use": op({ description: "Activate a named strategy.", params: z.object({ name: z.string().min(1) }), handler: (ctx, p) => mutation(ctx, "strategy", () => strategyAction(async () => ({name: p.name, path: await strategy.use(ctx, p.name)}))) }),
  "strategy.show": op({ description: "Show a strategy's YAML, summary and active status.", params: z.object({name: id}), handler: (ctx, p) => strategyAction(() => strategy.show(ctx, p.name)) }),
  "strategy.preview": op({ description: "Validate a strategy draft without writing and compare its ranking and routing.", params: z.object({draft}), handler: (ctx, p) => strategyAction(() => strategy.preview(ctx, p.draft)) }),
  "strategy.save": op({ description: "Save a validated named strategy with a reason, optionally replacing an inactive strategy.", params: z.object({name: id, draft, reason: z.string().min(1), overwrite: z.boolean().optional()}), handler: (ctx, p) => mutation(ctx, "strategy", () => strategyAction(() => { const {name, path} = strategy.save(ctx, p.name, p.draft, p.reason, {overwrite: p.overwrite}); return {name, path}; })) }),
  "strategy.remove": op({ description: "Remove a named strategy; default and the active strategy are protected.", params: z.object({name: id}), handler: (ctx, p) => mutation(ctx, "strategy", () => strategyAction(() => {
    if (p.name === "default" || loadStrategy(ctx).name === p.name) throw new CoreError("not_allowed", `cannot delete ${p.name === "default" ? "the default" : "the active"} strategy`, "Switch to another strategy first; default cannot be removed.");
    strategy.remove(ctx, p.name);
    return {removed: true};
  })) }),
  "plugin.list": op({ description: "Discovered plugins with state, capabilities, grants and pid; starts nothing.", params: z.object({}), handler: ctx => plugins.list(ctx) }),
  "plugin.enable": op({ description: "Enable a plugin. An installed plugin without a matching grant returns needs_grant with its capability set until called with grant: true.", params: z.object({ id: pluginId, grant: z.boolean().optional() }), handler: (ctx, p) => mutation(ctx, "plugins", () => plugins.enable(ctx, p.id, p.grant ?? false)) }),
  "plugin.disable": op({ description: "Stop a plugin and record it as disabled.", params: z.object({ id: pluginId }), handler: (ctx, p) => mutation(ctx, "plugins", () => plugins.disable(ctx, p.id)) }),
  "plugin.remove": op({ description: "Disable an installed plugin, delete its folder and forget its grant. Bundled plugins return not_allowed.", params: z.object({ id: pluginId }), handler: (ctx, p) => mutation(ctx, "plugins", () => plugins.remove(ctx, p.id)) }),
  "plugin.doctor": op({ description: "Start enabled plugins if idle and ping each with a 5 s deadline; report protocol versions, served extension points, restarts and errors.", params: z.object({ id: pluginId.optional() }), handler: (ctx, p) => plugins.doctor(ctx, p.id) }),

  "update.check": op({ description: "Check the release version, optionally bypassing the cached update check. `plugin` is always null since the Orca plugin was removed.", params: z.object({force: z.boolean().optional()}), handler: (ctx, p) => mutation(ctx, "update", async () => {
    const check = await checkForUpdate(ctx, {force: p.force});
    return {current: currentVersion(), latest: check?.latest ?? null, available: updateAvailable(check), plugin: null, ...(check?.error ? {error: check.error} : {}), ...(!check ? {disabled: true} : {})};
  }) }),
  "update.apply": op({ description: "Apply pacer update as a shared job; package-manager and source installs are refused.", params: z.object({}), handler: (ctx, _p, deps) => applyUpdate(ctx, deps) }),
};

export const opNames = (): string[] => Object.keys(OPS).sort();

export function opJsonSchemas(): Record<string, { description: string; params: unknown }> {
  return Object.fromEntries(opNames().map((name) => {
    const def = OPS[name];
    return [name, { description: def.description, params: z.toJSONSchema(def.params) }];
  }));
}

export async function callOp(ctx: Ctx, name: string, params: unknown, deps: OpDeps = {}): Promise<unknown> {
  if (!Object.hasOwn(OPS, name)) throw new CoreError("unknown_op", `unknown operation "${name}"`, `operations: ${opNames().join(", ")}`);
  if(name==="task.review"&&params&&typeof params==="object"&&Object.hasOwn(params,"accepted"))throw new CoreError("invalid_input","task.review requires verdict; accepted was removed in protocol 3");
  const def = OPS[name];
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  return await def.handler(ctx, parsed.data, deps);
}
