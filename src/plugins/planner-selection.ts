import { plannerPrivatePath } from "./planner-private-paths";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { lstatSync } from "node:fs";
import { readInstallFile } from "../install/atomic";
import type { Ctx } from "../types";
/** Capture only the exact script named by the selected account's current settings. */
export function plannerSelectedSources(
  ctx: Ctx,
  agent: string,
  folder: string,
): string[] {
  if (agent !== "claude-code") return [];
  try {
    const text = readInstallFile(join(folder, "settings.json"));
    if (text === null) return [];
    const command = JSON.parse(text).statusLine?.command;
    if (typeof command !== "string" || !command || /\s|\0/.test(command))
      return [];
    const path = command
      .replace(/^~(?=\/)/, ctx.home)
      .replace(/^\$HOME(?=\/)/, ctx.home);
    if (!isAbsolute(path) || plannerPrivatePath(ctx, path)) return [];
    const target = resolve(path),
      selected = resolve(folder),
      inside = target === selected || target.startsWith(selected + sep);
    const nativeRoots = [
      join(ctx.home, ".codex"),
      join(ctx.home, ".cursor"),
      join(ctx.home, ".config/opencode"),
      join(ctx.home, ".local/share/opencode"),
      join(ctx.pacerHome, "accounts"),
    ];
    if (
      !inside &&
      nativeRoots.some(
        (root) => target === root || target.startsWith(root + sep),
      )
    )
      return [];
    const stat = lstatSync(path);
    // Outside the selected account, only an exact configured executable/shell
    // script may be discovered; arbitrary HOME config/data files are not sources.
    if (!inside && !(stat.mode & 0o111) && !basename(target).endsWith(".sh"))
      return [];
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      ? [path]
      : [];
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return [];
    throw error;
  }
}
