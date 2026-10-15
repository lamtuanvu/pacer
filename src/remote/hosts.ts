import { type HostCfg, repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { applyEdit } from "../core/accounts";
import { CoreError } from "../core/errors";
import { shq } from "../install/fsx";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES } from "../tasks/types";
import type { Ctx } from "../types";
import { SCRIPTS } from "./scripts";
import { runRemote } from "./ssh";
import { transferred } from "./transfer";
import { probeCodexUsage } from "./usage";

export interface HostCheck { alias: string; ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }
const fields = (s: string): Record<string, string> => Object.fromEntries(s.split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
function configured(ctx: Ctx, alias: string): HostCfg {
  const hosts = loadStrategy(ctx).hosts;
  const host = Object.hasOwn(hosts, alias) ? hosts[alias] : undefined;
  if (!host) throw new CoreError("invalid_input", `unknown host ${alias}`);
  return host;
}
async function localRepo(ctx: Ctx, path: string) {
  const git = async (...args: string[]) => {
    const r = await ctx.run(["git", "-C", path, ...args], 10000);
    return r.code === 0 ? r.stdout.trim() : "";
  };
  const origin = await git("remote", "get-url", "origin");
  return { origin, key: repoKey(origin), name: await git("config", "user.name"), email: await git("config", "user.email") };
}

export function list(ctx: Ctx) {
  const s = loadStrategy(ctx), tasks = listTasks(ctx, Infinity);
  return Object.values(s.hosts).map(h => ({ alias: h.alias, ssh: h.ssh, maxTasks: h.maxTasks,
    repos: Object.keys(h.repos), runners: Object.values(s.runners).filter(r => r.host === h.alias).map(r => r.id),
    running: tasks.filter(t => t.state === "running" && t.run?.host === h.alias).length }));
}

export async function check(ctx: Ctx, alias: string, o: { repo?: string } = {}): Promise<HostCheck> {
  const host = configured(ctx, alias), s = loadStrategy(ctx), local = await localRepo(ctx, o.repo ?? process.cwd());
  if (o.repo && (!local.key || !host.repos[local.key])) throw new CoreError("invalid_input", `repo not mapped on ${alias}`);
  const repos = o.repo ? [[local.key!, host.repos[local.key!]]] : Object.entries(host.repos);
  const agents = new Set(Object.values(s.runners).filter(r => r.host === alias).map(r => r.agent));
  const names = ["ssh", "git", "setsid", ...(agents.has("codex") ? ["codex"] : []), ...(agents.has("claude-code") ? ["claude"] : []), "account homes", ...repos.flatMap(([key]) => [`checkout ${key}`, `identity ${key}`])];
  const checks: HostCheck["checks"] = [];
  const add = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok, detail }); };
  // A no-op isolates connectivity from tool failures in the diagnostic probe.
  const connected = await runRemote(ctx, host, SCRIPTS.ECHO_STDIN, [], { stdin: "", timeoutMs: 15000 }).catch(() => null);
  if (!connected || connected.code !== 0) {
    return { alias, ok: false, checks: names.map(name => ({ name, ok: false, detail: name === "ssh" ? "unreachable" : "skipped" })) };
  }
  add("ssh", true);
  const probe = await runRemote(ctx, host, SCRIPTS.PROBE, []).catch(() => null), tools = fields(probe?.stdout ?? "");
  const version = /git version (\d+)\.(\d+)/.exec(tools.git ?? "");
  const gitOk = !!version && (+version[1] > 2 || (+version[1] === 2 && +version[2] >= 30));
  add("git", gitOk, gitOk ? tools.git : `${tools.git || "git missing"} < 2.30`);
  add("setsid", !!tools.setsid, tools.setsid || "missing");
  for (const agent of ["codex", "claude"]) if (names.includes(agent)) add(agent, !!tools[agent], tools[agent] || "missing");
  const missing: string[] = [];
  for (const [account, cfg] of Object.entries(host.accounts)) {
    const r = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [cfg.home, "home"]);
    if (r.code) missing.push(account);
  }
  add("account homes", !missing.length, missing.length ? `missing: ${missing.join(", ")}` : "");
  for (const [key, path] of repos) {
    const r = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [path, "check"]), facts = fields(r.stdout);
    const checkoutOk = r.code === 0 && facts.git === "1" && repoKey(facts.origin ?? "") === key;
    add(`checkout ${key}`, checkoutOk, checkoutOk ? "" : facts.exists !== "1" ? "missing checkout" : facts.git !== "1" ? "not a git checkout" : "origin mismatch");
    const identityOk = !!local.name && !!local.email && facts.name === local.name && facts.email === local.email;
    // Never put identity values or remote paths in returned diagnostics.
    add(`identity ${key}`, identityOk, identityOk ? "" : "repo-local identity does not match local repo");
  }
  const accounts = new Set(Object.values(s.runners).filter(r => r.host === alias && r.agent === "codex").map(r => r.account));
  for (const account of accounts) await probeCodexUsage(ctx, host, s.accounts[account]);
  return { alias, ok: checks.every(c => c.ok), checks };
}

export async function setup(ctx: Ctx, alias: string, repo: string, confirm: (question: string) => Promise<boolean>): Promise<HostCheck> {
  const host = configured(ctx, alias), local = await localRepo(ctx, repo), path = local.key && host.repos[local.key];
  if (!path) throw new CoreError("invalid_input", `repo not mapped on ${alias}`);
  const r = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [path, "check"]);
  if (r.code) throw new CoreError("invalid_input", `host ${alias} unreachable`);
  if (fields(r.stdout).exists !== "1") {
    const target = path.startsWith("~/") ? `"$HOME"/${shq(path.slice(2))}` : shq(path);
    const command = `git clone -- ${shq(local.origin)} ${target}`;
    if (await confirm(`Run on ${alias}: ${command}?`)) {
      const cloned = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [path, "clone", local.origin]);
      if (cloned.code) throw new CoreError("invalid_input", `clone failed on ${alias}`);
    }
  }
  if (!local.name || !local.email) throw new CoreError("invalid_input", "local repo needs user.name and user.email");
  if (await confirm(`Set repo-local identity on ${alias} to ${local.name} <${local.email}>?`)) {
    const set = await runRemote(ctx, host, SCRIPTS.SET_IDENTITY, [path, local.name, local.email]);
    if (set.code) throw new CoreError("invalid_input", `identity setup failed on ${alias}`);
  }
  return check(ctx, alias, { repo });
}

/** Host-only cleanup; preserve branches whose results have not been transferred. */
export async function clean(ctx: Ctx, alias: string) {
  const host = configured(ctx, alias), removed: string[] = [], kept: { id: string; reason: string }[] = [];
  for (const t of listTasks(ctx, Infinity)) {
    if (t.run?.host !== alias || t.run.mode !== "new" || !TERMINAL_STATES.includes(t.state) || !(t.review || t.dismissed || t.resolved)) continue;
    try {
      const local = await localRepo(ctx, t.brief.repo), checkout = local.key && host.repos[local.key];
      if (!checkout || !t.run.remoteWorktree || !t.run.remoteDir) {
        kept.push({ id: t.id, reason: "remote cleanup needs a configured host, checkout and run" }); continue;
      }
      const r = await runRemote(ctx, host, SCRIPTS.CLEAN, [t.run.remoteWorktree, t.run.remoteDir, checkout, t.id, await transferred(ctx, t) ? (t.run.remoteBranch ?? `pacer/${t.id}`) : ""]);
      if (r.code) kept.push({ id: t.id, reason: "remote cleanup failed" });
      else removed.push(t.id);
    } catch { kept.push({ id: t.id, reason: "remote cleanup failed" }); }
  }
  return { removed, kept };
}

/** Add an SSH alias using the strategy validator, without connecting to it. */
export function add(ctx: Ctx, {alias, ssh}: {alias: string; ssh: string}) {
  const s = loadStrategy(ctx);
  if (alias === "local" || !/^[a-z0-9][a-z0-9-]*$/.test(alias)) throw new CoreError("invalid_input", "invalid or reserved host alias", "Use lowercase letters, digits and hyphens; local is reserved.");
  if (Object.hasOwn(s.hosts, alias)) throw new CoreError("conflict", `host ${alias} already exists`, "Choose a different alias or remove the existing host.");
  applyEdit(ctx, doc => doc.setIn(["hosts", alias], {ssh}));
  return {alias};
}
export function remove(ctx: Ctx, alias: string) {
  if (alias === "local") throw new CoreError("invalid_input", "local is reserved", "Only configured SSH hosts can be removed.");
  const s = loadStrategy(ctx);
  configured(ctx, alias);
  if (Object.values(s.runners).some(r => r.host === alias)) throw new CoreError("conflict", `host ${alias} is in use`, "Remove its runners first.");
  applyEdit(ctx, doc => doc.deleteIn(["hosts", alias]));
  return {removed: true as const};
}
