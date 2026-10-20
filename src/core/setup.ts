import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PLANNERS, validateStrategy } from "../config/strategy";
import { parseRunnerId } from "../config/runner-id";
import { migrateStrategy } from "../config/migrate";
import { detect, starterStrategy } from "../install/init";
import { agentPlans, type AgentId } from "../install/detection";
import { installPlanner } from "../install";
import { uninstallPlanner } from "../install/uninstall";
import { pacerArgv } from "../install/self";
import { serviceBackend, type ServiceBackend } from "../service";
import { checkSetup } from "../setup/check";
import { withLock } from "./lock";
import { loadStrategy } from "../config/strategy";
import { accountFolder } from "../install/role";
import { claudeConnectPreview } from "../install/claude";
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
export function agentPreview(ctx: Ctx, agent: AgentId) {
  // Preview remains available even when a CLI has not been installed yet.
  const plan = agentPlans(ctx.home, ctx.pacerHome, () => "preview", ctx.env).find(p => p.id === agent);
  if (!plan) throw new CoreError("invalid_input", `unknown agent: ${agent}`, `choose ${PLANNERS.join(', ')}`);
  const target=plannerTarget(ctx,agent);
  const account=typeof target==="object"?loadStrategy(ctx).accounts[target.account]:undefined;
  const folder=account?accountFolder(ctx,account):null;
  const root=join(ctx.home,agent==="claude-code"?".claude":`.${agent}`);
  const files=folder&&(agent==="codex"||agent==="claude-code")?plan.files.map(p=>p.startsWith(root+"/")?join(folder,p.slice(root.length+1)):p):plan.files;
  return {agent,files,undo:folder&&typeof target==="object"?`pacer uninstall ${agent}#${target.account}`:plan.undo,...(agent==="claude-code"?{detail:claudeConnectPreview(ctx.home,folder??root)}:{})};
}

export async function agentConnect(ctx: Ctx, agent: AgentId, options: {consent?: boolean} = {}) {
  if (options.consent !== true) throw new CoreError("not_allowed", "connecting an agent requires consent", "Review agent.preview, then pass consent: true");
  agentPreview(ctx, agent);
  try {
    const r = await installPlanner({ctx, pacerArgv: pacerArgv(ctx.env), mcp: false}, plannerTarget(ctx,agent));
    return {installed: r.touched};
  } catch (e) { throw toCoreError(e); }
}

export async function agentDisconnect(ctx: Ctx, agent: AgentId) {
  agentPreview(ctx, agent);
  try {
    const r = await uninstallPlanner(ctx, agent);
    return {removed: r ? [...r.removed, ...r.restored, ...r.reverted] : []};
  } catch (e) { throw toCoreError(e); }
}

export async function version(ctx: Ctx) {
  return {pacer: currentVersion(), protocol: PROTOCOL_VERSION, service: await serviceStatus(ctx)};
}

export async function serviceInstall(ctx:Ctx, consent:boolean, backend:Pick<ServiceBackend,"install"|"status">=serviceBackend(ctx)) {
  if(consent!==true)throw new CoreError("not_allowed","installing the login service requires consent","Pass consent: true to run pacer in the background at login");
  try {
    return await withLock(ctx,"setup-install",async()=>{await backend.install();const s=await backend.status(2000);return {installed:s.installed,running:s.running};},{timeoutMs:0});
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
