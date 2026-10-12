import { join } from "node:path";
import { shellCommand } from "./fsx";
import { editHooksFile } from "./hookjson";
import { getMember, setMember } from "./jsonc";
import type { UndoOp } from "./manifest";
import type { Txn } from "./txn";

export function installCursor(tx: Txn): void {
  const { ctx, pacerArgv: argv } = tx.env;
  const dir = join(ctx.home, ".cursor");
  const server = { command: argv[0], args: [...argv.slice(1), "mcp"] };
  const undo: UndoOp = { kind: "json-member", path: ["mcpServers", "pacer"] };
  tx.edit(join(dir, "mcp.json"), old => {
    if (!old?.trim()) {
      undo.dropEmpty = ["mcpServers"];
      return JSON.stringify({ mcpServers: { pacer: server } }, null, 2) + "\n";
    }
    if (getMember(old, ["mcpServers"]) === undefined) undo.dropEmpty = ["mcpServers"];
    return setMember(old, ["mcpServers", "pacer"], server);
  }, [undo]);

  const specs = [
    { event: "sessionStart", command: shellCommand([...argv, "session-start", "--planner", "cursor"]), timeout: 15 },
    { event: "subagentStart", command: shellCommand([...argv, "guard", "--planner", "cursor"]), timeout: 15 },
  ];
  tx.edit(join(dir, "hooks.json"), old => editHooksFile(old, "cursor", specs, "cursor"), [
    { kind: "hooks", format: "cursor", commands: specs.map(spec => spec.command), restore: [] },
  ]);
  tx.notes.push("Cursor has no user rule file; pacer's policy arrives through the sessionStart hook.");
}
