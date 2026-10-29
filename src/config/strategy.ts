import { parseDispatchConfig } from "./dispatch";
import type { DispatchConfig } from "../dispatch/types";
import { validateTerminalOpen } from "../session/targets";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, UsageKind } from "../types";
import { isObj } from "../util";
import { LOCAL_LOAD_LIMIT_ERROR, LOCAL_MAX_TASKS_ERROR, LOCAL_MEMORY_PRESSURE_LIMIT_ERROR, MEMORY_PRESSURE_LIMITS, localLoadLimitProblem, localMaxTasksProblem } from "./execution";
import { parseRunnerId, runnerDefaults, resolveRunner } from "./runner-id";
import { parseHosts, type HostCfg } from "./hosts";
import { validateRemoteRunner, allowedPair, legacyToAccounts, parseAccounts, parseSize, parseDuration, type AccountCfg, type RunnerCfg, type PlannerCfg } from "./accounts";

export { parseSize, parseDuration } from "./accounts";

export const KINDS = [
  "boilerplate", "tests", "docs", "rename", "migration", "feature",
  "debug", "refactor", "performance", "unfamiliar-code", "research",
] as const;
export const NATIVE = ["claude-code", "codex", "cursor", "agy"] as const;
export const PLANNERS = ["claude-code", "codex", "cursor", "opencode"] as const;
export const POLICIES = ["priority", "even", "burn-before-reset", "cheapest-first"] as const;
export type Policy = (typeof POLICIES)[number];

const USAGES: UsageKind[] = ["quota", "metered", "reactive", "unmetered"];
const NATIVE_USAGE: Record<string, UsageKind> = { "claude-code": "quota", codex: "quota", cursor: "reactive", agy: "reactive" };
const DEFAULT_ORDER = ["codex", "cursor", "agy", "opencode"];

export interface ProviderCfg {
  session?: "headless" | "interactive";
  id: string;
  via: "opencode" | null;
  model: string | null;
  usage: UsageKind;
  allowPaid: boolean;
  cooldownS: number;
  quotaSource: "arkcli" | null;
  weeklyTokens: number | null;
  weeklyUsd: number | null;
}
export interface RouteRule { kinds: string[] | null; executors: string[] }

export interface PluginGrant { version: string; capabilities: string[]; /** UI surface kinds the user granted; absent in grants recorded before plugin protocol 1.2, which cover none. */ surfaces?: string[] }
export interface PluginsCfg { policy: { mode: "open" | "closed" }; disabled: string[]; installed: Record<string, PluginGrant>; config: Record<string, Record<string, unknown>> }
export const EMPTY_PLUGINS: PluginsCfg = { policy: { mode: "open" }, disabled: [], installed: {}, config: {} };

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function parsePlugins(raw: unknown, p: string[]): PluginsCfg {
  if (raw === undefined) return { policy: { mode: "open" }, disabled: [], installed: {}, config: {} };
  if (!isObj(raw)) { p.push("plugins must be a mapping"); return { policy: { mode: "open" }, disabled: [], installed: {}, config: {} }; }
  let mode: "open" | "closed" = "open";
  if (raw.policy !== undefined) {
    if (!isObj(raw.policy)) p.push("plugins.policy must be a mapping");
    else if (raw.policy.mode !== undefined && raw.policy.mode !== "open" && raw.policy.mode !== "closed") p.push("plugins.policy.mode must be open or closed");
    else mode = raw.policy.mode ?? "open";
  }
  const disabled: string[] = [];
  if (raw.disabled !== undefined) {
    if (!Array.isArray(raw.disabled)) p.push("plugins.disabled must be a list of plugin ids");
    else for (const id of raw.disabled) { if (typeof id !== "string" || !PLUGIN_ID.test(id)) p.push(`plugins.disabled: invalid plugin id "${String(id)}"`); else disabled.push(id); }
  }
  const installed: Record<string, PluginGrant> = {};
  if (raw.installed !== undefined) {
    if (!isObj(raw.installed)) p.push("plugins.installed must be a mapping of plugin id to grant");
    else for (const [id, g] of Object.entries(raw.installed)) {
      if (!PLUGIN_ID.test(id)) { p.push(`plugins.installed: invalid plugin id "${id}"`); continue; }
      if (!isObj(g)) { p.push(`plugins.installed.${id} must be a mapping`); continue; }
      if (typeof g.version !== "string" || !SEMVER.test(g.version)) p.push(`plugins.installed.${id}.version must be semver`);
      if (!Array.isArray(g.capabilities) || g.capabilities.some(c => typeof c !== "string")) p.push(`plugins.installed.${id}.capabilities must be a list of names`);
      else if (g.surfaces !== undefined && (!Array.isArray(g.surfaces) || g.surfaces.some(c => typeof c !== "string"))) p.push(`plugins.installed.${id}.surfaces must be a list of names`);
      else installed[id] = { version: String(g.version), capabilities: g.capabilities.map(String), ...(g.surfaces ? { surfaces: g.surfaces.map(String) } : {}) };
    }
  }
  const config: Record<string, Record<string, unknown>> = {};
  if (raw.config !== undefined) {
    if (!isObj(raw.config)) p.push("plugins.config must be a mapping of plugin id to settings");
    else for (const [id, c] of Object.entries(raw.config)) { if (!isObj(c)) p.push(`plugins.config.${id} must be a mapping`); else config[id] = c; }
  }
  return { policy: { mode }, disabled, installed, config };
}

export interface Strategy {
  dispatch?: DispatchConfig;
  name: string;
  planner: PlannerCfg;
  accounts: Record<string, AccountCfg>;
  hosts: Record<string, HostCfg>;
  runners: Record<string, RunnerCfg>;
  legacy: boolean;
  runnerAliases: Record<string, string>;
  /** @deprecated Derived from runners and accounts; use those directly in new consumers. */
  providers: Record<string, ProviderCfg>;
  pacing: { policy: Policy; order: string[]; plannerReserve: number; plannerReserveHeadroom: number; plannerProbe: "ask" | "auto" | "off"; aheadThreshold: number; behindThreshold: number; accounts: "spread" | "fill"; fillThreshold: number };
  routing: RouteRule[];
  execution: Record<string, unknown>;
  classifier: Record<string, unknown>;
  terminal?: {open:string};
  taskRetentionDays?: number;
  plugins?: PluginsCfg;
}

export class StrategyError extends Error {
  constructor(readonly path: string, readonly problems: string[]) {
    super(`invalid strategy ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "StrategyError";
  }
}
export class MissingStrategyError extends Error {
  constructor(readonly path: string) {
    super(`no strategy found at ${path}`);
    this.name = "MissingStrategyError";
  }
}

export function validateStrategy(raw: unknown, path: string, name = "default"): Strategy {
  const p: string[] = [];
  if (!isObj(raw)) throw new StrategyError(path, ["top level must be a mapping"]);

  const hosts = parseHosts(raw.hosts, p);
  const legacy = Object.hasOwn(raw, "providers");
  if (legacy && (raw.accounts !== undefined || raw.runners !== undefined)) p.push("providers cannot be combined with accounts or runners");
  const providers: Record<string, ProviderCfg> = {};
  if (legacy) {
    const planner = String(raw.planner ?? "");
    if (!(PLANNERS as readonly string[]).includes(planner)) {
      p.push(`planner must be one of ${PLANNERS.join(", ")} (got "${planner}")`);
    }

    if (!isObj(raw.providers) || (Object.keys(raw.providers).length === 0 && planner !== "opencode")) {
      p.push("providers must be a non-empty mapping");
    } else {
      for (const [id, v] of Object.entries(raw.providers)) {
        const c = isObj(v) ? v : {};
        const native = (NATIVE as readonly string[]).includes(id);
        const via = c.via === undefined ? null : c.via;
        if (native && via !== null) p.push(`providers.${id}: native providers cannot set "via"`);
        if (!native && via !== "opencode") p.push(`providers.${id}: non-native providers need via: opencode`);
        const model = c.model === undefined ? null : String(c.model);
        if (via === "opencode" && (!model || !model.includes("/"))) {
          p.push(`providers.${id}: model must look like "<provider>/<model>"`);
        }
        const usage = (c.usage ?? (native ? NATIVE_USAGE[id] : "metered")) as UsageKind;
        if (!USAGES.includes(usage)) p.push(`providers.${id}: usage must be one of ${USAGES.join(", ")}`);
        if ((id === "cursor" || id === "agy") && usage === "quota") {
          p.push(`providers.${id}: quota usage is not available for ${id}; use reactive`);
        }
        const quotaSource = c.quota_source === undefined ? null : c.quota_source;
        if (!native && usage === "quota" && quotaSource !== "arkcli") {
          p.push(`providers.${id}: quota usage via opencode needs quota_source: arkcli`);
        }
        const weeklyTokens = isObj(c.budget) ? parseSize(c.budget.weekly_tokens) : null;
        if (usage === "metered" && weeklyTokens === null) {
          p.push(`providers.${id}: metered usage needs budget.weekly_tokens (e.g. 20M)`);
        }
        const cooldownS = c.cooldown === undefined ? 6 * 3600 : parseDuration(c.cooldown);
        if (cooldownS === null) p.push(`providers.${id}: cooldown must look like 30m, 6h or 2d`);
      }
    }
  }
  const { accounts, runners, planner, runnerAliases } = legacy ? legacyToAccounts(raw) : parseAccounts(raw, p, hosts);
  // Keep the provider facade stable while consumers move to accounts and runners.
  for (const [id, runner] of Object.entries(runners)) {
    const account = accounts[runner.account];
    if (!account) continue;
    providers[id] = {
      ...(runner.session ? {session: runner.session} : {}),
      id, via: runner.agent === "opencode" ? "opencode" : null, model: runner.model,
      usage: account.usage, allowPaid: account.allowPaid, cooldownS: account.cooldownS,
      quotaSource: account.quotaSource === "arkcli" ? "arkcli" : null, weeklyTokens: account.weeklyTokens, weeklyUsd: account.weeklyUsd,
    };
  }

  const resolve = (id: string) => resolveRunner({ accounts, runners, runnerAliases } as Strategy, id)?.id ?? id;

  const pc = isObj(raw.pacing) ? raw.pacing : {};
  const policy = String(pc.policy ?? "priority") as Policy;
  if (!(POLICIES as readonly string[]).includes(policy)) {
    p.push(`pacing.policy must be one of ${POLICIES.join(", ")} (got "${policy}")`);
  }
  let order: string[] = [];
  if (pc.order === undefined) {
    const hasOpencode = Object.values(providers).some((cfg) => cfg.via === "opencode");
    order = legacy ? DEFAULT_ORDER.filter((id) => Object.hasOwn(runners, id) || (id === "opencode" && hasOpencode)) : Object.keys(runners);
  } else if (!Array.isArray(pc.order)) {
    p.push("pacing.order must be a list");
  } else {
    order = pc.order.map(v => resolve(String(v)));
    for (const id of order) {
      const parsed = parseRunnerId(id);
      const account = parsed ? accounts[parsed.account ?? runnerDefaults(accounts)[parsed.agent] ?? ""] : undefined;
      if (parsed && account && !allowedPair(parsed.agent, account.kind)) p.push(`pacing.order: ${parsed.agent} cannot use ${account.kind} account "${account.name}"`);
      if (parsed) validateRemoteRunner(id, parsed, parsed.account ?? runnerDefaults(accounts)[parsed.agent], runnerDefaults(accounts), hosts, p);
      if (id !== "opencode" && !Object.hasOwn(providers, id) && !account) {
        p.push(`pacing.order: unknown provider "${id}"`);
      }
    }
  }
  const num = (k: string, d: number): number => {
    const v = pc[k] ?? d;
    if (typeof v !== "number") {
      p.push(`pacing.${k} must be a number`);
      return d;
    }
    return v;
  };
  const plannerProbeRaw = pc.planner_probe ?? "ask";
  const plannerProbe = ["ask", "auto", "off"].includes(String(plannerProbeRaw))
    ? plannerProbeRaw as "ask" | "auto" | "off"
    : "ask";
  const pacing = {
    policy,
    order,
    plannerReserve: num("planner_reserve", 15),
    plannerReserveHeadroom: num("planner_reserve_headroom", 25),
    plannerProbe,
    aheadThreshold: num("ahead_threshold", 10),
    behindThreshold: num("behind_threshold", -10),
    accounts: (pc.accounts ?? "spread") as "spread" | "fill",
    fillThreshold: num("fill_threshold", 90),
  };
  if (!["spread", "fill"].includes(pacing.accounts)) p.push("pacing.accounts must be spread or fill");
  if (!Number.isFinite(pacing.fillThreshold) || pacing.fillThreshold < 50 || pacing.fillThreshold > 100) p.push("pacing.fill_threshold must be between 50 and 100");
  if (pacing.plannerReserve < 0 || pacing.plannerReserve >= 100) {
    p.push("pacing.planner_reserve must be between 0 and 99");
  }
  if (pacing.plannerReserveHeadroom < 0 || pacing.plannerReserveHeadroom >= 100) {
    p.push("pacing.planner_reserve_headroom must be between 0 and 99");
  }
  if (!["ask", "auto", "off"].includes(String(plannerProbeRaw))) {
    p.push("pacing.planner_probe must be ask, auto or off");
  }

  const routing: RouteRule[] = [];
  const rawRouting = raw.routing ?? [{ default: Object.keys(providers) }];
  if (!Array.isArray(rawRouting)) {
    p.push("routing must be a list");
  } else {
    rawRouting.forEach((r, i) => {
      if (!isObj(r)) {
        p.push(`routing[${i}] must be a mapping`);
        return;
      }
      const isDefault = Array.isArray(r.default);
      const executors = isDefault ? r.default : r.executors;
      if (!Array.isArray(executors) || executors.length === 0) {
        p.push(`routing[${i}] needs a non-empty executors (or default) list`);
        return;
      }
      for (const e of executors) if (!providers[resolve(String(e))]) p.push(`routing[${i}]: unknown provider "${e}"`);
      let kinds: string[] | null = null;
      if (!isDefault) {
        if (!Array.isArray(r.kinds) || r.kinds.length === 0) {
          p.push(`routing[${i}] needs kinds (or use default:)`);
          return;
        }
        kinds = r.kinds.map(String);
        for (const k of kinds) {
          if (!(KINDS as readonly string[]).includes(k)) {
            p.push(`routing[${i}]: unknown kind "${k}" (allowed: ${KINDS.join(", ")})`);
          }
        }
      }
      routing.push({ kinds, executors: executors.map(e => resolve(String(e))) });
    });
  }

  const exec = isObj(raw.execution) ? raw.execution : {};
  if (localMaxTasksProblem(exec.local_max_tasks)) p.push(LOCAL_MAX_TASKS_ERROR);
  if (exec.local_memory_pressure_limit != null && !(MEMORY_PRESSURE_LIMITS as readonly unknown[]).includes(exec.local_memory_pressure_limit)) p.push(LOCAL_MEMORY_PRESSURE_LIMIT_ERROR);
  if (localLoadLimitProblem(exec.local_load_limit)) p.push(LOCAL_LOAD_LIMIT_ERROR);
  const launchMode = isObj(raw.execution) ? raw.execution.launch_mode : undefined;
  if (launchMode !== undefined && launchMode !== "interactive" && launchMode !== "headless") p.push("execution.launch_mode must be interactive or headless");
  const taskRetentionDays = raw.task_retention_days ?? 14;
  if (typeof taskRetentionDays !== "number" || !Number.isSafeInteger(taskRetentionDays) || taskRetentionDays < 0) p.push("task_retention_days must be a non-negative integer");
  const plugins = parsePlugins(raw.plugins, p);
  let dispatch: DispatchConfig | undefined;
  try { dispatch = parseDispatchConfig(raw.dispatch); } catch (e) { p.push(e instanceof Error ? e.message : "invalid dispatch configuration"); }
  if (p.length) throw new StrategyError(path, p);
  return {
    name, planner, accounts, hosts, runners, legacy, runnerAliases, providers, pacing, routing, taskRetentionDays: taskRetentionDays as number,
    plugins, ...(dispatch ? {dispatch} : {}),
    execution: isObj(raw.execution) ? raw.execution : {},
    classifier: isObj(raw.classifier) ? raw.classifier : {},
    ...(isObj(raw.terminal) && raw.terminal.open !== undefined ? {terminal:{open:validateTerminalOpen(String(raw.terminal.open))}} : {}),
  };
}

function activeName(ctx: Ctx): string | null {
  const f = join(ctx.pacerHome, "active");
  return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
}

export function strategyPath(ctx: Ctx): string {
  const name = activeName(ctx);
  return name ? join(ctx.pacerHome, "strategies", `${name}.yaml`) : join(ctx.pacerHome, "strategy.yaml");
}

function parseFile(path: string, name: string): Strategy {
  if (!existsSync(path)) throw new MissingStrategyError(path);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StrategyError(path, [`YAML syntax error: ${(e as Error).message}`]);
  }
  return validateStrategy(raw, path, name);
}

export function loadStrategy(ctx: Ctx): Strategy {
  return parseFile(strategyPath(ctx), activeName(ctx) ?? "default");
}

/** Switch the active strategy. "default" returns to ~/.pacer/strategy.yaml. Returns the active file path. */
export function useStrategy(ctx: Ctx, name: string): string {
  const active = join(ctx.pacerHome, "active");
  if (name === "default") {
    rmSync(active, { force: true });
    return join(ctx.pacerHome, "strategy.yaml");
  }
  const path = join(ctx.pacerHome, "strategies", `${name}.yaml`);
  parseFile(path, name); // validate before switching
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(active, `${name}\n`);
  return path;
}
