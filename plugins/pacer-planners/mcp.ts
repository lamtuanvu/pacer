import { applyUndo, type FileChange, type UndoOp } from "@pacer/plugin/install";

/** The slice of a planner transaction the stale MCP-entry cleanup needs. */
export interface StaleMcpTx {
  env: { mcp?: boolean };
  record: { mcp?: boolean; files: FileChange[] };
  read(path: string): Promise<string | null> | string | null;
  edit(path: string, fn: (old: string | null) => string, undo: UndoOp[]): Promise<boolean> | boolean;
  notes: string[];
}

/**
 * A planner install or reconnect without MCP (explicit --no-mcp, or no choice on
 * a record that is not MCP-on) must not keep a prior record entry whose only
 * managed content was this planner's MCP member/table: if the member/table is
 * still present it is removed exactly as uninstall would, and the entry is then
 * retired so doctor stops reporting the file forever. Unrelated user content in
 * the file (other MCP servers, providers, settings) is never touched.
 */
export async function dropStaleMcpEntry(tx: StaleMcpTx, configPath: string,
    isMcpOp: (op: UndoOp) => boolean, memberPresent: (text: string) => boolean): Promise<void> {
  if (tx.env.mcp === true || tx.record.mcp === true) return;
  const entry = tx.record.files.find(file =>
    file.path === configPath && file.undo.length > 0 && file.undo.every(isMcpOp));
  if (!entry) return;
  const text = await tx.read(configPath);
  if (text !== null) {
    // An unreadable file counts as present so the undo edit reports it with the path.
    let present: boolean;
    try { present = memberPresent(text); }
    catch { present = true; }
    if (present) {
      await tx.edit(configPath, old => applyUndo(old!, entry.undo), []);
      tx.notes.push(`removed the pacer MCP registration from ${configPath}`);
    }
  }
  const index = tx.record.files.findIndex(file => file.path === configPath);
  if (index >= 0) tx.record.files.splice(index, 1);
}
