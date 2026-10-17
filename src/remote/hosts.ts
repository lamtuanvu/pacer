import { appendActivity } from "../activity/log";
import type { ExecutorRow } from "../api/read-model/types";
import { listRepos } from "../core/repos";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { listJobs, startJob, type StepApi } from "../jobs/registry";
import { type HostCfg, canonical, repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { applyEdit } from "../core/accounts";
import { CoreError } from "../core/errors";
import { shq } from "../install/fsx";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES } from "../tasks/types";
import type { Ctx } from "../types";
import { openInTerminal } from "../terminal/open";
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
  executors: ExecutorRow[];
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
    : stored?.checks.some(c => !c.ok) || listRepos(ctx).some(r=>!r.key.startsWith("local:")&&!host.repos[r.key]&&Object.values(s.runners).some(e=>e.host===host.alias&&e.enabled!==false)) ? "needs_setup" : "ready";
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
  const before=configured(ctx, alias);
  applyEdit(ctx, doc => {
    if (o.max_tasks !== undefined) doc.setIn(["hosts", alias, "max_tasks"], o.max_tasks);
    if (o.paused !== undefined) doc.setIn(["hosts", alias, "paused"], o.paused);
  });
  if(o.paused===true&&!before.paused)appendActivity(ctx,{kind:"host_state",level:"info",host:alias,text:`${alias} paused · new work goes elsewhere`});
  return summary(ctx, configured(ctx, alias));
}
export async function detail(ctx: Ctx, alias: string): Promise<HostDetail> {
  // Read-model tasks depend on the pump; load them after host operations initialize.
  const [{buildExecutors},{snapshotTasks},{computeStatus}]=await Promise.all([
    import("../api/read-model/capacity"),import("../api/read-model/tasks"),import("../engine/status"),
  ]);
  const host = configured(ctx, alias), row = summary(ctx, host), stored = readHostCheck(ctx, alias);
  const checks = stored?.checks ?? [];
  const done = listTasks(ctx, Infinity).filter(t => {
    // Old task records have no updatedAt; use their persisted completion/review time.
    const at = (t as typeof t & { updatedAt?: number }).updatedAt ?? t.review?.at ?? t.attempts.at(-1)?.endedAt ?? t.createdAt;
    return t.run?.host === alias && t.state === "done" && at >= ctx.now - 7 * 86400 && at <= ctx.now;
  });
  return { ...row, checkedAt: stored?.at ?? null, reachableAt: readHostReachability(ctx, host)?.at ?? null,
    facts: stored?.facts ?? null, checks, executors: buildExecutors(await computeStatus({...ctx,readOnly:true},loadStrategy(ctx)),loadStrategy(ctx),snapshotTasks(ctx,listTasks(ctx,Infinity)),ctx.now,ctx).filter(e=>e.host===alias),
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
  const names = ["ssh", "git", "setsid", "script", "tail", ...(agents.has("codex") ? ["codex"] : []), ...(agents.has("claude-code") ? ["claude"] : []), "account homes", ...repos.flatMap(([key]) => [`checkout ${key}`, `identity ${key}`])];
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
  steps?.start("script");
  const scriptVersion = /util-linux (\d+)\.(\d+)/.exec(tools.script ?? "");
  const scriptOk = !!scriptVersion && (+scriptVersion[1] > 2 || (+scriptVersion[1] === 2 && +scriptVersion[2] >= 35));
  add("script", scriptOk, scriptOk ? tools.script : `${tools.script || "util-linux script missing"}; requires >= 2.35 (stdin EOF issue)`);
  steps?.start("tail");
  // Live viewing follows session.raw with a plain tail -f; any POSIX tail works.
  const tailOk = !!tools.tail;
  add("tail", tailOk, tailOk ? tools.tail : "tail missing");
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

export function mapRepo(ctx: Ctx, alias: string, key: string, path: string) {
  configured(ctx, alias);
  key = key.toLowerCase();
  if (!canonical(key)) throw new CoreError("invalid_input", "invalid repo key", "Use the canonical host/owner/repo form, e.g. github.com/acme/api.");
  applyEdit(ctx, doc => doc.setIn(["hosts", alias, "repos", key], path));
  return { alias, key, path };
}

export function addAccount(ctx: Ctx, alias: string, account: string, home: string) {
  configured(ctx, alias);
  const cfg = loadStrategy(ctx).accounts[account];
  if (!cfg || !["codex", "claude"].includes(cfg.kind)) throw new CoreError("invalid_input", "host account must be a configured codex or claude account");
  applyEdit(ctx, doc => doc.setIn(["hosts", alias, "accounts", account, "home"], home));
  // Tilde expansion is safe only outside quotes; quote the rest as one shell word.
  const folder = home.startsWith("~/") ? `~/${shq(home.slice(2))}` : shq(home);
  return { command: `${cfg.kind === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}=${folder} ${cfg.kind === "codex" ? "codex login" : "claude\n# Then run /login to sign in."}` };
}

export interface SetupOptions { clone?: boolean; identity?: boolean; consent: boolean; steps?: StepApi }
export async function setup(ctx: Ctx, alias: string, repo: string, o: SetupOptions): Promise<HostCheck> {
  if (o.consent !== true) throw new CoreError("invalid_input", "host repo setup requires consent: true");
  const host = configured(ctx, alias), local = await localRepo(ctx, repo), path = local.key && host.repos[local.key];
  if (!path) throw new CoreError("invalid_input", `repo not mapped on ${alias}`);
  if (o.clone !== false) {
    o.steps?.start("Clone");
    const r = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [path, "check"]);
    if (r.code) throw new CoreError("invalid_input", `host ${alias} unreachable`);
    if (fields(r.stdout).exists !== "1") {
      const cloned = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [path, "clone", local.origin]);
      if (cloned.code) throw new CoreError("invalid_input", `clone failed on ${alias}`);
      o.steps?.pass("Clone");
    } else o.steps?.skip("Clone", "checkout already exists");
  } else o.steps?.skip("Clone");
  if (o.identity !== false) {
    o.steps?.start("Set identity");
    if (!local.name || !local.email) throw new CoreError("invalid_input", "local repo needs user.name and user.email");
    const set = await runRemote(ctx, host, SCRIPTS.SET_IDENTITY, [path, local.name, local.email]);
    if (set.code) throw new CoreError("invalid_input", `identity setup failed on ${alias}`);
    o.steps?.pass("Set identity");
  } else o.steps?.skip("Set identity");
  o.steps?.start("Check");
  const result = await check(ctx, alias, { repo });
  if (result.ok) o.steps?.pass("Check");
  else o.steps?.fail("Check", result.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; "));
  return result;
}

/** The API has a canonical key, so find its local checkout among known repos. */
export async function setupJob(ctx: Ctx, alias: string, key: string, o: Omit<SetupOptions, "steps">) {
  if (o.consent !== true) throw new CoreError("invalid_input", "host repo setup requires consent: true");
  const host = configured(ctx, alias);
  key = key.toLowerCase();
  if (!canonical(key) || !Object.hasOwn(host.repos, key)) throw new CoreError("invalid_input", `repo not mapped on ${alias}`, "Use a mapped canonical host/owner/repo key.");
  const candidates = new Set([process.cwd(), ...listTasks(ctx, Infinity).map(t => t.brief.repo)]);
  let repo: string | undefined;
  for (const candidate of candidates) if ((await localRepo(ctx, candidate)).key === key) { repo = candidate; break; }
  if (!repo) throw new CoreError("invalid_input", "local repo checkout not found", "Run pacer host setup from the local checkout, or delegate a task for that repo first.");
  return startJob(ctx, "host.repo.setup", `${alias}:${key}`, ["Clone", "Set identity", "Check"], async steps => {
    await setup(ctx, alias, repo!, { ...o, steps });
  });
}

/** CLI-only interactive consent; API setup never prompts. */
export async function confirmSetup(ctx: Ctx, alias: string, repo: string, confirm: (question: string) => Promise<boolean>) {
  const host = configured(ctx, alias), local = await localRepo(ctx, repo), path = local.key && host.repos[local.key];
  if (!path) throw new CoreError("invalid_input", `repo not mapped on ${alias}`);
  const r = await runRemote(ctx, host, SCRIPTS.CHECK_REPO, [path, "check"]);
  if (r.code) throw new CoreError("invalid_input", `host ${alias} unreachable`);
  const target = path.startsWith("~/") ? `"$HOME"/${shq(path.slice(2))}` : shq(path);
  const clone = fields(r.stdout).exists !== "1" && await confirm(`Run on ${alias}: git clone -- ${shq(local.origin)} ${target}?`);
  if (!local.name || !local.email) throw new CoreError("invalid_input", "local repo needs user.name and user.email");
  const identity = await confirm(`Set repo-local identity on ${alias} to ${local.name} <${local.email}>?`);
  return setup(ctx, alias, repo, { clone, identity, consent: true });
}

export function terminal(ctx: Ctx, alias: string, opener = openInTerminal) {
  const host = configured(ctx, alias);
  return opener(ctx, { argv: ["ssh", host.ssh], title: `SSH ${alias}` });
}

/** Host-only cleanup; preserve branches whose results have not been transferred. */
export interface HostWorktree { branch: string; state: string; fate: "will remove" | "in use" | "kept" }
export function clean(ctx: Ctx, alias: string, o: { dryRun: true }): Promise<{ worktrees: HostWorktree[] }>;
export function clean(ctx: Ctx, alias: string, o?: { dryRun?: false }): Promise<{ removed: string[]; kept: { id: string; reason: string }[] }>;
export async function clean(ctx: Ctx, alias: string, o: { dryRun?: boolean } = {}) {
  const host = configured(ctx, alias), removed: string[] = [], kept: { id: string; reason: string }[] = [];
  const worktrees: HostWorktree[] = [];
  for (const t of listTasks(ctx, Infinity)) {
    if (t.run?.host !== alias || t.run.mode !== "new") continue;
    const eligible = TERMINAL_STATES.includes(t.state) && !!(t.review || t.dismissed || t.resolved);
    const received = eligible && await transferred(ctx, t).catch(() => false);
    let removable = received && !!t.run.remoteWorktree && !!t.run.remoteDir;
    if (removable && o.dryRun) {
      const local = await localRepo(ctx, t.brief.repo).catch(() => null);
      removable = !!local?.key && Object.hasOwn(host.repos, local.key);
    }
    worktrees.push({ branch: t.run.remoteBranch ?? `pacer/${t.id}`, state: t.state,
      fate: !TERMINAL_STATES.includes(t.state) ? "in use" : removable ? "will remove" : "kept" });
    if (o.dryRun || !eligible) continue;
    try {
      const local = await localRepo(ctx, t.brief.repo), checkout = local.key && host.repos[local.key];
      if (!checkout || !t.run.remoteWorktree || !t.run.remoteDir) {
        kept.push({ id: t.id, reason: "remote cleanup needs a configured host, checkout and run" }); continue;
      }
      const r = await runRemote(ctx, host, SCRIPTS.CLEAN, [t.run.remoteWorktree, t.run.remoteDir, checkout, t.id, received ? (t.run.remoteBranch ?? `pacer/${t.id}`) : ""]);
      if (r.code) kept.push({ id: t.id, reason: "remote cleanup failed" });
      else removed.push(t.id);
    } catch { kept.push({ id: t.id, reason: "remote cleanup failed" }); }
  }
  return o.dryRun ? { worktrees } : { removed, kept };
}

export function cleanJob(ctx: Ctx, alias: string) {
  configured(ctx, alias);
  return startJob(ctx, "host.clean", alias, ["Clean"], async steps => {
    steps.start("Clean");
    const result = await clean(ctx, alias);
    if (result.kept.length) steps.fail("Clean", result.kept.map(k => `${k.id}: ${k.reason}`).join("; "));
    else steps.pass("Clean");
  });
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
  // Strategy runners include explicit declarations even when enabled: false.
  const reference = Object.values(s.runners).find(r => r.host === alias);
  if (reference) throw new CoreError("conflict", `${alias} is used by ${reference.id}`, "Remove its runners first.");
  applyEdit(ctx, doc => doc.deleteIn(["hosts", alias]));
  return {removed: true as const};
}
