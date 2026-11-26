// Pure view-model for the html panel: data in, data out, no DOM and no `orca` import.
import type { AttentionAction } from './pacer-client'
import type { AttentionRow, PanelSnapshot, PanelTask } from './protocol'

export type PanelState = {
  snapshot: PanelSnapshot | null
  loadError: boolean
  ui: UiState
}

export type UiState = {
  expandedTaskId: string | null
  doneOpen: boolean
  answers: Record<string, string>
  answeringTaskId: string | null
  pending: Record<string, true>
  confirm: ConfirmSpec | null
  statusByKey: Record<string, { tone: 'good' | 'bad' | 'warn'; text: string }>
  lastSeenAt: number | null
}

export type ConfirmSpec = {
  key: string
  text: string
  confirmLabel: string
  cancelLabel: string
  successText: string
  run: RunRequest
}

export type RunRequest =
  | { kind: 'act'; op: string; params: Record<string, unknown>; pendingKey: string }
  | { kind: 'openWorkspace'; workspaceId: string; pendingKey: string }

export const initialUiState = (): UiState => ({
  expandedTaskId: null,
  doneOpen: false,
  answers: {},
  answeringTaskId: null,
  pending: {},
  confirm: null,
  statusByKey: {},
  lastSeenAt: null,
})

export const initialPanelState = (): PanelState => ({
  snapshot: null,
  loadError: false,
  ui: initialUiState(),
})

export type PanelEvent =
  | { type: 'snapshot'; snapshot: PanelSnapshot }
  | { type: 'load-error' }
  | { type: 'toggle-task'; id: string | null }
  | { type: 'toggle-done' }
  | { type: 'set-answer'; id: string; text: string }
  | { type: 'start-answer'; id: string }
  | { type: 'cancel-answer'; id: string }
  | { type: 'ask-confirm'; confirm: ConfirmSpec }
  | { type: 'cancel-confirm' }
  | { type: 'begin'; pendingKey: string }
  | {
      type: 'act-result'
      pendingKey: string
      ok: boolean
      error?: string
      conflict?: boolean
      result?: unknown
      successText?: string
      now?: number
    }
  | { type: 'clear-status'; pendingKey: string }

export function normalizePath(path: string): string {
  try {
    // basic normalise trailing slashes; realpath not available in pure view-model
    return path.replace(/\/+$/, '') || '/'
  } catch {
    return path
  }
}

export function worktreeTasks(snapshot: PanelSnapshot): PanelTask[] {
  const fw = snapshot.focusedWorkspace
  const focusedPath = fw?.path
  const tasks = snapshot.tasks ?? []
  if (!focusedPath) return []
  const want = normalizePath(focusedPath)
  return tasks.filter((t) => {
    const p = t.repo?.path ?? t.worktree
    return typeof p === 'string' && normalizePath(p) === want
  })
}

/** Only what is addressed to a person: a requested review or a message for the human, on this worktree's tasks. */
export function needsYouItems(snapshot: PanelSnapshot): AttentionRow[] {
  const ids = new Set(worktreeTasks(snapshot).map((t) => t.id))
  return (snapshot.attention ?? []).filter(
    (a) => !!a.taskId && ids.has(a.taskId) && (a.kind === 'review' || a.kind === 'message'),
  )
}

export function absoluteTime(at: number, now: number, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }
  const time = new Date(at * 1000).toLocaleTimeString('en-GB', opts)
  const dayOpts: Intl.DateTimeFormatOptions = { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }
  const sameDay =
    new Date(at * 1000).toLocaleDateString('en-CA', dayOpts) ===
    new Date(now * 1000).toLocaleDateString('en-CA', dayOpts)
  if (sameDay) return time
  const weekday = new Date(at * 1000).toLocaleDateString('en-GB', { timeZone, weekday: 'short' })
  return `${weekday} ${time}`
}

export type TaskClassification = 'asked' | 'caller-deciding' | 'running' | 'queued' | 'failed'

export function classifyTask(task: PanelTask): TaskClassification {
  if (task.state === 'needs_input' && task.question) return 'asked'
  if (task.liveness?.reason === 'caller_decision') return 'caller-deciding'
  if (task.state === 'queued') return 'queued'
  if (task.state === 'failed' || task.state === 'limit') return 'failed'
  return 'running'
}

export function taskGlyph(task: PanelTask): { glyph: string; colorVar: string } {
  const c = classifyTask(task)
  if (c === 'asked' || c === 'caller-deciding') return { glyph: '◐', colorVar: 'var(--warn-fg)' }
  if (c === 'running') return { glyph: '●', colorVar: 'var(--good-fill)' }
  if (c === 'queued') return { glyph: '○', colorVar: 'var(--ink-muted)' }
  return { glyph: '✕', colorVar: 'var(--bad-fg)' }
}

export function taskStatusText(task: PanelTask, now: number): string {
  const c = classifyTask(task)
  if (c === 'asked') return 'asked caller'
  if (c === 'caller-deciding') return 'caller deciding'
  if (c === 'queued') return 'queued'
  if (c === 'failed') return 'failed · caller told'
  // running
  if (task.liveness?.stalled) {
    const mins = Math.max(1, Math.round((now - (task.liveness.since ?? now)) / 60))
    return `no output ${mins}m`
  }
  const start = task.attemptStartedAt ?? task.updatedAt
  const mins = Math.max(1, Math.round((now - start) / 60))
  return `running ${mins}m`
}


/** Colour of a row's short status: amber when it waits on someone or stalls, red when it failed. */
export function taskStatusTone(task: PanelTask): 'warn' | 'bad' | 'muted' {
  const c = classifyTask(task)
  if (c === 'asked' || c === 'caller-deciding') return 'warn'
  if (c === 'failed') return 'bad'
  if (c === 'running' && task.liveness?.stalled) return 'warn'
  return 'muted'
}

export function stalledMinutes(since: number, now: number): number {
  return Math.max(1, Math.round((now - since) / 60))
}

export function stalledPillText(mins: number): string {
  return `No output for ${mins} min`
}

export function doneGlyph(task: PanelTask): { glyph: string; tone: 'good' | 'bad' | 'warn' | 'muted'; label: string } {
  if (task.review?.accepted === true) return { glyph: '✓', tone: 'good', label: 'Accepted' }
  if (task.review?.accepted === false) return { glyph: '✕', tone: 'bad', label: 'Rejected' }
  if (task.state === 'failed' || task.state === 'limit') return { glyph: '✕', tone: 'bad', label: 'Failed' }
  if (task.state === 'partial') return { glyph: '◐', tone: 'warn', label: 'Incomplete' }
  return { glyph: '·', tone: 'muted', label: 'Done' }
}

/** A task still in motion: running, queued, asking, or failed with an open failure item (not yet retried or resolved). */
export function isActiveTask(task: PanelTask, snapshot: PanelSnapshot): boolean {
  if (task.state === 'running' || task.state === 'queued' || task.state === 'needs_input') return true
  if (task.state === 'failed' || task.state === 'limit') {
    return (snapshot.attention ?? []).some((a) => a.taskId === task.id && (a.kind === 'failed' || a.kind === 'limit'))
  }
  return false
}

/** This worktree's active tasks, newest first, leaving out those already listed under Needs you. */
export function activeTasks(snapshot: PanelSnapshot): PanelTask[] {
  const needs = new Set(needsYouItems(snapshot).map((a) => a.taskId))
  return worktreeTasks(snapshot)
    .filter((t) => isActiveTask(t, snapshot) && !needs.has(t.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Settled tasks of this worktree from the last 24 hours, newest first, leaving out those under Needs you. */
export function doneTasks(snapshot: PanelSnapshot, now: number): PanelTask[] {
  const needs = new Set(needsYouItems(snapshot).map((a) => a.taskId))
  const cutoff = now - 24 * 3600
  return worktreeTasks(snapshot)
    .filter((t) => !isActiveTask(t, snapshot) && !needs.has(t.id) && t.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function summaryText(snapshot: PanelSnapshot, _now: number): string {
  const active = activeTasks(snapshot)
  const needs = needsYouItems(snapshot).length
  const running = active.filter((t) => classifyTask(t) === 'running').length
  const asked = active.filter((t) => classifyTask(t) === 'asked').length
  const parts: string[] = []
  if (needs > 0) parts.push(`${needs} needs you`)
  if (running > 0) parts.push(`${running} running`)
  if (asked > 0) parts.push(`${asked} asked caller`)
  // Every row in Tasks shows up in the summary, so it never reads "nothing active" above a listed row.
  const queued = active.filter((t) => classifyTask(t) === 'queued').length
  const failed = active.filter((t) => classifyTask(t) === 'failed').length
  if (queued > 0) parts.push(`${queued} queued`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (parts.length === 0) return worktreeTasks(snapshot).length === 0 ? 'no tasks yet' : 'nothing active'
  return parts.join(' · ')
}


export function reducePanel(state: PanelState, event: PanelEvent): { state: PanelState; run: RunRequest | null } {
  switch (event.type) {
    case 'snapshot':
      return {
        state: {
          ...state,
          snapshot: event.snapshot,
          loadError: false,
          ui: { ...state.ui, lastSeenAt: event.snapshot.connected ? event.snapshot.at : state.ui.lastSeenAt },
        },
        run: null,
      }
    case 'load-error':
      return { state: { ...state, loadError: true }, run: null }
    case 'toggle-task':
      return {
        state: { ...state, ui: { ...state.ui, expandedTaskId: event.id, answeringTaskId: null } },
        run: null,
      }
    case 'toggle-done':
      return { state: { ...state, ui: { ...state.ui, doneOpen: !state.ui.doneOpen } }, run: null }
    case 'set-answer':
      return { state: { ...state, ui: { ...state.ui, answers: { ...state.ui.answers, [event.id]: event.text } } }, run: null }
    case 'start-answer':
      return { state: { ...state, ui: { ...state.ui, answeringTaskId: event.id } }, run: null }
    case 'cancel-answer':
      return { state: { ...state, ui: { ...state.ui, answeringTaskId: null } }, run: null }
    case 'ask-confirm':
      return { state: { ...state, ui: { ...state.ui, confirm: event.confirm } }, run: null }
    case 'cancel-confirm':
      return { state: { ...state, ui: { ...state.ui, confirm: null } }, run: null }
    case 'begin': {
      const pending = { ...state.ui.pending, [event.pendingKey]: true as const }
      const statusByKey = { ...state.ui.statusByKey }
      delete statusByKey[event.pendingKey]
      return { state: { ...state, ui: { ...state.ui, pending, statusByKey, confirm: null } }, run: null }
    }
    case 'act-result': {
      const pending = { ...state.ui.pending }
      delete pending[event.pendingKey]
      // Only the latest outcome is shown, so a new result replaces older ones.
      const statusByKey: UiState['statusByKey'] = {}
      if (event.conflict) {
        statusByKey[event.pendingKey] = { tone: 'warn', text: 'Already handled elsewhere' }
      } else if (!event.ok) {
        statusByKey[event.pendingKey] = { tone: 'bad', text: event.error || 'Failed' }
      } else if ((event.result as { opened?: unknown } | undefined)?.opened === false) {
        const command = (event.result as { command?: unknown }).command
        statusByKey[event.pendingKey] = {
          tone: 'warn',
          text: typeof command === 'string' && command !== '' ? `Couldn't open it in Orca. Run: ${command}` : "Couldn't open it in Orca.",
        }
      } else if (event.successText) {
        statusByKey[event.pendingKey] = { tone: 'good', text: event.successText }
      }
      const ui = { ...state.ui, pending, statusByKey }
      return { state: { ...state, ui }, run: null }
    }
    case 'clear-status': {
      const statusByKey = { ...state.ui.statusByKey }
      delete statusByKey[event.pendingKey]
      return { state: { ...state, ui: { ...state.ui, statusByKey } }, run: null }
    }
  }
}

export type PanelModel =
  | { kind: 'loading' }
  | { kind: 'load-error' }
  | { kind: 'not-connected'; snapshot: PanelSnapshot; lastSeenAt: number | null }
  | {
      kind: 'ready'
      snapshot: PanelSnapshot
      needsYou: AttentionRow[]
      tasks: PanelTask[]
      doneTasks: PanelTask[]
      doneMore: number
      summary: string
      ui: UiState
    }

export function panelModel(state: PanelState, now: number): PanelModel {
  if (state.snapshot === null) return state.loadError ? { kind: 'load-error' } : { kind: 'loading' }
  const snapshot = state.snapshot
  if (!snapshot.connected) {
    return { kind: 'not-connected', snapshot, lastSeenAt: state.ui.lastSeenAt }
  }
  const tasks = activeTasks(snapshot)
  const needs = needsYouItems(snapshot)
  const done = doneTasks(snapshot, now)
  const doneVisible = done.slice(0, 10)
  const doneMore = Math.max(0, done.length - 10)
  return {
    kind: 'ready',
    snapshot,
    needsYou: needs,
    tasks,
    doneTasks: doneVisible,
    doneMore,
    summary: summaryText(snapshot, now),
    ui: state.ui,
  }
}

export function answerActionParams(action: AttentionAction, text: string, expectRev?: number): Record<string, unknown> {
  return {
    ...action.params,
    text,
    ...(expectRev != null ? { expect_rev: expectRev } : {}),
  }
}

export function reviewExpectRev(snapshot: PanelSnapshot, taskId?: string): number | undefined {
  if (!taskId) return undefined
  const row = (snapshot.tasks ?? []).find((t) => t.id === taskId)
  return row?.rev
}

export function controlBusy(pending: Record<string, true>, pendingKey: string): boolean {
  return !!pending[pendingKey]
}

export function answerDisabled(answerText: string, busy: boolean): boolean {
  return busy || !answerText.trim()
}

export function showOpenWorktree(orcaWorkspaceId?: string | null): boolean {
  return Boolean(orcaWorkspaceId)
}

export function executorLabelFor(id: string | null | undefined, _names?: Map<string, string>): string | null {
  if (!id) return null
  return id.split('@')[0]!.split('#')[0]!
}

export function executorShortLabel(id: string | null | undefined, _executors: any[] = []): string | null {
  if (!id) return null
  const agent = id.split('@')[0]!.split('#')[0]!
  const map: Record<string, string> = {
    'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', cursor: 'Cursor',
    opencode: 'OpenCode', agy: 'Antigravity', antigravity: 'Antigravity', local: 'Local model',
  }
  return map[agent.toLowerCase()] ?? agent
}

export function plannerAgentDisplay(agent: string | null | undefined): string {
  if (!agent) return 'Planner'
  const key = agent.toLowerCase()
  const map: Record<string, string> = {
    'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', cursor: 'Cursor',
    opencode: 'OpenCode', agy: 'Antigravity', antigravity: 'Antigravity', local: 'Local model',
  }
  return map[key] ?? agent
}

