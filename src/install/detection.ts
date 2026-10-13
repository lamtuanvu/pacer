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
