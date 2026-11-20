import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Product name of the first bundled native assistant plugin binary (sibling of pacer-core). */
export const ASSISTANT_PACER_EXECUTABLE = "pacer-assistant-pacer";

/** Explicit path for source-mode / test builds; never fall through to ~/.local/bin. */
export const ASSISTANT_PACER_BIN_ENV = "PACER_ASSISTANT_PACER_BIN";

function isBunExecutable(path: string): boolean {
  return /(^|\/)bun(?:\.exe)?$/.test(path);
}

function looksLikePacerCore(path: string): boolean {
  const name = basename(path);
  return name === "pacer-core" || name.startsWith("pacer-core-");
}

/**
 * Absolute path of a sibling native bundled plugin, or null when it is not available.
 *
 * Resolution:
 * - `PACER_ASSISTANT_PACER_BIN` when set and the file exists (tests / local builds).
 * - Next to the compiled pacer-core: `PACER_CORE_ARGV[0]` when that path is pacer-core, else
 *   `dirname(process.execPath)` when the runtime is not bun (compiled install).
 * - Never searches bun's directory or `PACER_BIN`'s directory.
 */
export function resolveBundledNativeExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable: string = process.execPath,
): string | null {
  if (name === ASSISTANT_PACER_EXECUTABLE) {
    const explicit = env[ASSISTANT_PACER_BIN_ENV];
    if (typeof explicit === "string" && explicit && existsSync(explicit)) return explicit;
  }

  const dirs: string[] = [];
  const raw = env.PACER_CORE_ARGV;
  if (typeof raw === "string" && raw.length) {
    try {
      const argv = JSON.parse(raw) as unknown;
      if (Array.isArray(argv) && typeof argv[0] === "string" && argv[0] && looksLikePacerCore(argv[0])) {
        dirs.push(dirname(argv[0]));
      }
    } catch { /* ignore malformed selectors */ }
  }
  // Compiled install: process.execPath is pacer-core (or the front door next to it).
  if (runtimeExecutable && !isBunExecutable(runtimeExecutable)) {
    dirs.push(dirname(runtimeExecutable));
  }

  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}
