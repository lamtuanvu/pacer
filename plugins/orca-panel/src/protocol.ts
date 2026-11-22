// The panel <-> worker contract, declared once: src/panel.ts and src/worker.ts both read it.
import type { AttentionItem } from './pacer-client'

/** An attention item as the panel sees it: the item's own repo's human label attached, so a
 *  global (all-repos) list can say which repo each row belongs to instead of leaving the
 *  reader to guess from the title text alone. */
export type AttentionRow = AttentionItem & { repoLabel?: string }

/** What the worker answers `pacer.snapshot` with and pushes as `pacer.changed`:
 *  `connected: false` means pacer has no token or is unreachable, `scope` says whether
 *  `attention` is filtered to the focused workspace's repo or is the global list. */
export type PanelSnapshot = {
  connected: boolean
  scope: 'repo' | 'global'
  repoLabel?: string
  attention: AttentionRow[]
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
