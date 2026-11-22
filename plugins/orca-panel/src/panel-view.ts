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
  successText: string
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
  /** All-repos question row expanded for answering (S9). */
  expandedAnswerId: string | null
  /** Last connected snapshot.at this session (S14 last-seen caption). */
  lastSeenAt: number | null
  pending: Record<string, true>
  confirm: ConfirmSpec | null
  statusByKey: Record<string, { tone: 'good' | 'bad' | 'warn'; text: string }>
  delegateError: string | null
  delegated: {
    taskId: string
    executorLabel: string
    goal: string
    worktree: 'new' | 'current'
    startedAt: number
    orcaWorkspaceId?: string
  } | null
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
  expandedAnswerId: null,
  lastSeenAt: null,
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

/** Exact pending key for the delegate submit (not Watch/Open on the confirmation). */
export const DELEGATE_SUBMIT_KEY = 'delegate'

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
  | { type: 'expand-answer'; id: string | null }
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

function answerItemIdFromPendingKey(pendingKey: string): string | null {
  const match = /^att:([^:]+):(?:task|dispatch)\.answer$/.exec(pendingKey)
  return match?.[1] ?? null
}

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
            lastSeenAt: event.snapshot.connected ? event.snapshot.at : state.ui.lastSeenAt,
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
    case 'expand-answer':
      return { state: { ...state, ui: { ...state.ui, expandedAnswerId: event.id, menuOpen: false } }, run: null }
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
      // Exact submit key only — Watch/Open use delegate:watch / delegate:open.
      if (event.pendingKey === DELEGATE_SUBMIT_KEY && event.ok) {
        const result = event.result as { task_id?: string; id?: string } | undefined
        const taskId = result?.task_id ?? result?.id ?? ''
        const executorLabel = event.successText?.replace(/^Running on /, '') || 'executor'
        ui = {
          ...ui,
          view: 'delegate-done',
          delegated: {
            taskId,
            executorLabel,
            goal: state.ui.goal,
            worktree: state.ui.delegateWorktree,
            startedAt: event.now ?? Date.now() / 1000,
            orcaWorkspaceId: undefined,
          },
          delegateError: null,
          goal: '',
        }
      } else if (event.pendingKey === DELEGATE_SUBMIT_KEY && !event.ok) {
        ui = { ...ui, delegateError: event.error || 'Failed' }
      }
      if (event.ok) {
        const answerId = answerItemIdFromPendingKey(event.pendingKey)
        if (answerId) {
          const answers = { ...ui.answers }
          delete answers[answerId]
          ui = {
            ...ui,
            answers,
            expandedAnswerId: ui.expandedAnswerId === answerId ? null : ui.expandedAnswerId,
          }
        }
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

export function scopedQueued(snapshot: PanelSnapshot, scope: Scope): PanelTask[] {
  if (scope === 'global') return snapshot.queued
  const key = snapshot.focusedRepo?.key
  if (!key) return snapshot.queued
  return snapshot.queued.filter((t) => t.repo?.key === key)
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

export function executorLabelFor(id: string | null | undefined, names: Map<string, string>): string | null {
  if (!id) return null
  return names.get(id) ?? id.split('@')[0]!.split('#')[0]!
}

/** Caption parts for an attention card; omit the executor when the item has none. */
export function attentionCaption(parts: {
  executorLabel: string | null
  when: string
  detail?: string
}): string {
  return [parts.executorLabel, parts.when, parts.detail].filter(Boolean).join(' · ')
}

/**
 * Board captions per attention kind (S3):
 * review — "<Executor> · finished HH:MM · <detail>"
 * question — "<task title> · asked HH:MM"
 * failed/limit — "<detail> · HH:MM"
 * else — "<Executor> · HH:MM · <detail>" (omit executor when none)
 */
export function attentionCaptionFor(
  kind: string,
  parts: {
    executorLabel: string | null
    when: string
    detail?: string
    taskTitle?: string
  },
): string {
  if (kind === 'question') {
    return [parts.taskTitle, `asked ${parts.when}`].filter(Boolean).join(' · ')
  }
  if (kind === 'review') {
    return [parts.executorLabel, `finished ${parts.when}`, parts.detail].filter(Boolean).join(' · ')
  }
  if (kind === 'failed' || kind === 'limit') {
    return [parts.detail, parts.when].filter(Boolean).join(' · ')
  }
  return attentionCaption({
    executorLabel: parts.executorLabel,
    when: parts.when,
    detail: parts.detail,
  })
}

/** Question card title line (S1): "<Executor|pacer> is waiting on you". */
export function questionWaitingTitle(executorLabel: string | null): string {
  return `${executorLabel ?? 'pacer'} is waiting on you`
}

/** All-repos list glyph (S9). */
export function attentionListGlyph(kind: string): { glyph: string; colorVar: string; label: string } {
  if (kind === 'review') return { glyph: '●', colorVar: 'var(--info-fg)', label: 'Waiting for review' }
  if (kind === 'failed' || kind === 'limit') return { glyph: '✕', colorVar: 'var(--bad-fg)', label: 'Failed' }
  if (kind === 'question' || kind === 'stuck' || kind === 'stalled') {
    return { glyph: '◐', colorVar: 'var(--warn-fg)', label: 'Needs attention' }
  }
  return { glyph: '·', colorVar: 'var(--ink-muted)', label: 'Needs you' }
}

export type AttentionBtnRole = 'secondary' | 'ghost'

export type AttentionBtn =
  | { kind: 'spacer' }
  | {
      kind: 'button'
      id: string
      label: string
      role: AttentionBtnRole
      /** Built-in Accept/Reject or service action. */
      source: 'accept' | 'reject' | 'answer' | 'expand-answer' | 'action'
      action?: AttentionAction
    }

/**
 * Button roles matching the boards (S2 / S9).
 * This-repo: direct controls + first non-ui.open = secondary; other non-ui.open = ghost;
 * ui.open actions after a flex spacer as ghost.
 * All-repos: at most two buttons (first secondary, second ghost); question's first is "Answer".
 */
export function attentionButtons(item: AttentionRow, scope: Scope): AttentionBtn[] {
  if (scope === 'global') {
    const out: AttentionBtn[] = []
    if (showsReviewVerdicts(item.kind)) {
      out.push({ kind: 'button', id: 'accept', label: 'Accept', role: 'secondary', source: 'accept' })
      const reviewAction = item.actions.find((a) => a.op === 'ui.open') ?? item.actions[0]
      if (reviewAction) {
        out.push({
          kind: 'button',
          id: `action:${reviewAction.op}:${reviewAction.label}`,
          label: reviewAction.label,
          role: 'ghost',
          source: 'action',
          action: reviewAction,
        })
      }
      return out.slice(0, 2)
    }
    if (showsAnswerComposer(item.kind)) {
      out.push({ kind: 'button', id: 'expand-answer', label: 'Answer', role: 'secondary', source: 'expand-answer' })
      const other = item.actions.find((a) => !isAnswerAction(a))
      if (other) {
        out.push({
          kind: 'button',
          id: `action:${other.op}:${other.label}`,
          label: other.label,
          role: 'ghost',
          source: 'action',
          action: other,
        })
      }
      return out.slice(0, 2)
    }
    const nonOpen = item.actions.filter((a) => a.op !== 'ui.open')
    const open = item.actions.filter((a) => a.op === 'ui.open')
    const ordered = [...nonOpen, ...open]
    for (let i = 0; i < Math.min(2, ordered.length); i++) {
      const action = ordered[i]!
      out.push({
        kind: 'button',
        id: `action:${action.op}:${action.label}`,
        label: action.label,
        role: i === 0 ? 'secondary' : 'ghost',
        source: 'action',
        action,
      })
    }
    return out
  }

  const out: AttentionBtn[] = []
  if (showsReviewVerdicts(item.kind)) {
    out.push({ kind: 'button', id: 'accept', label: 'Accept', role: 'secondary', source: 'accept' })
    out.push({ kind: 'button', id: 'reject', label: 'Reject', role: 'secondary', source: 'reject' })
  }

  const nonOpen = item.actions.filter((a) => a.op !== 'ui.open')
  const open = item.actions.filter((a) => a.op === 'ui.open')
  let firstSecondaryUsed = showsReviewVerdicts(item.kind)

  for (const action of nonOpen) {
    if (showsAnswerComposer(item.kind) && isAnswerAction(action)) {
      out.push({
        kind: 'button',
        id: `action:${action.op}`,
        label: actionButtonLabel(action, item.kind),
        role: 'secondary',
        source: 'answer',
        action,
      })
      firstSecondaryUsed = true
      continue
    }
    const role: AttentionBtnRole = firstSecondaryUsed ? 'ghost' : 'secondary'
    firstSecondaryUsed = true
    out.push({
      kind: 'button',
      id: `action:${action.op}:${action.label}`,
      label: action.label,
      role,
      source: 'action',
      action,
    })
  }

  if (open.length > 0) {
    out.push({ kind: 'spacer' })
    for (const action of open) {
      out.push({
        kind: 'button',
        id: `action:${action.op}:${action.label}`,
        label: action.label,
        role: 'ghost',
        source: 'action',
        action,
      })
    }
  }
  return out
}

export type MeterTone = 'good' | 'warn' | 'bad' | 'neutral'

export function meterTone(verdict: string, stale?: boolean): MeterTone {
  if (stale) return 'neutral'
  if (verdict === 'behind' || verdict === 'on_pace') return 'good'
  if (verdict === 'ahead') return 'warn'
  if (verdict === 'out') return 'bad'
  return 'neutral'
}

/**
 * Display name for the planner meter agent. Maps known runner/agent ids to board names;
 * falls back to the raw agent string when unknown (L3).
 */
export function plannerAgentDisplay(agent: string | null | undefined): string {
  if (!agent) return 'Planner'
  const key = agent.toLowerCase()
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
  return map[key] ?? agent
}

export function plannerHeadline(planner: PanelSnapshot['planner'], resetLabel?: string): string {
  if (!planner) return 'Usage unknown.'
  if (planner.verdict === 'out') {
    return `${plannerAgentDisplay(planner.agent)} is out until ${resetLabel || 'reset'}.`
  }
  if (planner.verdict === 'behind') return 'Plenty left this week.'
  if (planner.verdict === 'ahead') return "You're ahead of pace."
  if (planner.verdict === 'on_pace') return "You're on pace for the week."
  return 'Usage unknown.'
}

/** Map planner.window to the "of … used" phrase (weekly→week, …). Unknown → null (omit). */
export function windowUsedWord(window: string | null | undefined): string | null {
  if (!window) return null
  const map: Record<string, string> = {
    week: 'week',
    weekly: 'week',
    day: 'day',
    daily: 'day',
    month: 'month',
    monthly: 'month',
    '5h': '5-hour window',
  }
  return map[window] ?? (window.endsWith('h') ? `${window}-hour window` : null)
}

export function plannerCaption(planner: NonNullable<PanelSnapshot['planner']>, resetLabel: string): string {
  const agent = plannerAgentDisplay(planner.agent)
  if (planner.stale) return `${agent} · stale`
  const used = typeof planner.usedPct === 'number' ? Math.round(planner.usedPct) : null
  const pace = typeof planner.pacePct === 'number' ? Math.round(planner.pacePct) : null
  const ofWord = windowUsedWord(planner.window)
  const usedPart =
    used === null ? null : ofWord ? `${used}% of ${ofWord} used` : `${used}% used`
  return [agent, usedPart, pace === null ? null : `pace ${pace}%`, `resets ${resetLabel || '—'}`]
    .filter(Boolean)
    .join(' · ')
}

/** words.ts verdict words for the pace keys the panel uses (L4). */
const VERDICT_WORDS: Record<string, string> = {
  behind: 'Behind pace',
  on_pace: 'On pace',
  ahead: 'Ahead of pace',
  out: 'Out of quota',
  unknown: 'Usage unknown',
}

function normalizeAdviceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Show the service advice line unless it is exactly the verdict words (case/punctuation-insensitive).
 * Live example: headline "You're on pace…" + advice "On pace." → omit advice.
 */
export function shouldShowAdvice(advice: string | null | undefined, verdict: string): boolean {
  if (!advice || !advice.trim()) return false
  const adviceNorm = normalizeAdviceText(advice)
  const expected = VERDICT_WORDS[verdict]
  if (expected && normalizeAdviceText(expected) === adviceNorm) return false
  for (const words of Object.values(VERDICT_WORDS)) {
    if (normalizeAdviceText(words) === adviceNorm) return false
  }
  return true
}

export function modePillLabel(snapshot: PanelSnapshot): { text: string; tone: 'neutral' | 'warn' | 'bad' } {
  if (snapshot.pause) return { text: 'Paused', tone: 'warn' }
  const mode = snapshot.planner?.mode || 'normal'
  if (mode === 'emergency') return { text: 'Emergency mode', tone: 'bad' }
  const text = `${mode[0]!.toUpperCase()}${mode.slice(1)} mode`
  return { text, tone: 'neutral' }
}

/** Port of src/view-model/words.ts executorStatus / executorRowStatus labels; tone from the row. */
export function executorStateWords(row: PanelExecutor): { label: string; tone: string } {
  if (row.state === 'ready' && row.untested) return { label: 'Not tested', tone: 'neutral' }
  const labels: Record<string, string> = {
    ready: 'Ready',
    busy: 'Busy',
    full: 'At capacity',
    failing: 'Failing',
    down: 'Unavailable',
    blocked: 'Blocked',
    exhausted: 'Out of quota',
    disabled: 'Disabled',
    checking: 'Checking',
  }
  const label = labels[row.state] ?? row.state
  const tone = row.tone === 'muted' ? 'neutral' : row.tone || 'neutral'
  return { label, tone }
}

/** Phase words from words.ts; lower-cased for captions after the first segment. */
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
  const raw = phase ? map[phase] ?? phase : 'Working'
  return phaseCaption(raw)
}

/** Lower-case phase words for captions (match words.ts after the first segment). */
export function phaseCaption(words: string): string {
  if (!words) return words
  // Keep "You're driving" natural; otherwise lower-case for caption consistency.
  if (words.startsWith("You're ")) return words
  return words.toLowerCase()
}

export function doneGlyph(task: PanelTask): { glyph: string; tone: 'good' | 'bad' | 'warn' | 'muted'; label: string } {
  if (task.review?.accepted === true) return { glyph: '✓', tone: 'good', label: 'Accepted' }
  if (task.review?.accepted === false) return { glyph: '✕', tone: 'bad', label: 'Rejected' }
  if (task.state === 'failed' || task.state === 'limit') return { glyph: '✕', tone: 'bad', label: 'Failed' }
  if (task.state === 'partial') return { glyph: '◐', tone: 'warn', label: 'Incomplete' }
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

/** Success text from the action/op, not by comparing display labels. */
export function successTextForAction(action: AttentionAction, kind: string): string {
  if (kind === 'question' && (action.op === 'task.answer' || action.op === 'dispatch.answer' || action.label === 'Answer')) {
    return 'Answer sent'
  }
  if (action.op === 'task.review') {
    const verdict = action.params.verdict
    if (verdict === 'accept') return 'Accepted'
    if (verdict === 'reject') return 'Rejected'
  }
  if (action.op === 'task.stop' || action.op === 'dispatch.stop') return 'Stopped'
  if (action.op === 'task.retry' || action.op === 'dispatch.retry') return 'Retrying'
  if (action.op === 'task.attach') return 'Watching'
  return action.label
}

export function successTextForConfirm(confirm: ConfirmSpec): string {
  return confirm.successText
}

export function reviewExpectRev(snapshot: PanelSnapshot, taskId?: string): number | undefined {
  if (!taskId) return undefined
  const row = [...snapshot.running, ...snapshot.doneToday].find((t) => t.id === taskId)
  return row?.rev
}

/** Merge answer text (+ expect_rev when known) into the service action params. */
export function answerActionParams(
  action: AttentionAction,
  text: string,
  expectRev?: number,
): Record<string, unknown> {
  return {
    ...action.params,
    text,
    ...(expectRev != null ? { expect_rev: expectRev } : {}),
  }
}

/** Whether Accept/Reject appear for this attention kind. */
export function showsReviewVerdicts(kind: string): boolean {
  return kind === 'review'
}

/** Whether the answer textarea + Send answer appear. */
export function showsAnswerComposer(kind: string): boolean {
  return kind === 'question'
}

export function isAnswerAction(action: AttentionAction): boolean {
  return action.op === 'task.answer' || action.op === 'dispatch.answer' || action.label === 'Answer'
}

export function isReviewOpenAction(kind: string, action: AttentionAction): boolean {
  return kind === 'review' && action.op === 'ui.open'
}

export function answerDisabled(answerText: string, busy: boolean): boolean {
  return busy || !answerText.trim()
}

export function rejectConfirmText(executorLabel: string | null): string {
  const who = executorLabel ?? 'The executor'
  return `Reject this result? ${who} is told it was rejected.`
}

export function stalledMinutes(since: number, now: number): number {
  return Math.max(1, Math.round((now - since) / 60))
}

/** Board stalled pill copy (S5). */
export function stalledPillText(mins: number): string {
  return `No output for ${mins} min`
}

/** Short agent display name for Done today meta (S6) — never the account suffix. */
export function executorShortLabel(
  id: string | null | undefined,
  executors: PanelExecutor[],
): string | null {
  if (!id) return null
  const row = executors.find((e) => e.id === id)
  if (row) return plannerAgentDisplay(row.agent)
  const agent = id.split('@')[0]!.split('#')[0]!
  return plannerAgentDisplay(agent)
}

/** Sum enabled executor slots for All-repos Running header (S10). */
export function slotsInUse(executors: PanelExecutor[]): { used: number; max: number } | null {
  let used = 0
  let max = 0
  let any = false
  for (const row of executors) {
    if (!row.enabled) continue
    if (!row.slots || typeof row.slots.used !== 'number' || typeof row.slots.max !== 'number') continue
    any = true
    used += row.slots.used
    max += row.slots.max
  }
  if (!any || max <= 0) return null
  return { used, max }
}

/** Queued row caption (S16). */
export function queuedCaption(paused: boolean, nextLabel: string | null, queuedAt: string): string {
  if (paused) return `Waits for resume · queued ${queuedAt}`
  return `${nextLabel ?? 'An executor'} runs it next · queued ${queuedAt}`
}

export function runningCaption(parts: {
  scope: Scope
  repoLabel?: string
  executorLabel: string | null
  phase: string
  started: string
}): string {
  return [
    parts.scope === 'global' ? parts.repoLabel : null,
    parts.executorLabel,
    parts.phase,
    `started ${parts.started}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function showOpenWorktree(orcaWorkspaceId?: string | null): boolean {
  return Boolean(orcaWorkspaceId)
}

export type MenuItem =
  | { kind: 'action'; id: string; label: string; caption?: string; run: RunRequest; successText?: string }
  | { kind: 'divider' }

export function menuItems(snapshot: PanelSnapshot, now: number): MenuItem[] {
  const items: MenuItem[] = []
  if (snapshot.pause) {
    const until = snapshot.pause.until ? absoluteTime(snapshot.pause.until, now) : 'later'
    items.push({
      kind: 'action',
      id: 'resume',
      label: 'Resume delegation',
      caption: `Paused until ${until}`,
      run: { kind: 'act', op: 'delegation.resume', params: {}, pendingKey: 'menu:resume' },
      successText: 'Resumed',
    })
  } else {
    items.push(
      {
        kind: 'action',
        id: 'pause1h',
        label: 'Pause for 1 hour',
        run: { kind: 'act', op: 'delegation.pause', params: { for: '1h' }, pendingKey: 'menu:pause1h' },
        successText: 'Paused',
      },
      {
        kind: 'action',
        id: 'pause4h',
        label: 'Pause for 4 hours',
        run: { kind: 'act', op: 'delegation.pause', params: { for: '4h' }, pendingKey: 'menu:pause4h' },
        successText: 'Paused',
      },
      {
        kind: 'action',
        id: 'pause1d',
        label: 'Pause until tomorrow',
        run: { kind: 'act', op: 'delegation.pause', params: { for: '1d' }, pendingKey: 'menu:pause1d' },
        successText: 'Paused',
      },
    )
  }
  if (snapshot.planner?.modeHeldUntil) {
    items.push({
      kind: 'action',
      id: 'mode-release',
      label: 'Release the held mode',
      run: { kind: 'act', op: 'mode.release', params: {}, pendingKey: 'menu:mode-release' },
      successText: 'Released',
    })
  } else {
    items.push({
      kind: 'action',
      id: 'mode-hold',
      label: 'Hold strict mode',
      caption: 'Until the week resets',
      run: { kind: 'act', op: 'mode.hold', params: { mode: 'strict' }, pendingKey: 'menu:mode-hold' },
      successText: 'Held',
    })
  }
  items.push({ kind: 'divider' })
  items.push({
    kind: 'action',
    id: 'open',
    label: 'Open the pacer app',
    run: { kind: 'act', op: 'ui.open', params: { view: 'overview' }, pendingKey: 'menu:open' },
  })
  return items
}

export function whoRunsCounts(executors: PanelExecutor[]): { ready: number; out: number } {
  const ready = executors.filter((e) => e.enabled && (e.state === 'ready' || e.untested)).length
  const out = executors.filter((e) => e.state === 'exhausted' || e.state === 'down' || e.state === 'disabled').length
  return { ready, out }
}

/** Rank chip text: rank number for next/ready; en-dash when unavailable. */
export function rankChipText(row: PanelExecutor): string {
  if (row.next || row.state === 'ready') return String(row.rank)
  return '–'
}

export function byRepoCaption(repo: { running: number; doneToday: number }): string {
  if (repo.running > 0 || repo.doneToday > 0) {
    return `${repo.running} running · ${repo.doneToday} done today`
  }
  return 'Nothing running'
}

export type PanelRepoRow = {
  key: string
  label: string
  path: string
  needsYou: number
  running: number
  doneToday: number
  orcaWorkspaceId?: string
}

/**
 * By-repo list: only repos with needsYou or running, sorted needsYou desc → running desc → label,
 * capped at `limit` with a "N more" count (L2). Hide the section when rows is empty.
 */
export function visibleByRepos(
  repos: PanelRepoRow[],
  limit = 5,
): { rows: PanelRepoRow[]; more: number } {
  const qualified = repos
    .filter((r) => r.needsYou > 0 || r.running > 0)
    .slice()
    .sort(
      (a, b) =>
        b.needsYou - a.needsYou ||
        b.running - a.running ||
        a.label.localeCompare(b.label),
    )
  return {
    rows: qualified.slice(0, limit),
    more: Math.max(0, qualified.length - limit),
  }
}

export function emptyNeedsYouCopy(scope: Scope, label: string | undefined): string {
  return `Nothing needs you in ${scope === 'repo' ? label ?? 'this repo' : 'any repo'}.`
}

export function emptyRunningCopy(nextLabel: string | null): string {
  return `Nothing running here. ${nextLabel ?? 'An executor'} runs next.`
}

export function executorOptionDisabled(row: PanelExecutor): boolean {
  return !row.enabled || row.state === 'disabled' || row.state === 'down' || row.state === 'exhausted'
}

export function delegateWhyCaption(
  executorId: string,
  next: PanelExecutor | undefined,
  names: Map<string, string>,
  executors: PanelExecutor[],
): string {
  if (executorId === 'auto') {
    const nextName = next ? executorLabelFor(next.id, names) : 'An executor'
    const sub = next?.sub
    return sub ? `${nextName} runs next · ${sub}` : `${nextName} runs next`
  }
  const row = executors.find((e) => e.id === executorId)
  if (!row) return ''
  const words = executorStateWords(row)
  return row.sub || words.label
}

export function worktreeRadioCaption(kind: 'new' | 'current', branch?: string | null): string {
  if (kind === 'new') return 'Branches from the default branch; your worktree stays untouched.'
  return `Works on ${branch || 'this worktree'}. Commit or stash first.`
}

export function delegatedCaption(worktree: 'new' | 'current', startedLabel: string): string {
  const place = worktree === 'new' ? 'New worktree' : 'In this worktree'
  return `${place} · started ${startedLabel}`
}

/** Local client ids map to "by you" (S15); unknown/remote clients omit the by-clause. */
function isLocalPauseClient(by: string): boolean {
  const key = by.toLowerCase()
  return (
    key === 'you' ||
    key === 'ui' ||
    key === 'user' ||
    key === 'desktop' ||
    key === 'web' ||
    key === 'tui' ||
    key === 'orca' ||
    key === 'panel' ||
    key.startsWith('ui-') ||
    key.startsWith('desktop') ||
    key.startsWith('web')
  )
}

export function pauseBannerExtra(pause: { by: string | null; reason: string | null }, atLabel: string | null): string | null {
  if (!pause.by || !isLocalPauseClient(pause.by)) return null
  if (atLabel) return `Paused by you at ${atLabel}.`
  return `Paused by you.`
}

export function headerStatusKeys(): string[] {
  return [
    'menu:resume',
    'menu:pause1h',
    'menu:pause4h',
    'menu:pause1d',
    'menu:mode-hold',
    'menu:mode-release',
    'pause:resume',
  ]
}

export function headerStatus(
  statusByKey: UiState['statusByKey'],
): { tone: 'good' | 'bad' | 'warn'; text: string } | null {
  for (const key of headerStatusKeys()) {
    const status = statusByKey[key]
    if (status) return status
  }
  return null
}

export type PanelModel =
  | { kind: 'loading' }
  | { kind: 'load-error' }
  | { kind: 'not-connected'; snapshot: PanelSnapshot; lastSeenAt: number | null }
  | {
      kind: 'ready'
      snapshot: PanelSnapshot
      scope: Scope
      attention: AttentionRow[]
      running: PanelTask[]
      queued: PanelTask[]
      doneToday: PanelTask[]
      doneVisible: PanelTask[]
      doneMore: number
      otherNeedsYou: number
      globalNeedsYou: number
      names: Map<string, string>
      next: PanelExecutor | undefined
      slots: { used: number; max: number } | null
      ui: UiState
    }

export function panelModel(state: PanelState, _now: number): PanelModel {
  if (state.snapshot === null) return state.loadError ? { kind: 'load-error' } : { kind: 'loading' }
  const snapshot = state.snapshot
  if (!snapshot.connected) {
    return { kind: 'not-connected', snapshot, lastSeenAt: state.ui.lastSeenAt }
  }
  const scope = effectiveScope(snapshot, state.ui.scope)
  const attention = scopedAttention(snapshot, scope)
  const running = scopedRunning(snapshot, scope)
  const queued = scopedQueued(snapshot, scope)
  const doneToday = scopedDoneToday(snapshot, scope)
  const doneVisible = doneToday.slice(0, 8)
  const doneMore = Math.max(0, doneToday.length - 8)
  return {
    kind: 'ready',
    snapshot,
    scope,
    attention,
    running,
    queued,
    doneToday,
    doneVisible,
    doneMore,
    otherNeedsYou: otherReposNeedsYou(snapshot),
    globalNeedsYou: globalNeedsYouCount(snapshot),
    names: executorDisplayNames(snapshot.executors),
    next: nextExecutor(snapshot.executors),
    slots: slotsInUse(snapshot.executors),
    ui: state.ui,
  }
}
