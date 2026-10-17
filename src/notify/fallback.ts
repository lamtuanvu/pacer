import { execProcess } from "../exec/process";
import type { RunFn } from "../types";

export interface FallbackDeps { platform?: NodeJS.Platform; run?: RunFn; which?: (bin: string) => string | null }
/** No shell interpolation: user-facing strings are always separate arguments. */
export async function postFallback(title: string, body: string, deps: FallbackDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const tool = platform === "darwin" ? "osascript" : platform === "linux" ? "notify-send" : null;
  if (!tool) return false;
  const binary = (deps.which ?? Bun.which)(tool);
  if (!binary) return false;
  const argv = platform === "darwin"
    ? [binary, "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]
    : [binary, "--", title, body];
  try {
    const result = deps.run ? await deps.run(argv, 5000) : await execProcess({ argv, timeoutMs: 5000, cwd: process.cwd(), env: process.env });
    return result.code === 0;
  } catch { return false; }
}
