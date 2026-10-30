import { pluginRegistry } from "../plugins";
import { CoreError } from "../core/errors";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_BINS = {
  "claude-code": ["claude"],
  codex: ["codex"],
  cursor: ["cursor-agent", "cursor"],
  opencode: ["opencode"],
} as const;
export type AgentId = keyof typeof AGENT_BINS;
export interface AgentPlan {
  id: AgentId;
  name: string;
  installed: boolean;
  files: string[];
  undo: string;
}
const names = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};
/** Host-owned presence/record labels only. Desired file discovery belongs to planner.preview. */
export function agentPlans(
  home: string,
  pacerHome: string,
  which: (bin: string) => string | null,
  _env: NodeJS.ProcessEnv = {},
): AgentPlan[] {
  let installed: Record<string, unknown> = {};
  try {
    installed =
      JSON.parse(readFileSync(join(pacerHome, "install-manifest.json"), "utf8"))
        .planners ?? {};
  } catch {}
  return (Object.keys(AGENT_BINS) as AgentId[])
    .filter((id) => AGENT_BINS[id].some((bin) => which(bin)))
    .map((id) => ({
      id,
      name: names[id],
      installed: !!installed[id],
      files: [],
      undo: `pacer uninstall ${id}`,
    }));
}

export interface AgentDetection {
  agent: AgentId;
  found: boolean;
  version: string | null;
  path: string | null;
  install_hint: string;
}
/** Probe policy/cache stay host-owned; plugin owns detection interpretation and hints. */
export async function detectAgents(
  ctx: Ctx,
  o: { host?: string } = {},
): Promise<AgentDetection[]> {
  const ids = Object.keys(AGENT_BINS) as AgentId[];
  const binaries = ids.map((id) =>
    o.host !== undefined
      ? undefined
      : AGENT_BINS[id]
          .map((name) => ({ name, path: ctx.which(name) }))
          .find((value) => value.path),
  );
  const key = createHash("sha256")
      .update(JSON.stringify([binaries, ctx.env.PATH, o.host]))
      .digest("hex"),
    file = join(ctx.pacerHome, "cache", `agent-detect-${key}.json`);
  const cached = readJson<{ at: number; rows: AgentDetection[] }>(file);
  if (cached && ctx.now - cached.at >= 0 && ctx.now - cached.at < 3600)
    return cached.rows;
  const registry = pluginRegistry(ctx),
    id = registry.find(ctx, "planner", (value) => {
      const agents = value.agents;
      return (
        Array.isArray(agents) && ids.every((agent) => agents.includes(agent))
      );
    });
  if (!id)
    throw new CoreError(
      "plugin_unavailable",
      "planner detection plugin unavailable",
    );
  const rows = await Promise.all(
    ids.map(async (agent, index) => {
      const binary = binaries[index],
        env = { HOME: ctx.home, PATH: ctx.env.PATH ?? "" };
      const probe =
        binary && binary.name !== "cursor"
          ? {
              argv: [binary.name, "--version"],
              timeoutMs: 5000,
              cwd: ctx.home,
              env,
            }
          : undefined;
      const selected = binary?.path ?? null,
        host = {
          ...ctx,
          readOnly: true,
          which: (name: string) => (name === binary?.name ? selected : null),
        };
      return await registry.call<AgentDetection>(
        host,
        id,
        "planner.detect",
        {
          agent,
          binary: binary ? { name: binary.name, path: selected } : null,
          ...(probe ? { probe } : {}),
        },
        {
          resources: { reads: [], commands: probe ? [probe] : [], stores: [] },
        },
      );
    }),
  );
  if (!ctx.readOnly && o.host === undefined)
    writeJsonAtomic(file, { at: ctx.now, rows });
  return rows;
}
