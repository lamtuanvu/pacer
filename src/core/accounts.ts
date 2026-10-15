import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep, parse } from "node:path";
import { parseSize } from "../config/accounts";
import { editStrategy } from "../config/edit";
import { loadStrategy, strategyPath, type Strategy } from "../config/strategy";
import { accountFolder } from "../install/role";
import { shq } from "../install/fsx";
import { readOrcaAccounts } from "../orca/accounts";
import { readAccountUsage } from "../usage";
import { CoreError, toCoreError } from "./errors";
import type { Ctx } from "../types";

export function requireAccounts(strategy: Strategy): void {
  if (strategy.legacy) throw new CoreError("invalid_input", "Run pacer config migrate before editing accounts or runners.", "Run pacer config migrate.");
}
export function applyEdit(ctx: Ctx, change: Parameters<typeof editStrategy>[1]): string {
  const result = editStrategy(strategyPath(ctx), change);
  if (!result.ok) throw new CoreError("invalid_input", result.error, "Check the strategy values and retry.");
  return result.diff;
}
/** A delete-home operation must never remove a shared, default, or symlinked folder. */
export function deletionHome(ctx: Ctx, s: Strategy, name: string): string {
  const account = s.accounts[name];
  if (account.source !== "pacer") throw Error("--delete-home is only available for pacer-managed accounts");
  const folder = accountFolder(ctx, account)!;
  if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) throw Error("refusing to delete a symlinked account home");
  const canonical = (p: string) => existsSync(p) ? realpathSync(p) : resolve(p);
  const target = canonical(folder);
  if (target === parse(target).root) throw Error("refusing to delete a protected account home");
  const protectedPaths = [ctx.home, ctx.pacerHome, join(ctx.home,'.claude'), join(ctx.home,'.codex'), ...Object.values(s.accounts).filter(a => a.name !== name).map(a => accountFolder(ctx,a)).filter((p):p is string=>!!p)];
  if (protectedPaths.some(p => {const c=canonical(p); return c===target || c.startsWith(target+sep);})) throw Error("refusing to delete a protected or shared account home");
  return folder;
}

// Orca ids, labels and resolved folder paths may contain an account email.
function publicValue<T>(value: T): T {
  if (typeof value === "string") return (value.includes("@") ? "[redacted]" : value) as T;
  if (Array.isArray(value)) return value.map(publicValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicValue(v)])) as T;
  return value;
}
export async function list(ctx: Ctx) {
  const s = loadStrategy(ctx);
  const orca = await readOrcaAccounts(ctx);
  const rows = await Promise.all(Object.values(s.accounts).map(async a => {
    const runners = Object.values(s.runners).filter(r=>r.account===a.name);
    const identity = a.orcaAccount && (a.kind === "claude" || a.kind === "codex") ? orca?.[a.kind].find(v=>v.id===a.orcaAccount) : undefined;
    const folder = accountFolder(ctx,a);
    const usageReading = await readAccountUsage({...ctx,readOnly:true},a,runners);
    return {...a, label: identity?.label ?? a.name, folder, runners:runners.map(r=>r.id), signedIn: identity ? true : null,
      runnable: a.source !== "orca" || folder !== null, usageReading};
  }));
  return rows.map(row => {
    const native = row.kind === "claude" || row.kind === "codex";
    const folder = row.folder ?? (row.kind === "codex" ? join(ctx.home, ".codex") : join(ctx.home, ".claude"));
    const signin = native && row.signedIn !== true
      ? `${row.kind === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}=${shq(folder)} ${row.kind === "codex" ? "codex login" : "claude\n# Then run /login to sign in."}` : undefined;
    // Runner ids are validated identifiers; their @host suffix is not an email.
    return {...publicValue({...row, ...(signin ? {signin_command: signin} : {})}), runners: row.runners};
  });
}

// Extended options preserve the existing CLI's endpoint and Orca-link workflows.
export interface AddOptions {
  kind: string; name: string; home?: string; orca?: string; usage?: string;
  quotaSource?: string; weeklyTokens?: string; noLogin?: boolean;
}
export async function add(ctx: Ctx, options: AddOptions) {
  try {
    const s = loadStrategy(ctx); requireAccounts(s);
    const {kind, name} = options;
    const flags: Record<string, string | true> = {};
    for (const [key, value] of Object.entries({home: options.home, orca: options.orca, usage: options.usage, "quota-source": options.quotaSource, "weekly-tokens": options.weeklyTokens, "no-login": options.noLogin || undefined})) if (value !== undefined) flags[key] = value;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw Error("account name must contain lowercase letters, digits and hyphens");
    if (s.accounts[name]) throw Error(`account ${name} already exists`);
    if (!['claude','codex','endpoint'].includes(kind)) throw Error("only claude, codex and endpoint accounts can be added");
    const value: Record<string,unknown> = {kind}; let folder: string | null = null;
    if (flags.orca) {
      if (kind !== 'claude' && kind !== 'codex') throw Error("Orca links require claude or codex");
      if (Object.keys(flags).some(k=>k!=='orca')) throw Error("--orca cannot be combined with home, login or endpoint options");
      const data = await readOrcaAccounts(ctx);
      if (!data?.[kind].some(a=>a.id===flags.orca)) throw Error("Orca account id not found for that kind");
      value.orca_account=flags.orca;
    } else if (kind === 'endpoint') {
      if (flags.home || flags['no-login']) throw Error("endpoint accounts do not have a home or login");
      if (!['quota','metered','unmetered'].includes(String(flags.usage))) throw Error("endpoint requires --usage quota, metered or unmetered");
      value.usage = flags.usage;
      if (flags['quota-source']) {
        if (flags['quota-source'] !== 'arkcli' || flags.usage !== 'quota') throw Error("--quota-source arkcli requires quota usage");
        value.quota_source=flags['quota-source'];
      }
      if (flags['weekly-tokens']) {
        const n=parseSize(flags['weekly-tokens']); if (n===null || !Number.isFinite(n) || n<=0 || flags.usage !== 'metered') throw Error("--weekly-tokens requires a positive metered budget");
        value.budget={weekly_tokens:n};
      }
    } else {
      if (flags.usage || flags['quota-source'] || flags['weekly-tokens']) throw Error("usage options are only supported for endpoints");
      folder=resolve(typeof flags.home==='string' ? flags.home.replace(/^~(?=\/|$)/,ctx.home) : join(ctx.home,`.${kind}-${name}`));
      if (existsSync(folder)) throw Error("account home already exists; choose a new folder");
      value.home=folder;
    }
    // Validate before creating a folder; the edit writes no bytes on refusal.
    const diff=applyEdit(ctx,doc=>doc.addMappingEntry('accounts',name,value));
    if (folder) {
      try { mkdirSync(folder,{recursive:true,mode:0o700}); chmodSync(folder,0o700); }
      catch(e) {applyEdit(ctx,doc=>doc.removeMappingEntry('accounts',name)); throw e;}
    }
    return {account: loadStrategy(ctx).accounts[name], folder, diff};
  } catch (e) {
    const error = toCoreError(e);
    throw new CoreError(error.code, error.message, error.hint ?? "Check the account name, options and configured accounts.");
  }
}

export function remove(ctx: Ctx, name: string, {deleteHome = false}: {deleteHome?: boolean} = {}) {
  try {
    const s = loadStrategy(ctx); requireAccounts(s);
    const a = s.accounts[name]; if (!a) throw Error(`unknown account: ${name}`);
    if (s.planner.account === name || Object.values(s.runners).some(r => r.account === name)) throw new CoreError("conflict", `account ${name} is in use`, "Remove its runners and change the planner first.");
    const folder = deleteHome ? deletionHome(ctx, s, name) : null;
    const diff = applyEdit(ctx, doc => doc.removeMappingEntry('accounts', name));
    if (folder) rmSync(folder, {recursive: true, force: true});
    return {removed: true as const, diff};
  } catch (e) {
    const error = toCoreError(e);
    throw new CoreError(error.code, error.message, error.hint ?? "Check the account name, options and configured accounts.");
  }
}
