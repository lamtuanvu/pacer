import { hostFingerprint as driftFingerprint, matchesHostFingerprint } from "./host-drift";
import { isAbsolute } from "node:path";
import { repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostIdentityGrant {
  readonly resource: Readonly<HostOperationResource>;
}

interface Captured {
  home: string;
  alias: string;
  repo: string;
  key: string;
  hostFingerprint: string;
  args: readonly string[];
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostIdentityGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured host identity changed or was not issued"); };

async function localIdentity(ctx: Ctx, repo: string): Promise<{ key: string; name: string; email: string }> {
  const read = async (...args: string[]) => {
    const result = await ctx.run(["git", "-C", repo, ...args], 10_000);
    if (result.code !== 0 || result.timedOut) return deny();
    return result.stdout.trim();
  };
  const origin = await read("remote", "get-url", "origin");
  const key = repoKey(origin), name = await read("config", "user.name"), email = await read("config", "user.email");
  if (!key || !name || !email || [name, email].some(value => value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)))
    return deny();
  return { key, name, email };
}

/** Host-only consent path: derive the exact mutation tuple from configured mapping and local Git. */
export async function issueConfiguredHostIdentity(ctx: Ctx, alias: string,
  repo: string): Promise<ConfiguredHostIdentityGrant> {
  if (!isAbsolute(repo)) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host || host.paused) return deny();
  const local = await localIdentity(ctx, repo);
  const remotePath = Object.hasOwn(host.repos, local.key) ? host.repos[local.key] : undefined;
  if (!remotePath || !(isAbsolute(remotePath) || remotePath.startsWith("~/")) ||
    remotePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(remotePath)) return deny();
  const args = Object.freeze([remotePath, local.name, local.email]);
  const hostFingerprint = driftFingerprint(host, args, true);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "SET_IDENTITY", args: [...args], timeoutMs: 50_000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, repo, key: local.key, hostFingerprint, args, consumed: false });
  return grant;
}

/** Recheck the host mapping and local source before a caller receives authority. */
export async function validateConfiguredHostIdentity(ctx: Ctx, grant: ConfiguredHostIdentityGrant): Promise<void> {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const host = loadStrategy(ctx).hosts[saved.alias];
  if (!host || host.paused || matchesHostFingerprint(host, saved.hostFingerprint) === false ||
    host.repos[saved.key] !== saved.args[0] || grant.resource.alias !== saved.alias ||
    grant.resource.hostFingerprint !== saved.hostFingerprint || grant.resource.script !== "SET_IDENTITY" ||
    grant.resource.timeoutMs !== 50_000 || grant.resource.maxBytes !== 65_536 ||
    grant.resource.args.length !== saved.args.length ||
    grant.resource.args.some((arg, index) => arg !== saved.args[index])) return deny();
  const local = await localIdentity(ctx, saved.repo);
  if (local.key !== saved.key || local.name !== saved.args[1] || local.email !== saved.args[2]) return deny();
}

/** Consume before admitting a plugin caller; validation during that call stays available. */
export async function consumeConfiguredHostIdentity(ctx: Ctx, grant: ConfiguredHostIdentityGrant): Promise<void> {
  await validateConfiguredHostIdentity(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
