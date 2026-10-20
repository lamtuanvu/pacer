import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const PATH_BLOCK = ["# >>> pacer >>>", 'export PATH="$HOME/.local/bin:$PATH"', "# <<< pacer <<<"];

export function removePathBlock(text: string): { text: string; removed: boolean } {
  const cleaned = text.replace(/^# >>> pacer >>>\r?\n[\s\S]*?^# <<< pacer <<<(?:\r?\n|$)/gm, "");
  return { text: cleaned, removed: cleaned !== text };
}

export function appLink(home: string): string | null {
  const path = join(home, ".local/bin/pacer");
  try {
    return lstatSync(path).isSymbolicLink() && /\.app\/Contents\/MacOS\/pacer$/.test(readlinkSync(path)) ? path : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
