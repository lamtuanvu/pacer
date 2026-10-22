import { claudeHookChecks, claudeHooksApplicable, probeClaudeHandlers } from "./doctor-hooks";
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

export interface Check {
  name: string;
  level: "ok" | "warn" | "fail" | "info";
  detail: string;
  fix?: string;
  evidence?: "configured" | "tested" | "unverified";
}

export async function runDoctor(ctx: Ctx, deps: { status?: (ctx: Ctx) => Promise<Status>; service?: () => Promise<ServiceStatus> } = {}): Promise<Check[]> {
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
        checks.push({ name: `Usage ${cfg.id}`, level: warn ? "warn" : "ok", detail,
          ...(cfg.id === "claude-code" && provider?.error?.startsWith("no Claude rate-limit data yet")
            ? { fix: "pacer install claude-code, then use Claude Code once" } : {}) });
      }
    } catch (e) {
      for (const id of Object.keys(strategy.providers)) {
        checks.push({ name: `Usage ${id}`, level: "warn", detail: errorText(e) });
      }
    }
  }

  if (claudeHooksApplicable(ctx, strategy)) {
    checks.push(...claudeHookChecks(ctx, strategy));
    checks.push(await probeClaudeHandlers());
  }
  checks.push(...await removableVolumeChecks(ctx));
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
    checks.push({ name: "Service", level: good ? "ok" : "warn",
      detail: `installed: ${s.installed}; running: ${s.running}; healthy: ${s.healthy}; binary matches current: ${s.binaryMatches}`,
      ...(!good ? { fix: !s.installed || !s.binaryMatches ? "pacer service install" : "pacer service restart" } : {}) });
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
      for(const skill of record.files.filter(f=>f.path.endsWith("/skills/pacer/SKILL.md")))checks.push({name:`Skill ${target}`,level:fileIntact(skill)?"ok":"warn",detail:skill.path,...(!fileIntact(skill)?{fix:`pacer install ${target}`}:{})});
      const broken = record.files.filter(file => !fileIntact(file));
      checks.push({ name: `Install ${target}`, level: broken.length ? "warn" : "ok",
        detail: broken.length ? `missing or changed: ${broken.map(file => file.path).join(", ")}` : "installed files intact (configuration only; runtime unverified)",
        ...(broken.length ? { fix: record.planner === "service" ? "pacer service install" : `pacer install ${target}` } : {}) });
    }
  } catch (e) {
    checks.push({ name: "Installs", level: "warn", detail: errorText(e) });
  }
  if (existsSync(join(ctx.home, ".claude", "scripts", "budget", "subagent_guard.py"))) {
    checks.push({ name: "Legacy guard", level: "warn", detail: "legacy subagent_guard.py present",
      fix: "pacer install claude-code migrates it" });
  }
  return checks;
}

export function renderDoctor(checks: Check[]): string {
  return checks.map(check => `[${check.level === "fail" ? "FAIL" : check.level}] ${check.name}: ${check.detail}\n`
    + (check.fix ? `  fix: ${check.fix}\n` : "")).join("");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
    detail: loggedIn ? "login indicator present" : "no login indicator", ...(!loggedIn ? { fix } : {}) };
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
