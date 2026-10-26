import { join } from "node:path";
import type { Ctx } from "../types";
import type { PlannerRecord } from "../install/manifest";
import { CoreError } from "../core/errors";
import { pluginRegistry } from "./index";
import { PlannerResources } from "./planner-resources";
import { plannerSelectedSources } from "./planner-selection";
/** Ordinary exact file resources, never an installation-effect borrow. */
export async function plannerCheck(
  ctx: Ctx,
  key: string,
  record: PlannerRecord,
  selectedFolder?: string,
): Promise<{ intact: boolean; files: { path: string; intact: boolean }[] }> {
  const agent = key.split("#")[0]!,
    folder =
      selectedFolder ??
      record.folder ??
      join(
        ctx.home,
        agent === "claude-code"
          ? ".claude"
          : agent === "opencode"
            ? ".config/opencode"
            : `.${agent}`,
      );
  const registry = pluginRegistry(ctx),
    id = registry.find(
      ctx,
      "planner",
      (value) => Array.isArray(value.agents) && value.agents.includes(agent),
    );
  if (!id)
    throw new CoreError(
      "plugin_unavailable",
      "planner check plugin unavailable",
    );
  const scope = new PlannerResources(ctx, {
    purpose: "preview",
    binaries: [],
    cwd: ctx.home,
    roots: [folder],
    files: [
      ...plannerSelectedSources(ctx, agent, folder),
      // Legacy default Codex records may keep only their skill in CODEX_HOME.
      // Admit the exact recorded asset, never that root or its siblings.
      ...record.files
        .filter((file) => file.path.endsWith("/skills/pacer/SKILL.md"))
        .map((file) => file.path),
    ],
  });
  try {
    const paths = record.files.flatMap((file) => [
      file.path,
      ...(file.backup ? [file.backup] : []),
    ]);
    if (paths.some((path) => !scope.permits(path)))
      throw new CoreError(
        "capability_denied",
        "planner check path outside selected file policy",
      );
    return await registry.call(
      { ...ctx, readOnly: true },
      id,
      "planner.check",
      { agent, files: structuredClone(record.files) },
      {
        accountHome: folder,
        resources: {
          reads: [...new Set(paths)].map((path) => ({
            path,
            kind: "file" as const,
          })),
          commands: [],
          stores: [],
        },
      },
    );
  } finally {
    await scope.dispose();
  }
}
