import { readFileSync } from "node:fs";
import type { AccountCfg } from "../config/accounts";
import { opencodeConfigPath } from "../install/opencode";
import type { Ctx } from "../types";
import { isObj } from "../util";
import type { Catalog } from "./catalog";
import { discoverEndpointModels } from "../plugins/endpoint-adapter";
import { classify, type UsageClass } from "./recommend";

export type CandidateGroup = "signed_in" | "local" | "catalog";
export interface Candidate { group: CandidateGroup; provider: string; name: string; added: string | null; usage: UsageClass; base_url?: string; models?: number }
export interface Detection { candidates: Candidate[]; opencode: boolean; catalog: "fresh" | "stale" | "offline"; notes: string[] }
export const LOCAL_SERVERS = [
  { provider: "ollama" as const, name: "Ollama", base_url: "http://127.0.0.1:11434/v1" },
  { provider: "lmstudio" as const, name: "LM Studio", base_url: "http://127.0.0.1:1234/v1" },
];

/** Only provider ids and names are read; connection ids and methods are ignored. */
export async function signedInProviders(ctx: Ctx): Promise<{ id: string; name: string }[] | null> {
  const r = await ctx.run(["opencode", "auth", "list", "--format", "json"], 15000);
  if (r.code !== 0) return null;
  try {
    const list = JSON.parse(r.stdout);
    if (!Array.isArray(list)) return null;
    return list.filter(p => isObj(p) && typeof p.id === "string").map(p => ({ id: p.id as string, name: typeof p.name === "string" ? p.name : p.id as string }));
  } catch { return null; }
}
/** Provider keys and display names only; options (which may hold keys) are never read. */
export function configProviders(ctx: Ctx): { id: string; name: string }[] {
  try {
    const config = JSON.parse(readFileSync(opencodeConfigPath(ctx), "utf8"));
    if (!isObj(config) || !isObj(config.provider)) return [];
    return Object.entries(config.provider).map(([id, p]) => ({ id, name: isObj(p) && typeof p.name === "string" ? p.name : id }));
  } catch { return []; }
}
/** null means OpenCode could not list models (not installed, failed or timed out), not "no models". */
export async function opencodeModelIds(ctx: Ctx, provider: string): Promise<string[] | null> {
  // "opencode models <provider>" rejects a positional provider argument (verified against the real CLI),
  // so all models are listed and filtered by the "<provider>/" prefix.
  const r = await ctx.run(["opencode", "models"], 90000);
  if (r.code !== 0 || (r as any).timedOut) return null;
  const prefix = `${provider}/`;
  return r.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length));
}
function addedBy(accounts: Record<string, AccountCfg>, provider: string, baseUrl?: string): string | null {
  return Object.values(accounts).find(a => (a.source === "opencode" && a.provider === provider) || (!!baseUrl && a.connection?.base_url === baseUrl))?.name ?? null;
}
export async function detectCandidates(ctx: Ctx, deps: { discover?: typeof discoverEndpointModels; catalog: Catalog | null; accounts: Record<string, AccountCfg> }): Promise<Detection> {
  const notes: string[] = [], candidates: Candidate[] = [];
  const opencode = ctx.which("opencode") !== null;
  const catalog = deps.catalog;
  const local = Promise.all(LOCAL_SERVERS.map(async s => ({ s, r: await (deps.discover ?? discoverEndpointModels)(ctx, { baseUrl: s.base_url, key: null, timeoutMs: 1000 }) })));
  if (!opencode) notes.push("Install OpenCode to use providers you have signed in to or connect new ones.");
  const signed = opencode ? await signedInProviders(ctx) : [];
  if (signed === null) notes.push("Could not read OpenCode sign-ins; showing other options.");
  const seen = new Set<string>();
  if (opencode) for (const p of [...(signed ?? []), ...configProviders(ctx)]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    candidates.push({ group: "signed_in", provider: p.id, name: p.name, added: addedBy(deps.accounts, p.id), usage: classify({ id: p.id }, catalog?.providers[p.id]) });
  }
  for (const { s, r } of await local) if (r.listed)
    candidates.push({ group: "local", provider: s.provider, name: s.name, base_url: s.base_url, models: r.models.length, added: addedBy(deps.accounts, s.provider, s.base_url), usage: classify({ id: s.provider, local: true }) });
  if (opencode && catalog) for (const p of Object.values(catalog.providers)) {
    if (seen.has(p.id) || p.id === "ollama" || p.id === "lmstudio" || !p.models.length) continue;
    candidates.push({ group: "catalog", provider: p.id, name: p.name, added: addedBy(deps.accounts, p.id), usage: classify({ id: p.id }, p) });
  }
  return { candidates, opencode, catalog: catalog ? catalog.stale ? "stale" : "fresh" : "offline", notes };
}
