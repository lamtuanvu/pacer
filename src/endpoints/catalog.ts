import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Ctx } from "../types";
import { isObj } from "../util";

export const CATALOG_URL = "https://models.dev/api.json";
const MAX_AGE_S = 24 * 3600;
export interface CatalogModel { id: string; name: string; toolCall: boolean; input: string[]; output: string[]; context: number | null; outputLimit: number | null; costIn: number | null; costOut: number | null; release: string | null }
export interface CatalogProvider { id: string; name: string; env: string[]; api: string | null; models: CatalogModel[] }
export interface Catalog { providers: Record<string, CatalogProvider>; fetchedAt: number; stale: boolean }

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function parseCatalog(raw: unknown): Record<string, CatalogProvider> {
  const out: Record<string, CatalogProvider> = {};
  if (!isObj(raw)) return out;
  for (const [key, p] of Object.entries(raw)) {
    if (!isObj(p) || !isObj(p.models)) continue;
    const id = typeof p.id === "string" ? p.id : key;
    const models: CatalogModel[] = [];
    for (const [mid, m] of Object.entries(p.models)) {
      if (!isObj(m)) continue;
      const mod = isObj(m.modalities) ? m.modalities : {}, limit = isObj(m.limit) ? m.limit : {}, cost = isObj(m.cost) ? m.cost : {};
      // A 0 limit means "not a text limit" (image/embedding models); null lets callers apply defaults.
      models.push({
        id: typeof m.id === "string" ? m.id : mid, name: typeof m.name === "string" ? m.name : mid, toolCall: m.tool_call === true,
        input: strings(mod.input), output: strings(mod.output), context: num(limit.context) || null, outputLimit: num(limit.output) || null,
        costIn: num(cost.input), costOut: num(cost.output), release: typeof m.release_date === "string" ? m.release_date : null,
      });
    }
    out[id] = { id, name: typeof p.name === "string" ? p.name : id, env: strings(p.env), api: typeof p.api === "string" ? p.api : null, models };
  }
  return out;
}

const cachePath = (ctx: Ctx) => join(ctx.pacerHome, "cache", "models.json");
/** Local-only: read-model paths may call this, never loadCatalog. */
export function readCachedCatalog(ctx: Ctx): Catalog | null {
  try {
    const v = JSON.parse(readFileSync(cachePath(ctx), "utf8"));
    if (!isObj(v) || typeof v.fetchedAt !== "number" || !isObj(v.providers)) return null;
    return { providers: v.providers as Record<string, CatalogProvider>, fetchedAt: v.fetchedAt, stale: ctx.now - v.fetchedAt >= MAX_AGE_S };
  } catch { return null; }
}
function writeCache(ctx: Ctx, providers: Record<string, CatalogProvider>) {
  const path = cachePath(ctx), temp = `${path}.${randomUUID()}.tmp`;
  mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true, mode: 0o700 });
  try { writeFileSync(temp, JSON.stringify({ fetchedAt: ctx.now, providers }), { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export async function loadCatalog(ctx: Ctx, deps: { fetch?: typeof fetch } = {}): Promise<Catalog | null> {
  const cached = readCachedCatalog(ctx);
  if (cached && !cached.stale) return cached;
  try {
    const response = await (deps.fetch ?? fetch)(CATALOG_URL, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const providers = parseCatalog(await response.json());
    if (!Object.keys(providers).length) throw Error("empty catalog");
    writeCache(ctx, providers);
    return { providers, fetchedAt: ctx.now, stale: false };
  } catch {
    return cached ? { ...cached, stale: true } : null;
  }
}
