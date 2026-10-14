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
export interface AccountCfg {
  name: string;
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
export interface RunnerCfg { name: string; agent: AgentId; account: string; model: string | null }
export interface PlannerCfg { agent: AgentId; account: string }
export interface AccountsModel {
  accounts: Record<string, AccountCfg>;
  runners: Record<string, RunnerCfg>;
  planner: PlannerCfg;
}
const ACCOUNT_KIND: Record<AgentId, AccountKind> = {
  "claude-code": "claude", codex: "codex", cursor: "cursor", agy: "agy", opencode: "endpoint",
};
export function allowedPair(agent: AgentId, kind: AccountKind): boolean {
  return Object.hasOwn(ACCOUNT_KIND, agent) && ACCOUNT_KIND[agent] === kind;
}

function accountCfg(name: string, c: Record<string, unknown>): AccountCfg {
  const kind = c.kind as AccountKind;
  const home = typeof c.home === "string" ? c.home : null;
  const orcaAccount = typeof c.orca_account === "string" ? c.orca_account : null;
  const source = orcaAccount ? "orca" : home ? "pacer" : kind === "endpoint" ? "endpoint" : "default";
  const usage = (c.usage ?? (kind === "claude" || kind === "codex" ? "quota" : kind === "endpoint" ? "metered" : "reactive")) as UsageKind;
  const quotaSource = typeof c.quota_source === "string" ? c.quota_source : null;
  const usageSource = (c.usage_source ?? (source === "orca" ? "orca" : quotaSource === "arkcli" ? "arkcli" : usage === "quota" ? "native" : usage)) as AccountCfg["usageSource"];
  return {
    name, kind, source, home, orcaAccount, usage, usageSource, quotaSource,
    weeklyTokens: isObj(c.budget) ? parseSize(c.budget.weekly_tokens) : null,
    cooldownS: c.cooldown === undefined ? 6 * 3600 : parseDuration(c.cooldown) ?? 6 * 3600,
    allowPaid: c.allow_paid === true,
  };
}

function plannerCfg(raw: unknown, accounts: Record<string, AccountCfg>, problems: string[]): PlannerCfg {
  const stringForm = typeof raw === "string";
  const c = isObj(raw) ? raw : {};
  const agent = (stringForm ? raw : c.agent) as AgentId;
  const account = (stringForm ? raw : c.account) as string;
  if (!["claude-code", "codex", "cursor", "opencode"].includes(agent)) {
    problems.push("planner must be one of claude-code, codex, cursor, opencode");
  }
  if (stringForm && Object.hasOwn(ACCOUNT_KIND, agent)) {
    const existing = accounts[account];
    if (!existing) accounts[account] = accountCfg(account, {
      kind: ACCOUNT_KIND[agent], ...(agent === "opencode" ? { usage: "unmetered" } : {}),
    });
    else if (existing.source !== "default" && agent !== "opencode") {
      problems.push(`planner: ${agent} string requires its default account`);
    }
  }
  const cfg = accounts[account];
  if (!cfg) problems.push(`planner: unknown account "${account}"`);
  else if (!allowedPair(agent, cfg.kind)) problems.push(`planner: ${agent} cannot use ${cfg.kind} account "${account}"`);
  return { agent, account };
}

/** Map the legacy provider shape without changing its accepted usage settings. */
export function legacyToAccounts(raw: unknown): AccountsModel {
  const c = isObj(raw) ? raw : {};
  const accounts: Record<string, AccountCfg> = {};
  const runners: Record<string, RunnerCfg> = {};
  for (const [name, value] of Object.entries(isObj(c.providers) ? c.providers : {})) {
    const v = isObj(value) ? value : {};
    const agent = v.via === "opencode" ? "opencode" : name as AgentId;
    accounts[name] = accountCfg(name, { ...v, kind: ACCOUNT_KIND[agent] });
    runners[name] = { name, agent, account: name, model: v.model === undefined ? null : String(v.model) };
  }
  return { accounts, runners, planner: plannerCfg(c.planner, accounts, []) };
}

export function parseAccounts(raw: Record<string, unknown>, problems: string[]): AccountsModel {
  const accounts: Record<string, AccountCfg> = {};
  const runners: Record<string, RunnerCfg> = {};
  if (!isObj(raw.accounts) || !Object.keys(raw.accounts).length) problems.push("accounts must be a non-empty mapping");
  for (const [name, value] of Object.entries(isObj(raw.accounts) ? raw.accounts : {})) {
    const at = `accounts.${name}`;
    if (!isObj(value)) { problems.push(`${at} must be a mapping`); continue; }
    const cfg = accountCfg(name, value);
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
    if (["cursor", "agy"].includes(cfg.kind) && cfg.usage === "quota" && cfg.usageSource !== "orca") problems.push(`${at}: quota usage is not available; use reactive or usage_source: orca`);
    if (cfg.kind === "endpoint" && cfg.usage === "quota" && cfg.quotaSource !== "arkcli" && cfg.usageSource !== "orca") problems.push(`${at}: quota usage needs quota_source: arkcli or usage_source: orca`);
    if (cfg.usage === "metered" && (cfg.weeklyTokens === null || !Number.isFinite(cfg.weeklyTokens) || cfg.weeklyTokens <= 0)) problems.push(`${at}: metered usage needs budget.weekly_tokens`);
    if (value.cooldown !== undefined && (parseDuration(value.cooldown) === null || !Number.isFinite(cfg.cooldownS) || cfg.cooldownS < 0)) problems.push(`${at}: cooldown must look like 30m, 6h or 2d`);
    accounts[name] = cfg;
  }
  const planner = plannerCfg(raw.planner, accounts, problems);
  if (!isObj(raw.runners) || !Object.keys(raw.runners).length) problems.push("runners must be a non-empty mapping");
  for (const [name, value] of Object.entries(isObj(raw.runners) ? raw.runners : {})) {
    const at = `runners.${name}`;
    if (!isObj(value)) { problems.push(`${at} must be a mapping`); continue; }
    const agent = value.agent as AgentId;
    const account = value.account as string;
    const model = typeof value.model === "string" ? value.model : null;
    if (!(AGENTS as readonly unknown[]).includes(agent)) problems.push(`${at}: unknown agent`);
    if (!Object.hasOwn(accounts, account)) problems.push(`${at}: unknown account "${account}"`);
    else if (!allowedPair(agent, accounts[account].kind)) problems.push(`${at}: ${agent} cannot use ${accounts[account].kind} account "${account}"`);
    if (agent === "opencode" && (!model || !model.includes("/"))) problems.push(`${at}: model must look like "<provider>/<model>"`);
    runners[name] = { name, agent, account, model };
  }
  return { accounts, runners, planner };
}
