import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { loadStrategy } from "../config/strategy";
import type { AccountCfg } from "../config/accounts";
import { opencodeModelIds } from "../endpoints/detect";
import { readCachedCatalog, type CatalogModel } from "../endpoints/catalog";
import type { SetupDeps } from "../core/opencode-setup";

export interface AvailableModel { id: string; name?: string; context?: number; output?: number; tools?: boolean; costIn?: number | null; costOut?: number | null; release?: string }
export type ModelSource = "opencode" | "connection" | "discovery" | "none";
export interface AvailableModels { runner: string; source: ModelSource; models: AvailableModel[] | null; fetchedAt: number; note?: string }

/** Cached for ten minutes regardless of when the plan last looked; refresh: true bypasses it. */
const TTL_S = 600;
function cacheFile(ctx: Ctx, runnerId: string): string {
  const hash = createHash("sha256").update(runnerId).digest("hex");
  return join(ctx.pacerHome, "cache", "available-models", `${hash}.json`);
}

function readCache(ctx: Ctx, path: string): AvailableModels | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (!isObj(v) || typeof v.runner !== "string" || typeof v.fetchedAt !== "number"
      || !(v.source === "opencode" || v.source === "connection" || v.source === "discovery" || v.source === "none")
      || (v.models !== null && !Array.isArray(v.models))) return null;
    if (ctx.now - v.fetchedAt >= TTL_S) return null;
    return v as unknown as AvailableModels;
  } catch { return null; }
}
function writeCache(ctx: Ctx, path: string, value: AvailableModels) {
  if (ctx.readOnly) return;
  const temp = `${path}.${createHash("sha256").update(String(ctx.now)).digest("hex").slice(0, 8)}.tmp`;
  mkdirSync(join(ctx.pacerHome, "cache", "available-models"), { recursive: true, mode: 0o700 });
  try { writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

/** Attach catalog facts to a served model id; only the presence of an entry is required, so unknown ids stay listed. */
function opencodeModels(ctx: Ctx, account: AccountCfg, deps?: SetupDeps, out: AvailableModels = { runner: "", source: "opencode", models: null, fetchedAt: ctx.now }): Promise<AvailableModels> {
  return opencodeModelIds(ctx, account.provider!).then(ids => {
    if (ids === null) {
      out.note = `opencode could not list models for ${account.provider}`;
      return out;
    }
    const provider = account.provider!;
    const catalog = deps && deps.catalog !== undefined ? deps.catalog : readCachedCatalog(ctx);
    const entry = catalog?.providers[provider];
    out.models = ids.map(id => fact(entry?.models.find(m => m.id === id), { id: `${provider}/${id}` }));
    return out;
  });
}
/** Map a catalog model's facts onto an entry; missing facts stay absent so callers can apply defaults. */
function fact(entry: CatalogModel | undefined, base: AvailableModel): AvailableModel {
  if (!entry) return base;
  return { ...base, name: entry.name, context: entry.context ?? undefined, output: entry.outputLimit ?? undefined, tools: entry.toolCall, costIn: entry.costIn, costOut: entry.costOut, release: entry.release ?? undefined };
}

/** List the models a runner can start, resolving the adapter from the runner's account. */
export async function availableModels(ctx: Ctx, runnerId: string, o: { refresh?: boolean; deps?: SetupDeps } = {}): Promise<AvailableModels> {
  const path = cacheFile(ctx, runnerId);
  if (!o.refresh) {
    const cached = readCache(ctx, path);
    if (cached) return cached;
  }
  const strategy = loadStrategy(ctx);
  const runner = strategy.runners[runnerId];
  const base: AvailableModels = { runner: runnerId, source: "none", models: null, fetchedAt: ctx.now };
  if (!runner) return base;
  const account = strategy.accounts[runner.account];
  if (!account) return base;
  // Adapter pick: opencode source lists through the OpenCode CLI + catalog facts; an endpoint connection lists its
  // configured models; anything else (native agents, plain opencode, undiscovered base_urls) has no adapter here.
  let result: AvailableModels;
  if (account.source === "opencode" && account.provider) {
    result = await opencodeModels(ctx, account, o.deps, { ...base, source: "opencode" });
  } else if (account.connection) {
    const prefix = `pacer-${runner.account}/`;
    result = { ...base, source: "connection", models: account.connection.models.map(m => ({ id: prefix + m.id, ...(m.name ? { name: m.name } : {}), context: m.context, output: m.output, tools: m.tools })) };
  } else {
    return base;
  }
  // A failed or empty listing is never cached: an unknown result must be re-probed on the next call.
  if (result.models) writeCache(ctx, path, result);
  return result;
}

/** null means the runner's available models are unknown, not "model is absent". */
export function isOffered(list: AvailableModels, modelId: string): boolean | null {
  if (list.models === null) return null;
  return list.models.some(m => m.id === modelId);
}

function sharedPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const next = [i];
    for (let j = 1; j <= n; j++) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return prev[n];
}

/** Nearest offered ids to modelId: shared-prefix length first, then Levenshtein distance; the queried id itself is not offered. */
export function closestModels(list: AvailableModels, modelId: string, n = 3): string[] {
  if (list.models === null) return [];
  return list.models
    .filter(m => m.id !== modelId)
    .sort((x, y) => sharedPrefixLen(y.id, modelId) - sharedPrefixLen(x.id, modelId)
      || levenshtein(x.id, modelId) - levenshtein(y.id, modelId))
    .slice(0, n)
    .map(m => m.id);
}