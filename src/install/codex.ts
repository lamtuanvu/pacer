import { installSkill } from "./skill";
import { readText } from "./fsx";
import { join } from "node:path";
import { removeBlock, upsertBlock } from "./blocks";
import { shellCommand } from "./fsx";
import { editHooksFile, type HookSpec } from "./hookjson";
import { removeTomlTable } from "./manifest";
import { policyText } from "./policy";
import type { Txn } from "./txn";

export function codexMcpBlock(argv: string[]): string {
  const [command, ...rest] = argv;
  return `[mcp_servers.pacer]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify([...rest, "mcp"])}\n`;
}

export function installCodex(tx: Txn): void {
  const dir = join(tx.env.ctx.home, ".codex");
  const argv = tx.env.pacerArgv;
  const configPath = join(dir, "config.toml");
  const ownsTable = tx.record.files.some(file => file.path === configPath
    && file.undo.some(op => op.kind === "toml-table" && op.table === "mcp_servers.pacer"));
  if(tx.env.mcp===false && readText(configPath)!==null)tx.edit(configPath,old=>removeTomlTable(removeTomlTable(removeBlock(old!,"hash"),"mcp_servers.pacer"),'mcp_servers."pacer"'),[]);
  if(tx.env.mcp===true)tx.edit(configPath, old => {
    const text = old ?? "";
    if (/^\[mcp_servers\.("pacer"|pacer)\]/m.test(removeBlock(text, "hash"))) {
      if (ownsTable) {
        const withoutTable = removeTomlTable(removeTomlTable(removeBlock(text, "hash"), "mcp_servers.pacer"), 'mcp_servers."pacer"');
        return upsertBlock(withoutTable, codexMcpBlock(argv), "hash");
      }
      tx.notes.push("already defines [mcp_servers.pacer]; left it unchanged");
      return text;
    }
    return upsertBlock(text, codexMcpBlock(argv), "hash");
  }, [{ kind: "block", style: "hash" }, { kind: "toml-table", table: "mcp_servers.pacer" }]);

  installSkill(tx,join(tx.env.ctx.env.CODEX_HOME || dir));
  tx.edit(join(dir, "AGENTS.md"), old => upsertBlock(old ?? "", policyText("codex"), "md"),
    [{ kind: "block", style: "md" }]);

  const specs: HookSpec[] = [
    { event: "SessionStart", command: shellCommand([...argv, "status", "--hook", "codex"]), timeout: 15, statusMessage: "Checking subscription budgets" },
    { event: "PreToolUse", matcher: "spawn_agent", command: shellCommand([...argv, "guard", "--planner", "codex"]), timeout: 15 },
  ];
  tx.edit(join(dir, "hooks.json"), old => editHooksFile(old, "claude", specs, "codex"),
    [{ kind: "hooks", format: "claude", commands: specs.map(spec => spec.command), restore: [] }]);
  tx.notes.push("Codex may ask you to review and trust the new pacer hooks the next time it starts.");
}
