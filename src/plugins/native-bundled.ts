import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { currentVersion } from "../update/version";

/** Product name of the first bundled native assistant plugin binary (sibling of pacer-core). */
export const ASSISTANT_PACER_EXECUTABLE = "pacer-assistant-pacer";

/** Explicit path for source-mode / test builds; never fall through to ~/.local/bin. */
export const ASSISTANT_PACER_BIN_ENV = "PACER_ASSISTANT_PACER_BIN";

export type NativeSibling =
  | { status: "ready"; path: string }
  | { status: "missing" }
  | { status: "outdated"; path: string; reported: string | null; expected: string };

function isBunExecutable(path: string): boolean {
  return /(^|\/)bun(?:\.exe)?$/.test(path);
}

function looksLikePacerCore(path: string): boolean {
  const name = basename(path);
  return name === "pacer-core" || name.startsWith("pacer-core-");
}

const versionCache = new Map<string, { mtimeMs: number; size: number; reported: string | null }>();

/** Parse `pacer <version>` from a sibling's `--version` output; null when unusable. */
export function nativeSiblingReportedVersion(path: string): string | null {
  let mtimeMs = 0, size = 0;
  try {
    const st = statSync(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch { return null; }
  const cached = versionCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.reported;
  const result = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  const text = result.exitCode === 0 ? result.stdout.toString().trim() : "";
  const words = text.split(/\s+/).filter(Boolean);
  const reported = words[0] === "pacer" && words.length === 2 ? words[1]! : null;
  versionCache.set(path, { mtimeMs, size, reported });
  return reported;
}

function candidateDirs(env: NodeJS.ProcessEnv, runtimeExecutable: string): string[] {
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
  if (runtimeExecutable && !isBunExecutable(runtimeExecutable)) {
    dirs.push(dirname(runtimeExecutable));
  }
  return dirs;
}

/**
 * Inspect a sibling native bundled plugin.
 *
 * Explicit `PACER_ASSISTANT_PACER_BIN` skips the version guard (tests / local builds).
 * Installed siblings must report the same version as this pacer (ADR 0031).
 */
export function inspectBundledNativeExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable: string = process.execPath,
  expectedVersion: string = currentVersion(),
): NativeSibling {
  if (name === ASSISTANT_PACER_EXECUTABLE) {
    const explicit = env[ASSISTANT_PACER_BIN_ENV];
    if (typeof explicit === "string" && explicit && existsSync(explicit)) {
      return { status: "ready", path: explicit };
    }
  }

  const seen = new Set<string>();
  for (const dir of candidateDirs(env, runtimeExecutable)) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const reported = nativeSiblingReportedVersion(path);
    if (reported === expectedVersion) return { status: "ready", path };
    return { status: "outdated", path, reported, expected: expectedVersion };
  }
  return { status: "missing" };
}

/**
 * Absolute path of a sibling native bundled plugin, or null when it is not available
 * (missing or version-mismatched after a partial update).
 */
export function resolveBundledNativeExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable: string = process.execPath,
  expectedVersion: string = currentVersion(),
): string | null {
  const sibling = inspectBundledNativeExecutable(name, env, runtimeExecutable, expectedVersion);
  return sibling.status === "ready" ? sibling.path : null;
}

export function nativeSiblingRefusal(name: string, sibling: NativeSibling): string | null {
  if (sibling.status === "missing") return `native executable ${name} is not installed next to pacer-core`;
  if (sibling.status === "outdated") {
    return `native executable ${name} is outdated (reports ${sibling.reported ?? "unknown"}, pacer is ${sibling.expected})`;
  }
  return null;
}
