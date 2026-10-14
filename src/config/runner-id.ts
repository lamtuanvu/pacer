import { AGENTS, allowedPair, type AccountCfg, type AgentId, type RunnerCfg } from "./accounts";
import type { Strategy } from "./strategy";
export interface RunnerId { agent: AgentId; account: string | null; host: string | null }
export type RunnerDefaults = Partial<Record<AgentId, string>>;
export function parseRunnerId(id: string): RunnerId | null {
  const m = /^([a-z0-9][a-z0-9-]*)(?:#([a-z0-9][a-z0-9-]*))?(?:@([a-z0-9][a-z0-9-]*))?$/.exec(id);
  if (!m || !(AGENTS as readonly string[]).includes(m[1])) return null;
  return { agent: m[1] as AgentId, account: m[2] ?? null, host: m[3] ?? null };
}
export function runnerDefaults(accounts: Record<string, AccountCfg>): RunnerDefaults {
  const defaults: RunnerDefaults = {};
  for (const agent of AGENTS) {
    const matches = Object.values(accounts).filter(a => allowedPair(agent, a.kind) && !a.home && !a.orcaAccount);
    if (matches.length === 1) defaults[agent] = matches[0].name;
  }
  return defaults;
}
export function formatRunnerId(id: RunnerId, defaults: RunnerDefaults): string {
  return id.agent + (id.account && id.account !== defaults[id.agent] ? `#${id.account}` : "") + (id.host ? `@${id.host}` : "");
}
export function resolveRunner(s: Strategy, idOrAlias: string): RunnerCfg | null {
  if (Object.hasOwn(s.runners, idOrAlias)) return s.runners[idOrAlias];
  const alias = s.runnerAliases?.[idOrAlias];
  if (alias && Object.hasOwn(s.runners, alias)) return s.runners[alias];
  const id = parseRunnerId(idOrAlias) ?? (s.accounts[idOrAlias]?.kind === "endpoint" ? {agent: "opencode" as const, account: idOrAlias, host: null} : null);
  if (!id) return null;
  // Endpoint ids always spell the account out; opencode in pacing is a group.
  const defaults = runnerDefaults(s.accounts); delete defaults.opencode;
  const canonical = formatRunnerId(id, defaults);
  return Object.hasOwn(s.runners, canonical) ? s.runners[canonical] : null;
}
