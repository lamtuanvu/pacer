import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { readInstallFile, writeInstallFile } from "./atomic";
import { sha256 } from "./fsx";

export interface PendingFile { path: string; before: string | null; after: string | null; mode?: number; beforeMode?: number }
interface Journal { schema: 1; files: PendingFile[]; manifestHash: string }
const journalPath = (ctx: Ctx) => join(ctx.pacerHome, "install-transaction.json");
export function recoverInstall(ctx: Ctx): void {
  const text = readInstallFile(journalPath(ctx));
  if (text === null) return;
  const journal = JSON.parse(text) as Journal;
  if (journal.schema !== 1 || !Array.isArray(journal.files)) throw Error("invalid installation recovery journal");
  const manifest = readInstallFile(join(ctx.pacerHome, "install-manifest.json"));
  if (manifest !== null && sha256(manifest) === journal.manifestHash) { rmSync(journalPath(ctx)); return; }
  // Check every destination before recovery; never discard an intervening user edit.
  for (const file of journal.files) {
    const value = readInstallFile(file.path);
    if (value !== file.before && value !== file.after) throw Error(`integration changed during recovery: ${file.path}; reconnect after resolving the conflict`);
  }
  for (const file of [...journal.files].reverse()) {
    if (file.before === null) rmSync(file.path, { force: true });
    else writeInstallFile(file.path, file.before, file.beforeMode);
  }
  rmSync(journalPath(ctx));
}
export function commitInstall(ctx: Ctx, files: PendingFile[], manifest: string): void {
  for (const file of files) if (readInstallFile(file.path) !== file.before) throw Error(`integration changed while planning: ${file.path}`);
  writeInstallFile(journalPath(ctx), JSON.stringify({ schema: 1, files, manifestHash: sha256(manifest) } satisfies Journal));
  try {
    for (const file of files) {
      if (readInstallFile(file.path) !== file.before) throw Error(`integration changed while applying: ${file.path}`);
      if (file.after === null) rmSync(file.path, { force: true });
      else writeInstallFile(file.path, file.after, file.mode);
    }
    writeInstallFile(join(ctx.pacerHome, "install-manifest.json"), manifest);
    rmSync(journalPath(ctx));
  } catch (error) {
    recoverInstall(ctx);
    throw error;
  }
}
