/// <reference types="@types/bun" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PanelSnapshot } from './protocol'
import {
  absoluteTime,
  actionButtonLabel,
  answerActionParams,
  answerDisabled,
  attentionCaption,
  attentionCardTone,
  attentionGlyph,
  buildDelegateParams,
  byRepoCaption,
  confirmTextFor,
  DELEGATE_SUBMIT_KEY,
  delegatedCaption,
  doneGlyph,
  effectiveScope,
  emptyNeedsYouCopy,
  emptyRunningCopy,
  executorLabelFor,
  executorMonogram,
  executorOptionDisabled,
  executorStateWords,
  globalNeedsYouCount,
  headerStatus,
  initialPanelState,
  menuItems,
  meterTone,
  modePillLabel,
  otherReposNeedsYou,
  panelModel,
  phaseCaption,
  phaseWords,
  plannerCaption,
  plannerHeadline,
  rankChipText,
  reducePanel,
  rejectConfirmText,
  reviewExpectRev,
  runningCaption,
  scopedAttention,
  showOpenWorktree,
  showsAnswerComposer,
  showsReviewVerdicts,
  successTextForAction,
  whoRunsCounts,
  windowUsedWord,
  worktreeRadioCaption,
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
      {
        id: 'n1',
        kind: 'limit',
        severity: 'problem',
        repo,
        title: 'No executor item',
        detail: 'quota',
        raisedAt: 10,
        since: 10,
        actions: [],
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
    doneToday: [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `done-${i}`,
        rev: 1,
        title: `Done ${i}`,
        repo,
        executor: 'cursor' as string | null,
        state: 'done',
        updatedAt: 1_700_000_000 - i,
        review: i === 0 ? { accepted: true } : i === 1 ? { accepted: false } : null,
      })),
      {
        id: 'partial-1',
        rev: 1,
        title: 'Partial work',
        repo,
        executor: 'cursor',
        state: 'partial',
        updatedAt: 1_699_999_000,
        review: null,
      },
    ],
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
      {
        id: 'down',
        agent: 'opencode',
        account: 'oc-glm',
        rank: 3,
        state: 'down',
        tone: 'bad',
        sub: 'Unavailable',
        next: false,
        slots: { used: 0, max: 1 },
        enabled: true,
      },
    ],
    ...over,
  }
}

test('scope filtering includes repo-null items in every scope', () => {
  const s = snap()
  const repoIds = scopedAttention(s, 'repo').map((a) => a.id)
  assert.ok(repoIds.includes('g1'))
  assert.ok(repoIds.includes('q1'))
  assert.ok(repoIds.includes('r1'))
  assert.equal(scopedAttention(s, 'global').length, 5)
  assert.equal(otherReposNeedsYou(s), 1)
  assert.equal(globalNeedsYouCount(s), 5)
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

test('planner caption uses week not weekly for window words', () => {
  assert.equal(windowUsedWord('weekly'), 'week')
  assert.equal(windowUsedWord('week'), 'week')
  assert.equal(windowUsedWord('daily'), 'day')
  assert.equal(windowUsedWord('5h'), '5-hour window')
  assert.equal(windowUsedWord('monthly'), 'month')
  assert.equal(windowUsedWord('weird'), null)
  const caption = plannerCaption(
    { agent: 'Claude', usedPct: 14, pacePct: 12, verdict: 'on_pace', advice: '', mode: 'normal', resetsAt: null, window: 'weekly', stale: false },
    'Mon 09:00',
  )
  assert.match(caption, /14% of week used/)
  assert.doesNotMatch(caption, /weekly used/)
})

test('absolute time today vs other day is timezone-safe with injected clock', () => {
  const tz = 'UTC'
  const now = Date.UTC(2026, 10, 22, 12, 0, 0) / 1000
  const today = Date.UTC(2026, 10, 22, 15, 21, 0) / 1000
  const otherDay = Date.UTC(2026, 10, 20, 14, 0, 0) / 1000
  assert.equal(absoluteTime(today, now, tz), '15:21')
  assert.match(absoluteTime(otherDay, now, tz), /Fri 14:00/)
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

test('done-today cap, glyphs, and partial is Incomplete', () => {
  const state = { ...initialPanelState(), snapshot: snap() }
  const model = panelModel(state, 1_700_000_100)
  assert.equal(model.kind, 'ready')
  if (model.kind !== 'ready') return
  assert.equal(model.doneVisible.length, 8)
  assert.equal(model.doneMore, 3)
  assert.deepEqual(doneGlyph(model.doneToday[0]!), { glyph: '✓', tone: 'good', label: 'Accepted' })
  assert.deepEqual(doneGlyph(model.doneToday[1]!), { glyph: '✕', tone: 'bad', label: 'Rejected' })
  const partial = model.doneToday.find((t) => t.state === 'partial')!
  assert.deepEqual(doneGlyph(partial), { glyph: '◐', tone: 'warn', label: 'Incomplete' })
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
      successText: 'Stopped',
      run: { kind: 'act', op: 'task.stop', params: {}, pendingKey: 'x' },
    },
  })
  apply({ type: 'toggle-menu', open: true })
  apply({ type: 'begin', pendingKey: 'x' })
  apply({ type: 'snapshot', snapshot: snap({ at: 1_700_000_200 }) })
  assert.equal(state.ui.goal, 'Ship it')
  assert.equal(state.ui.answers.q1, 'postgres')
  assert.equal(state.ui.view, 'delegate')
  assert.equal(state.ui.menuOpen, true)
  assert.equal(state.ui.scope, 'global')
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

test('R1: delegate:watch and delegate:open do not enter the delegated branch', () => {
  let state = initialPanelState()
  state = reducePanel(state, { type: 'snapshot', snapshot: snap() }).state
  state = reducePanel(state, { type: 'set-goal', goal: 'Keep me' }).state
  state = reducePanel(state, {
    type: 'act-result',
    pendingKey: DELEGATE_SUBMIT_KEY,
    ok: true,
    result: { task_id: 't-new' },
    successText: 'Running on Cursor',
    now: 1_700_000_100,
  }).state
  assert.equal(state.ui.view, 'delegate-done')
  assert.equal(state.ui.delegated?.taskId, 't-new')
  assert.equal(state.ui.delegated?.goal, 'Keep me')
  assert.equal(state.ui.goal, '')

  state = reducePanel(state, {
    type: 'act-result',
    pendingKey: 'delegate:watch',
    ok: true,
    successText: 'Watching',
  }).state
  assert.equal(state.ui.view, 'delegate-done')
  assert.equal(state.ui.delegated?.taskId, 't-new')
  assert.equal(state.ui.delegated?.executorLabel, 'Cursor')
  assert.equal(state.ui.statusByKey['delegate:watch']?.text, 'Watching')

  state = reducePanel(state, {
    type: 'act-result',
    pendingKey: 'delegate:open',
    ok: true,
    successText: 'Opened',
  }).state
  assert.equal(state.ui.delegated?.taskId, 't-new')
  assert.notEqual(state.ui.delegated?.executorLabel, 'Opened')
})

test('P2: answer success clears the answer text so Send stays disabled', () => {
  let state = initialPanelState()
  state = reducePanel(state, { type: 'snapshot', snapshot: snap() }).state
  state = reducePanel(state, { type: 'set-answer', id: 'q1', text: 'postgres' }).state
  assert.equal(answerDisabled(state.ui.answers.q1!, false), false)
  state = reducePanel(state, {
    type: 'act-result',
    pendingKey: 'att:q1:task.answer',
    ok: true,
    successText: 'Answer sent',
  }).state
  assert.equal(state.ui.answers.q1, undefined)
  assert.equal(answerDisabled(state.ui.answers.q1 ?? '', false), true)
})

test('review Accept/Reject only on kind review; Answer adds text and disables when empty', () => {
  assert.equal(showsReviewVerdicts('review'), true)
  assert.equal(showsReviewVerdicts('question'), false)
  assert.equal(showsAnswerComposer('question'), true)
  assert.equal(showsAnswerComposer('review'), false)
  assert.equal(answerDisabled('', false), true)
  assert.equal(answerDisabled('hi', false), false)
  assert.equal(answerDisabled('hi', true), true)
  assert.equal(
    actionButtonLabel({ label: 'Answer', op: 'task.answer', params: { id: 't' } }, 'question'),
    'Send answer',
  )
  assert.equal(
    successTextForAction({ label: 'Answer', op: 'task.answer', params: { id: 't' } }, 'question'),
    'Answer sent',
  )
})

test('attention caption omits executor when the item has none', () => {
  assert.equal(attentionCaption({ executorLabel: null, when: '09:41', detail: 'quota' }), '09:41 · quota')
  assert.equal(attentionCaption({ executorLabel: 'Cursor', when: '09:41', detail: 'd' }), 'Cursor · 09:41 · d')
  assert.equal(executorLabelFor(null, new Map()), null)
  assert.equal(executorLabelFor(undefined, new Map()), null)
})

test('phaseWords captions are lower-case consistently', () => {
  assert.equal(phaseWords('working'), 'editing')
  assert.equal(phaseWords('testing'), 'testing')
  assert.equal(phaseWords('starting'), 'starting')
  assert.equal(phaseCaption('Editing'), 'editing')
  assert.equal(phaseCaption("You're driving"), "You're driving")
})

test('executor state words match words.ts; tone from the row', () => {
  const down = snap().executors.find((e) => e.state === 'down')!
  assert.deepEqual(executorStateWords(down), { label: 'Unavailable', tone: 'bad' })
  assert.deepEqual(
    executorStateWords({ ...down, state: 'full', tone: 'info' }),
    { label: 'At capacity', tone: 'info' },
  )
  assert.deepEqual(
    executorStateWords({ ...down, state: 'failing', tone: 'warn' }),
    { label: 'Failing', tone: 'warn' },
  )
  assert.deepEqual(
    executorStateWords({ ...down, state: 'ready', untested: true, tone: 'muted' }),
    { label: 'Not tested', tone: 'neutral' },
  )
})

test('Emergency mode pill is bad; pause is warn', () => {
  assert.deepEqual(modePillLabel(snap({ planner: { ...snap().planner!, mode: 'emergency' } })), {
    text: 'Emergency mode',
    tone: 'bad',
  })
  assert.deepEqual(modePillLabel(snap({ pause: { until: 1, reason: null, by: 'you' } })), {
    text: 'Paused',
    tone: 'warn',
  })
})

test('menu items, who-runs counts, rank chip, by-repo and empty copy', () => {
  const s = snap()
  const items = menuItems(s, 1_700_000_100)
  assert.ok(items.some((i) => i.kind === 'action' && i.id === 'pause1h'))
  assert.ok(items.some((i) => i.kind === 'divider'))
  assert.ok(items.some((i) => i.kind === 'action' && i.id === 'mode-hold' && i.caption === 'Until the week resets'))
  const paused = menuItems(snap({ pause: { until: 1_700_100_000, reason: null, by: 'you' } }), 1_700_000_100)
  assert.ok(paused.some((i) => i.kind === 'action' && i.id === 'resume' && i.caption?.startsWith('Paused until')))
  assert.deepEqual(whoRunsCounts(s.executors), { ready: 1, out: 1 })
  assert.equal(rankChipText(s.executors[0]!), '1')
  assert.equal(rankChipText(s.executors[2]!), '–')
  assert.equal(byRepoCaption({ running: 0, doneToday: 0 }), 'Nothing running')
  assert.equal(byRepoCaption({ running: 2, doneToday: 1 }), '2 running · 1 done today')
  assert.equal(emptyNeedsYouCopy('repo', 'jawfish'), 'Nothing needs you in jawfish.')
  assert.equal(emptyRunningCopy('Cursor'), 'Nothing running here. Cursor runs next.')
  assert.equal(showOpenWorktree('ws'), true)
  assert.equal(showOpenWorktree(undefined), false)
  assert.equal(executorOptionDisabled(s.executors[2]!), true)
  assert.equal(executorOptionDisabled(s.executors[0]!), false)
  assert.match(worktreeRadioCaption('new'), /default branch/)
  assert.match(worktreeRadioCaption('current'), /this worktree/)
  assert.equal(delegatedCaption('new', '11:42'), 'New worktree · started 11:42')
  assert.equal(rejectConfirmText('Cursor'), 'Reject this result? Cursor is told it was rejected.')
})

test('running caption composition and monograms', () => {
  assert.equal(
    runningCaption({ scope: 'repo', executorLabel: 'Cursor', phase: 'editing', started: '15:21' }),
    'Cursor · editing · started 15:21',
  )
  assert.equal(
    runningCaption({ scope: 'global', repoLabel: 'jawfish', executorLabel: 'Cursor', phase: 'editing', started: '15:21' }),
    'jawfish · Cursor · editing · started 15:21',
  )
  assert.equal(executorMonogram('cursor'), 'Cu')
  assert.equal(executorMonogram(null), null)
})

test('reviewExpectRev finds running and done rows; missing is undefined', () => {
  const s = snap()
  assert.equal(reviewExpectRev(s, 't-run'), 3)
  assert.equal(reviewExpectRev(s, 'done-0'), 1)
  assert.equal(reviewExpectRev(s, 'missing'), undefined)
})

test('R6: answer params include expect_rev when the task row is known', () => {
  const action = { label: 'Answer', op: 'task.answer', params: { id: 't-q' } }
  assert.deepEqual(answerActionParams(action, 'postgres', 3), {
    id: 't-q',
    text: 'postgres',
    expect_rev: 3,
  })
  assert.deepEqual(answerActionParams(action, 'postgres'), { id: 't-q', text: 'postgres' })
})

test('end-to-end reducer: confirm fire, cancel, load-error cleared by snapshot, not-connected', () => {
  let state = initialPanelState()
  assert.equal(panelModel(state, 1).kind, 'loading')

  state = reducePanel(state, { type: 'load-error' }).state
  assert.equal(panelModel(state, 1).kind, 'load-error')

  state = reducePanel(state, { type: 'snapshot', snapshot: snap() }).state
  assert.equal(state.loadError, false)
  assert.equal(panelModel(state, 1).kind, 'ready')

  state = reducePanel(state, {
    type: 'ask-confirm',
    confirm: {
      key: 'run:t-run:stop',
      text: 'Stop this task?',
      confirmLabel: 'Stop it',
      cancelLabel: 'Keep it',
      successText: 'Stopped',
      run: { kind: 'act', op: 'task.stop', params: { id: 't-run' }, pendingKey: 'run:t-run:stop' },
    },
  }).state
  assert.equal(state.ui.confirm?.key, 'run:t-run:stop')
  state = reducePanel(state, { type: 'cancel-confirm' }).state
  assert.equal(state.ui.confirm, null)

  state = reducePanel(state, {
    type: 'ask-confirm',
    confirm: {
      key: 'run:t-run:stop',
      text: 'Stop this task?',
      confirmLabel: 'Stop it',
      cancelLabel: 'Keep it',
      successText: 'Stopped',
      run: { kind: 'act', op: 'task.stop', params: { id: 't-run' }, pendingKey: 'run:t-run:stop' },
    },
  }).state
  state = reducePanel(state, { type: 'begin', pendingKey: 'run:t-run:stop' }).state
  assert.equal(state.ui.confirm, null)
  assert.equal(state.ui.pending['run:t-run:stop'], true)
  state = reducePanel(state, {
    type: 'act-result',
    pendingKey: 'run:t-run:stop',
    ok: true,
    successText: 'Stopped',
  }).state
  assert.equal(state.ui.statusByKey['run:t-run:stop']?.text, 'Stopped')

  state = reducePanel(state, { type: 'snapshot', snapshot: snap({ connected: false }) }).state
  assert.equal(panelModel(state, 1).kind, 'not-connected')

  state = reducePanel(state, {
    type: 'act-result',
    pendingKey: 'menu:pause1h',
    ok: true,
    successText: 'Paused',
  }).state
  assert.deepEqual(headerStatus(state.ui.statusByKey), { tone: 'good', text: 'Paused' })
})

test('default scope is this repo when focusedRepo exists', () => {
  const state = { ...initialPanelState(), snapshot: snap() }
  const model = panelModel(state, 1)
  assert.equal(model.kind, 'ready')
  if (model.kind === 'ready') assert.equal(model.scope, 'repo')
})

test('success text derives from op not display label', () => {
  assert.equal(
    successTextForAction({ label: 'Reject it', op: 'task.review', params: { verdict: 'reject' } }, 'review'),
    'Rejected',
  )
  assert.equal(
    successTextForAction({ label: 'Stop it', op: 'task.stop', params: {} }, 'failed'),
    'Stopped',
  )
  assert.equal(
    successTextForAction({ label: 'Retry', op: 'dispatch.retry', params: {} }, 'failed'),
    'Retrying',
  )
})
