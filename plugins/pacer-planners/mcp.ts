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
 * A planner install or reconnect without MCP must not keep a prior record entry
 * whose only managed content was this planner's MCP member/table. With an
 * explicit --no-mcp the member/table is removed exactly as uninstall would and
 * the entry is then retired, so doctor stops reporting the file forever. Without
 * a flag the entry is retired only when the member/table is already absent: a
 * member still present is a live registration (reconcile-target.ts infers MCP-on
 * for exactly that state), so the entry and the file are left untouched, and a
 * file pacer cannot parse counts as present. Unrelated user content in the file
 * (other MCP servers, providers, settings) is never touched.
 */
export async function dropStaleMcpEntry(tx: StaleMcpTx, configPath: string,
    isMcpOp: (op: UndoOp) => boolean, memberPresent: (text: string) => boolean): Promise<void> {
  if (tx.env.mcp === true || tx.record.mcp === true) return;
  const entry = tx.record.files.find(file =>
    file.path === configPath && file.undo.length > 0 && file.undo.every(isMcpOp));
  if (!entry) return;
  const text = await tx.read(configPath);
  let present = false;
  if (text !== null) {
    try { present = memberPresent(text); }
    catch { present = true; }
  }
  // No flag and the registration is live: keep the entry and the file.
  if (present && tx.env.mcp !== false) return;
  if (present) {
    // An explicit --no-mcp removes the registration exactly as uninstall would.
    // An unreadable file counts as present so the undo edit reports it with the path.
    await tx.edit(configPath, old => applyUndo(old!, entry.undo), []);
    tx.notes.push(`removed the pacer MCP registration from ${configPath}`);
  }
  const index = tx.record.files.findIndex(file => file.path === configPath);
  if (index >= 0) tx.record.files.splice(index, 1);
}
