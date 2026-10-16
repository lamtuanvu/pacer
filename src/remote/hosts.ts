import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { listJobs, startJob, type StepApi } from "../jobs/registry";
import { type HostCfg, repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { applyEdit } from "../core/accounts";
import { CoreError } from "../core/errors";
import { shq } from "../install/fsx";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES } from "../tasks/types";
import type { Ctx } from "../types";
import { readHostReachability } from "./eligibility";
import { sshAliases } from "./ssh-config";
import { SCRIPTS } from "./scripts";
import { runRemote } from "./ssh";
import { transferred } from "./transfer";
import { probeCodexUsage } from "./usage";

export interface HostFacts {
  os: string | null;
  arch: string | null;
  git: string | null;
  setsid: string | null;
  tools: { codex?: string; claude?: string };
}
export interface HostCheck { alias: string; ok: boolean; checks: { name: string; ok: boolean; detail: string }[]; facts: HostFacts }
export type StoredHostCheck = Omit<HostCheck, "alias"> & { at: number };
const checkFile = (ctx: Ctx) => join(ctx.pacerHome, "state", "host-checks.json");
export function readHostCheck(ctx: Ctx, alias: string): StoredHostCheck | null {
  const stored = readJson<Record<string, StoredHostCheck>>(checkFile(ctx));
  return stored && Object.hasOwn(stored, alias) ? stored[alias] : null;
}
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

export interface HostSummary {
  alias: string;
  ssh: string;
  maxTasks: number;
  paused: boolean;
  state: "paused" | "down" | "checking" | "needs_setup" | "ready";
  repos: string[];
  runners: string[];
  running: number;
  slots: { used: number; max: number };
}
export interface HostDetail extends Omit<HostSummary, "repos"> {
  checkedAt: number | null;
  reachableAt: number | null;
  facts: HostFacts | null;
  checks: HostCheck["checks"];
  executors: string[];
  doneThisWeek: { done: number; accepted: number };
  repos: { key: string; path: string; origin: "matches" | "differs" | "no_checkout" | "unknown"; identity: "matches" | "differs" | "unknown" }[];
  accounts: { name: string; home: string; signedIn: boolean | null }[];
  worktrees: { branch: string; state: string; fate: "will remove" | "in use" | "kept" }[];
}
function summary(ctx: Ctx, host: HostCfg): HostSummary {
  const s = loadStrategy(ctx), stored = readHostCheck(ctx, host.alias), reachability = readHostReachability(ctx, host);
  const running = listTasks(ctx, Infinity).filter(t => t.state === "running" && t.run?.host === host.alias).length;
  const state = host.paused ? "paused" : (reachability?.failures ?? 0) >= 2 ? "down"
    : listJobs(ctx, { target: host.alias }).some(j => j.kind === "host.check" && j.state === "running") ? "checking"
    : stored?.checks.some(c => !c.ok) ? "needs_setup" : "ready";
  return { alias: host.alias, ssh: host.ssh, maxTasks: host.maxTasks, paused: host.paused ?? false, state,
    repos: Object.keys(host.repos), runners: Object.values(s.runners).filter(r => r.host === host.alias).map(r => r.id),
    running, slots: { used: running, max: host.maxTasks } };
}
export function list(ctx: Ctx): HostSummary[] {
  return Object.values(loadStrategy(ctx).hosts).map(host => summary(ctx, host));
}
export function suggest(ctx: Ctx): string[] {
  const used = new Set(Object.values(loadStrategy(ctx).hosts).map(h => h.ssh));
  return sshAliases(ctx.home).filter(alias => !used.has(alias));
}
export function set(ctx: Ctx, alias: string, o: { max_tasks?: number; paused?: boolean }): HostSummary {
  configured(ctx, alias);
  applyEdit(ctx, doc => {
    if (o.max_tasks !== undefined) doc.setIn(["hosts", alias, "max_tasks"], o.max_tasks);
    if (o.paused !== undefined) doc.setIn(["hosts", alias, "paused"], o.paused);
  });
  return summary(ctx, configured(ctx, alias));
}
export function detail(ctx: Ctx, alias: string): HostDetail {
  const host = configured(ctx, alias), row = summary(ctx, host), stored = readHostCheck(ctx, alias);
  const checks = stored?.checks ?? [];
  const done = listTasks(ctx, Infinity).filter(t => {
    // Old task records have no updatedAt; use their persisted completion/review time.
    const at = (t as typeof t & { updatedAt?: number }).updatedAt ?? t.review?.at ?? t.attempts.at(-1)?.endedAt ?? t.createdAt;
    return t.run?.host === alias && t.state === "done" && at >= ctx.now - 7 * 86400 && at <= ctx.now;
  });
  return { ...row, checkedAt: stored?.at ?? null, reachableAt: readHostReachability(ctx, host)?.at ?? null,
    facts: stored?.facts ?? null, checks, executors: row.runners,
    doneThisWeek: { done: done.length, accepted: done.filter(t => t.review?.accepted).length },
    repos: Object.entries(host.repos).map(([key, path]) => {
      const checkout = checks.find(c => c.name === `checkout ${key}`), identity = checks.find(c => c.name === `identity ${key}`);
      return { key, path, origin: !checkout || checkout.detail === "skipped" ? "unknown" : checkout.ok ? "matches"
        : checkout.detail === "origin mismatch" ? "differs" : "no_checkout",
        identity: !identity || identity.detail === "skipped" ? "unknown" : identity.ok ? "matches" : "differs" };
    }),
    accounts: Object.entries(host.accounts).map(([name, cfg]) => ({ name, home: cfg.home, signedIn: null })),
    // Cleanup previews are supplied by phase 3c Task 4.
    worktrees: [] };
}

async function prepareCheck(ctx: Ctx, alias: string, o: { repo?: string }) {
  const host = configured(ctx, alias), s = loadStrategy(ctx), local = await localRepo(ctx, o.repo ?? process.cwd());
  if (o.repo && (!local.key || !host.repos[local.key])) throw new CoreError("invalid_input", `repo not mapped on ${alias}`);
  const repos = o.repo ? [[local.key!, host.repos[local.key!]]] : Object.entries(host.repos);
  const agents = new Set(Object.values(s.runners).filter(r => r.host === alias).map(r => r.agent));
  const names = ["ssh", "git", "setsid", ...(agents.has("codex") ? ["codex"] : []), ...(agents.has("claude-code") ? ["claude"] : []), "account homes", ...repos.flatMap(([key]) => [`checkout ${key}`, `identity ${key}`])];
  return { host, s, local, repos, names };
}
export async function checkJob(ctx: Ctx, alias: string, o: { repo?: string } = {}) {
  const prepared = await prepareCheck(ctx, alias, o);
  return startJob(ctx, "host.check", alias, prepared.names, async steps => {
    await performCheck(ctx, alias, prepared, steps);
  });
}
export async function check(ctx: Ctx, alias: string, o: { repo?: string; steps?: StepApi } = {}): Promise<HostCheck> {
  return performCheck(ctx, alias, await prepareCheck(ctx, alias, o), o.steps);
}
async function performCheck(ctx: Ctx, alias: string, { host, s, local, repos, names }: Awaited<ReturnType<typeof prepareCheck>>, steps?: StepApi): Promise<HostCheck> {
  const checks: HostCheck["checks"] = [];
  const facts: HostFacts = { os: null, arch: null, git: null, setsid: null, tools: {} };
  const finish = (): HostCheck => {
    const result = { ok: checks.every(c => c.ok), checks, facts };
    if (!ctx.readOnly) writeJsonAtomic(checkFile(ctx), { ...(readJson<Record<string, StoredHostCheck>>(checkFile(ctx)) ?? {}), [alias]: { at: ctx.now, ...result } });
    return { alias, ...result };
  };
  const add = (name: string, ok: boolean, detail = "") => {
    checks.push({ name, ok, detail });
    if (detail === "skipped") steps?.skip(name, detail);
    else if (ok) steps?.pass(name, detail);
    else steps?.fail(name, detail);
  };
  steps?.start("ssh");
  // A no-op isolates connectivity from tool failures in the diagnostic probe.
  const connected = await runRemote(ctx, host, SCRIPTS.ECHO_STDIN, [], { stdin: "", timeoutMs: 15000 }).catch(() => null);
  if (!connected || connected.code !== 0) {
    for (const name of names) add(name, false, name === "ssh" ? "unreachable" : "skipped");
    return finish();
  }
  add("ssh", true);
  steps?.start("git");
  const probe = await runRemote(ctx, host, SCRIPTS.PROBE, []).catch(() => null), tools = fields(probe?.stdout ?? "");
  Object.assign(facts, { os: tools.os || null, arch: tools.arch || null, git: tools.git?.replace(/^git version\s+/, "") || null, setsid: tools.setsid || null,
    tools: { ...(tools.codex ? { codex: tools.codex } : {}), ...(tools.claude ? { claude: tools.claude } : {}) } });
  const version = /git version (\d+)\.(\d+)/.exec(tools.git ?? "");
  const gitOk = !!version && (+version[1] > 2 || (+version[1] === 2 && +version[2] >= 30));
  add("git", gitOk, gitOk ? tools.git : `${tools.git || "git missing"} < 2.30`);
  steps?.start("setsid");
  add("setsid", !!tools.setsid, tools.setsid || "missing");
  for (const agent of ["codex", "claude"]) if (names.includes(agent)) {
    steps?.start(agent);
    add(agent, !!tools[agent], tools[agent] || `${agent} not on login PATH`);
  }
  steps?.start("account homes");
  const missing: string[] = [];
  for (const [account, cfg] of Object.entries(host.accounts)) {
    const r = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [cfg.home, "home"]).catch(() => ({ code: 255 }));
    if (r.code) missing.push(account);
  }
  add("account homes", !missing.length, missing.length ? `missing: ${missing.join(", ")}` : "");
  for (const [key, path] of repos) {
    steps?.start(`checkout ${key}`);
    const r = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [path, "check"]).catch(() => ({ code: 255, stdout: "" })), facts = fields(r.stdout);
    const checkoutOk = r.code === 0 && facts.git === "1" && repoKey(facts.origin ?? "") === key;
    add(`checkout ${key}`, checkoutOk, checkoutOk ? "" : facts.exists !== "1" ? "missing checkout" : facts.git !== "1" ? "not a git checkout" : "origin mismatch");
    steps?.start(`identity ${key}`);
    const identityOk = !!local.name && !!local.email && facts.name === local.name && facts.email === local.email;
    // Never put identity values or remote paths in returned diagnostics.
    add(`identity ${key}`, identityOk, identityOk ? "" : "repo-local identity does not match local repo");
  }
  const accounts = new Set(Object.values(s.runners).filter(r => r.host === alias && r.agent === "codex").map(r => r.account));
  for (const account of accounts) await probeCodexUsage(ctx, host, s.accounts[account]);
  return finish();
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
