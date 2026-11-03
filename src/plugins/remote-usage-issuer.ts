import { loadStrategy } from "../config/strategy";
import type { AccountCfg } from "../config/accounts";
import type { HostCfg } from "../config/hosts";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredRemoteUsageGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured {
  home: string;
  alias: string;
  account: string;
  hostFingerprint: string;
  accountFingerprint: string;
  args: readonly string[];
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredRemoteUsageGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "remote usage grant changed or was not issued"); };

function tuple(ctx: Ctx, host: HostCfg, account: AccountCfg) {
  const strategy = loadStrategy(ctx), configured = strategy.hosts[host.alias];
  const selected = strategy.accounts[account.name];
  if (!configured || configured.paused || JSON.stringify(configured) !== JSON.stringify(host) ||
    !selected || selected.kind !== "codex" || JSON.stringify(selected) !== JSON.stringify(account)) return deny();
  const accountHome = configured.accounts[account.name]?.home;
  if (accountHome && (accountHome.length > 4096 || /[\u0000-\u001f\u007f]/.test(accountHome) ||
    !(accountHome.startsWith("/") || accountHome.startsWith("~/")))) return deny();
  return { host: configured, account: selected, args: accountHome ? [accountHome] : [] };
}

/** Host-only snapshot of one configured Codex account on one configured SSH host. */
export function issueConfiguredRemoteUsage(ctx: Ctx, host: HostCfg,
  account: AccountCfg): ConfiguredRemoteUsageGrant {
  const selected = tuple(ctx, host, account);
  const resource: HostOperationResource = Object.freeze({ alias: host.alias,
    hostFingerprint: JSON.stringify(selected.host), script: "CODEX_USAGE",
    args: [...selected.args], timeoutMs: 60_000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias: host.alias, account: account.name,
    hostFingerprint: resource.hostFingerprint, accountFingerprint: JSON.stringify(selected.account),
    args: resource.args, consumed: false });
  return grant;
}

export function validateConfiguredRemoteUsage(ctx: Ctx, grant: ConfiguredRemoteUsageGrant): void {
  const saved = issued.get(grant), resource = grant.resource;
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const strategy = loadStrategy(ctx), host = strategy.hosts[saved.alias], account = strategy.accounts[saved.account];
  if (!host || host.paused || !account || account.kind !== "codex" ||
    JSON.stringify(host) !== saved.hostFingerprint ||
    JSON.stringify(account) !== saved.accountFingerprint ||
    resource.alias !== saved.alias || resource.hostFingerprint !== saved.hostFingerprint ||
    resource.script !== "CODEX_USAGE" || resource.timeoutMs !== 60_000 ||
    resource.maxBytes !== 65_536 ||
    JSON.stringify(resource.args) !== JSON.stringify(saved.args) ||
    JSON.stringify(host.accounts[saved.account]?.home ? [host.accounts[saved.account]!.home] : []) !== JSON.stringify(saved.args))
    return deny();
}

export function consumeConfiguredRemoteUsage(ctx: Ctx, grant: ConfiguredRemoteUsageGrant): void {
  validateConfiguredRemoteUsage(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
