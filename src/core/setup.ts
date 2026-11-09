import { sha256 } from "../install/fsx";
import { runDoctor } from "../install/doctor";
import { saveDoctorReport } from "./doctor-fix";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PLANNERS, validateStrategy } from "../config/strategy";
import { formatRunnerId, runnerDefaults, parseRunnerId } from "../config/runner-id";
import { migrateStrategy } from "../config/migrate";
import { detect, starterStrategy } from "../install/init";
import { AGENT_BINS, type AgentId } from "../install/detection";
import { installPlanner } from "../install";
import { uninstallPlanner } from "../install/uninstall";
import { pacerArgv } from "../install/self";
import { serviceBackend, type ServiceBackend } from "../service";
import { checkSetup } from "../setup/check";
import { withLock } from "./lock";
import { loadStrategy } from "../config/strategy";
import { accountFolder } from "../install/role";
import { plannerPreview } from "../plugins/planner-preview";
import { currentVersion } from "../update/version";
import { PROTOCOL_VERSION } from "../api/protocol";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";
import * as config from "./config";
export { tryDelegation as onboardingTry } from "../onboarding/try";

export async function check(ctx: Ctx, options: {snapshotProbe?:boolean} = {}) {
  try { return await checkSetup(ctx,options); } catch (e) { throw toCoreError(e); }
}

/** Initialize configuration only; connecting agents requires separate consent. */
export async function init(ctx: Ctx, planner: string) {
  try {
    const id = parseRunnerId(planner);
    if (!id || id.host || !(PLANNERS as readonly string[]).includes(id.agent)) throw new CoreError("invalid_input", "unknown planner", `choose ${PLANNERS.join(', ')}`);
    const path = join(ctx.pacerHome, "strategy.yaml");
    if (existsSync(path)) await config.set(ctx, "planner", planner, {integrations: "skip"});
    else {
      const text = starterStrategy(await detect(ctx), planner);
      validateStrategy(Bun.YAML.parse(text), path);
      mkdirSync(ctx.pacerHome, {recursive: true});
      writeFileSync(path, text);
      migrateStrategy(path);
    }
    return {strategy: path};
  } catch (e) { throw toCoreError(e); }
}

export async function serviceStatus(ctx: Ctx) {
  try {
    const s = await serviceBackend(ctx).status(2000);
    return {installed: s.installed, running: s.running, ...(s.pid === null ? {} : {pid: s.pid})};
  } catch (e) { throw toCoreError(e); }
}

/** Kept so protocol 3 clients get a clear refusal; remove with the next protocol major (API-2). */
export function pluginInstall(): never {
  throw new CoreError("not_allowed", "pacer no longer ships an Orca plugin", "Use the pacer desktop app or pacer open. Remove an earlier install with: pacer plugin uninstall");
}

function plannerTarget(ctx:Ctx,agent:AgentId) {
  try {const s=loadStrategy(ctx);return s.planner.agent===agent?s.planner:agent;}catch{return agent;}
}
export async function agentPreview(ctx: Ctx, agent: AgentId) {
  // Preview remains available even when a CLI has not been installed yet.
  if (!Object.hasOwn(AGENT_BINS,agent)) throw new CoreError("invalid_input", `unknown agent: ${agent}`, `choose ${PLANNERS.join(', ')}`);
  const target=plannerTarget(ctx,agent);
  const account=typeof target==="object"?loadStrategy(ctx).accounts[target.account]:undefined;
  const folder=account?accountFolder(ctx,account):null;
  const root=join(ctx.home,agent==="claude-code"?".claude":`.${agent}`);

  const desired=await plannerPreview(ctx,agent,folder??(agent==="opencode"?join(ctx.env.XDG_CONFIG_HOME??join(ctx.home,".config"),"opencode"):root),folder&&typeof target==="object"?`${agent}#${target.account}`:agent,agent==="codex"?folder??ctx.env.CODEX_HOME:undefined);
  const preview={agent,...desired};
  return {...preview, revision: sha256(JSON.stringify({target, folder, ...preview}))};
}

export async function agentConnect(ctx: Ctx, agent: AgentId, options: {consent?: boolean; preview_revision?: string} = {}) {
  if (options.consent !== true) throw new CoreError("not_allowed", "connecting an agent requires consent", "Review agent.preview, then pass consent: true");
  const preview = await agentPreview(ctx, agent);
  if (options.preview_revision !== undefined && options.preview_revision !== preview.revision)
    throw new CoreError("conflict", "The integration target changed after preview", "Review a fresh repair preview before applying changes.");
  const target = plannerTarget(ctx, agent);
  try {
    const r = await installPlanner({ctx, pacerArgv: pacerArgv(ctx.env), mcp: false}, target);
    return {installed: r.touched};
  } catch (e) { throw toCoreError(e); }
}

export async function agentDisconnect(ctx: Ctx, agent: AgentId) {
  await agentPreview(ctx, agent);
  try {
    const r = await uninstallPlanner(ctx, agent);
    return {removed: r ? [...r.removed, ...r.restored, ...r.reverted] : []};
  } catch (e) { throw toCoreError(e); }
}

export function version(_ctx: Ctx) {
  return {pacer: currentVersion(), protocol: PROTOCOL_VERSION};
}

export async function serviceInstall(ctx:Ctx, consent:boolean, backend:Pick<ServiceBackend,"install"|"status">=serviceBackend(ctx)) {
  if(consent!==true)throw new CoreError("not_allowed","installing the login service requires consent","Pass consent: true to run pacer in the background at login");
  try {
    return await withLock(ctx,"setup-install",async()=>{const notes=await backend.install();if(notes.reloadPending)return {installed:true,running:true,restarting:true};const s=await backend.status(2000);return {installed:s.installed,running:s.running};},{timeoutMs:0});
  }catch(e){if(e instanceof Error&&e.message.startsWith("timed out waiting for"))throw new CoreError("conflict","setup installation is already running");throw toCoreError(e);}
}

export function onboardingSkip(ctx:Ctx) {
  const dir=join(ctx.pacerHome,"onboarding"),path=join(dir,"skipped"),tmp=join(dir,`.skipped-${crypto.randomUUID()}`);
  try {
    mkdirSync(dir,{recursive:true,mode:0o700});
    writeFileSync(tmp,"",{flag:"wx",mode:0o600});renameSync(tmp,path);
    return {skipped:true};
  }catch(e){throw toCoreError(e);}finally{rmSync(tmp,{force:true});}
}

/** Read diagnostics and run fixed isolated handler fixtures; never repair installations. */
export async function doctor(ctx: Ctx) {
  try {
    const checks = await runDoctor(ctx);
    let planner: string | undefined;
    let repairAvailable = false;
    try {
      const strategy = loadStrategy(ctx);
      planner = formatRunnerId({...strategy.planner, host: null}, runnerDefaults(strategy.accounts));
      const account = strategy.accounts[strategy.planner.account];
      repairAvailable = !!account && (account.source === "default" || !!accountFolder(ctx, account));
    } catch { /* The strategy diagnostic reports missing or invalid configuration. */ }
    const report = { checkedAt: ctx.now, checks, ...(planner ? {planner, repairAvailable} : {}) };
    saveDoctorReport(ctx, report);
    return report;
  }
  catch (e) { throw toCoreError(e); }
}

/** Startup/update gate: bounded doctor view, fingerprint, and whether the full-window stage can skip. */
export async function health(
  ctx: Ctx,
  params: { trigger?: "startup" | "update" | "manual" } = {},
  options: { snapshotProbe?: boolean } = {},
) {
  try {
    const { aggregateSetupHealth, fingerprintFromReport, shouldSkipFullWindow } = await import("../view-model/setup-health");
    const {
      readSetupHealthPass,
      writeSetupHealthPass,
      setupHealthRequired,
      clearSetupHealthRequired,
    } = await import("../install/setup-health-store");
    const { readManifest } = await import("../install/manifest");
    const started = Date.now();
    const previous = readSetupHealthPass(ctx);
    const forced = params.trigger === "update" || setupHealthRequired(ctx);
    const trigger =
      params.trigger === "update" || (forced && params.trigger !== "manual")
        ? "update"
        : (params.trigger ?? "startup");

    const reportDoctor = await doctor(ctx);
    // Removable-volume probes are Diagnostics-only; keep the gate bounded.
    const checks = reportDoctor.checks.filter(c => !c.name.startsWith("Removable volume "));
    const checklist = await check(ctx, options);
    const checkedAt = ctx.now;
    const report = aggregateSetupHealth({
      checks,
      checklist,
      trigger,
      checkedAt,
      durationSeconds: (Date.now() - started) / 1000,
    });
    const version = currentVersion();
    const integrationHashes: Record<string, string> = {};
    for (const [key, record] of Object.entries(readManifest(ctx).planners)) {
      integrationHashes[key] = sha256(JSON.stringify(record));
    }
    const versions = { appVersion: version, serviceVersion: version, integrationHashes };
    const fingerprint = fingerprintFromReport(report, versions);
    writeSetupHealthPass(ctx, {
      fingerprint,
      trigger,
      outcome: report.outcome,
      durationSeconds: report.durationSeconds,
    });
    clearSetupHealthRequired(ctx);
    const skipFullWindow =
      !forced &&
      shouldSkipFullWindow(previous?.fingerprint ?? null, versions) &&
      report.attentionCount === 0;
    return {
      ...report,
      fingerprint,
      skipFullWindow,
      planner: reportDoctor.planner,
      repairAvailable: reportDoctor.repairAvailable,
    };
  } catch (e) {
    throw toCoreError(e);
  }
}
