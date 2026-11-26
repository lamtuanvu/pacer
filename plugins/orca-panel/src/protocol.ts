// The panel <-> worker contract, declared once: src/panel.ts and src/worker.ts both read it.
import type { AttentionItem, PacerPause, PacerPlanner } from './pacer-client'

/** An attention item as the panel sees it: the item's own repo's human label attached. */
export type AttentionRow = AttentionItem & { repoLabel?: string }

export type RepoRef = { key: string; label: string; path: string }

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

/** Pacer-wide counts, across every worktree (the status bar and the panel's "All worktrees" box). */
export type PanelOverall = {
  /** Reviews and messages addressed to a person. */
  needsYou: number
  running: number
  /** Executor questions waiting on their caller. */
  asked: number
  queued: number
  /** Worktrees with something active or waiting on a person. */
  worktrees: number
}

/** One enabled executor, as the "All worktrees" box lists it. */
export type PanelExecutor = { id: string; name: string; state: string; tone: 'good' | 'info' | 'warn' | 'bad' | 'muted' }

/** Trimmed snapshot the worker builds from /v3/snapshot. The panel filters by scope. */
export type PanelSnapshot = {
  connected: boolean
  at: number
  /** Focused Orca workspace (path + name) the panel is scoped to. */
  focusedWorkspace?: { path: string; name: string } | null
  planner: PanelPlanner | null
  pause: PacerPause | null
  attention: AttentionRow[]
  tasks?: PanelTask[]
  overall?: PanelOverall
  executors?: PanelExecutor[]
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
