import { plannerCheck } from "../plugins/planner-check";
import { integrationFreshness } from "./reconcile";
import { recordedAgent } from "./reconcile-target";
import { claudeHookChecks, claudeHooksApplicable, probeClaudeHandlers, enforcementProbeScheduleCheck } from "./doctor-hooks";
import { removableVolumeChecks } from "./removable-volume";
import { executorCliCheck } from "./cli-check";
import { serviceBackend, type ServiceStatus } from "../service";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy, MissingStrategyError, type Strategy } from "../config/strategy";
import { binaryFor, computeStatus, type Status } from "../engine/status";
import { readJson } from "../fsutil";
import type { ActivityProfile } from "../pace/activity";
import { isCalendar } from "../pace/clock";
import type { Ctx } from "../types";
import { loginIndicator } from "./login";
import { accountFolder } from "./role";
import { formatRunnerId, runnerDefaults } from "../config/runner-id";
import type { RunnerCfg } from "../config/accounts";
import { executorsFor } from "../engine/rank";
import { readText, sha256 } from "./fsx";
import { piecesPresent, readManifest, type FileChange } from "./manifest";
import { pruneExpiredUndoSnapshots } from "./undo-store";
import { withInstallLock } from "./lock";
import { internalCheck, internalErrorCode, isInternalCode, remedies, remedyCommand, withRemedies } from "./doctor-remedy";
import { displayName } from "../render/accounts";
import type { ProviderStatus } from "../engine/rank";

/** The one primary fix for a warning or failure. The server decides it; clients render it. */
export interface Remedy {
  kind: "auto" | "review" | "user" | "agent" | "internal";
  /** Button text: a verb and its object. */
  label: string;
  /** A registered operation; consent-gated operations keep their own consent step. */
  op?: string;
  /** Validated by the operation's schema at call time; never carries consent. */
  params?: Record<string, unknown>;
  /**
   * Set when `op` requires consent. The client must show what will change and send
   * `consent: true` after the user's click; the remedy never grants it.
   */
  consent?: true;
  /** `user` remedies only: https or x-apple.systempreferences: links. */
  url?: string;
  secondary?: { label: string; op?: string; params?: Record<string, unknown>; consent?: true; url?: string };
}

export interface Check {
  name: string;
  level: "ok" | "warn" | "fail" | "info";
  detail: string;
  /** Free text for the CLI and older clients; new clients use `remedy` when present. */
  fix?: string;
  evidence?: "configured" | "tested" | "unverified";
  remedy?: Remedy;
}

/** Hook checks whose files agent.connect writes, so a reviewed reconnect repairs them. */
const CLAUDE_HOOK_CHECKS = ["Claude hook configuration", "Claude message hooks"];

export async function runDoctor(ctx: Ctx, deps: { status?: (ctx: Ctx) => Promise<Status>; service?: () => Promise<ServiceStatus> } = {}): Promise<Check[]> {
  // Expire old undo snapshots so credential-bearing configs never sit on disk
  // indefinitely when no file-changing connect runs to prune them (L2). Run
  // under the install lock so pacer never races a concurrent staged connect.
  try {
    await withInstallLock(ctx, async () => { pruneExpiredUndoSnapshots(ctx, ctx.now); });
  } catch { /* pruning is best-effort; never let it fail doctor */ }
  const checks: Check[] = [];
  let strategy: Strategy | undefined;
  try {
    strategy = loadStrategy(ctx);
    checks.push({ name: "Strategy", level: "ok", detail: strategy.name });
  } catch (e) {
    checks.push({ name: "Strategy", level: "fail", detail: errorText(e),
      ...(e instanceof MissingStrategyError ? { fix: "pacer init" } : {}) });
  }

  if (strategy) {
    if (!executorsFor(null, strategy).some(id => {
      const runner = strategy!.runners[id];
      return runner && !(runner.agent === strategy!.planner.agent && runner.account === strategy!.planner.account);
    })) checks.push({ name: "Executor", level: "warn", detail: "no executor configured",
      fix: "install an executor CLI such as codex, then run pacer init" });

    for (const cfg of Object.values(strategy.providers)) {
      const bin = binaryFor(cfg);
      const installed = ctx.which(bin) !== null;
      checks.push({ name: `Binary ${cfg.id}`, level: installed ? "ok" : "fail",
        detail: installed ? `${bin} installed` : `${bin} missing`,
        ...(!installed ? { fix: `install ${bin} or remove providers.${cfg.id}` } : {}) });
      if(installed && cfg.id !== strategy.planner.agent)checks.push(await executorCliCheck(ctx,cfg));

    }
    const logins = new Map<string, RunnerCfg>();
    for (const runner of Object.values(strategy.runners)) logins.set(runner.id, runner);
    const plannerId = formatRunnerId({...strategy.planner, host: null}, runnerDefaults(strategy.accounts));
    if (!logins.has(plannerId)) logins.set(plannerId, { ...strategy.planner, id: plannerId, name: plannerId, host: null, model: null });
    for (const runner of logins.values()) checks.push(loginCheck(ctx, runner, strategy));
    if (Object.values(strategy.providers).some(cfg => cfg.quotaSource === "arkcli"))
      checks.push({ name: "Login arkcli", level: "info", evidence: "unverified", detail: "login not cheaply checkable" });

    try {
      const status = deps.status ? await deps.status(ctx) : await computeStatus(ctx, strategy);
      for (const cfg of Object.values(strategy.providers)) {
        const provider = status.providers.find(p => p.id === cfg.id);
        const detail = provider?.error || (provider?.stale ? "stale usage" : provider?.verdict ?? "UNKNOWN");
        const warn = !provider || !!provider.error || provider.stale || provider.verdict === "UNKNOWN";
        const noClaudeData = cfg.id === "claude-code" && !!provider?.error?.startsWith("no Claude rate-limit data yet");
        const remedy = warn ? usageRemedy(ctx, strategy, cfg.id, provider, noClaudeData) : undefined;
        // Sign-in and billing come from the account's own evidence and outrank a pacer failure in another reading.
        if (remedy?.kind !== "user" && isInternalCode(provider?.errorCode)) {
          checks.push(internalCheck({ name: `Usage ${cfg.id}`, detail }));
          continue;
        }
        checks.push({ name: `Usage ${cfg.id}`, level: warn ? "warn" : "ok", detail,
          ...(noClaudeData ? { fix: "pacer install claude-code, then use Claude Code once" } : {}),
          ...(remedy ? { remedy } : {}) });
      }
    } catch (e) {
      for (const id of Object.keys(strategy.providers)) {
        checks.push(internalErrorCode(e) ? internalCheck({ name: `Usage ${id}`, detail: errorText(e) })
          : { name: `Usage ${id}`, level: "warn", detail: errorText(e) });
      }
    }
  }
  const claudeTarget = strategy?.planner.agent === "claude-code" ? plannerKey(strategy) : "claude-code";
  const claudeAgent = connectableAgent(ctx, strategy, claudeTarget);

  if (claudeHooksApplicable(ctx, strategy)) {
    // Configured hooks that warn point at an account-folder mismatch, which reconnecting cannot repair.
    checks.push(...claudeHookChecks(ctx, strategy).map(check =>
      CLAUDE_HOOK_CHECKS.includes(check.name) && check.evidence !== "configured" && claudeAgent
        ? { ...check, remedy: remedies.review(claudeAgent) } : check));
    checks.push(await probeClaudeHandlers());
  }
  checks.push(enforcementProbeScheduleCheck(ctx));
  checks.push(...(await removableVolumeChecks(ctx)).map(check =>
    check.name === "Removable volume access" ? { ...check, remedy: remedies.privacySettings() } : check));
  checks.push(await linkLatencyCheck(ctx));

  if (ctx.which("orca") === null) {
    checks.push({ name: "Orca", level: "info", detail: "not installed" });
  } else {
    let reachable = false;
    try {
      const result = await ctx.run(["orca", "status", "--json"], 5000);
      reachable = result.code === 0 && JSON.parse(result.stdout)?.result?.runtime?.reachable === true;
    } catch { /* An unavailable runtime uses the direct backend. */ }
    checks.push({ name: "Orca", level: reachable ? "ok" : "warn",
      detail: reachable ? "runtime reachable" : "tasks use the direct backend" });
  }

  try {
    const s = await (deps.service ? deps.service() : serviceBackend(ctx).status());
    const good = s.installed && s.running && s.healthy && s.binaryMatches;
    const reinstall = !s.installed || !s.binaryMatches;
    checks.push({ name: "Service", level: good ? "ok" : "warn",
      detail: `installed: ${s.installed}; running: ${s.running}; healthy: ${s.healthy}; binary matches current: ${s.binaryMatches}`,
      ...(!good ? { fix: reinstall ? "pacer service install" : "pacer service restart",
        remedy: remedies.service(reinstall ? "Install service" : "Restart service") } : {}) });
  } catch (e) { checks.push({ name: "Service", level: "info", detail: errorText(e) }); }

  const profile = readJson<ActivityProfile>(join(ctx.pacerHome, "activity.json"));
  const usableProfile = profile && Array.isArray(profile.active) && Array.isArray(profile.bins)
    && profile.bins.length === 168 && !isCalendar(profile);
  checks.push({ name: "Activity", level: "info",
    detail: usableProfile ? `learned from ${profile.days} days` : "calendar pace" });

  try {
    const records = Object.entries(readManifest(ctx).planners);
    if (!records.length) checks.push({ name: "Installs", level: "warn", detail: "no install records" });
    for (const [target, record] of records) {
      const broken = record.files.filter(file => !fileIntact(file));
      // agent.connect addresses one target per agent; other recorded targets go to an agent task.
      const agent = connectableAgent(ctx, strategy, target);
      const review = agent ? { remedy: remedies.review(agent) } : {};
      if (recordedAgent(target)) {
        const fresh = await integrationFreshness(ctx, target);
        const name = `Integration freshness ${target}`;
        const detail = fresh.state === "current" ? "managed assets match this runtime"
          : fresh.state === "refreshed" ? (record.undoneAt ? "the last repair was undone; reconnect to re-apply pacer's files" : "managed assets need refresh; the next service startup or local launch will reconcile them")
          : fresh.detail ?? "refresh could not be verified";
        // Refreshing only pacer-managed files is automatic; a user-edited file or an undone
        // repair needs a reviewed preview (F5: never re-apply an undo without consent).
        const remedy = !record.undoneAt && fresh.state === "refreshed" && agent && !broken.length ? { remedy: remedies.updateFiles(agent) } : review;
        checks.push(fresh.state !== "current" && isInternalCode(fresh.code) ? internalCheck({ name, detail })
          : { name, level: fresh.state === "current" ? "ok" : "warn", detail,
            ...(fresh.hint ? { fix: fresh.hint } : {}), evidence: "configured", ...(fresh.state === "current" ? {} : remedy) });
      }
      if (recordedAgent(target)) {
        try {
          const result=await plannerCheck(ctx,target,record,record.folder);
          checks.push({name:`Planner check ${target}`,level:result.intact?"ok":"warn",detail:result.intact?"planner reports files intact":"planner reports missing or changed files",evidence:"configured",...(result.intact?{}:review)});
        } catch(error) {
          const name = `Planner check ${target}`;
          checks.push(internalErrorCode(error) ? internalCheck({name,detail:errorText(error)}) : {name,level:"warn",detail:errorText(error),evidence:"unverified"});
        }
      }
      for(const skill of record.files.filter(f=>f.path.endsWith("/skills/pacer/SKILL.md")))checks.push({name:`Skill ${target}`,level:fileIntact(skill)?"ok":"warn",detail:skill.path,...(!fileIntact(skill)?{fix:`pacer install ${target}`,...review}:{})});
      const service = record.planner === "service";
      checks.push({ name: `Install ${target}`, level: broken.length ? "warn" : "ok",
        detail: broken.length ? `missing or changed: ${broken.map(file => file.path).join(", ")}` : "installed files intact (configuration only; runtime unverified)",
        ...(broken.length ? { fix: service ? "pacer service install" : `pacer install ${target}`,
          ...(service ? { remedy: remedies.service("Install service") } : review) } : {}) });
    }
  } catch (e) {
    checks.push({ name: "Installs", level: "warn", detail: errorText(e) });
  }
  if (existsSync(join(ctx.home, ".claude", "scripts", "budget", "subagent_guard.py"))) {
    checks.push({ name: "Legacy guard", level: "warn", detail: "legacy subagent_guard.py present",
      fix: "pacer install claude-code migrates it", ...(claudeAgent ? { remedy: remedies.review(claudeAgent) } : {}) });
  }
  return withRemedies(checks);
}

export function renderDoctor(checks: Check[]): string {
  return checks.map(check => {
    const command = check.remedy && remedyCommand(check.remedy);
    return `[${check.level === "fail" ? "FAIL" : check.level}] ${check.name}: ${check.detail}\n`
      + (check.fix ? `  fix: ${check.fix}\n` : "")
      + (command && command !== check.fix ? `  run: ${command}\n` : "");
  }).join("");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function plannerKey(strategy: Strategy): string {
  return formatRunnerId({ ...strategy.planner, host: null }, runnerDefaults(strategy.accounts));
}

/**
 * The agent `agent.connect` would repair for this recorded target: the selected planner's target for
 * the planner's agent, the default target for any other agent. Returns undefined for other targets.
 */
function connectableAgent(ctx: Ctx, strategy: Strategy | undefined, target: string): string | undefined {
  const agent = recordedAgent(target);
  if (!agent) return;
  if (!strategy || strategy.planner.agent !== agent) return target === agent ? agent : undefined;
  if (target !== plannerKey(strategy)) return;
  const account = strategy.accounts[strategy.planner.account];
  return account && (account.source === "default" || accountFolder(ctx, account)) ? agent : undefined;
}

function usageRemedy(ctx: Ctx, strategy: Strategy, id: string, provider: ProviderStatus | undefined, noClaudeData: boolean): Remedy {
  const runner = strategy.runners[id];
  const account = runner ? strategy.accounts[runner.account] : undefined;
  const accountName = runner?.account ?? id;
  const codes = provider?.eligibility?.reasons.map(reason => reason.code) ?? [];
  if (codes.includes("subscription_missing")) return remedies.billing(account?.kind ?? "", id, displayName(id));
  if (provider?.signedOutReason || codes.some(code => code === "authentication_failed" || code === "signed_out"))
    return remedies.signIn(accountName, displayName(id));
  if (noClaudeData) {
    const agent = connectableAgent(ctx, strategy, strategy.planner.agent === "claude-code" ? plannerKey(strategy) : "claude-code");
    return agent ? remedies.review(agent) : remedies.agent(`Usage ${id}`);
  }
  return provider?.error ? remedies.agent(`Usage ${id}`) : remedies.refreshUsage(accountName);
}

function loginCheck(ctx: Ctx, runner: RunnerCfg, strategy: Strategy): Check {
  const name = `Login ${runner.id}`;
  const account = strategy.accounts[runner.account];
  const folder = account ? accountFolder(ctx, account) : null;
  if (runner.host || !account || account.kind === "endpoint" || (account.source !== "default" && !folder))
    return { name, level: "info", evidence: "unverified", detail: "Account login is unverified: remote, endpoint or unresolved account folder." };
  // Inspect the declared account, not the service's launch overrides or another account's API key.
  const env = {...ctx.env};
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  if (account.source !== "default") {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete env[key];
  }
  const indicator = loginIndicator({...ctx, env}, runner.agent, folder ?? undefined);
  if (!indicator) return { name, level: "info", evidence: "unverified", detail: "login not cheaply checkable" };
  const { loggedIn, fix } = indicator;
  return { name, level: loggedIn ? "ok" : "warn",
    detail: loggedIn ? "login indicator present" : "no login indicator",
    ...(!loggedIn ? { fix, remedy: remedies.signIn(runner.account, displayName(runner.id)) } : {}) };
}

function fileIntact(file: FileChange): boolean {
  if (file.action === "moved") return !existsSync(file.path) && !!file.backup && existsSync(file.backup);
  const text = readText(file.path);
  return text !== null && ((!!file.afterHash && sha256(text) === file.afterHash)
    || (file.undo.length > 0 && piecesPresent(text, file.undo)));
}

/** Measure cached HTTP reads independently of provider and Orca diagnostics. */
export async function linkLatencyCheck(ctx:Ctx):Promise<Check> {
  try {
    const token=readText(join(ctx.pacerHome,"token"))?.trim();
    if(!token)return {name:"Link latency",level:"info",detail:"serve is not configured"};
    const port=ctx.env.PACER_PORT ?? "4317";
    const samples:number[]=[];
    for(let i=0;i<3;i++) {
      const start=performance.now();
      const r=await fetch(`http://127.0.0.1:${port}/v2/snapshot`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
      if(!r.ok)throw Error(`HTTP ${r.status}`);
      await r.arrayBuffer();samples.push(performance.now()-start);
    }
    const max=Math.max(...samples);
    return {name:"Link latency",level:max<50?"ok":"warn",detail:`/v2/snapshot max ${max.toFixed(1)} ms across 3 requests (target < 50 ms)`};
  }catch(e){return {name:"Link latency",level:"warn",detail:`serve unavailable: ${errorText(e)}`};}
}
