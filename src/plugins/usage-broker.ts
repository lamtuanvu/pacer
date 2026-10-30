import { join, resolve } from "node:path";
import type { AccountCfg } from "../config/accounts";
import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { orcaAccountHome } from "../orca/accounts";
import { claudeCachePaths } from "../usage/claude";
import { defaultAccountFolder } from "../exec/account-folder";
import { pluginRegistry } from "./index";
import type { CallResources } from "./authority";

/** Project public account identity and fixed host-owned resources, never credential configuration. */
export async function readPluginUsage(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg, refresh = false): Promise<UsageReading> {
  if (cfg.usage === "reactive") return { windows: [{ name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false }], capturedAt: ctx.now, stale: false, source: "reactive" };
  if (cfg.usage === "unmetered") return { windows: [], capturedAt: ctx.now, stale: false, source: "unmetered" };
  const provider = cfg.usage === "metered" ? "metered" : ["claude-code", "codex"].includes(cfg.id) ? cfg.id : cfg.quotaSource === "arkcli" ? "arkcli" : null;
  if (!provider) return { windows: [], capturedAt: null, stale: false, error: `no quota source for ${cfg.id}` };
  const registry = pluginRegistry(ctx);
  const plugin = registry.find(ctx, "usage", contribution => Array.isArray(contribution.providers) && contribution.providers.includes(provider));
  if (!plugin) return { windows: [], capturedAt: null, stale: false, error: `no enabled plugin reads ${provider} usage (pacer plugin list)` };
  const resources: CallResources = { reads: [], commands: [], stores: [] };
  let accountHome: string | null = null;
  const inputResources: { claudeFiles?: string[]; codexSessions?: string } = {};
  if (cfg.usage === "quota" && cfg.id === "claude-code") {
    inputResources.claudeFiles = claudeCachePaths(ctx, account).map(path => resolve(path));
    // The default account's folder may come from the login profile's CLAUDE_CONFIG_DIR (#439); scopes see it as ACCOUNT_HOME.
    if (!account || account.source === "default") accountHome = resolve(defaultAccountFolder(ctx, "claude"));
    resources.reads = inputResources.claudeFiles.map(path => ({ path, kind: "file" }));
  } else if (cfg.usage === "quota" && cfg.id === "codex") {
    const home = account?.source === "orca" ? orcaAccountHome(ctx, "codex", account.orcaAccount ?? "")
      : account?.home ? account.home.replace(/^~(?=\/|$)/, ctx.home) : defaultAccountFolder(ctx, "codex");
    if (!home) return { windows: [], capturedAt: null, stale: false, error: "Orca account folder not found" };
    accountHome = resolve(home);
    const root = join(accountHome, "sessions");
    inputResources.codexSessions = root;
    resources.reads.push({ path: root, kind: "codex-logs" });
    resources.stores.push({ id: "codex-cursors", path: join(ctx.pacerHome, "state", "codex-cursors.json"), kind: "cursors", version: 4, root });
    if (refresh) resources.commands.push({ argv: ["codex", "-s", "read-only", "-a", "never", "app-server"],
      timeoutMs: 10_000, mode: "codex-live", env: { ...Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "XDG_CONFIG_HOME"].flatMap(key => typeof ctx.env[key] === "string" ? [[key, ctx.env[key]]] : [])) as Record<string, string>, CODEX_HOME: accountHome } });
  } else if (cfg.usage === "quota" && cfg.quotaSource === "arkcli") {
    resources.commands.push({ argv: ["arkcli", "usage", "plan", "--product", "coding-plan"], timeoutMs: 8000 });
    resources.stores.push({ id: "arkcli-usage-plan", path: join(ctx.pacerHome, "cache", "arkcli-usage-plan.json"), kind: "cache" });
  } else if (cfg.usage === "metered" && cfg.model) {
    resources.commands.push({ argv: ["opencode", "stats", "--models", "--cost", "--json", "--days", "7"], timeoutMs: 15000 });
    resources.stores.push({ id: "opencode-stats-7d-cost", path: join(ctx.pacerHome, "cache", "opencode-stats-7d-cost.json"), kind: "cache" });
  }
  return registry.call<UsageReading>(ctx, plugin, "usage.read", {
    provider, usage: cfg.usage, account: account ? { name: account.name, kind: account.kind, source: account.source } : null,
    accountHome, model: cfg.model ?? null, weeklyTokens: cfg.weeklyTokens ?? null, weeklyUsd: cfg.weeklyUsd ?? null,
    quotaSource: cfg.quotaSource ?? null, now: ctx.now, readOnly: ctx.readOnly === true, refresh, resources: inputResources,
  }, { resources, accountHome });
}
