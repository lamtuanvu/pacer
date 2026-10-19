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
