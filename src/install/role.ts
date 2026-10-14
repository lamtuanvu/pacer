import { allowedPair, type AccountCfg, type AgentId } from "../config/accounts";
import { formatRunnerId, runnerDefaults } from "../config/runner-id";
import { orcaAccountHome } from "../orca/accounts";
import { computeStatus } from "../engine/status";
import { resolve } from "node:path";
import { loadStrategy, type Strategy } from "../config/strategy";
import { isTaskId } from "../tasks/store";
import type { Ctx } from "../types";
import { isObj } from "../util";

/** Orca new-child worktrees are named pacer-<taskId>-<providerId>. */
export function isExecutorSession(ctx: Ctx, input?: unknown): boolean {
  if (ctx.env.PACER_ROLE === "executor") return true;
  const paths = [process.cwd(), ...(isObj(input) && typeof input.cwd === "string" ? [input.cwd] : [])];
  return paths.some(path => {
    const match = /\/orca\/workspaces\/[^/]+\/pacer-(t-\d{8}-\d{6}-[0-9a-f]{4})-([^/]+)(?:\/|$)/.exec(resolve(path));
    if (!match || !isTaskId(match[1])) return false;
    try { return Object.hasOwn(loadStrategy(ctx).providers, match[2]); }
    catch { return false; }
  });
}

export function plannerPolicyApplies(ctx: Ctx, planner: string, input?: unknown): boolean {
  if (isExecutorSession(ctx, input)) return false;
  try { return loadStrategy(ctx).planner.agent === planner; }
  catch { return true; } // Preserve existing missing-strategy/fail-open behavior.
}

export function hookInput(stdin: string): unknown {
  try { return JSON.parse(stdin); } catch { return undefined; }
}

/** Resolve config folders without inspecting any credentials. */
export function accountFolder(ctx: Ctx, account: AccountCfg): string | null {
  if (account.source === "orca" && (account.kind === "claude" || account.kind === "codex"))
    return orcaAccountHome(ctx, account.kind, account.orcaAccount ?? "");
  return account.home ? resolve(account.home.replace(/^~(?=\/|$)/, ctx.home)) : null;
}

export const UNKNOWN_PLANNER_FOLDER = "planner session runs on an unknown config folder";

/** Hooks use the session's actual account, even when the configured planner differs. */
export function plannerSessionStrategy(ctx: Ctx, strategy: Strategy, agent = strategy.planner.agent): { strategy: Strategy; warnings: string[] } {
  const variable = agent === "claude-code" ? "CLAUDE_CONFIG_DIR" : agent === "codex" ? "CODEX_HOME" : null;
  if (!variable) return { strategy, warnings: [] };
  const folder = ctx.env[variable];
  const defaultFolder = resolve(ctx.home, agent === "codex" ? ".codex" : ".claude");
  const accounts = Object.values(strategy.accounts).filter(a => allowedPair(agent, a.kind));
  const matched = folder && resolve(folder) !== defaultFolder
    ? accounts.find(a => a.source !== "default" && accountFolder(ctx, a) === resolve(folder))
    : accounts.find(a => a.source === "default");
  const warnings = folder && resolve(folder) !== defaultFolder && !matched ? [UNKNOWN_PLANNER_FOLDER] : [];
  const account = matched ?? accounts.find(a => a.source === "default");
  // A strategy need not declare a default account. Do not charge an unknown session to work.
  if (!account) return { strategy: { ...strategy, planner: {agent, account: ""} }, warnings };
  const name = formatRunnerId({agent, account: account.name, host: null}, runnerDefaults(strategy.accounts));
  const runner = {id: name, name, agent, account: account.name, host: null, model: account.model};
  return { strategy: { ...strategy, planner: {agent, account: account.name}, runners: {...strategy.runners, [name]: strategy.runners[name] ?? runner} }, warnings };
}

export async function plannerSessionStatus(ctx: Ctx, agent?: AgentId) {
  const selected = plannerSessionStrategy(ctx, loadStrategy(ctx), agent);
  return {...await computeStatus(ctx, selected.strategy), ...(selected.warnings.length ? {warnings: selected.warnings} : {})};
}
