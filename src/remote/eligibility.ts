import { slotBlock, slotUse } from "../engine/slots";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type HostCfg, repoKey } from "../config/hosts";
import { resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import { readJson, writeJsonAtomic } from "../fsutil";
import { listTasks } from "../tasks/store";
import type { Ctx } from "../types";
import { SCRIPTS } from "./scripts";
import { runRemote } from "./ssh";

type Reading = { target: string; at: number; reachable: boolean };
const memory = new Map<string, Record<string, Reading>>();
const inFlight = new Map<string, Promise<boolean>>();
const targetKey = (host: HostCfg) => createHash("sha256").update(host.ssh).digest("hex");
const fresh = (ctx: Ctx, host: HostCfg, r: Reading | undefined): r is Reading =>
  !!r && r.target === targetKey(host) && typeof r.reachable === "boolean" && Number.isFinite(r.at) && ctx.now >= r.at && ctx.now - r.at < 60;

async function reachable(ctx: Ctx, host: HostCfg): Promise<boolean> {
  const file = join(ctx.pacerHome, "cache", "hosts.json");
  const cached = memory.get(file)?.[host.alias];
  if (fresh(ctx, host, cached)) return cached.reachable;
  const disk = readJson<Record<string, Reading>>(file) ?? {};
  if (fresh(ctx, host, disk[host.alias])) {
    memory.set(file, { ...memory.get(file), [host.alias]: disk[host.alias] });
    return disk[host.alias].reachable;
  }
  const key = JSON.stringify([file, host.alias, host.ssh]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const probe = (async () => {
    // The allowlisted cat program with empty stdin is a no-op connectivity check.
    const ok = await runRemote(ctx, host, SCRIPTS.ECHO_STDIN, [], { stdin: "", timeoutMs: 15_000 })
      .then(r => r.code === 0, () => false);
    const reading = { target: targetKey(host), at: ctx.now, reachable: ok };
    memory.set(file, { ...memory.get(file), [host.alias]: reading });
    if (!ctx.readOnly) {
      try { writeJsonAtomic(file, { ...(readJson<Record<string, Reading>>(file) ?? {}), [host.alias]: reading }); } catch {}
    }
    return ok;
  })();
  inFlight.set(key, probe);
  try { return await probe; } finally { inFlight.delete(key); }
}

/** Route previews omit task facts and check only connectivity. */
export async function remoteExclusion(
  ctx: Ctx, s: Strategy, runnerId: string,
  task?: { repo: string; placement: "current" | "new" },
  deps: { reachable?: (h: HostCfg) => Promise<boolean>; running?: (alias: string) => number } = {},
): Promise<string | null> {
  const alias = resolveRunner(s, runnerId)?.host;
  if (!alias) return null;
  const host = s.hosts[alias];
  const up = await (deps.reachable ? deps.reachable(host).catch(() => false) : reachable(ctx, host));
  if (!up) return `host ${alias} unreachable`;
  if (!task) return null;
  const origin = await ctx.run(["git", "-C", task.repo, "remote", "get-url", "origin"], 10_000).catch(() => null);
  const key = origin?.code === 0 ? repoKey(origin.stdout.trim()) : null;
  if (!key || !Object.hasOwn(host.repos, key)) return `repo not set up on ${alias} (add hosts.${alias}.repos.${key ?? "<key>"})`;
  if (task.placement === "current") return "remote runners need a new worktree";
  const use = slotUse(listTasks(ctx, Infinity));
  if (deps.running) use.byHost[alias] = deps.running(alias);
  return slotBlock(s, runnerId, use);
}
