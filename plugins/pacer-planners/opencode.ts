import { join } from "node:path";
import {
  upsertBlock,
  getMember,
  removeMember,
  setMember,
  type UndoOp,
} from "@pacer/plugin/install";
import { installSkill } from "./skill";
import { policyText } from "./policy";
import type { PlannerBuilder } from "./types";
export async function installOpencodeFiles(tx: PlannerBuilder): Promise<void> {
  const env = tx.env;
  const dir = env.folder ?? join(tx.context.home, ".config", "opencode");
  const configPath =
    (await tx.read(join(dir, "opencode.jsonc"))) !== null
      ? join(dir, "opencode.jsonc")
      : join(dir, "opencode.json");
  await tx.edit(
    join(dir, "AGENTS.md"),
    (old) => upsertBlock(old ?? "", policyText("opencode"), "md"),
    [{ kind: "block", style: "md" }],
  );

  await installSkill(tx, dir);
  const pacer = {
    type: "local",
    command: [...env.pacerArgv, "mcp"],
    enabled: true,
  };
  const undo: UndoOp = { kind: "json-member", path: ["mcp", "pacer"] };
  if (tx.env.mcp === false && (await tx.read(configPath)) !== null)
    await tx.edit(
      configPath,
      (old) => removeMember(old!, ["mcp", "pacer"]),
      [],
    );
  if (tx.env.mcp === true)
    await tx.edit(
      configPath,
      (old) => {
        if (!old?.trim()) {
          undo.dropEmpty = ["mcp"];
          return (
            JSON.stringify(
              { $schema: "https://opencode.ai/config.json", mcp: { pacer } },
              null,
              2,
            ) + "\n"
          );
        }
        if (getMember(old, ["mcp"]) === undefined) undo.dropEmpty = ["mcp"];
        return setMember(old, ["mcp", "pacer"], pacer);
      },
      [undo],
    );
  tx.notes.push(
    "OpenCode guard is policy-only; policy and skill installed; MCP is optional.",
  );
}
