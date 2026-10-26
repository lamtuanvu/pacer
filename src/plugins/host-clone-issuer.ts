import { isAbsolute } from "node:path";
import { repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostCloneGrant {
  readonly resource: Readonly<HostOperationResource>;
}

/** The exact tuple shown for CLI consent or captured before an API setup precheck. */
export interface ConfiguredHostCloneSnapshot {
  readonly alias: string;
  readonly key: string;
  readonly path: string;
  readonly origin: string;
  readonly hostFingerprint: string;
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
const issued = new WeakMap<ConfiguredHostCloneGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured host clone changed or was not issued"); };

async function localOrigin(ctx: Ctx, repo: string): Promise<{ key: string; origin: string }> {
  const result = await ctx.run(["git", "-C", repo, "remote", "get-url", "origin"], 10_000);
  if (result.code !== 0 || result.timedOut) return deny();
  const origin = result.stdout.trim(), key = repoKey(origin);
  if (!key || !origin || origin.length > 4096 || /[\u0000-\u001f\u007f]/.test(origin)) return deny();
  return { key, origin };
}

/** Mint only after setup consent and the completed configured checkout precheck. */
export async function issueConfiguredHostClone(ctx: Ctx, alias: string, repo: string,
  consent: boolean, expected: ConfiguredHostCloneSnapshot): Promise<ConfiguredHostCloneGrant> {
  if (consent !== true || !isAbsolute(repo)) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host || host.paused) return deny();
  const local = await localOrigin(ctx, repo);
  const remotePath = Object.hasOwn(host.repos, local.key) ? host.repos[local.key] : undefined;
  if (!expected || expected.alias !== alias || expected.key !== local.key ||
    expected.path !== remotePath || expected.origin !== local.origin ||
    expected.hostFingerprint !== JSON.stringify(host)) return deny();
  if (!remotePath || !(isAbsolute(remotePath) || remotePath.startsWith("~/")) ||
    remotePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(remotePath)) return deny();
  const args = Object.freeze([remotePath, "clone", local.origin]);
  const hostFingerprint = JSON.stringify(host);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "CHECK_REPO", args: [...args], timeoutMs: 50_000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, repo, key: local.key, hostFingerprint, args, consumed: false });
  return grant;
}

export async function validateConfiguredHostClone(ctx: Ctx, grant: ConfiguredHostCloneGrant): Promise<void> {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const host = loadStrategy(ctx).hosts[saved.alias];
  if (!host || host.paused || JSON.stringify(host) !== saved.hostFingerprint ||
    host.repos[saved.key] !== saved.args[0] || grant.resource.alias !== saved.alias ||
    grant.resource.hostFingerprint !== saved.hostFingerprint || grant.resource.script !== "CHECK_REPO" ||
    grant.resource.timeoutMs !== 50_000 || grant.resource.maxBytes !== 65_536 ||
    grant.resource.args.length !== saved.args.length ||
    grant.resource.args.some((arg, index) => arg !== saved.args[index])) return deny();
  const local = await localOrigin(ctx, saved.repo);
  if (local.key !== saved.key || local.origin !== saved.args[2]) return deny();
}

export async function consumeConfiguredHostClone(ctx: Ctx, grant: ConfiguredHostCloneGrant): Promise<void> {
  await validateConfiguredHostClone(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
