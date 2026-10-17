import { formatRunnerId, parseRunnerId, runnerDefaults } from "./runner-id";
import type { HostCfg } from "./hosts";
import type { UsageKind } from "../types";
import { isObj } from "../util";

export function parseSize(v: unknown): number | null {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const mult = { "": 1, k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Number(m[1]) * mult;
}

export function parseDuration(v: unknown): number | null {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(String(v ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

export const AGENTS = ["claude-code", "codex", "cursor", "agy", "opencode"] as const;
export type AgentId = (typeof AGENTS)[number];
export type AccountKind = "claude" | "codex" | "cursor" | "agy" | "endpoint";
export type KeySource = "keychain" | "file" | `env:${string}` | "none";
export interface EndpointModel { id: string; name?: string; context: number; output: number; tools: boolean }
export interface EndpointConnection {
  api: "openai-compatible";
  base_url: string;
  key: KeySource;
  models: EndpointModel[];
}
export interface AccountCfg {
  connection?: EndpointConnection;
  name: string;
  model: string | null;
  kind: AccountKind;
  source: "default" | "pacer" | "orca" | "endpoint";
  home: string | null;
  orcaAccount: string | null;
  usage: UsageKind;
  usageSource: "native" | "orca" | "arkcli" | "metered" | "reactive" | "unmetered";
  quotaSource: string | null;
  weeklyTokens: number | null;
  cooldownS: number;
  allowPaid: boolean;
}
export interface RunnerCfg { enabled?: boolean; maxTasks?: number; test?: boolean; id: string; host: string | null; name: string; agent: AgentId; account: string; model: string | null }
export interface PlannerCfg { agent: AgentId; account: string }
export interface AccountsModel {
  accounts: Record<string, AccountCfg>;
  runners: Record<string, RunnerCfg>;
  planner: PlannerCfg;
  runnerAliases: Record<string, string>;
}
const ACCOUNT_KIND: Record<AgentId, AccountKind> = {
  "claude-code": "claude", codex: "codex", cursor: "cursor", agy: "agy", opencode: "endpoint",
};
export function allowedPair(agent: AgentId, kind: AccountKind): boolean {
  return Object.hasOwn(ACCOUNT_KIND, agent) && ACCOUNT_KIND[agent] === kind;
}

function parseConnection(value: unknown, at: string, problems: string[]): EndpointConnection | undefined {
  const start = problems.length;
  if (!isObj(value)) { problems.push(`${at}.connection must be a mapping`); return; }
  if (value.api !== "openai-compatible") problems.push(`${at}.connection.api must be openai-compatible`);
  try {
    const url = new URL(typeof value.base_url === "string" ? value.base_url : "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw Error();
  } catch { problems.push(`${at}.connection.base_url must be an http(s) URL without credentials`); }
  if (typeof value.key !== "string" || !/^(keychain|file|none|env:[A-Za-z_][A-Za-z0-9_]*)$/.test(value.key)) problems.push(`${at}.connection.key must be keychain, file, env:VAR or none`);
  if (!Array.isArray(value.models) || !value.models.length) problems.push(`${at}.connection.models must be a non-empty list`);
  const models: EndpointModel[] = [];
  const ids = new Set<string>();
  for (const [i, model] of (Array.isArray(value.models) ? value.models : []).entries()) {
    const where = `${at}.connection.models.${i}`;
    if (!isObj(model)) { problems.push(`${where} must be a mapping`); continue; }
    if (typeof model.id !== "string" || !model.id.trim()) problems.push(`${where}.id must be non-empty`);
    else if (ids.has(model.id)) problems.push(`${where}.id must be unique`);
    else ids.add(model.id);
    if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim())) problems.push(`${where}.name must be non-empty`);
    for (const limit of ["context", "output"]) {
      if (typeof model[limit] !== "number" || !Number.isSafeInteger(model[limit]) || model[limit] <= 0) problems.push(`${where}.${limit} must be a positive integer`);
    }
    if (typeof model.tools !== "boolean") problems.push(`${where}.tools must be a boolean`);
    models.push({id: model.id as string, ...(model.name !== undefined ? {name: model.name as string} : {}), context: model.context as number, output: model.output as number, tools: model.tools as boolean});
  }
  if (problems.length !== start) return;
  return {api: "openai-compatible", base_url: value.base_url as string, key: value.key as KeySource, models};
}

function accountCfg(name: string, c: Record<string, unknown>): AccountCfg {
  const kind = c.kind as AccountKind;
  const home = typeof c.home === "string" ? c.home : null;
  const orcaAccount = typeof c.orca_account === "string" ? c.orca_account : null;
  const source = orcaAccount ? "orca" : home ? "pacer" : kind === "endpoint" ? "endpoint" : "default";
  const usage = (c.usage ?? (kind === "claude" || kind === "codex" ? "quota" : kind === "endpoint" ? "metered" : "reactive")) as UsageKind;
  const quotaSource = typeof c.quota_source === "string" ? c.quota_source : null;
  const usageSource = (c.usage_source ?? (quotaSource === "arkcli" ? "arkcli" : usage === "quota" ? "native" : usage)) as AccountCfg["usageSource"];
  return {
    name, model: c.model === undefined ? null : String(c.model), kind, source, home, orcaAccount, usage, usageSource, quotaSource,
    weeklyTokens: isObj(c.budget) ? parseSize(c.budget.weekly_tokens) : null,
    cooldownS: c.cooldown === undefined ? 6 * 3600 : parseDuration(c.cooldown) ?? 6 * 3600,
    allowPaid: c.allow_paid === true,
  };
}

/** Map the legacy provider shape without changing its accepted usage settings. */
export function legacyToAccounts(raw: unknown): AccountsModel {
  const c = isObj(raw) ? raw : {};
  const accounts: Record<string, AccountCfg> = {};
  const runners: Record<string, RunnerCfg> = {};
  const runnerAliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(isObj(c.providers) ? c.providers : {})) {
    const v = isObj(value) ? value : {};
    const agent = v.via === "opencode" ? "opencode" : name as AgentId;
    accounts[name] = accountCfg(name, { ...v, kind: ACCOUNT_KIND[agent] });
    const id = agent === "opencode" ? `opencode#${name}` : agent;
    runnerAliases[name] = id;
    runners[id] = { id, name: id, host: null, agent, account: name, model: accounts[name].model };
  }
  const agent = c.planner as AgentId;
  if (agent !== "opencode" && !accounts[agent]) accounts[agent] = accountCfg(agent, {kind: ACCOUNT_KIND[agent]});
  const planner = {agent, account: agent};
  if (accounts[agent] && !runners[agent]) runners[agent] = {id: agent, name: agent, host: null, agent, account: agent, model: accounts[agent].model};
  return { accounts, runners, planner, runnerAliases };
}

export function validateRemoteRunner(reference: string, parsed: { agent: AgentId; host: string | null }, account: string | undefined, defaults: Partial<Record<AgentId, string>>, hosts: Record<string, HostCfg>, problems: string[]): void {
  if (!parsed.host) return;
  const at = `runner ${reference}`;
  const host = Object.hasOwn(hosts, parsed.host) ? hosts[parsed.host] : undefined;
  if (!host) problems.push(`${at}: unknown host ${parsed.host} (hosts: ${Object.keys(hosts).join(", ") || "none"})`);
  if (!["codex", "claude-code"].includes(parsed.agent)) problems.push(`${at}: remote runners support codex and claude-code`);
  if (host && account && account !== defaults[parsed.agent] && !Object.hasOwn(host.accounts, account)) problems.push(`${at}: account ${account} on ${parsed.host} needs hosts.${parsed.host}.accounts.${account}.home`);
}

export function parseAccounts(raw: Record<string, unknown>, problems: string[], hosts: Record<string, HostCfg> = {}): AccountsModel {
  const accounts: Record<string, AccountCfg> = {};
  const runners: Record<string, RunnerCfg> = {};
  if (!isObj(raw.accounts) || !Object.keys(raw.accounts).length) problems.push("accounts must be a non-empty mapping");
  for (const [name, value] of Object.entries(isObj(raw.accounts) ? raw.accounts : {})) {
    const at = `accounts.${name}`;
    if (!isObj(value)) { problems.push(`${at} must be a mapping`); continue; }
    const cfg = accountCfg(name, value);
    if (value.connection !== undefined) {
      if (cfg.kind !== "endpoint") problems.push(`${at}: connection requires an endpoint account`);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) problems.push(`${at}: connection account name must contain lowercase letters, digits and hyphens`);
      cfg.connection = parseConnection(value.connection, at, problems);
    }
    if (!["claude", "codex", "cursor", "agy", "endpoint"].includes(cfg.kind)) problems.push(`${at}: unknown account kind`);
    if (value.home !== undefined && (typeof value.home !== "string" || !value.home.trim() || !["claude", "codex"].includes(cfg.kind))) {
      problems.push(`${at}: home requires a non-empty folder on a claude or codex account`);
    }
    if (value.orca_account !== undefined && (typeof value.orca_account !== "string" || !value.orca_account.trim() || !["claude", "codex"].includes(cfg.kind))) {
      problems.push(`${at}: orca_account requires a non-empty id on a claude or codex account`);
    }
    if (value.home !== undefined && value.orca_account !== undefined) problems.push(`${at}: home and orca_account are mutually exclusive`);
    if (!["quota", "metered", "reactive", "unmetered"].includes(cfg.usage)) problems.push(`${at}: unknown usage kind`);
    if (!["native", "orca", "arkcli", "metered", "reactive", "unmetered"].includes(cfg.usageSource)) problems.push(`${at}: unknown usage_source`);
    if (["cursor", "agy"].includes(cfg.kind) && cfg.usage === "quota" && cfg.usageSource !== "orca") problems.push(`${at}: quota usage is not available for ${cfg.kind}; use reactive`);
    if (cfg.kind === "endpoint" && cfg.usage === "quota" && cfg.quotaSource !== "arkcli" && cfg.usageSource !== "orca") problems.push(`${at}: quota usage needs quota_source: arkcli`);
    if (cfg.usage === "metered" && (cfg.weeklyTokens === null || !Number.isFinite(cfg.weeklyTokens) || cfg.weeklyTokens <= 0)) problems.push(`${at}: metered usage needs budget.weekly_tokens`);
    if (value.cooldown !== undefined && (parseDuration(value.cooldown) === null || !Number.isFinite(cfg.cooldownS) || cfg.cooldownS < 0)) problems.push(`${at}: cooldown must look like 30m, 6h or 2d`);
    accounts[name] = cfg;
  }
  // Native defaults are unique; endpoint budgets are always explicitly named.
  for (const kind of ["claude", "codex", "cursor", "agy"]) {
    if (Object.values(accounts).filter(a => a.kind === kind && !a.home && !a.orcaAccount).length > 1) problems.push(`accounts: more than one default ${kind} account`);
  }
  const defaults = runnerDefaults(accounts); delete defaults.opencode;
  const runnerAliases: Record<string, string> = {};
  const declarations = new Map<string, string | null>();
  const entries = isObj(raw.runners) ? raw.runners : {};
  if (raw.runners !== undefined && !isObj(raw.runners)) problems.push("runners must be a mapping");
  // Accept the explicit agent/account shape from the transitional accounts format.
  for (const [name, value] of Object.entries(entries)) {
    if (isObj(value) && value.agent && value.account) runnerAliases[name] = formatRunnerId({agent: value.agent as AgentId, account: String(value.account), host: parseRunnerId(name)?.host ?? null}, defaults);
  }
  const add = (reference: string, value: unknown = {}): RunnerCfg | null => {
    const at = `runner ${reference}`;
    const c = isObj(value) ? value : {};
    if (!isObj(value)) problems.push(`${at}: must be a mapping`);
    const declared = parseRunnerId(reference);
    const explicit = c.agent !== undefined || c.account !== undefined;
    if (declared && explicit && (declared.agent !== c.agent || (declared.account ?? defaults[declared.agent]) !== c.account)) problems.push(`${at}: declaration conflicts with runner id identity`);
    const parsed = explicit ? {agent: c.agent as AgentId, account: c.account as string, host: declared?.host ?? null} : parseRunnerId(runnerAliases[reference] ?? reference)
      ?? (accounts[reference]?.kind === "endpoint" ? {agent: "opencode" as const, account: reference, host: null} : null);
    if (!parsed || !(AGENTS as readonly string[]).includes(parsed.agent)) { problems.push(`${at}: invalid runner id or unknown agent`); return null; }
    if (parsed.agent === "opencode" && reference === "opencode" && !accounts.opencode) return null;
    const account = parsed.account ?? defaults[parsed.agent];
    validateRemoteRunner(reference, parsed, account, defaults, hosts, problems);
    if (!account) { problems.push(`${at}: no default account for ${parsed.agent}`); return null; }
    const cfg = accounts[account];
    if (!cfg) { problems.push(`${at}: unknown account "${account}"`); return null; }
    if (!allowedPair(parsed.agent, cfg.kind)) problems.push(`${at}: ${parsed.agent} cannot use ${cfg.kind} account "${account}"`);
    const id = formatRunnerId({...parsed, account}, defaults);
    if (!parseRunnerId(id)) problems.push(`${at}: invalid runner id`);
    if (runners[id] && !Object.keys(c).length) { runnerAliases[reference] = id; return runners[id]; }
    let model = c.model === undefined ? cfg.model : typeof c.model === "string" ? c.model : null;
    if (cfg.connection) {
      const prefix = `pacer-${account}/`;
      const selected = model?.startsWith(prefix) ? model.slice(prefix.length) : model ?? cfg.connection.models[0].id;
      if (!cfg.connection.models.some(m => m.id === selected)) problems.push(`${at}: model must be selected from connection.models`);
      model = prefix + selected;
    }
    if (Object.keys(c).length) {
      if (declarations.has(id) && declarations.get(id) !== model) problems.push(`${at}: conflicting model declarations for ${id}`);
      declarations.set(id, model);
    }
    if (c.enabled !== undefined && typeof c.enabled !== "boolean") problems.push(`${at}: enabled must be a boolean`);
    if (c.max_tasks !== undefined && (typeof c.max_tasks !== "number" || !Number.isInteger(c.max_tasks) || c.max_tasks < 1 || c.max_tasks > 16)) problems.push(`runners.${reference}.max_tasks must be 1..16`);
    if (c.test !== undefined && typeof c.test !== "boolean") problems.push(`${at}: test must be a boolean`);
    const runner = {...(typeof c.enabled === "boolean" ? {enabled:c.enabled}:{}), ...(typeof c.max_tasks === "number" ? {maxTasks:c.max_tasks}:{}), ...(typeof c.test === "boolean" ? {test:c.test}:{}), id, name: id, host: parsed.host, agent: parsed.agent, account, model};
    if (!runners[id] || Object.keys(c).length) runners[id] = runner;
    runnerAliases[reference] = id;
    return runners[id];
  };
  const plannerRaw = isObj(raw.planner) ? raw.planner : {};
  const plannerRef = plannerRaw.agent === "opencode" && plannerRaw.account === "opencode" && !accounts.opencode ? "opencode" : typeof raw.planner === "string" ? raw.planner : formatRunnerId({agent: plannerRaw.agent as AgentId, account: plannerRaw.account as string, host: null}, defaults);
  const plannerRunner = add(plannerRef, typeof raw.planner === "string" ? {} : plannerRaw);
  if (plannerRunner?.host) problems.push("the planner can't run on a host");
  const planner = plannerRunner ? {agent: plannerRunner.agent, account: plannerRunner.account} : {agent: "opencode" as AgentId, account: "opencode"};
  if (!["claude-code", "codex", "cursor", "opencode"].includes(planner.agent)) problems.push("planner must be one of claude-code, codex, cursor, opencode");
  for (const [name, value] of Object.entries(entries)) add(name, value);
  if (Array.isArray(raw.routing)) for (const rule of raw.routing) {
    if (!isObj(rule)) continue;
    const refs = rule.default ?? rule.executors;
    if (Array.isArray(refs)) for (const ref of refs) add(String(ref));
  }
  for (const runner of Object.values(runners)) {
    if (runner.agent === "opencode" && (!runner.model || !runner.model.includes("/"))) problems.push(`runner ${runner.id}: model must look like "<provider>/<model>"`);
  }
  return {accounts, runners, planner, runnerAliases};
}
