// src/plugins/types.ts
import type { PluginManifest } from "./protocol";
/** A reference plugin compiled into the pacer binary; `main` is imported only by `pacer plugin run`. */
export interface BundledPlugin { manifest: PluginManifest; main: () => Promise<{ handlers: Record<string, unknown> }> }
