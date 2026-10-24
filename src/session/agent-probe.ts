import type { AgentVersion } from "@pacer/plugin";
import type { Ctx } from "../types";

export interface AgentProbe extends AgentVersion { reason?: string }
export function agentExecutable(agent: string): string {
  return agent === "claude-code" ? "claude" : agent === "cursor" ? "cursor-agent" : agent;
}

/** Never put CLI stderr in API results: wrappers may print sensitive account data. */
export async function probeAgentSession(ctx: Ctx, agent: string, env: Record<string, string | undefined>): Promise<AgentProbe> {
  const executable = agentExecutable(agent);
  const commands = [[executable, "--version"], [executable, "--help"],
    ...(agent === "codex" ? [[executable, "resume", "--help"]] : agent === "opencode" ? [[executable, "api", "--help"]] : [])];
  const results = await Promise.all(commands.map(async argv => {
    try { return await ctx.run(argv, 5000, {env}); }
    catch { return {code: 127, stdout: "", stderr: ""}; }
  }));
  const version = results[0]!.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "unknown";
  const failed = results.findIndex(result => result.code !== 0 || result.timedOut || !result.stdout.trim());
  if (failed !== -1) return {agent, version, reason: `${agent}: ${commands[failed]!.slice(1).join(" ")} probe failed. Check that ${executable} is installed and runs in this account's environment.`};
  return {agent, version, help: results[1]!.stdout.slice(0, 100_000),
    ...(agent === "codex" ? {resumeHelp: results[2]!.stdout.slice(0, 100_000)} : {}),
    ...(agent === "opencode" ? {apiHelp: results[2]!.stdout.slice(0, 100_000)} : {})};
}
