import { join, resolve } from "node:path";
import type { AccountCfg } from "../config/accounts";
import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { orcaAccountHome } from "../orca/accounts";
import { claudeCachePaths } from "../usage/claude";
import { defaultAccountFolder } from "../exec/account-folder";
import { pluginRegistry } from "./index";
import type { CallResources } from "./authority";
import { NETWORK_ENV } from "./capability-spawn";

/** The call a usage read needs, before the registry call that makes it. */
export type UsageCallSpec = { reading: UsageReading } | {
  plugin: string;
  params: {
    provider: string;
    usage: ProviderCfg["usage"];
    account: { name: string; kind: AccountCfg["kind"]; source: AccountCfg["source"] } | null;
    accountHome: string | null;
    model: string | null;
    weeklyTokens: number | null;
    weeklyUsd: number | null;
    quotaSource: "arkcli" | null;
    now: number;
    readOnly: boolean;
    refresh: boolean;
    resources: { claudeFiles?: string[]; codexSessions?: string };
  };
  resources: CallResources;
  accountHome: string | null;
};

/** `readPluginUsage` without the call: project public account identity and fixed host-owned resources, never credential configuration. */
export function usageCallSpec(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg, refresh = false): UsageCallSpec {
  if (cfg.usage === "reactive") return { reading: { windows: [], capturedAt: null, stale: false, source: "reactive" } };
  if (cfg.usage === "unmetered") return { reading: { windows: [], capturedAt: null, stale: false, source: "unmetered" } };
  const provider = cfg.usage === "metered" ? "metered" : ["claude-code", "codex"].includes(cfg.id) ? cfg.id : cfg.quotaSource === "arkcli" ? "arkcli" : null;
  if (!provider) return { reading: { windows: [], capturedAt: null, stale: false, error: `no quota source for ${cfg.id}` } };
  const registry = pluginRegistry(ctx);
  const plugin = registry.find(ctx, "usage", contribution => Array.isArray(contribution.providers) && contribution.providers.includes(provider));
  if (!plugin) return { reading: { windows: [], capturedAt: null, stale: false, error: `no enabled plugin reads ${provider} usage (pacer plugin list)` } };
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
    if (!home) return { reading: { windows: [], capturedAt: null, stale: false, error: "Orca account folder not found" } };
    accountHome = resolve(home);
    const root = join(accountHome, "sessions");
    inputResources.codexSessions = root;
    resources.reads.push({ path: root, kind: "codex-logs" });
    resources.stores.push({ id: "codex-cursors", path: join(ctx.pacerHome, "state", "codex-cursors.json"), kind: "cursors", version: 4, root });
    if (refresh) resources.commands.push({ argv: ["codex", "-s", "read-only", "-a", "never", "app-server"],
      timeoutMs: 10_000, mode: "codex-live", env: { ...Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "XDG_CONFIG_HOME",...NETWORK_ENV].flatMap(key => typeof ctx.env[key] === "string" ? [[key, ctx.env[key]]] : [])) as Record<string, string>, CODEX_HOME: accountHome } });
  } else if (cfg.usage === "quota" && cfg.quotaSource === "arkcli") {
    resources.commands.push({ argv: ["arkcli", "usage", "plan", "--product", "coding-plan"], timeoutMs: 8000 });
    resources.stores.push({ id: "arkcli-usage-plan", path: join(ctx.pacerHome, "cache", "arkcli-usage-plan.json"), kind: "cache" });
  } else if (cfg.usage === "metered" && cfg.model) {
    resources.commands.push({ argv: ["opencode", "stats", "--standalone", "--models", "--cost", "--json", "--days", "7"], timeoutMs: 15000 });
    resources.stores.push({ id: "opencode-stats-7d-cost", path: join(ctx.pacerHome, "cache", "opencode-stats-7d-cost.json"), kind: "cache" });
  }
  return {
    plugin,
    params: {
      provider, usage: cfg.usage, account: account ? { name: account.name, kind: account.kind, source: account.source } : null,
      accountHome, model: cfg.model ?? null, weeklyTokens: cfg.weeklyTokens ?? null, weeklyUsd: cfg.weeklyUsd ?? null,
      quotaSource: cfg.quotaSource ?? null, now: ctx.now, readOnly: ctx.readOnly === true, refresh, resources: inputResources,
    },
    resources,
    accountHome,
  };
}

/** Project public account identity and fixed host-owned resources, never credential configuration. */
export async function readPluginUsage(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg, refresh = false): Promise<UsageReading> {
  const spec = usageCallSpec(ctx, cfg, account, refresh);
  if ("reading" in spec) return spec.reading;
  return pluginRegistry(ctx).call<UsageReading>(ctx, spec.plugin, "usage.read", spec.params, {
    resources: spec.resources,
    accountHome: spec.accountHome,
  });
}
