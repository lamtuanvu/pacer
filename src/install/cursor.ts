import { installSkill } from "./skill";
import { readText } from "./fsx";
import { join } from "node:path";
import { shellCommand } from "./fsx";
import { editHooksFile } from "./hookjson";
import { getMember, removeMember, setMember } from "./jsonc";
import type { UndoOp } from "./manifest";
import type { Txn } from "./txn";

export function installCursor(tx: Txn): void {
  const { ctx, pacerArgv: argv } = tx.env;
  const dir = join(ctx.home, ".cursor");
  const server = { command: argv[0], args: [...argv.slice(1), "mcp"] };
  const undo: UndoOp = { kind: "json-member", path: ["mcpServers", "pacer"] };
  if(tx.env.mcp===false && readText(join(dir, "mcp.json"))!==null)tx.edit(join(dir, "mcp.json"),old=>removeMember(old!,["mcpServers","pacer"]),[]);
  if(tx.env.mcp===true)tx.edit(join(dir, "mcp.json"), old => {
    if (!old?.trim()) {
      undo.dropEmpty = ["mcpServers"];
      return JSON.stringify({ mcpServers: { pacer: server } }, null, 2) + "\n";
    }
    if (getMember(old, ["mcpServers"]) === undefined) undo.dropEmpty = ["mcpServers"];
    return setMember(old, ["mcpServers", "pacer"], server);
  }, [undo]);

  installSkill(tx,dir);
  const specs = [
    { event: "sessionStart", command: shellCommand([...argv, "session-start", "--planner", "cursor"]), timeout: 15 },
    { event: "subagentStart", command: shellCommand([...argv, "guard", "--planner", "cursor"]), timeout: 15 },
  ];
  tx.edit(join(dir, "hooks.json"), old => editHooksFile(old, "cursor", specs, "cursor"), [
    { kind: "hooks", format: "cursor", commands: specs.map(spec => spec.command), restore: [] },
  ]);
  tx.notes.push("Cursor has no user rule file; pacer's policy arrives through the sessionStart hook.");
}
