import { isObj } from "../util";

export interface HostCfg {
  alias: string;
  ssh: string;
  repos: Record<string, string>;
  maxTasks: number;
  accounts: Record<string, { home: string }>;
}

const aliasPattern = /^[a-z0-9][a-z0-9-]*$/;
const canonicalPattern = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9._-]+\/[a-z0-9._-]+$/;
const canonical = (key: string) => canonicalPattern.test(key) && !key.endsWith(".git");

/** Return the canonical host/owner/repo identity of a supported git URL. */
export function repoKey(url: string): string | null {
  let host: string, path: string;
  const scp = /^[^@\s/:]+@([A-Za-z0-9.-]+):([^\s]+)$/.exec(url);
  if (scp) [host, path] = [scp[1], scp[2]];
  else {
    try {
      const parsed = new URL(url);
      if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.search || parsed.hash || parsed.password) return null;
      host = parsed.hostname;
      path = parsed.pathname.slice(1);
    } catch { return null; }
  }
  const key = `${host}/${path}`.toLowerCase().replace(/\.git$/, "");
  return canonical(key) ? key : null;
}

export function parseHosts(raw: unknown, problems: string[]): Record<string, HostCfg> {
  const hosts: Record<string, HostCfg> = {};
  if (raw === undefined) return hosts;
  if (!isObj(raw)) { problems.push("hosts must be a mapping"); return hosts; }
  const unknownKeys = (value: Record<string, unknown>, allowed: string[], at: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${at}: unknown key ${key}`);
  };
  for (const [alias, value] of Object.entries(raw)) {
    const at = `hosts.${alias}`;
    if (alias === "local") problems.push('hosts: "local" is reserved');
    if (!aliasPattern.test(alias)) problems.push(`${at}: invalid host alias`);
    if (!isObj(value)) { problems.push(`${at} must be a mapping`); continue; }
    unknownKeys(value, ["ssh", "repos", "max_tasks", "accounts"], at);
    if (typeof value.ssh !== "string" || !/^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/.test(value.ssh)) problems.push(`${at}.ssh must be an ssh alias`);
    const maxTasks = value.max_tasks === undefined ? 2 : value.max_tasks;
    if (typeof maxTasks !== "number" || !Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 16) problems.push(`${at}.max_tasks must be 1..16`);
    const repos: Record<string, string> = {};
    // repos is optional: an unmapped repo is excluded at routing time with a hint.
    if (value.repos !== undefined && !isObj(value.repos)) problems.push(`${at}.repos must be a mapping`);
    else for (const [key, path] of Object.entries(isObj(value.repos) ? value.repos : {})) {
      if (!canonical(key)) problems.push(`${at}.repos: ${key} is not a canonical repo key (host/owner/repo)`);
      if (typeof path !== "string" || !path.trim()) problems.push(`${at}.repos.${key} must be a non-empty path`);
      else Object.defineProperty(repos, key, { value: path, enumerable: true, configurable: true, writable: true });
    }
    const accounts: Record<string, { home: string }> = {};
    if (value.accounts !== undefined && !isObj(value.accounts)) problems.push(`${at}.accounts must be a mapping`);
    for (const [account, cfg] of Object.entries(isObj(value.accounts) ? value.accounts : {})) {
      const accountAt = `${at}.accounts.${account}`;
      if (!aliasPattern.test(account)) problems.push(`${accountAt}: invalid account name`);
      if (!isObj(cfg)) { problems.push(`${accountAt} must be a mapping`); continue; }
      unknownKeys(cfg, ["home"], accountAt);
      if (typeof cfg.home !== "string" || !cfg.home.trim()) problems.push(`${accountAt}.home must be a non-empty folder`);
      else accounts[account] = { home: cfg.home };
    }
    hosts[alias] = { alias, ssh: typeof value.ssh === "string" ? value.ssh : "", repos, maxTasks: typeof maxTasks === "number" ? maxTasks : 2, accounts };
  }
  return hosts;
}
