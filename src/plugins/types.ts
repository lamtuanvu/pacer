// src/plugins/types.ts
import type { PluginManifest } from "./protocol";
/**
 * A reference plugin compiled into the pacer binary.
 * TypeScript plugins supply `main` (imported only by `pacer plugin run`).
 * Native plugins supply `executable` (basename next to `pacer-core`); when that sibling is
 * missing the registry refuses the plugin so contribution selection skips it.
 */
export interface BundledPlugin {
  manifest: PluginManifest;
  main?: () => Promise<{ handlers: Record<string, unknown> }>;
  /** Basename of a sibling of pacer-core; spawn that binary instead of `plugin run <id>`. */
  executable?: string;
}
