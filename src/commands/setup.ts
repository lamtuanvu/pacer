import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { agentPlans, AGENT_BINS, type AgentId } from "../install/detection";
import { initCmd } from "../install/init";
import { installPlanner } from "../install";
import { pacerArgv } from "../install/self";
import { serviceBackend, type ServiceBackend } from "../service";
import type { Ctx } from "../types";
import type { Result } from "./types";
export const SETUP_USAGE = "setup [--yes] [--agents a,b] [--json]";
export interface SetupDeps { tty?: boolean; confirm?: (plan: string) => Promise<boolean>; service?: (ctx: Ctx) => Pick<ServiceBackend, "status" | "install"> }
export async function setupCmd(args: string[], ctx: Ctx, deps: SetupDeps = {}): Promise<Result> {
  let yes = false, json = false, selected: AgentId[] | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yes") yes = true;
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--agents" && args[i + 1] && !args[i + 1].startsWith("--")) {
      const ids = args[++i].split(",");
      if (ids.some(id => !Object.hasOwn(AGENT_BINS, id))) return { code: 2, out: "", err: `unknown agent; choose ${Object.keys(AGENT_BINS).join(", ")}` };
      selected = [...new Set(ids)] as AgentId[];
    } else return { code: 2, out: "", err: `usage: pacer ${SETUP_USAGE}` };
  }
  try {
    const agents = agentPlans(ctx.home, ctx.pacerHome, ctx.which, ctx.env).filter(a => !selected || selected.includes(a.id));
    if (selected?.some(id => !agents.some(a => a.id === id))) return { code: 2, out: "", err: "requested agent CLI is not on PATH" };
    const plan = ["Ensure pacer strategy and login service.", ...agents.map(a => `${a.name}: ${a.installed ? "already connected" : a.files.join(", ")}\n  Undo: ${a.undo}`), "No MCP servers will be added."].join("\n");
    if (!yes) {
      if (!(deps.tty ?? process.stdin.isTTY)) return { code: 2, out: json ? JSON.stringify({ plan, agents, applied: false }) : plan, err: "Run with --yes to connect your agents." };
      const confirm = deps.confirm ?? (async (text: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try { return /^y(?:es)?$/i.test((await rl.question(`${text}\nConnect your agents? [y/N] `)).trim()); } finally { rl.close(); }
      });
      if (!await confirm(plan)) return { code: 2, out: plan, err: "Setup cancelled." };
    }
    if (!existsSync(join(ctx.pacerHome, "strategy.yaml"))) {
      const result = await initCmd(ctx); if (result.code) return result;
    }
    const service = (deps.service ?? serviceBackend)(ctx);
    if (!(await service.status()).installed) await service.install();
    const results = [];
    for (const agent of agents) {
      if (!agent.installed) await installPlanner({ ctx, pacerArgv: pacerArgv(ctx.env) }, agent.id);
      results.push({ ...agent, installed: true, status: agent.installed ? "already connected" : "connected" });
    }
    return { code: 0, out: json ? JSON.stringify({ agents: results, applied: true }) : results.map(a => `${a.name}: ${a.status}\n  Undo: ${a.undo}`).join("\n") || "No agent CLIs detected.", err: "" };
  } catch (e) { return { code: 1, out: "", err: `pacer setup: ${(e as Error).message}` }; }
}
