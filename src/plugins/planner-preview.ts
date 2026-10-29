import type { Ctx } from "../types";
import { pluginRegistry } from "./index";
import { PlannerResources } from "./planner-resources";
import { plannerSelectedSources } from "./planner-selection";
export async function plannerPreview(
  ctx: Ctx,
  agent: string,
  folder: string,
  key = agent,
  skillFolder?: string,
): Promise<{ files: string[]; undo: string; detail?: string }> {
  ctx = { ...ctx, readOnly: true };
  const registry = pluginRegistry(ctx),
    id = registry.find(
      ctx,
      "planner",
      (value) => Array.isArray(value.agents) && value.agents.includes(agent),
    );
  if (!id) throw Error(`planner plugin unavailable: ${agent}`);
  const lease = new PlannerResources(ctx, {
    purpose: "preview",
    cwd: ctx.home,
    binaries: [],
    roots: [folder, ...(skillFolder ? [skillFolder] : [])],
    files: plannerSelectedSources(ctx, agent, folder),
  });
  try {
    return await registry.call(
      ctx,
      id,
      "planner.preview",
      {
        agent,
        home: ctx.home,
        pacerHome: ctx.pacerHome,
        binary: null,
        env: {
          now: ctx.now,
          pacerArgv: ["pacer"],
          plannerKey: key,
          folder,
          ...(skillFolder ? { skillFolder } : {}),
        },
      },
      { plannerResources: lease, accountHome: folder },
    );
  } finally {
    await lease.dispose();
  }
}
