import { statSync } from "node:fs";
import { join } from "node:path";
import { orcaUserDataDir } from "../link/paths";
import { sanitizedOrcaEnv } from "../exec/orca/client";
import type { Ctx } from "../types";
import { isObj, toNum } from "../util";

export interface OrcaAccount { id: string; label: string; active: boolean }
export interface OrcaWindow { name?: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | string | null }
export interface OrcaRateLimit {
  accountId?: string;
  provider: string;
  updatedAt: number | string | null;
  session?: OrcaWindow;
  weekly?: OrcaWindow;
  monthly?: OrcaWindow;
  buckets?: OrcaWindow[];
  error?: string;
}
export interface OrcaAccounts {
  claude: OrcaAccount[];
  codex: OrcaAccount[];
  rateLimits: Record<string, OrcaRateLimit>;
  inactive: Record<string, OrcaRateLimit[]>;
}

const safeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
const timestamp = (v: unknown): number | string | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && !v.includes("@") ? v : null;
function window(v: unknown): OrcaWindow | undefined {
  if (!isObj(v)) return undefined;
  return {
    ...(typeof v.name === "string" && !v.name.includes("@") ? {name: v.name} : {}),
    usedPercent: toNum(v.usedPercent), windowMinutes: toNum(v.windowMinutes), resetsAt: timestamp(v.resetsAt),
  };
}
function rateLimit(v: unknown, provider: string, accountId?: string): OrcaRateLimit | null {
  if (!isObj(v)) return null;
  const result: OrcaRateLimit = { provider, updatedAt: timestamp(v.updatedAt), ...(accountId ? {accountId} : {}) };
  for (const key of ["session", "weekly", "monthly"] as const) {
    const w = window(v[key]); if (w) result[key] = w;
  }
  if (Array.isArray(v.buckets)) result.buckets = v.buckets.flatMap(b => { const w = window(b); return w ? [w] : []; });
  // Orca's free-form errors and metadata can contain an account email.
  if (typeof v.error === "string" && v.error) result.error = "Orca rate-limit data unavailable";
  return result;
}

/** Parse only public account identities and numeric usage, never credential or email fields. */
function parseAccounts(raw: unknown): OrcaAccounts | null {
  if (!isObj(raw) || raw.ok === false) return null;
  const data = isObj(raw.result) ? raw.result : raw;
  if (!isObj(data.rateLimits)) return null;
  const result: OrcaAccounts = { claude: [], codex: [], rateLimits: {}, inactive: {claude: [], codex: []} };
  for (const kind of ["claude", "codex"] as const) {
    const group = isObj(data[kind]) ? data[kind] : {};
    const activeId = safeId(group.activeAccountId) ? group.activeAccountId : undefined;
    result[kind] = (Array.isArray(group.accounts) ? group.accounts : []).flatMap(a => {
      if (!isObj(a) || !safeId(a.id)) return [];
      const label = typeof a.label === "string" && !a.label.includes("@") ? a.label : a.id;
      return [{id: a.id, label, active: a.id === activeId}];
    });
    const active = rateLimit(data.rateLimits[kind], kind, activeId);
    if (active) result.rateLimits[kind] = active;
    const inactive = data.rateLimits[kind === "claude" ? "inactiveClaudeAccounts" : "inactiveCodexAccounts"];
    if (Array.isArray(inactive)) for (const item of inactive) {
      if (!isObj(item) || !safeId(item.accountId)) continue;
      const limit = rateLimit(item.rateLimits, kind, item.accountId);
      if (limit) result.inactive[kind].push(limit);
    }
  }
  for (const [key, value] of Object.entries(data.rateLimits)) {
    if (!safeId(key) || key === "claude" || key === "codex") continue;
    if (!isObj(value) || typeof value.provider !== "string") continue;
    const limit = rateLimit(value, key);
    if (limit) result.rateLimits[key] = limit;
  }
  return result;
}

const snapshots = new Map<string, {at: number; pending: Promise<OrcaAccounts | null>}>();
/** No raw CLI output is persisted or included in errors. The shared cache contains only sanitized fields. */
export async function readOrcaAccounts(ctx: Ctx): Promise<OrcaAccounts | null> {
  const bin = ctx.env.ORCA_CLI_COMMAND || "orca";
  if (!ctx.which(bin)) return null;
  const key = JSON.stringify([ctx.pacerHome, ctx.home, bin, orcaUserDataDir(ctx), ctx.env.ORCA_USER_DATA_PATH]);
  const hit = snapshots.get(key);
  if (hit && ctx.now >= hit.at && ctx.now - hit.at < 60) return hit.pending;
  const pending = (async () => {
    try {
      const r = await ctx.run([bin, "account", "list", "--json"], 10000, {env: sanitizedOrcaEnv(ctx.env)});
      return r.code === 0 ? parseAccounts(JSON.parse(r.stdout)) : null;
    } catch { return null; }
  })();
  snapshots.set(key, {at: ctx.now, pending});
  return pending;
}

/** Locate only an existing Orca-managed home; account ids cannot escape the layout. */
export function orcaAccountHome(ctx: Ctx, kind: "claude" | "codex", id: string): string | null {
  if (!safeId(id)) return null;
  const root = ctx.env.ORCA_USER_DATA_PATH || orcaUserDataDir(ctx);
  // TODO(#19): replace this derived layout with Orca's public folder field.
  const path = join(root, kind === "claude" ? "claude-profiles" : "codex-accounts", id, "home");
  try { return statSync(path).isDirectory() ? path : null; } catch { return null; }
}
