import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_BINS = { "claude-code": ["claude"], codex: ["codex"], cursor: ["cursor-agent", "cursor"], opencode: ["opencode"] } as const;
export type AgentId = keyof typeof AGENT_BINS;
export interface AgentPlan { id: AgentId; name: string; installed: boolean; files: string[]; undo: string }
const names = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
/** Read-only consent preview; never probes a CLI by starting it. */
export function agentPlans(home: string, pacerHome: string, which: (bin: string) => string | null, env: NodeJS.ProcessEnv = {}): AgentPlan[] {
  let installed: Record<string, unknown> = {};
  try { installed = JSON.parse(readFileSync(join(pacerHome, "install-manifest.json"), "utf8")).planners ?? {}; } catch { /* no manifest yet */ }
  return (Object.keys(AGENT_BINS) as AgentId[]).filter(id => AGENT_BINS[id].some(bin => which(bin))).map(id => {
    const root = id === "opencode" ? join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode") : join(home, id === "claude-code" ? ".claude" : `.${id}`);
    const skillRoot = id === "codex" ? env.CODEX_HOME || root : root;
    const files = [join(skillRoot, "skills/pacer/SKILL.md"), ...({
      "claude-code": [join(root, "rules/pacer.md"), join(root, "settings.json")],
      codex: [join(root, "AGENTS.md"), join(root, "hooks.json")],
      cursor: [join(root, "hooks.json")],
      opencode: [join(root, "AGENTS.md")],
    }[id])];
    if (id === "claude-code") {
      try {
        const command = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).statusLine?.command;
        if (typeof command === "string" && !/\s/.test(command)) {
          const path = command.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home);
          if (path.startsWith("/") && existsSync(path) && /^input=\$\(cat\)\s*$/m.test(readFileSync(path, "utf8"))) files.push(path);
        }
      } catch { /* malformed settings are reported by install */ }
      files.push(...["scripts/budget/budget_status.py", "scripts/budget/subagent_guard.py", "scripts/budget/budget-status", "rules/model-delegation.md"].map(p => join(root, p)).filter(existsSync));
      const delegation = join(root, "agents/delegation");
      if (existsSync(delegation)) files.push(...readdirSync(delegation).filter(p => p.endsWith(".md")).sort().map(p => join(delegation, p)));
    }
    return { id, name: names[id], installed: !!installed[id], files, undo: `pacer uninstall ${id}` };
  });
}


export interface AgentDetection {
  agent: AgentId;
  found: boolean;
  version: string | null;
  path: string | null;
  install_hint: string;
}
const installHints: Record<AgentId, string> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  cursor: "Install Cursor CLI from https://cursor.com/docs/cli/installation",
  opencode: "brew install opencode",
};
/** Probe only version flags, never start interactive agent sessions. */
export async function detectAgents(ctx: Ctx, o: { host?: string } = {}): Promise<AgentDetection[]> {
  const ids = Object.keys(AGENT_BINS) as AgentId[];
  const missing = (agent: AgentId): AgentDetection => ({ agent, found: false, version: null, path: null, install_hint: installHints[agent] });
  // Phase 3c supplies host tool data. Do not run local probes for remote hosts.
  if (o.host !== undefined) return ids.map(missing);
  const paths = ids.map(id => AGENT_BINS[id].map(bin => ctx.which(bin)).find(Boolean) ?? null);
  const key = createHash("sha256").update(JSON.stringify([paths, ctx.env.PATH])).digest("hex");
  const file = join(ctx.pacerHome, "cache", `agent-detect-${key}.json`);
  const cached = readJson<{ at: number; rows: AgentDetection[] }>(file);
  if (cached && ctx.now - cached.at >= 0 && ctx.now - cached.at < 3600) return cached.rows;
  const rows = await Promise.all(ids.map(async (agent, i) => {
    const path = paths[i];
    if (!path) return missing(agent);
    let version: string | null = null;
    try {
      const result = await ctx.run([path, "--version"], 5000, { env: ctx.env });
      if (result.code === 0) version = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
    } catch { /* A found binary can still fail or time out while reporting its version. */ }
    return { agent, found: true, version, path, install_hint: installHints[agent] };
  }));
  if (!ctx.readOnly) writeJsonAtomic(file, { at: ctx.now, rows });
  return rows;
}
