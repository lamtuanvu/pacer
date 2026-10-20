import { readFileSync } from "node:fs";
import { StrategyDoc } from "../config/edit";
import { loadStrategy, strategyPath, validateStrategy } from "../config/strategy";
import type { RunnerCfg } from "../config/accounts";
import type { Ctx } from "../types";
import { ensureAccounts } from "./accounts";
import { addRunnerAndRoute, type EndpointDeps } from "./endpoints";
import { CoreError } from "./errors";
import { loadCatalog, readCachedCatalog, type Catalog } from "../endpoints/catalog";
import { configProviders, detectCandidates, opencodeModelIds, signedInProviders, type CandidateGroup, type Detection } from "../endpoints/detect";
import { discoverModels } from "../endpoints/models";
import { classify, filterModelIds, idChoice, recommend, toChoice, usableModels, type ModelChoice, type UsageClass } from "../endpoints/recommend";
import { readEndpointState, writeEndpointState, type EndpointState } from "../endpoints/state";
import { testEndpoint } from "../endpoints/test-task";

export interface SetupDeps extends EndpointDeps { catalog?: Catalog | null; login?: (argv: string[]) => Promise<number> }
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const catalogFor = async (ctx: Ctx, deps: SetupDeps) => deps.catalog !== undefined ? deps.catalog : loadCatalog(ctx, { fetch: deps.fetch as typeof fetch | undefined });

export async function setupCandidates(ctx: Ctx, deps: SetupDeps = {}): Promise<Detection> {
  return detectCandidates(ctx, { fetch: deps.fetch as typeof fetch | undefined, catalog: await catalogFor(ctx, deps), accounts: loadStrategy(ctx).accounts });
}

export interface SetupModelsResult { pick: ModelChoice | null; rest: ModelChoice[]; filtered: "catalog" | "ids"; usage: UsageClass; note?: string }
export async function setupModels(ctx: Ctx, input: { provider: string; group: CandidateGroup; base_url?: string }, deps: SetupDeps = {}): Promise<SetupModelsResult> {
  const catalog = await catalogFor(ctx, deps), entry = catalog?.providers[input.provider];
  const usage: UsageClass = classify({ id: input.provider, local: input.group === "local" }, entry);
  if (input.group !== "local" && entry?.models.length) {
    const usable = usableModels(entry.models);
    return { ...recommend(usable.map(toChoice), Object.fromEntries(usable.map(m => [m.id, m.release]))), filtered: "catalog" as const, usage };
  }
  let ids: string[];
  if (input.group === "local") {
    const r = await discoverModels({ baseUrl: input.base_url ?? "", key: null, fetch: deps.fetch, timeoutMs: 3000 });
    ids = r.listed ? r.models.map(m => m.id) : [];
  } else {
    const listed = await opencodeModelIds(ctx, input.provider);
    if (listed === null) return { pick: null, rest: [], filtered: "ids" as const, usage, note: `OpenCode could not list models for ${input.provider}; enter a model id.` };
    ids = listed;
  }
  return { ...recommend(filterModelIds(ids).map(idChoice)), filtered: "ids" as const, usage };
}

export function suggestName(ctx: Ctx, provider: string): string {
  const taken = loadStrategy(ctx).accounts;
  const base = provider.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "opencode";
  let name = base;
  for (let i = 2; taken[name]; i++) name = `${base}-${i}`;
  return name;
}

async function knownProvider(ctx: Ctx, provider: string): Promise<boolean | null> {
  const signed = await signedInProviders(ctx);
  if (configProviders(ctx).some(p => p.id === provider)) return true;
  return signed === null ? null : signed.some(p => p.id === provider);
}

export interface OpencodeAccountInput { provider: string; model: string; name?: string; cap_usd?: number; usage?: UsageClass["usage"]; test?: boolean }
export async function addOpencodeAccount(ctx: Ctx, input: OpencodeAccountInput, deps: SetupDeps = {}) {
  const name = input.name ?? suggestName(ctx, input.provider);
  try {
    if (!NAME.test(name)) throw Error("invalid account name");
    const { strategy: s, edit } = ensureAccounts(ctx);
    if (s.accounts[name]) throw Error(`account ${name} already exists; use pacer account edit ${name}`);
    if (await knownProvider(ctx, input.provider) === false) throw Error(`OpenCode is not signed in to ${input.provider}; run opencode auth login ${input.provider}`);
    if (input.cap_usd !== undefined && !(Number.isFinite(input.cap_usd) && input.cap_usd > 0)) throw Error("cap_usd must be a positive number");
    const usage = classify({ id: input.provider }, (deps.catalog ?? readCachedCatalog(ctx))?.providers[input.provider]);
    const kind = input.usage ?? usage.usage;
    const account: Record<string, unknown> = { kind: "endpoint", source: "opencode", provider: input.provider, usage: kind };
    if (kind === "metered" && input.cap_usd !== undefined) account.budget = { weekly_usd: input.cap_usd };
    if (kind === "quota" && usage.quota_source) account.quota_source = usage.quota_source;
    const id = `opencode#${name}`;
    const change = (doc: StrategyDoc) => { doc.addMappingEntry("accounts", name, account); addRunnerAndRoute(doc, s, id, `${input.provider}/${input.model}`); };
    const preview = new StrategyDoc(readFileSync(strategyPath(ctx), "utf8")); change(preview);
    validateStrategy(Bun.YAML.parse(preview.toString()), strategyPath(ctx));
    edit(change);
    writeEndpointState(ctx, name, { state: "not_tested" });
    const state: EndpointState = input.test !== false ? await testEndpoint(ctx, name, deps) : readEndpointState(ctx, name);
    const updated = loadStrategy(ctx);
    return { account: updated.accounts[name], runner: updated.runners[id] as RunnerCfg, ...state };
  } catch (e) {
    if (e instanceof CoreError) throw e;
    throw new CoreError("invalid_input", e instanceof Error ? e.message : String(e));
  }
}

async function defaultLogin(ctx: Ctx, argv: string[]): Promise<number> {
  return Bun.spawn(argv, { env: ctx.env as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}
export async function connectProvider(ctx: Ctx, provider: string, deps: SetupDeps = {}): Promise<boolean> {
  const code = await (deps.login ?? (argv => defaultLogin(ctx, argv)))(["opencode", "auth", "login", provider]);
  if (code !== 0) return false;
  return (await signedInProviders(ctx))?.some(p => p.id === provider) ?? false;
}

/** Connect a catalog provider from a client that cannot run an interactive CLI (the app). OpenCode stores provider
 * keys; pacer must not put a key in argv, logs or state (security rules), and `opencode auth login` reading a key
 * from stdin could not be confirmed without changing a real OpenCode login. So nothing runs here: the caller shows
 * the command, and the user signs in through OpenCode in a terminal. */
export async function connectWithKey(_ctx: Ctx, provider: string): Promise<{ connected: boolean; command: string }> {
  return { connected: false, command: `opencode auth login ${provider}` };
}
