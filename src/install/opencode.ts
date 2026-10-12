import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { upsertBlock } from "./blocks";
import { getMember, setMember } from "./jsonc";
import type { UndoOp } from "./manifest";
import { policyText } from "./policy";
import { runInstall, type InstallEnv } from "./txn";

export function opencodeDir(ctx: Pick<Ctx, "home" | "env">): string {
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config"), "opencode");
}

export function opencodeConfigPath(ctx: Pick<Ctx, "home" | "env">): string {
  const dir = opencodeDir(ctx);
  const jsonc = join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(dir, "opencode.json");
}

export async function installOpencode(env: InstallEnv) {
  return runInstall(env, "opencode", tx => {
    tx.edit(join(opencodeDir(env.ctx), "AGENTS.md"),
      old => upsertBlock(old ?? "", policyText("opencode"), "md"),
      [{ kind: "block", style: "md" }]);

    const pacer = { type: "local", command: [...env.pacerArgv, "mcp"], enabled: true };
    const undo: UndoOp = { kind: "json-member", path: ["mcp", "pacer"] };
    tx.edit(opencodeConfigPath(env.ctx), old => {
      if (old === null) {
        undo.dropEmpty = ["mcp"];
        return JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { pacer } }, null, 2) + "\n";
      }
      if (getMember(old, ["mcp"]) === undefined) undo.dropEmpty = ["mcp"];
      return setMember(old, ["mcp", "pacer"], pacer);
    }, [undo]);
    tx.notes.push("OpenCode guard is policy-only; policy and MCP installed.");
  });
}
