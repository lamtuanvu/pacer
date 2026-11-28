import { join, resolve } from "node:path";
import type { AccountCfg } from "../config/accounts";
import { loadStrategy, type ProviderCfg } from "../config/strategy";
import { CoreError, raisedByPacer, type CoreErrorCode } from "../core/errors";
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

/** The plugin-call authority the private adapter needs; `PluginRegistry` satisfies it. */
export interface UsagePluginCalls {
  call<T>(ctx: Ctx, id: string, method: string, params: unknown, options?: unknown): Promise<T>;
}

export type UsageReadReply = { reading: UsageReading } | { thrown: string; errorCode: CoreErrorCode | null };

/** Pacer's JSON byte spelling, with object keys in lexical order, for private-body comparison. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const spelling = (value: unknown): string => JSON.stringify(canonical(value));

function refuse(message = "invalid private plugin request"): never {
  throw new CoreError("invalid_input", message);
}

/** The exact body Rust sends over the private extension kind; no extra keys are accepted. */
function privateBody(input: unknown): { account: string | null; cfg: ProviderCfg; refresh: boolean; spec: { params: Record<string, unknown>; resources: unknown; accountHome: unknown } } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse();
  const body = input as Record<string, unknown>;
  const bodyKeys = ["account", "cfg", "refresh", "spec"];
  if (Object.keys(body).some(key => !bodyKeys.includes(key)) || bodyKeys.some(key => !Object.hasOwn(body, key))) return refuse();
  const spec = body.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return refuse();
  const s = spec as Record<string, unknown>;
  const specKeys = ["params", "resources", "accountHome"];
  if (Object.keys(s).some(key => !specKeys.includes(key)) || specKeys.some(key => !Object.hasOwn(s, key))) return refuse();
  const cfg = body.cfg;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return refuse();
  const cfgKeys = ["id", "via", "model", "usage", "allowPaid", "cooldownS", "quotaSource", "weeklyTokens", "weeklyUsd", "session"];
  if (Object.keys(cfg as object).some(key => !cfgKeys.includes(key))) return refuse();
  if (typeof body.account !== "string" && body.account !== null) return refuse();
  if (typeof body.refresh !== "boolean") return refuse();
  if (!s.params || typeof s.params !== "object" || Array.isArray(s.params)) return refuse();
  return { account: body.account, cfg: cfg as ProviderCfg, refresh: body.refresh,
    spec: { params: s.params as Record<string, unknown>, resources: s.resources, accountHome: s.accountHome } };
}

/**
 * The one entry in S2's `EXTENSION_CALLS` for B12. It re-derives the host's
 * resource set rather than trusting the bearer-authenticated private channel:
 * any difference in plugin, params (beyond the clock skew) or resources is
 * refused before a plugin child is reached (K6/Q2).
 */
export async function usageReadExtension(ctx: Ctx, id: string, input: unknown, calls?: UsagePluginCalls): Promise<UsageReadReply> {
  const { account: name, cfg, refresh, spec } = privateBody(input);
  const accounts = loadStrategy(ctx).accounts;
  const account = name === null ? undefined : accounts[name];
  if (name !== null && (!account || account.name !== name)) return refuse();
  if (name === null && cfg.usage !== "metered") return refuse();
  const expected = usageCallSpec(ctx, cfg, account, refresh);
  if ("reading" in expected) return refuse();
  if (expected.plugin !== id) return refuse("usage plugin differs from the host's");
  const expectedParams = { ...expected.params } as Record<string, unknown>;
  const receivedParams = { ...spec.params };
  const expectedNow = expectedParams.now;
  const receivedNow = receivedParams.now;
  delete expectedParams.now;
  delete receivedParams.now;
  if (typeof receivedNow !== "number" || typeof expectedNow !== "number"
      || Math.abs(receivedNow - expectedNow) > 5
      || spelling(expectedParams) !== spelling(receivedParams)
      || spelling(expected.resources) !== spelling(spec.resources)
      || spelling(expected.accountHome) !== spelling(spec.accountHome)) {
    return refuse("usage resources differ from the host's");
  }
  try {
    const pluginCalls = calls ?? pluginRegistry(ctx);
    const reading = await pluginCalls.call<UsageReading>(ctx, id, "usage.read", expected.params, {
      resources: expected.resources,
      accountHome: expected.accountHome,
    });
    return { reading };
  } catch (error) {
    // A plugin's own reply keeps no pacer code; errors pacer raised keep theirs.
    return { thrown: String(error), errorCode: raisedByPacer(error) ? error.code : null };
  }
}
