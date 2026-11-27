import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { isObj } from "../util";
import type { AccountCfg } from "../config/accounts";
import { accountFolder } from "../install/role";
import type { AvailableModel } from "./available";

// Model lists of the native agents for Dispatcher › Agents › Add a model. The Rust twin is
// crates/models/src/agent_listings.rs; both must read the same lines and files alike.

/** `cursor-agent models` and `agy models` may reach the vendor's service; a hung CLI must not hold the request. */
export const AGENT_LIST_TIMEOUT_MS = 30000;

/** Ids are printable ASCII without spaces: the form both CLIs and the Codex cache use, and what `--model` takes. */
function plainId(value: string): boolean {
  return value.length > 0 && /^[\x21-\x7e]+$/.test(value);
}

/** The same set of characters as String.prototype.trim (and the Rust twin's `trim`). */
const trim = (value: string) => value.trim();

/** Each id once, in listing order. */
function once(models: AvailableModel[]): AvailableModel[] {
  const seen = new Set<string>();
  return models.filter(m => !seen.has(m.id) && (seen.add(m.id), true));
}

/** "Auto (current, default)" -> "Auto": a trailing group of only `current` / `default` words is a marker, not the name. */
function withoutMarker(name: string): string {
  const open = name.lastIndexOf("(");
  if (open < 0 || !name.endsWith(")")) return name;
  const words = name.slice(open + 1, -1).split(",").map(trim);
  return words.every(word => word === "current" || word === "default") ? trim(name.slice(0, open)) : name;
}

/** `cursor-agent models`: a heading, then `id - Name` lines; the current model carries "(current, default)". */
export function parseCursorModels(stdout: string): AvailableModel[] {
  const models: AvailableModel[] = [];
  for (const raw of stdout.split("\n")) {
    const line = trim(raw);
    const at = line.indexOf(" - ");
    if (at < 0) continue;
    const id = line.slice(0, at), name = withoutMarker(trim(line.slice(at + 3)));
    if (!plainId(id)) continue;
    models.push(name ? { id, name } : { id });
  }
  return once(models);
}

/** `agy models`: "Fetching available models...", then `id<TAB>Name` lines. */
export function parseAgyModels(stdout: string): AvailableModel[] {
  const models: AvailableModel[] = [];
  for (const raw of stdout.split("\n")) {
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const id = trim(raw.slice(0, tab)), name = trim(raw.slice(tab + 1));
    if (!plainId(id)) continue;
    models.push(name ? { id, name } : { id });
  }
  return once(models);
}

/**
 * `<CODEX_HOME>/models_cache.json`, which Codex writes for its own model picker. Only entries Codex itself lists
 * (`visibility: "list"`, or no visibility field in older caches) are offered: "hide" marks internal models such as
 * `codex-auto-review` and reserved ones. Returns null when the file is not a model cache.
 */
export function parseCodexCache(text: string): AvailableModel[] | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isObj(value) || !Array.isArray(value.models)) return null;
  const models: AvailableModel[] = [];
  for (const entry of value.models) {
    if (!isObj(entry) || typeof entry.slug !== "string" || !plainId(entry.slug)) continue;
    if ("visibility" in entry && entry.visibility !== "list") continue;
    const model: AvailableModel = { id: entry.slug };
    if (typeof entry.display_name === "string" && entry.display_name) model.name = entry.display_name;
    const context = entry.context_window;
    if (typeof context === "number" && Number.isFinite(context) && context > 0) model.context = context;
    models.push(model);
  }
  return once(models);
}

/** The folder Codex runs in for this account, as pacer launches it: a named folder, else the user's `~/.codex`. */
export function codexHome(ctx: Ctx, account: AccountCfg): string | null {
  if (account.source === "default") return join(ctx.home, ".codex");
  return accountFolder(ctx, account);
}

export interface AgentListing { models: AvailableModel[] | null; note?: string }

export function codexModels(ctx: Ctx, account: AccountCfg): AgentListing {
  const home = codexHome(ctx, account);
  if (!home) return { models: null, note: "Codex's folder for this account was not found" };
  let text: string;
  try {
    text = readFileSync(join(home, "models_cache.json"), "utf8");
  } catch (error) {
    return { models: null, note: (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Codex has not saved a model list yet; start Codex once with this account"
      : "Codex's saved model list could not be read" };
  }
  const models = parseCodexCache(text);
  if (models === null) return { models: null, note: "Codex's saved model list could not be read" };
  // An empty list is unknown, never "no models".
  if (!models.length) return { models: null, note: "Codex's saved model list has no models; start Codex once to refresh it" };
  return { models };
}

const CLI = {
  cursor: { argv: ["cursor-agent", "models"], parse: parseCursorModels, label: "Cursor" },
  agy: { argv: ["agy", "models"], parse: parseAgyModels, label: "Antigravity" },
} as const;

/** Run the agent's own `models` command with the service's environment, as pacer launches the agent. */
export async function cliModels(ctx: Ctx, agent: keyof typeof CLI): Promise<AgentListing> {
  const cli = CLI[agent];
  let r;
  try { r = await ctx.run([...cli.argv], AGENT_LIST_TIMEOUT_MS); } catch { r = null; }
  if (!r || r.code !== 0 || r.timedOut) return { models: null, note: `${cli.label} could not list its models` };
  const models = cli.parse(r.stdout);
  if (!models.length) return { models: null, note: `${cli.label} lists no models; check that it is signed in` };
  return { models };
}
