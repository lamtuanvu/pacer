import { isAbsolute } from "node:path";
import { resolveRepoInput, resolveRepoInputReadOnly } from "./repos";
import type { Strategy } from "../config/strategy";
import { projectRevision, readProjectStrategies } from "../config/project-strategies";
import { resolveProjectSelection, type ProjectSelection } from "../engine/project-routing";
import { CoreError } from "./errors";
import type { Ctx } from "../types";

export function projectSnapshot(ctx: Ctx, strategy: Strategy, repoKey: string) {
  const data = readProjectStrategies(ctx);
  return { repoKey, rev: projectRevision(data, repoKey), selection: resolveProjectSelection(strategy, repoKey, data.projects) };
}
export function requireProjectExecutor(selection: ProjectSelection | undefined, executor: string | null | undefined): void {
  if (executor && selection && !selection.executors.includes(executor)) {
    throw new CoreError("not_allowed", `${executor} is forbidden by project policy for ${selection.repoKey}`, "Choose an allowed executor or edit the project strategy.");
  }
}

/** Stored task identity is authoritative; inconclusive new probes must fail closed. */
export async function resolvePolicyRepo(ctx: Ctx, path: string) {
  const strict = Object.values(readProjectStrategies(ctx).projects).some(p => p.executors !== null);
  const repo = await resolveRepoInput(ctx, path, strict);
  requirePolicyIdentity(ctx, repo);
  return repo;
}
export async function resolvePolicyRepoInput(ctx: Ctx, value: string) {
  return isAbsolute(value) ? resolvePolicyRepo(ctx, value) : resolveRepoInput(ctx, value);
}

/** The read-only form of resolvePolicyRepoInput, for operations that must write nothing. */
export async function resolvePolicyRepoInputReadOnly(ctx: Ctx, value: string) {
  const strict = isAbsolute(value) && Object.values(readProjectStrategies(ctx).projects).some(p => p.executors !== null);
  const repo = await resolveRepoInputReadOnly(ctx, value, strict);
  requirePolicyIdentity(ctx, repo);
  return repo;
}

export function requirePolicyIdentity(ctx: Ctx, repo: import("../api/read-model/types").RepoRef): void {
  if (repo.identityUnverified && Object.values(readProjectStrategies(ctx).projects).some(p => p.executors !== null)) {
    throw new CoreError("invalid_input", "Cannot establish repository identity for project routing", "Restore Git access and retry; project policy cannot safely fall back to global routing.");
  }
}
