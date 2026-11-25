// src/plugins/types.ts
import type { PluginManifest } from "./protocol";
/**
 * A reference plugin available to the host. Shipped rows are native and hold
 * only a manifest; `main` remains solely for `pacer-dev`, the workflow-frame
 * plugin that has no Rust port yet (out of scope for M3 C13).
 * `executable` names a native sibling of pacer-core; when that sibling is
 * missing the registry refuses the plugin so contribution selection skips it.
 */
export interface BundledPlugin {
  manifest: PluginManifest;
  main?: () => Promise<{ handlers: Record<string, unknown> }>;
  /** Basename of a sibling of pacer-core; spawn that binary instead of `plugin run <id>`. */
  executable?: string;
}
