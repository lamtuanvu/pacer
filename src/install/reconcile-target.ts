import { readInstallFile } from "./atomic";
import { getMember } from "./jsonc";
import { dirname, join, resolve } from "node:path";
import { allowedPair } from "../config/accounts";
import { loadStrategy } from "../config/strategy";
import type { Ctx } from "../types";
import type { PlannerRecord } from "./manifest";
import type { InstallEnv } from "./txn";
import { accountFolder } from "./role";
import { pacerArgv } from "./self";
import { opencodeDir } from "./opencode";

export const INTEGRATION_AGENTS = ["claude-code", "codex", "cursor", "opencode"] as const;
export type IntegrationAgent = typeof INTEGRATION_AGENTS[number];
export function recordedAgent(key: string): IntegrationAgent | null {
  const agent = key.split("#")[0];
  return INTEGRATION_AGENTS.includes(agent as IntegrationAgent) ? agent as IntegrationAgent : null;
}
export function resolveRecordedTarget(ctx: Ctx, key: string, record: PlannerRecord): InstallEnv {
  const agent = recordedAgent(key);
  if (!agent || record.planner !== key || key.includes("@")) throw Error("invalid recorded integration identity");
  const accountName = record.account ?? key.split("#")[1];
  if (key.includes("#") && key.split("#")[1] !== accountName) throw Error("recorded account identity changed");
  const defaultRoot = agent === "opencode" ? opencodeDir(ctx) : join(ctx.home, agent === "claude-code" ? ".claude" : `.${agent}`);
  // Old records lack folder; infer it from policy/hooks, never from an arbitrary skill path.
  const suffix = agent === "claude-code" ? "/rules/pacer.md" : "/AGENTS.md";
  const policy = record.files.find(file => file.path.endsWith(suffix));
  const hook = record.files.find(file => file.path.endsWith("/hooks.json"));
  const inferred = policy ? policy.path.slice(0, -suffix.length) : hook ? dirname(hook.path) : undefined;
  const folder = resolve(record.folder ?? inferred ?? defaultRoot);
  if (accountName) {
    const account = loadStrategy(ctx).accounts[accountName];
    if (!account || !allowedPair(agent, account.kind)) throw Error("recorded account no longer exists or has changed agent type");
    const currentRoot = accountFolder(ctx, account) ?? (account.source === "default" ? defaultRoot : null);
    if (!currentRoot || resolve(currentRoot) !== folder) throw Error("recorded account folder changed; reconnect the intended account");
  } else if (!inferred && !record.folder) throw Error("recorded integration folder cannot be established; reconnect the intended account");
  const variable = agent === "codex" ? "CODEX_HOME" : agent === "claude-code" ? "CLAUDE_CONFIG_DIR" : undefined;
  const skill = record.files.find(file => file.path.endsWith("/skills/pacer/SKILL.md"));
  const skillRoot = skill ? skill.path.slice(0, -"/skills/pacer/SKILL.md".length) : folder;
  if (record.configEnv && Object.entries(record.configEnv).some(([name, value]) => name !== variable || resolve(value) !== folder)) throw Error("recorded integration environment conflicts with account identity");
  let mcp = record.mcp;
  if (mcp === undefined && agent !== "claude-code") {
    // Legacy records have no explicit choice: infer only from a recorded owned
    // file. Never discover an unrelated user MCP registration and claim it.
    for (const file of record.files.filter(file => file.undo.some(op => op.kind === "toml-table" || op.kind === "json-member"))) {
      const text = readInstallFile(file.path);
      if (text === null) continue;
      if (agent === "codex") mcp = !!(Bun.TOML.parse(text) as any).mcp_servers?.pacer;
      else mcp = getMember(text, agent === "cursor" ? ["mcpServers", "pacer"] : ["mcp", "pacer"]) !== undefined;
      break;
    }
  }
  return {
    ctx: { ...ctx, env: { ...ctx.env, ...(agent === "codex" ? { CODEX_HOME: skillRoot } : {}) } },
    pacerArgv: pacerArgv(ctx.env), folder, plannerKey: key, plannerAccount: accountName,
    configEnv: record.configEnv, mode: "reconcile", skillFolder: skillRoot,
    ...(agent !== "claude-code" && mcp ? { mcp: true } : {}),
  };
}
