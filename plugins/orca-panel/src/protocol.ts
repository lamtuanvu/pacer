// The panel <-> worker contract, declared once: src/panel.ts and src/worker.ts both read it.
import type { AttentionItem, PacerExecutor, PacerPause, PacerPlanner } from './pacer-client'

/** An attention item as the panel sees it: the item's own repo's human label attached. */
export type AttentionRow = AttentionItem & { repoLabel?: string }

export type RepoRef = { key: string; label: string; path: string }

export type PanelRepo = RepoRef & {
  needsYou: number
  running: number
  doneToday: number
  orcaWorkspaceId?: string
}

export type PanelTask = {
  id: string
  rev: number
  title: string
  repo: RepoRef | null
  repoLabel?: string
  executor?: string | null
  state: string
  phase?: string
  attemptStartedAt?: number
  updatedAt: number
  review?: { accepted: boolean } | null
  liveness?: { stalled: boolean; reason: string; since: number } | null
  worktree?: string | null
  orcaWorkspaceId?: string
  question?: string | null
  nextExecutor?: string | null
}

export type PanelPlanner = {
  agent: string
  usedPct: number | null
  pacePct: number | null
  verdict: string
  advice: string
  mode: string
  modeHeldUntil?: number
  resetsAt: number | null
  window: string | null
  stale: boolean
}

export type PanelExecutor = Pick<
  PacerExecutor,
  'id' | 'agent' | 'account' | 'rank' | 'state' | 'tone' | 'sub' | 'reason' | 'next' | 'slots' | 'enabled'
> & { untested?: true }

/** Trimmed snapshot the worker builds from /v3/snapshot. The panel filters by scope. */
export type PanelSnapshot = {
  connected: boolean
  at: number
  /** Focused Orca workspace (path + name) the panel is scoped to. */
  focusedWorkspace?: { path: string; name: string } | null
  /** Compatibility alias for older panel code. */
  focusedRepo?: RepoRef | null
  planner: PanelPlanner | null
  pause: PacerPause | null
  repos: PanelRepo[]
  attention: AttentionRow[]
  tasks?: PanelTask[]
  running: PanelTask[]
  /** Queued tasks (state queued); shown in their own section, not inside Running. */
  queued: PanelTask[]
  doneToday: PanelTask[]
  executors: PanelExecutor[]
}

export type ActResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; conflict?: true }

declare module 'orca' {
  interface PluginRequests {
    /** The trimmed snapshot right now; no input. */
    'pacer.snapshot': { output: PanelSnapshot }
    /** Runs one pacer operation (or the client-side ui.open). */
    'pacer.act': {
      input: { op: string; params: Record<string, unknown> }
      output: ActResult
    }
    /** Opens an Orca workspace by id (host `workspace.open`). */
    'orca.openWorkspace': {
      input: { workspaceId: string }
      output: { ok: true } | { ok: false; error: string }
    }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each pacer event re-fetches the snapshot. */
    'pacer.changed': { snapshot: PanelSnapshot }
  }
}

/** Re-export planner shape so callers that only import protocol stay typed. */
export type { PacerPlanner, PacerPause }
