import { z } from "zod";
import { spawn } from "node:child_process";
import * as core from "../core";
import * as accounts from "../core/accounts";
import * as runnersConfig from "../core/runners-config";
import * as routingConfig from "../core/routing-config";
import { AGENTS } from "../config/accounts";
import * as config from "../core/config";
import * as setup from "../core/setup";
import * as notify from "../core/notify";
import { publishConfigChange } from "../core/events";
import { KINDS, loadStrategy } from "../config/strategy";
import { CoreError, toCoreError } from "../core/errors";
import { isExecutorSession } from "../install/role";
import * as strategy from "../strategy/service";
import { pacerArgv } from "../install/self";
import { publish } from "../link/publish";
import { checkForUpdate, installedPlugin, updateAvailable } from "../update/check";
import { defaultUpdateDeps, runUpdate, type UpdateDeps } from "../update/update";
import { currentVersion } from "../update/version";
import { EXECUTOR_DELEGATE_ERROR, type SpawnRunner, delegateSchema, parseDelegateBrief, spawnRunner, summarizeTask } from "../tasks/api";
import type { Ctx } from "../types";

type UpdateSpawnOptions = { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv };
export interface OpDeps {
  spawnRunner?: SpawnRunner;
  spawnUpdate?: (argv: string[], options: UpdateSpawnOptions) => void | Promise<void>;
  update?: Partial<Pick<UpdateDeps, "standalone" | "execPath">>;
}
export interface OpDef<P extends z.ZodTypeAny = z.ZodTypeAny> { description: string; params: P; handler: (ctx: Ctx, p: z.infer<P>, deps: OpDeps) => unknown }

const id = z.string().min(1).max(128);
const op = <P extends z.ZodTypeAny>(d: OpDef<P>) => d as unknown as OpDef;

const agent = z.enum(["claude-code", "codex", "cursor", "opencode"]);
const level = z.enum(["off", "important", "all"]);
const draft = z.object({from: id, set: z.record(z.string(), z.json()).optional(), unset: z.array(z.string()).optional(), description: z.string().optional()});
async function strategyAction<T>(action: () => T | Promise<T>): Promise<T> {
  try { return await action(); } catch (e) {
    const error = toCoreError(e);
    throw new CoreError(error.code, error.message, error.hint ?? "Use strategy.list to choose a strategy and strategy.preview to validate a draft.");
  }
}
function spawnUpdate(argv: string[], options: UpdateSpawnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), options);
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
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
  const argv = [...(update.standalone ? [update.execPath] : pacerArgv(ctx.env)), "update"];
  try { await (deps.spawnUpdate ?? spawnUpdate)(argv, {detached: true, stdio: "ignore", env: ctx.env}); }
  catch (e) { throw new CoreError("invalid_input", e instanceof Error ? e.message : String(e), "Check that the pacer binary exists and is executable, then retry."); }
  await publish(ctx, [{v: 1, type: "alert", data: {key: "update", level: "info", title: "Updating pacer…", body: "", at: ctx.now}}], {channel: false});
  return {started: true};
}
async function mutation<T>(ctx: Ctx, area: string, action: () => T | Promise<T>): Promise<T> {
  const result = await action();
  await publishConfigChange(ctx, area);
  return result;
}

export const OPS: Record<string, OpDef> = {
  "account.list": op({ description: "Accounts, usage and sign-in commands without account emails.", params: z.object({}), handler: ctx => accounts.list(ctx) }),
  "account.add": op({ description: "Create a Claude or Codex account home without launching sign-in.", params: z.object({kind: z.enum(["claude", "codex"]), name: id, home: z.string().min(1).optional()}), handler: (ctx, p) => mutation(ctx, "accounts", async () => { await accounts.add(ctx, p); return {account: (await accounts.list(ctx)).find(a => a.name === p.name)!}; }) }),
  "account.remove": op({ description: "Remove an unused account, optionally deleting its protected-path-checked home.", params: z.object({name: id, delete_home: z.boolean().optional()}), handler: (ctx, p) => mutation(ctx, "accounts", () => { accounts.remove(ctx, p.name, {deleteHome: p.delete_home}); return {removed: true}; }) }),
  "runner.add": op({ description: "Add an agent/account runner to the default routing rule.", params: z.object({agent: z.enum(AGENTS), account: id.optional(), host: id.optional(), model: z.string().min(1).optional()}), handler: (ctx, p) => mutation(ctx, "runners", () => ({id: runnersConfig.add(ctx, p).id})) }),
  "runner.remove": op({ description: "Remove a runner and its routing and pacing order references.", params: z.object({id}), handler: (ctx, p) => mutation(ctx, "runners", () => { runnersConfig.remove(ctx, p.id); return {removed: true}; }) }),
  "routing.get": op({ description: "Routing rules and available executor ids.", params: z.object({}), handler: ctx => routingConfig.get(ctx) }),
  "routing.set": op({ description: "Validate and replace routing rules, keeping the default last and preserving comments.", params: z.object({rules: z.array(z.object({kinds: z.array(z.string()).optional(), executors: z.array(id)}))}), handler: (ctx, p) => mutation(ctx, "routing", () => routingConfig.set(ctx, p.rules)) }),
  "host.add": op({ description: "Add an SSH host alias without connecting to it.", params: z.object({alias: id, ssh: z.string().min(1)}), handler: (ctx, p) => mutation(ctx, "hosts", () => core.hosts.add(ctx, p)) }),
  "host.remove": op({ description: "Remove an SSH host unless a runner uses it; local is reserved.", params: z.object({alias: id}), handler: (ctx, p) => mutation(ctx, "hosts", () => core.hosts.remove(ctx, p.alias)) }),
  "config.get": op({ description: "Allow-listed settings with their sources and compatible planner candidates.", params: z.object({}), handler: ctx => config.get(ctx) }),
  "config.set": op({ description: "Change a setting with validation, rollback and an undo command; planner requires an integration choice.", params: z.object({ key: z.enum(config.CONFIG_KEYS), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]), integrations: z.enum(["install", "skip"]).optional() }), handler: (ctx, p) => mutation(ctx, "config", async () => { const {notes, ...result} = await config.set(ctx, p.key, p.value, p); return result; }) }),
  "notifications.get": op({ description: "Current Orca plugin notification level.", params: z.object({}), handler: ctx => notify.getLevel(ctx) }),
  "notifications.set": op({ description: "Set Orca plugin notifications to off, important or all.", params: z.object({level}), handler: (ctx, p) => mutation(ctx, "config", () => notify.setLevel(ctx, p.level)) }),
  "setup.check": op({ description: "Read the setup checklist and outstanding steps.", params: z.object({}), handler: ctx => setup.check(ctx) }),
  "setup.init": op({ description: "Create a missing strategy and select a planner without connecting agents.", params: z.object({planner: id}), handler: (ctx, p) => mutation(ctx, "setup", () => setup.init(ctx, p.planner)) }),
  "service.status": op({ description: "Whether the login service is installed and running, with its process id when known.", params: z.object({}), handler: ctx => setup.serviceStatus(ctx) }),
  "plugin.install": op({ description: "Install the Orca plugin under PACER_HOME without editing Orca settings.", params: z.object({}), handler: ctx => mutation(ctx, "setup", () => setup.pluginInstall(ctx)) }),
  "agent.preview": op({ description: "Preview agent integration files and the undo command before consenting.", params: z.object({agent}), handler: (ctx, p) => setup.agentPreview(ctx, p.agent) }),
  "agent.connect": op({ description: "Connect an agent after explicit consent to write its integration files.", params: z.object({agent, consent: z.boolean().optional()}), handler: (ctx, p) => mutation(ctx, "setup", () => setup.agentConnect(ctx, p.agent, p)) }),
  "agent.disconnect": op({ description: "Remove an agent integration using its recorded undo actions.", params: z.object({agent}), handler: (ctx, p) => mutation(ctx, "setup", () => setup.agentDisconnect(ctx, p.agent)) }),
  "version.get": op({ description: "Pacer, protocol, installed plugin and service versions or status.", params: z.object({}), handler: ctx => setup.version(ctx) }),
  "host.list": op({ description: "Configured SSH hosts and running task counts.", params: z.object({}), handler: ctx => core.hosts.list(ctx) }),
  "host.check": op({ description: "Check SSH host prerequisites, checkouts and identity.", params: z.object({ alias: id, repo: z.string().min(1).optional() }), handler: (ctx, p) => core.hosts.check(ctx, p.alias, { repo: p.repo }) }),
  "task.get": op({ description: "One task's state and result.", params: z.object({ id }), handler: (ctx, p) => summarizeTask(core.tasks.get(ctx, p.id)) }),
  "task.list": op({ description: "Recent tasks, newest first.", params: z.object({ limit: z.number().int().min(1).max(200).optional() }), handler: (ctx, p) => core.tasks.list(ctx, { limit: p.limit }).map(summarizeTask) }),
  "task.delegate": op({
    description: "Hand a brief to an executor chosen by budget and priority (or `executor`).",
    params: z.object({ ...delegateSchema, repo: z.string().min(1) }),
    handler: (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      return summarizeTask(core.tasks.delegate(ctx, parseDelegateBrief(p, p.repo), deps.spawnRunner ?? spawnRunner));
    },
  }),
  "task.wait": op({ description: "Block until the task settles or timeout_s passes.", params: z.object({ id, timeout_s: z.number().int().min(1).max(3000).optional() }), handler: async (ctx, p) => summarizeTask(await core.tasks.wait(ctx, p.id, p.timeout_s ?? 600)) }),
  "task.stop": op({ description: "Stop a task and its executor.", params: z.object({ id }), handler: (ctx, p) => summarizeTask(core.tasks.stop(ctx, p.id)) }),
  "task.retry": op({
    description: "Re-delegate a task's stored brief (one active retry per task).",
    params: z.object({ id, executor: z.string().min(1).max(128).optional(), from_panel: z.boolean().optional() }),
    handler: async (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      const r = await core.tasks.retry(ctx, p.id, { executor: p.executor, fromPanel: p.from_panel }, { delegate: (c, input) => core.tasks.delegate(c, input, deps.spawnRunner ?? spawnRunner) });
      return { retry: summarizeTask(r.retry), of: summarizeTask(r.of) };
    },
  }),
  "task.review": op({ description: "Record the planner's verdict on a task.", params: z.object({ id, accepted: z.boolean(), kind: z.string().optional(), note: z.string().max(2000).optional() }), handler: (ctx, p) => core.tasks.review(ctx, p.id, { accepted: p.accepted, kind: p.kind, note: p.note }) }),
  "task.dismiss": op({ description: "Hide settled tasks; unknown ids are reported.", params: z.object({ ids: z.array(id).min(1).max(100) }), handler: (ctx, p) => { const r = core.tasks.dismiss(ctx, p.ids); return { dismissed: r.dismissed.map((t) => t.id), unknown: r.unknown }; } }),
  "task.log": op({ description: "Read up to 256 KiB per output stream from byte offsets.", params: z.object({ id, stdout: z.number().int().nonnegative().optional(), stderr: z.number().int().nonnegative().optional() }), handler: (ctx, p) => core.tasks.log(ctx, p.id, p) }),
  "task.diff": op({ description: "Tracked changes against the task's base, plus untracked filenames.", params: z.object({ id }), handler: (ctx, p) => core.tasks.diff(ctx, p.id) }),
  "runner.list": op({ description: "Configured executors and their availability.", params: z.object({}), handler: (ctx) => core.runners.list(ctx) }),
  "runner.block": op({ description: "Block an executor for a duration, with an optional reason.", params: z.object({ id, for: z.string().optional(), reason: z.string().optional() }), handler: (ctx, p) => { core.runners.block(ctx, p.id, p); return { ok: true }; } }),
  "runner.unblock": op({ description: "Remove an executor's manual block.", params: z.object({ id }), handler: (ctx, p) => { core.runners.unblock(ctx, p.id); return { ok: true }; } }),
  "limits.check": op({ description: "Provider limits, freshness and usage sources.", params: z.object({}), handler: (ctx) => core.limits.check(ctx) }),
  "limits.report": op({ description: "Mark a provider's account exhausted until unix seconds or its cooldown.", params: z.object({ provider: id, until: z.number().optional() }), handler: (ctx, p) => core.limits.report(ctx, p.provider, p.until) }),
  "routing.status": op({ description: "Current budget and routing status.", params: z.object({}), handler: (ctx) => core.routing.status(ctx) }),
  "routing.route": op({ description: "Rank executors for an optional task kind.", params: z.object({ kind: z.enum(KINDS).optional() }), handler: (ctx, p) => core.routing.route(ctx, p.kind ?? null) }),
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
  "update.check": op({ description: "Check release and installed plugin versions, optionally bypassing the cached update check.", params: z.object({force: z.boolean().optional()}), handler: (ctx, p) => mutation(ctx, "update", async () => {
    const check = await checkForUpdate(ctx, {force: p.force});
    return {current: currentVersion(), latest: check?.latest ?? null, available: updateAvailable(check), plugin: installedPlugin(ctx), ...(check?.error ? {error: check.error} : {}), ...(!check ? {disabled: true} : {})};
  }) }),
  "update.apply": op({ description: "Start pacer update in a detached child; package-manager and source installs are refused.", params: z.object({}), handler: (ctx, _p, deps) => applyUpdate(ctx, deps) }),
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
  const def = OPS[name];
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  return await def.handler(ctx, parsed.data, deps);
}
