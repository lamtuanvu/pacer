import { SLOT_STATES, slotBlock, slotUse } from "../engine/slots";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type HostCfg, repoKey } from "../config/hosts";
import { resolveRunner } from "../config/runner-id";
import { loadStrategy, type Strategy } from "../config/strategy";
import { readJson, writeJsonAtomic } from "../fsutil";
import { listTasksWhere } from "../tasks/store";
import type { Ctx } from "../types";
import { pluginRegistry } from "../plugins";

type Reading = { target: string; at: number; reachable: boolean; failures?: number };
export function readHostReachability(ctx: Ctx, host: HostCfg): Reading | null {
  const reading = readJson<Record<string, Reading>>(join(ctx.pacerHome, "cache", "hosts.json"))?.[host.alias];
  return reading?.target === targetKey(host) && Number.isFinite(reading.at) ? reading : null;
}
const memory = new Map<string, Record<string, Reading>>();
const inFlight = new Map<string, Promise<boolean>>();
const targetKey = (host: HostCfg) => createHash("sha256").update(JSON.stringify(host)).digest("hex");
const fresh = (ctx: Ctx, host: HostCfg, r: Reading | undefined): r is Reading =>
  !!r && r.target === targetKey(host) && typeof r.reachable === "boolean" && Number.isFinite(r.at) && ctx.now >= r.at && ctx.now - r.at < 60;

function pluginsAvailable(ctx: Ctx): boolean {
  try {
    const registry = pluginRegistry(ctx);
    return registry.find(ctx, "remoteCaller", () => true) === "pacer-remote-caller" &&
      JSON.stringify(registry.findAll(ctx, "hostRunner", contribution =>
        Array.isArray(contribution.kinds) && contribution.kinds.length === 1 && contribution.kinds[0] === "ssh")) ===
      JSON.stringify(["pacer-ssh"]);
  } catch { return false; }
}

async function probeReachability(ctx: Ctx, host: HostCfg): Promise<boolean> {
  try {
    const snapshot = JSON.stringify(host);
    if (JSON.stringify(loadStrategy(ctx).hosts[host.alias]) !== snapshot) return false;
    const registry = pluginRegistry(ctx);
    const caller = registry.find(ctx, "remoteCaller", () => true);
    if (caller !== "pacer-remote-caller") return false;
    const result = await registry.call<{ reachable: boolean }>(ctx, caller,
      "remoteCaller.reachability", { alias: host.alias }, { deadlineMs: 30_000 });
    return result.reachable && JSON.stringify(loadStrategy(ctx).hosts[host.alias]) === snapshot;
  } catch { return false; }
}

function recordReachability(ctx: Ctx, host: HostCfg, ok: boolean): Reading {
  const file=join(ctx.pacerHome,"cache","hosts.json");
  const disk=readJson<Record<string,Reading>>(file)??{},prev=disk[host.alias];
  const failures=ok?0:(prev?.target===targetKey(host)?prev.failures??0:0)+1;
  const reading={target:targetKey(host),at:ctx.now,reachable:ok,failures};
  memory.set(file,{...memory.get(file),[host.alias]:reading});
  if(!ctx.readOnly){try{writeJsonAtomic(file,{...disk,[host.alias]:reading});}catch{/* Cache failures must not prevent routing. */}}
  return reading;
}

async function reachable(ctx: Ctx, host: HostCfg): Promise<boolean> {
  // A healthy cached SSH target does not authorize routing after its plugin is disabled.
  if (!pluginsAvailable(ctx)) return false;
  const file = join(ctx.pacerHome, "cache", "hosts.json");
  const cached = memory.get(file)?.[host.alias];
  if (fresh(ctx, host, cached)) return cached.reachable;
  const disk = readJson<Record<string, Reading>>(file) ?? {};
  if (fresh(ctx, host, disk[host.alias])) {
    memory.set(file, { ...memory.get(file), [host.alias]: disk[host.alias] });
    return disk[host.alias].reachable;
  }
  const key = JSON.stringify([file, host.alias, targetKey(host)]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const probe = (async () => {
    const ok = await probeReachability(ctx, host);
    recordReachability(ctx,host,ok);
    return ok;
  })();
  inFlight.set(key, probe);
  try { return await probe; } finally { inFlight.delete(key); }
}

/** Route previews omit task facts and check only connectivity. */
export async function remoteExclusion(
  ctx: Ctx, s: Strategy, runnerId: string,
  task?: { repo: string; placement: "current" | "new" },
  deps: { reachable?: (h: HostCfg) => Promise<boolean>; running?: (alias: string) => number; skipSlots?: boolean; currentTaskId?: string } = {},
): Promise<string | null> {
  const alias = resolveRunner(s, runnerId)?.host;
  if (!alias) return null;
  const host = s.hosts[alias];
  if (host.paused) return `${alias} paused`;
  const up = await (deps.reachable ? deps.reachable(host).catch(() => false) : reachable(ctx, host));
  if (!up) return `host ${alias} unreachable`;
  if (!task) return null;
  const origin = await ctx.run(["git", "-C", task.repo, "remote", "get-url", "origin"], 10_000).catch(() => null);
  const key = origin?.code === 0 ? repoKey(origin.stdout.trim()) : null;
  if (!key || !Object.hasOwn(host.repos, key)) return `repo not set up on ${alias} (add hosts.${alias}.repos.${key ?? "<key>"})`;
  if (task.placement === "current") return "remote runners need a new worktree";
  if (deps.skipSlots) return null;
  const use = slotUse(listTasksWhere(ctx, { states: SLOT_STATES }).filter(t => t.id !== deps.currentTaskId));
  if (deps.running) use.byHost[alias] = deps.running(alias);
  return slotBlock(s, runnerId, use);
}

export interface HostProbeDeps {
  strategy?: (ctx: Ctx) => Strategy;
  reachable?: (host: HostCfg) => Promise<boolean>;
}
/** Probe enabled hosts without changing running tasks or trusting the routing TTL. */
export async function probeHosts(ctx: Ctx, deps: HostProbeDeps = {}): Promise<{alias: string; reachable: boolean; failures: number}[]> {
  const strategy=(deps.strategy??loadStrategy)(ctx);
  const hosts=Object.values(strategy.hosts).filter(h=>!h.paused&&Object.values(strategy.runners).some(r=>r.host===h.alias&&r.enabled!==false));
  return Promise.all(hosts.map(async host=>{
    const ok=await (deps.reachable?deps.reachable(host):probeReachability(ctx,host)).catch(()=>false);
    const reading=recordReachability(ctx,host,ok);
    return {alias:host.alias,reachable:ok,failures:reading.failures??0};
  }));
}
