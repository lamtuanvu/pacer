import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Product name of the first bundled native assistant plugin binary (sibling of pacer-core). */
export const ASSISTANT_PACER_EXECUTABLE = "pacer-assistant-pacer";

/**
 * Absolute path of a sibling native bundled plugin, or null when it is not next to the
 * running core / front door. Candidates: PACER_CORE_ARGV[0]'s directory, then the runtime
 * executable's directory, then PACER_BIN's directory.
 */
export function resolveBundledNativeExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable: string = process.execPath,
): string | null {
  const dirs: string[] = [];
  const raw = env.PACER_CORE_ARGV;
  if (typeof raw === "string" && raw.length) {
    try {
      const argv = JSON.parse(raw) as unknown;
      if (Array.isArray(argv) && typeof argv[0] === "string" && argv[0]) dirs.push(dirname(argv[0]));
    } catch { /* ignore malformed selectors; fall through to other candidates */ }
  }
  if (runtimeExecutable) dirs.push(dirname(runtimeExecutable));
  if (typeof env.PACER_BIN === "string" && env.PACER_BIN) dirs.push(dirname(env.PACER_BIN));
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}
