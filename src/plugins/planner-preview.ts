import type { Ctx } from "../types";
import { readManifest } from "../install/manifest";
import { pluginRegistry } from "./index";
import { PlannerResources } from "./planner-resources";
import { plannerSelectedSources } from "./planner-selection";
export interface PreviewFile {
  path: string;
  change: "create" | "update" | "restore" | "unchanged" | "kept";
}
/** The preview a repair shows: the files pacer would write, plus per-file change (board 17b). */
export interface PlannerPreviewResult {
  files: string[];
  changes: PreviewFile[];
  undo: string;
  detail?: string;
}
export async function plannerPreview(
  ctx: Ctx,
  agent: string,
  folder: string,
  key = agent,
  skillFolder?: string,
): Promise<PlannerPreviewResult> {
  ctx = { ...ctx, readOnly: true };
  const registry = pluginRegistry(ctx),
    id = registry.find(
      ctx,
      "planner",
      (value) => Array.isArray(value.agents) && value.agents.includes(agent),
    );
  if (!id) throw Error(`planner plugin unavailable: ${agent}`);
  const prior = readManifest(ctx).planners[key];
  const lease = new PlannerResources(ctx, {
    purpose: "preview",
    cwd: ctx.home,
    binaries: [],
    roots: [folder, ...(skillFolder ? [skillFolder] : [])],
    files: plannerSelectedSources(ctx, agent, folder),
  });
  try {
    return (await registry.call(
      ctx,
      id,
      "planner.preview",
      {
        agent,
        home: ctx.home,
        pacerHome: ctx.pacerHome,
        binary: null,
        ...(prior ? { prior: structuredClone(prior) } : {}),
        env: {
          now: ctx.now,
          pacerArgv: ["pacer"],
          plannerKey: key,
          folder,
          ...(skillFolder ? { skillFolder } : {}),
        },
      },
      { plannerResources: lease, accountHome: folder },
    )) as PlannerPreviewResult;
  } finally {
    await lease.dispose();
  }
}
