import { executorLabel } from "../view-model/words";
import { isAbsolute } from "node:path";
import { loadStrategy, type Strategy } from "../config/strategy";
import { projectRevision, readProjectStrategies, writeProjectStrategy, type ProjectStrategyEntry } from "../config/project-strategies";
import { projectReferences, runnerReference } from "../engine/project-routing";
import { listRepos, resolveRepoInput, resolveRepo } from "./repos";
import type { RepoRef } from "../api/read-model/types";
import type { Ctx } from "../types";

export interface ProjectStrategyView {
  repo: Pick<RepoRef, "key" | "label"> & { path?: string };
  rev: number;
  executors: string[] | null;
  available: { id: string; reference: string; label: string }[];
}
function view(strategy: Strategy, repo: ProjectStrategyView["repo"], entry?: ProjectStrategyEntry): ProjectStrategyView {
  return { repo, rev: entry?.rev ?? 0, executors: entry?.executors ?? null,
    available: Object.values(strategy.runners)
      .filter(r => r.agent !== strategy.planner.agent || r.account !== strategy.planner.account)
      .map(r => ({ id: r.id, reference: runnerReference(r), label: `${executorLabel(r.agent)} · ${r.account} · ${r.host ?? "This machine"}` })) };
}
async function resolve(ctx: Ctx, value: string): Promise<ProjectStrategyView["repo"]> {
  const policies = readProjectStrategies(ctx);
  if (!isAbsolute(value) && Object.hasOwn(policies.projects, value)) {
    return listRepos({ ...ctx, readOnly: true }).find(r => r.key === value) ?? { key: value, label: value };
  }
  return resolveRepoInput(ctx, value);
}
export function list(ctx: Ctx): ProjectStrategyView[] {
  const data = readProjectStrategies(ctx), strategy = loadStrategy(ctx), repos = listRepos({ ...ctx, readOnly: true });
  return Object.entries(data.projects).filter(([, entry]) => entry.executors !== null)
    .map(([key, entry]) => view(strategy, repos.find(r => r.key === key) ?? { key, label: key }, entry));
}
export async function get(ctx: Ctx, value: string): Promise<ProjectStrategyView> {
  const repo = await resolve(ctx, value), data = readProjectStrategies(ctx);
  return view(loadStrategy(ctx), repo, projectRevision(data, repo.key) ? data.projects[repo.key] : undefined);
}
export async function set(ctx: Ctx, value: string, executors: string[], expectRev: number): Promise<ProjectStrategyView> {
  const repo = isAbsolute(value) ? await resolveRepo(ctx, value, true) : await resolve(ctx, value), strategy = loadStrategy(ctx);
  const entry = await writeProjectStrategy(ctx, repo.key, projectReferences(strategy, executors), expectRev);
  return view(strategy, repo, entry);
}
export async function remove(ctx: Ctx, value: string, expectRev: number): Promise<ProjectStrategyView> {
  const repo = await resolve(ctx, value), strategy = loadStrategy(ctx);
  return view(strategy, repo, await writeProjectStrategy(ctx, repo.key, null, expectRev));
}
