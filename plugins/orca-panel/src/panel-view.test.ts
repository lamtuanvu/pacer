/// <reference types="@types/bun" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PanelSnapshot } from './protocol'
import {
  absoluteTime,
  attentionCardTone,
  attentionGlyph,
  buildDelegateParams,
  confirmTextFor,
  doneGlyph,
  effectiveScope,
  globalNeedsYouCount,
  initialPanelState,
  meterTone,
  otherReposNeedsYou,
  panelModel,
  plannerHeadline,
  reducePanel,
  scopedAttention,
  type PanelEvent,
} from './panel-view'

const repo = { key: 'k1', label: 'jawfish', path: '/repo' }
const other = { key: 'k2', label: 'other', path: '/other' }

function snap(over: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    connected: true,
    at: 1_700_000_100,
    focusedRepo: repo,
    planner: {
      agent: 'Claude',
      usedPct: 14,
      pacePct: 12,
      verdict: 'on_pace',
      advice: 'Delegate multi-file edits.',
      mode: 'normal',
      resetsAt: 1_700_100_000,
      window: 'week',
      stale: false,
    },
    pause: null,
    repos: [
      { ...repo, needsYou: 1, running: 0, doneToday: 0 },
      { ...other, needsYou: 1, running: 0, doneToday: 0 },
    ],
    attention: [
      {
        id: 'r1',
        kind: 'review',
        severity: 'decide',
        repo,
        taskId: 't-review',
        executor: 'cursor',
        title: 'Review me',
        detail: '7 files',
        raisedAt: 50,
        since: 50,
        actions: [{ label: 'Review changes', op: 'ui.open', params: { view: 'review', id: 't-review' } }],
        notify: 'important',
        repoLabel: 'jawfish',
      },
      {
        id: 'f1',
        kind: 'failed',
        severity: 'problem',
        repo: other,
        title: 'Failed elsewhere',
        detail: 'boom',
        raisedAt: 40,
        since: 40,
        actions: [{ label: 'Retry', op: 'dispatch.retry', params: { id: 't' }, confirm: 'Retry this task?' }],
        notify: 'important',
        repoLabel: 'other',
      },
      {
        id: 'g1',
        kind: 'setup',
        severity: 'decide',
        repo: null,
        title: 'Global setup',
        detail: 'd',
        raisedAt: 30,
        since: 30,
        actions: [],
        notify: 'all',
      },
      {
        id: 'q1',
        kind: 'question',
        severity: 'blocked',
        repo,
        taskId: 't-q',
        executor: 'codex',
        title: 'Which DB?',
        detail: 'pick one',
        raisedAt: 20,
        since: 20,
        actions: [{ label: 'Answer', op: 'task.answer', params: { id: 't-q' } }],
        notify: 'important',
        repoLabel: 'jawfish',
      },
    ],
    running: [
      {
        id: 't-run',
        rev: 3,
        title: 'Running task',
        repo,
        repoLabel: 'jawfish',
        executor: 'cursor',
        state: 'running',
        phase: 'working',
        attemptStartedAt: 1_700_000_000,
        updatedAt: 1_700_000_050,
        review: null,
        liveness: { stalled: true, reason: 'waiting', since: 1_699_999_000 },
        worktree: '/wt',
        orcaWorkspaceId: 'ws-wt',
      },
    ],
    doneToday: Array.from({ length: 10 }, (_, i) => ({
      id: `done-${i}`,
      rev: 1,
      title: `Done ${i}`,
      repo,
      executor: 'cursor',
      state: 'done',
      updatedAt: 1_700_000_000 - i,
      review: i === 0 ? { accepted: true } : i === 1 ? { accepted: false } : null,
    })),
    executors: [
      {
        id: 'cursor',
        agent: 'cursor',
        account: 'default',
        rank: 1,
        state: 'ready',
        tone: 'good',
        sub: 'Ready',
        next: true,
        slots: { used: 0, max: 2 },
        enabled: true,
      },
      {
        id: 'codex',
        agent: 'codex',
        account: 'default',
        rank: 2,
        state: 'busy',
        tone: 'info',
        sub: 'Busy',
        next: false,
        slots: { used: 1, max: 1 },
        enabled: true,
      },
    ],
    ...over,
  }
}

test('scope filtering includes repo-null items in every scope', () => {
  const s = snap()
  const repoIds = scopedAttention(s, 'repo').map((a) => a.id)
  assert.deepEqual(repoIds.sort(), ['g1', 'q1', 'r1'])
  assert.equal(scopedAttention(s, 'global').length, 4)
  assert.equal(otherReposNeedsYou(s), 1)
  assert.equal(globalNeedsYouCount(s), 4)
})

test('card tone and glyph mapping', () => {
  assert.equal(attentionCardTone('failed'), 'bad')
  assert.equal(attentionCardTone('limit'), 'bad')
  assert.equal(attentionCardTone('question'), 'warn')
  assert.equal(attentionCardTone('stuck'), 'warn')
  assert.equal(attentionCardTone('stalled'), 'warn')
  assert.equal(attentionCardTone('review'), 'default')
  assert.equal(attentionGlyph('failed'), '✕')
  assert.equal(attentionGlyph('question'), '◐')
  assert.equal(attentionGlyph('review'), null)
})

test('planner headline and meter tone per verdict including stale', () => {
  assert.equal(plannerHeadline({ agent: 'Claude', usedPct: 10, pacePct: 10, verdict: 'on_pace', advice: '', mode: 'normal', resetsAt: null, window: 'week', stale: false }), "You're on pace for the week.")
  assert.equal(plannerHeadline({ agent: 'Claude', usedPct: 10, pacePct: 20, verdict: 'behind', advice: '', mode: 'normal', resetsAt: null, window: 'week', stale: false }), 'Plenty left this week.')
  assert.equal(plannerHeadline({ agent: 'Claude', usedPct: 40, pacePct: 20, verdict: 'ahead', advice: '', mode: 'normal', resetsAt: null, window: 'week', stale: false }), "You're ahead of pace.")
  assert.equal(plannerHeadline({ agent: 'Claude', usedPct: 100, pacePct: 20, verdict: 'out', advice: '', mode: 'normal', resetsAt: null, window: 'week', stale: false }, 'Mon 09:00'), 'Claude is out until Mon 09:00.')
  assert.equal(meterTone('behind'), 'good')
  assert.equal(meterTone('on_pace'), 'good')
  assert.equal(meterTone('ahead'), 'warn')
  assert.equal(meterTone('out'), 'bad')
  assert.equal(meterTone('on_pace', true), 'neutral')
})

test('absolute time today vs other day is timezone-safe with injected clock', () => {
  const tz = 'UTC'
  const now = Date.UTC(2026, 10, 22, 12, 0, 0) / 1000
  const today = Date.UTC(2026, 10, 22, 15, 21, 0) / 1000
  const other = Date.UTC(2026, 10, 20, 14, 0, 0) / 1000
  assert.equal(absoluteTime(today, now, tz), '15:21')
  assert.match(absoluteTime(other, now, tz), /Fri 14:00/)
})

test('confirm strings use the wire string; danger defaults', () => {
  assert.equal(confirmTextFor({ label: 'Retry', op: 'x', params: {}, confirm: 'Retry this task?' }), 'Retry this task?')
  assert.equal(confirmTextFor({ label: 'Stop', op: 'task.stop', params: {}, style: 'danger' }), 'Stop this task?')
})

test('delegate request building', () => {
  const auto = buildDelegateParams({
    goal: 'Do the thing',
    repoPath: '/repo',
    kind: 'auto',
    executor: 'auto',
    worktree: 'new',
    acceptance: '',
    requestId: 'req-1',
  })
  assert.deepEqual(auto, {
    goal: 'Do the thing',
    repo: '/repo',
    source: 'ui',
    worktree: 'new',
    request_id: 'req-1',
  })
  const full = buildDelegateParams({
    goal: 'Fix it',
    repoPath: '/repo',
    kind: 'fix',
    executor: 'cursor',
    worktree: 'current',
    acceptance: 'bun test',
    requestId: 'req-2',
  })
  assert.equal(full.kind, 'debug')
  assert.equal(full.executor, 'cursor')
  assert.equal(full.worktree, 'current')
  assert.equal(full.acceptance, 'bun test')
  assert.equal(full.request_id, 'req-2')
})

test('done-today cap and glyph', () => {
  const state = { ...initialPanelState(), snapshot: snap() }
  const model = panelModel(state, 1_700_000_100)
  assert.equal(model.kind, 'ready')
  if (model.kind !== 'ready') return
  assert.equal(model.doneVisible.length, 8)
  assert.equal(model.doneMore, 2)
  assert.deepEqual(doneGlyph(model.doneToday[0]!), { glyph: '✓', tone: 'good', label: 'Accepted' })
  assert.deepEqual(doneGlyph(model.doneToday[1]!), { glyph: '✕', tone: 'bad', label: 'Rejected' })
})

test('reducer keeps goal/answers/view/menu/confirm/pending across snapshot push', () => {
  let state = initialPanelState()
  const apply = (event: PanelEvent) => {
    state = reducePanel(state, event).state
  }
  apply({ type: 'snapshot', snapshot: snap() })
  apply({ type: 'set-goal', goal: 'Ship it' })
  apply({ type: 'set-answer', id: 'q1', text: 'postgres' })
  apply({ type: 'set-view', view: 'delegate' })
  apply({ type: 'set-scope', scope: 'global' })
  apply({ type: 'toggle-menu', open: true })
  apply({
    type: 'ask-confirm',
    confirm: {
      key: 'x',
      text: 'Stop?',
      confirmLabel: 'Stop it',
      cancelLabel: 'Keep it',
      run: { kind: 'act', op: 'task.stop', params: {}, pendingKey: 'x' },
    },
  })
  // ask-confirm closes the menu; reopen to prove a snapshot push keeps it.
  apply({ type: 'toggle-menu', open: true })
  apply({ type: 'begin', pendingKey: 'x' })
  apply({ type: 'snapshot', snapshot: snap({ at: 1_700_000_200 }) })
  assert.equal(state.ui.goal, 'Ship it')
  assert.equal(state.ui.answers.q1, 'postgres')
  assert.equal(state.ui.view, 'delegate')
  assert.equal(state.ui.menuOpen, true)
  assert.equal(state.ui.scope, 'global')
  // begin clears confirm; pending and interactive fields survive the push
  assert.equal(state.ui.confirm, null)
  assert.equal(state.ui.pending.x, true)
  assert.equal(effectiveScope(state.snapshot!, state.ui.scope), 'global')
})

test('conflict result becomes Already handled elsewhere', () => {
  let state = initialPanelState()
  state = reducePanel(state, { type: 'snapshot', snapshot: snap() }).state
  state = reducePanel(state, { type: 'begin', pendingKey: 'att:r1:accept' }).state
  state = reducePanel(state, {
    type: 'act-result',
    pendingKey: 'att:r1:accept',
    ok: false,
    conflict: true,
    error: 'rev mismatch',
  }).state
  assert.deepEqual(state.ui.statusByKey['att:r1:accept'], {
    tone: 'warn',
    text: 'Already handled elsewhere',
  })
})

test('default scope is this repo when focusedRepo exists', () => {
  const state = { ...initialPanelState(), snapshot: snap() }
  const model = panelModel(state, 1)
  assert.equal(model.kind, 'ready')
  if (model.kind === 'ready') assert.equal(model.scope, 'repo')
})

test('review items are kind review for Accept/Reject affordance', () => {
  const review = snap().attention.find((a) => a.kind === 'review')
  assert.equal(review?.kind, 'review')
  assert.ok(review?.taskId)
})
