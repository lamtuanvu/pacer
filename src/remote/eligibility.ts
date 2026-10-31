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
const targetKey = (host: HostCfg) => createHash("sha256").update(JSON.stringify([host.alias, host.ssh])).digest("hex");
const fresh = (ctx: Ctx, host: HostCfg, r: Reading | undefined): r is Reading =>
  !!r && r.target === targetKey(host) && typeof r.reachable === "boolean" && Number.isFinite(r.at) && ctx.now >= r.at && ctx.now - r.at < 60;

export function pluginAvailabilityReason(ctx: Ctx): string | null {
  try {
    const registry = pluginRegistry(ctx);
    const entries = registry.list(ctx);
    for (const [id, label] of [["pacer-remote-caller", "SSH remote caller"], ["pacer-ssh", "SSH host runner"]]) {
      const entry = entries.find(item => item.id === id);
      if (!entry) return `${label} plugin ${id} is unavailable`;
      if (!["idle", "starting", "ready"].includes(entry.state))
        return `${label} plugin ${id} is ${entry.state}${entry.error ? `: ${entry.error}` : ""}`;
    }
    return null;
  } catch (error) { return `SSH plugin availability check failed: ${String(error)}`; }
}

async function probeReachability(ctx: Ctx, host: HostCfg): Promise<boolean | null> {
  try {
    const snapshot = targetKey(host);
    const current = loadStrategy(ctx).hosts[host.alias];
    if (!current || targetKey(current) !== snapshot) return false;
    const registry = pluginRegistry(ctx);
    const caller = registry.find(ctx, "remoteCaller", () => true);
    if (caller !== "pacer-remote-caller") return null;
    const result = await registry.call<{ reachable: boolean }>(ctx, caller,
      "remoteCaller.reachability", { alias: host.alias }, { deadlineMs: 30_000 });
    const after = loadStrategy(ctx).hosts[host.alias];
    return result.reachable && !!after && targetKey(after) === snapshot;
  } catch { return pluginAvailabilityReason(ctx) ? null : false; }
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
  if (pluginAvailabilityReason(ctx)) return false;
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
    if (ok !== null && !pluginAvailabilityReason(ctx)) recordReachability(ctx,host,ok);
    return ok === true;
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
  const unavailable = pluginAvailabilityReason(ctx);
  if (unavailable) return unavailable;
  const up = await (deps.reachable ? deps.reachable(host).catch(() => false) : reachable(ctx, host));
  const lostProvider = pluginAvailabilityReason(ctx);
  if (lostProvider) return lostProvider;
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
    if (!deps.reachable && pluginAvailabilityReason(ctx))
      return {alias:host.alias,reachable:false,failures:readHostReachability(ctx,host)?.failures??0};
    const ok=await (deps.reachable?deps.reachable(host):probeReachability(ctx,host)).catch(()=>null);
    if (!deps.reachable && (ok === null || pluginAvailabilityReason(ctx)))
      return {alias:host.alias,reachable:false,failures:readHostReachability(ctx,host)?.failures??0};
    const reading=recordReachability(ctx,host,ok === true);
    return {alias:host.alias,reachable:ok === true,failures:reading.failures??0};
  }));
}
