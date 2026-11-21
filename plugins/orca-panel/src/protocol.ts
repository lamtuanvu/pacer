// The panel <-> worker contract, declared once: src/panel.ts and src/worker.ts both read it.
import type { AttentionItem } from './pacer-client'

/** What the worker answers `pacer.snapshot` with and pushes as `pacer.changed`:
 *  `connected: false` means pacer has no token or is unreachable, `scope` says whether
 *  `attention` is filtered to the focused workspace's repo or is the global list. */
export type PanelSnapshot = {
  connected: boolean
  scope: 'repo' | 'global'
  repoLabel?: string
  attention: AttentionItem[]
  counts?: unknown
  planner?: unknown
}

declare module 'orca' {
  interface PluginRequests {
    /** The scoped snapshot right now; no input. */
    'pacer.snapshot': { output: PanelSnapshot }
    /** Runs one pacer operation (an attention action's `op`/`params`). */
    'pacer.act': {
      input: { op: string; params: Record<string, unknown> }
      output: { ok: true } | { ok: false; error: string }
    }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each pacer event re-fetches the snapshot. */
    'pacer.changed': { snapshot: PanelSnapshot }
  }
}
