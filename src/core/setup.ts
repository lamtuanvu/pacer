import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNERS, validateStrategy } from "../config/strategy";
import { parseRunnerId } from "../config/runner-id";
import { migrateStrategy } from "../config/migrate";
import { detect, starterStrategy } from "../install/init";
import { agentPlans, type AgentId } from "../install/detection";
import { installPlanner } from "../install";
import { uninstallPlanner } from "../install/uninstall";
import { pacerArgv } from "../install/self";
import { installPlugin, pluginDir, MANAGED_MARKER } from "../plugin/install";
import { serviceBackend } from "../service";
import { checkSetup } from "../setup/check";
import { currentVersion } from "../update/version";
import { PROTOCOL_VERSION } from "../api/protocol";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";
import * as config from "./config";

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

export async function pluginInstall(ctx: Ctx) {
  try {
    await installPlugin({ctx, pacerArgv: pacerArgv(ctx.env)});
    return {path: pluginDir(ctx)};
  } catch (e) { throw toCoreError(e); }
}

export function agentPreview(ctx: Ctx, agent: AgentId) {
  // Preview remains available even when a CLI has not been installed yet.
  const plan = agentPlans(ctx.home, ctx.pacerHome, () => "preview", ctx.env).find(p => p.id === agent);
  if (!plan) throw new CoreError("invalid_input", `unknown agent: ${agent}`, `choose ${PLANNERS.join(', ')}`);
  return {agent, files: plan.files, undo: plan.undo};
}

export async function agentConnect(ctx: Ctx, agent: AgentId, options: {consent?: boolean} = {}) {
  if (options.consent !== true) throw new CoreError("not_allowed", "connecting an agent requires consent", "Review agent.preview, then pass consent: true");
  agentPreview(ctx, agent);
  try {
    const r = await installPlanner({ctx, pacerArgv: pacerArgv(ctx.env), mcp: false}, agent);
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
  let plugin: string | undefined;
  try { plugin = JSON.parse(readFileSync(join(pluginDir(ctx), MANAGED_MARKER), 'utf8')).version; } catch { /* not installed */ }
  return {pacer: currentVersion(), protocol: PROTOCOL_VERSION, ...(plugin ? {plugin} : {}), service: await serviceStatus(ctx)};
}
