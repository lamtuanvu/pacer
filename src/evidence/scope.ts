import { createHash } from "node:crypto";
import type { AccountCfg } from "../config/accounts";
import type { EvidenceScope } from "./types";
import type { HostCfg } from "../config/hosts";

export function accountEvidenceScope(account: AccountCfg, hosts: Record<string, HostCfg> = {}): EvidenceScope {
  const identity = createHash("sha256").update(JSON.stringify([account.name, account.kind, account.source,
    account.home, account.orcaAccount, account.usageSource, account.quotaSource,
    account.connection?.base_url, account.connection?.key,
    Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b)).map(([alias, host]) =>
      [alias, host.ssh, host.accounts[account.name]?.home ?? null]),
    ...(account.provider ? [account.provider] : [])])).digest("hex");
  return { account: account.name, identity };
}
