import { installSkill } from "./skill";

import { join } from "node:path";
import { shellCommand } from "@pacer/plugin/install";
import { editHooksFile } from "@pacer/plugin/install";
import { getMember, removeMember, setMember } from "@pacer/plugin/install";
import type { UndoOp } from "@pacer/plugin/install";
import type { PlannerBuilder } from "./types";

export async function installCursor(tx: PlannerBuilder): Promise<void> {
  const { pacerArgv: argv } = tx.env;
  const ctx = tx.context;
  const dir = tx.env.folder ?? join(ctx.home, ".cursor");
  const server = { command: argv[0], args: [...argv.slice(1), "mcp"] };
  const undo: UndoOp = { kind: "json-member", path: ["mcpServers", "pacer"] };
  if (tx.env.mcp === false && (await tx.read(join(dir, "mcp.json"))) !== null)
    await tx.edit(
      join(dir, "mcp.json"),
      (old) => removeMember(old!, ["mcpServers", "pacer"]),
      [],
    );
  if (tx.env.mcp === true)
    await tx.edit(
      join(dir, "mcp.json"),
      (old) => {
        if (!old?.trim()) {
          undo.dropEmpty = ["mcpServers"];
          return (
            JSON.stringify({ mcpServers: { pacer: server } }, null, 2) + "\n"
          );
        }
        if (getMember(old, ["mcpServers"]) === undefined)
          undo.dropEmpty = ["mcpServers"];
        return setMember(old, ["mcpServers", "pacer"], server);
      },
      [undo],
    );

  await installSkill(tx, dir);
  const specs = [
    {
      event: "sessionStart",
      command: shellCommand([...argv, "session-start", "--planner", "cursor"]),
      timeout: 15,
    },
    {
      event: "subagentStart",
      command: shellCommand([...argv, "guard", "--planner", "cursor"]),
      timeout: 15,
    },
  ];
  await tx.edit(
    join(dir, "hooks.json"),
    (old) => editHooksFile(old, "cursor", specs, "cursor"),
    [
      {
        kind: "hooks",
        format: "cursor",
        commands: specs.map((spec) => spec.command),
        restore: [],
      },
    ],
  );
  tx.notes.push(
    "Cursor has no user rule file; pacer's policy arrives through the sessionStart hook.",
  );
}
