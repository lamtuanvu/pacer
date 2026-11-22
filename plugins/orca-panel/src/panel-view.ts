// Pure view-model for the html panel: data in, data out, no DOM and no `orca` import.
import type { AttentionAction } from './pacer-client'
import type { AttentionRow, PanelExecutor, PanelSnapshot, PanelTask } from './protocol'

export type Scope = 'repo' | 'global'
export type PanelView = 'main' | 'delegate' | 'delegate-done'

export type RunRequest =
  | { kind: 'act'; op: string; params: Record<string, unknown>; pendingKey: string }
  | { kind: 'openWorkspace'; workspaceId: string; pendingKey: string }

export type ConfirmSpec = {
  key: string
  text: string
  confirmLabel: string
  cancelLabel: string
  run: RunRequest
}

export type UiState = {
  scope: Scope | null
  view: PanelView
  menuOpen: boolean
  goal: string
  delegateKind: string
  delegateExecutor: string
  delegateWorktree: 'new' | 'current'
  acceptance: string
  answers: Record<string, string>
  pending: Record<string, true>
  confirm: ConfirmSpec | null
  statusByKey: Record<string, { tone: 'good' | 'bad' | 'warn'; text: string }>
  delegateError: string | null
  delegated: { taskId: string; executorLabel: string; orcaWorkspaceId?: string } | null
}

export type PanelState = {
  snapshot: PanelSnapshot | null
  loadError: boolean
  ui: UiState
}

export const initialUiState = (): UiState => ({
  scope: null,
  view: 'main',
  menuOpen: false,
  goal: '',
  delegateKind: 'auto',
  delegateExecutor: 'auto',
  delegateWorktree: 'new',
  acceptance: '',
  answers: {},
  pending: {},
  confirm: null,
  statusByKey: {},
  delegateError: null,
  delegated: null,
})

export const initialPanelState = (): PanelState => ({
  snapshot: null,
  loadError: false,
  ui: initialUiState(),
})

export type PanelEvent =
  | { type: 'snapshot'; snapshot: PanelSnapshot }
  | { type: 'load-error' }
  | { type: 'set-scope'; scope: Scope }
  | { type: 'set-view'; view: PanelView }
  | { type: 'toggle-menu'; open?: boolean }
  | { type: 'set-goal'; goal: string }
  | { type: 'set-delegate-kind'; kind: string }
  | { type: 'set-delegate-executor'; executor: string }
  | { type: 'set-delegate-worktree'; worktree: 'new' | 'current' }
  | { type: 'set-acceptance'; acceptance: string }
  | { type: 'set-answer'; id: string; text: string }
  | { type: 'ask-confirm'; confirm: ConfirmSpec }
  | { type: 'cancel-confirm' }
  | { type: 'begin'; pendingKey: string }
  | { type: 'act-result'; pendingKey: string; ok: boolean; error?: string; conflict?: boolean; result?: unknown; successText?: string }
  | { type: 'clear-status'; pendingKey: string }

export function reducePanel(state: PanelState, event: PanelEvent): { state: PanelState; run: RunRequest | null } {
  switch (event.type) {
    case 'snapshot':
      return {
        state: {
          ...state,
          snapshot: event.snapshot,
          loadError: false,
          ui: {
            ...state.ui,
            // Keep interactive UI across pushes; only clear nothing here.
          },
        },
        run: null,
      }
    case 'load-error':
      return { state: { ...state, loadError: true }, run: null }
    case 'set-scope':
      return { state: { ...state, ui: { ...state.ui, scope: event.scope, menuOpen: false } }, run: null }
    case 'set-view':
      return {
        state: {
          ...state,
          ui: {
            ...state.ui,
            view: event.view,
            menuOpen: false,
            ...(event.view === 'main' ? { delegated: null, delegateError: null } : {}),
          },
        },
        run: null,
      }
    case 'toggle-menu':
      return {
        state: {
          ...state,
          ui: { ...state.ui, menuOpen: event.open ?? !state.ui.menuOpen },
        },
        run: null,
      }
    case 'set-goal':
      return { state: { ...state, ui: { ...state.ui, goal: event.goal } }, run: null }
    case 'set-delegate-kind':
      return { state: { ...state, ui: { ...state.ui, delegateKind: event.kind } }, run: null }
    case 'set-delegate-executor':
      return { state: { ...state, ui: { ...state.ui, delegateExecutor: event.executor } }, run: null }
    case 'set-delegate-worktree':
      return { state: { ...state, ui: { ...state.ui, delegateWorktree: event.worktree } }, run: null }
    case 'set-acceptance':
      return { state: { ...state, ui: { ...state.ui, acceptance: event.acceptance } }, run: null }
    case 'set-answer':
      return {
        state: { ...state, ui: { ...state.ui, answers: { ...state.ui.answers, [event.id]: event.text } } },
        run: null,
      }
    case 'ask-confirm':
      return { state: { ...state, ui: { ...state.ui, confirm: event.confirm, menuOpen: false } }, run: null }
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
      const statusByKey = { ...state.ui.statusByKey }
      if (event.conflict) {
        statusByKey[event.pendingKey] = { tone: 'warn', text: 'Already handled elsewhere' }
      } else if (!event.ok) {
        statusByKey[event.pendingKey] = { tone: 'bad', text: event.error || 'Failed' }
      } else if (event.successText) {
        statusByKey[event.pendingKey] = { tone: 'good', text: event.successText }
      }
      let ui = { ...state.ui, pending, statusByKey }
      if (event.pendingKey.startsWith('delegate') && event.ok) {
        const result = event.result as { task_id?: string; id?: string } | undefined
        const taskId = result?.task_id ?? result?.id ?? ''
        ui = {
          ...ui,
          view: 'delegate-done',
          delegated: {
            taskId,
            executorLabel: event.successText?.replace(/^Running on /, '') || 'executor',
            orcaWorkspaceId: undefined,
          },
          delegateError: null,
          goal: '',
        }
      } else if (event.pendingKey.startsWith('delegate') && !event.ok) {
        ui = { ...ui, delegateError: event.error || 'Failed' }
      }
      return { state: { ...state, ui }, run: null }
    }
    case 'clear-status': {
      const statusByKey = { ...state.ui.statusByKey }
      delete statusByKey[event.pendingKey]
      return { state: { ...state, ui: { ...state.ui, statusByKey } }, run: null }
    }
  }
}

/** Absolute local time: "15:21" today, "Thu 14:00" other days. Inject clock + timeZone for tests. */
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

export function effectiveScope(snapshot: PanelSnapshot, uiScope: Scope | null): Scope {
  if (!snapshot.focusedRepo) return 'global'
  return uiScope ?? 'repo'
}

export function scopedAttention(snapshot: PanelSnapshot, scope: Scope): AttentionRow[] {
  if (scope === 'global') return snapshot.attention
  const key = snapshot.focusedRepo?.key
  if (!key) return snapshot.attention
  return snapshot.attention.filter((a) => !a.repo || a.repo.key === key)
}

export function scopedRunning(snapshot: PanelSnapshot, scope: Scope): PanelTask[] {
  if (scope === 'global') return snapshot.running
  const key = snapshot.focusedRepo?.key
  if (!key) return snapshot.running
  return snapshot.running.filter((t) => t.repo?.key === key)
}

export function scopedDoneToday(snapshot: PanelSnapshot, scope: Scope): PanelTask[] {
  if (scope === 'global') return snapshot.doneToday
  const key = snapshot.focusedRepo?.key
  if (!key) return snapshot.doneToday
  return snapshot.doneToday.filter((t) => t.repo?.key === key)
}

export function globalNeedsYouCount(snapshot: PanelSnapshot): number {
  return snapshot.attention.length
}

export function otherReposNeedsYou(snapshot: PanelSnapshot): number {
  if (!snapshot.focusedRepo) return 0
  return snapshot.attention.length - scopedAttention(snapshot, 'repo').length
}

export type CardTone = 'default' | 'warn' | 'bad'

export function attentionCardTone(kind: string): CardTone {
  if (kind === 'failed' || kind === 'limit') return 'bad'
  if (kind === 'question' || kind === 'stuck' || kind === 'stalled') return 'warn'
  return 'default'
}

export function attentionGlyph(kind: string): string | null {
  if (kind === 'failed' || kind === 'limit') return '✕'
  if (kind === 'question' || kind === 'stuck' || kind === 'stalled') return '◐'
  return null
}

/** Display monogram for known agents; otherwise first two letters. */
export function executorMonogram(executor?: string | null): string | null {
  if (!executor) return null
  const agent = executor.split('@')[0]!.split('#')[0]!.toLowerCase()
  const map: Record<string, string> = {
    'claude-code': 'Cl',
    claude: 'Cl',
    codex: 'Cx',
    cursor: 'Cu',
    opencode: 'OC',
    agy: 'AG',
    antigravity: 'AG',
    local: 'Lo',
  }
  if (map[agent]) return map[agent]!
  return agent.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?'
}

/** Executor display names; account in parentheses only when two share an agent. */
export function executorDisplayNames(executors: PanelExecutor[]): Map<string, string> {
  const agentName = (agent: string): string => {
    const map: Record<string, string> = {
      'claude-code': 'Claude',
      claude: 'Claude',
      codex: 'Codex',
      cursor: 'Cursor',
      opencode: 'OpenCode',
      agy: 'Antigravity',
      antigravity: 'Antigravity',
      local: 'Local model',
    }
    return map[agent] ?? agent
  }
  const byAgent = new Map<string, PanelExecutor[]>()
  for (const row of executors) {
    const list = byAgent.get(row.agent) ?? []
    list.push(row)
    byAgent.set(row.agent, list)
  }
  const out = new Map<string, string>()
  for (const row of executors) {
    const base = agentName(row.agent)
    const peers = byAgent.get(row.agent) ?? []
    out.set(row.id, peers.length > 1 ? `${base} (${row.account})` : base)
  }
  return out
}

export function executorLabelFor(id: string | null | undefined, names: Map<string, string>): string {
  if (!id) return 'Automatic'
  return names.get(id) ?? id.split('@')[0]!.split('#')[0]!
}

export type MeterTone = 'good' | 'warn' | 'bad' | 'neutral'

export function meterTone(verdict: string, stale?: boolean): MeterTone {
  if (stale) return 'neutral'
  if (verdict === 'behind' || verdict === 'on_pace') return 'good'
  if (verdict === 'ahead') return 'warn'
  if (verdict === 'out') return 'bad'
  return 'neutral'
}

export function plannerHeadline(planner: PanelSnapshot['planner'], resetLabel?: string): string {
  if (!planner) return 'Usage unknown.'
  if (planner.verdict === 'out') {
    return `${planner.agent} is out until ${resetLabel || 'reset'}.`
  }
  if (planner.verdict === 'behind') return 'Plenty left this week.'
  if (planner.verdict === 'ahead') return "You're ahead of pace."
  if (planner.verdict === 'on_pace') return "You're on pace for the week."
  return 'Usage unknown.'
}

export function modePillLabel(snapshot: PanelSnapshot): { text: string; tone: 'neutral' | 'warn' } {
  if (snapshot.pause) return { text: 'Paused', tone: 'warn' }
  const mode = snapshot.planner?.mode || 'normal'
  const text = mode === 'emergency' ? 'Emergency mode' : `${mode[0]!.toUpperCase()}${mode.slice(1)} mode`
  return { text, tone: 'neutral' }
}

export function executorStateWords(row: PanelExecutor): { label: string; tone: string } {
  if (row.state === 'ready' && row.untested) return { label: 'Not tested', tone: 'neutral' }
  const map: Record<string, { label: string; tone: string }> = {
    ready: { label: 'Ready', tone: row.tone === 'muted' ? 'neutral' : row.tone },
    busy: { label: 'Busy', tone: row.tone === 'muted' ? 'neutral' : row.tone },
    full: { label: 'Full', tone: row.tone === 'muted' ? 'neutral' : row.tone },
    failing: { label: 'Not working', tone: 'warn' },
    down: { label: 'Down', tone: 'bad' },
    blocked: { label: 'Blocked', tone: 'neutral' },
    exhausted: { label: 'Out of quota', tone: 'bad' },
    disabled: { label: 'Disabled', tone: 'neutral' },
    checking: { label: 'Checking', tone: 'info' },
  }
  return map[row.state] ?? { label: row.state, tone: 'neutral' }
}

export function phaseWords(phase?: string): string {
  const map: Record<string, string> = {
    driving: "You're driving",
    starting: 'Starting',
    working: 'Editing',
    testing: 'Testing',
    idle: 'Idle',
    'lost-contact': 'Lost contact',
    queued: 'Queued',
  }
  return phase ? map[phase] ?? phase : 'Working'
}

export function doneGlyph(task: PanelTask): { glyph: string; tone: 'good' | 'bad' | 'muted'; label: string } {
  if (task.review?.accepted === true) return { glyph: '✓', tone: 'good', label: 'Accepted' }
  if (task.review?.accepted === false) return { glyph: '✕', tone: 'bad', label: 'Rejected' }
  if (task.state === 'failed' || task.state === 'limit') return { glyph: '✕', tone: 'bad', label: 'Failed' }
  return { glyph: '·', tone: 'muted', label: 'Done' }
}

export type DelegateKindChip = { id: string; label: string; kind?: string }

export const DELEGATE_KINDS: DelegateKindChip[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'feature', label: 'Feature', kind: 'feature' },
  { id: 'fix', label: 'Fix', kind: 'debug' },
  { id: 'tests', label: 'Tests', kind: 'tests' },
  { id: 'docs', label: 'Docs', kind: 'docs' },
  { id: 'refactor', label: 'Refactor', kind: 'refactor' },
  { id: 'research', label: 'Research', kind: 'research' },
]

/** Build task.delegate params from the delegate form. */
export function buildDelegateParams(input: {
  goal: string
  repoPath: string
  kind: string
  executor: string
  worktree: 'new' | 'current'
  acceptance: string
  requestId: string
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    goal: input.goal.trim(),
    repo: input.repoPath,
    source: 'ui',
    worktree: input.worktree,
    request_id: input.requestId,
  }
  const chip = DELEGATE_KINDS.find((k) => k.id === input.kind)
  if (chip?.kind) params.kind = chip.kind
  if (input.executor !== 'auto') params.executor = input.executor
  if (input.acceptance.trim()) params.acceptance = input.acceptance.trim()
  return params
}

export function nextExecutor(executors: PanelExecutor[]): PanelExecutor | undefined {
  return executors.find((e) => e.next) ?? executors.find((e) => e.enabled && e.state === 'ready')
}

export function actionNeedsConfirm(action: AttentionAction): boolean {
  return Boolean(action.confirm) || action.style === 'danger'
}

export function confirmTextFor(action: AttentionAction): string {
  if (typeof action.confirm === 'string' && action.confirm) return action.confirm
  return 'Stop this task?'
}

/** Relabel Answer → Send answer; keep others. */
export function actionButtonLabel(action: AttentionAction, kind: string): string {
  if (kind === 'question' && (action.op === 'task.answer' || action.op === 'dispatch.answer' || action.label === 'Answer')) {
    return 'Send answer'
  }
  return action.label
}

export function reviewExpectRev(snapshot: PanelSnapshot, taskId?: string): number | undefined {
  if (!taskId) return undefined
  const row = [...snapshot.running, ...snapshot.doneToday].find((t) => t.id === taskId)
  return row?.rev
}

export type PanelModel =
  | { kind: 'loading' }
  | { kind: 'load-error' }
  | { kind: 'not-connected'; snapshot: PanelSnapshot }
  | {
      kind: 'ready'
      snapshot: PanelSnapshot
      scope: Scope
      attention: AttentionRow[]
      running: PanelTask[]
      doneToday: PanelTask[]
      doneVisible: PanelTask[]
      doneMore: number
      otherNeedsYou: number
      globalNeedsYou: number
      names: Map<string, string>
      next: PanelExecutor | undefined
      ui: UiState
    }

export function panelModel(state: PanelState, _now: number): PanelModel {
  if (state.snapshot === null) return state.loadError ? { kind: 'load-error' } : { kind: 'loading' }
  const snapshot = state.snapshot
  if (!snapshot.connected) return { kind: 'not-connected', snapshot }
  const scope = effectiveScope(snapshot, state.ui.scope)
  const attention = scopedAttention(snapshot, scope)
  const running = scopedRunning(snapshot, scope)
  const doneToday = scopedDoneToday(snapshot, scope)
  const doneVisible = doneToday.slice(0, 8)
  const doneMore = Math.max(0, doneToday.length - 8)
  return {
    kind: 'ready',
    snapshot,
    scope,
    attention,
    running,
    doneToday,
    doneVisible,
    doneMore,
    otherNeedsYou: otherReposNeedsYou(snapshot),
    globalNeedsYou: globalNeedsYouCount(snapshot),
    names: executorDisplayNames(snapshot.executors),
    next: nextExecutor(snapshot.executors),
    ui: state.ui,
  }
}
