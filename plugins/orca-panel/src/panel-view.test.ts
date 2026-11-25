/// <reference types="@types/bun" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PanelSnapshot } from './protocol'
import {
  absoluteTime,
  activeTasks,
  answerActionParams,
  answerDisabled,
  classifyTask,
  controlBusy,
  doneGlyph,
  doneTasks,
  initialPanelState,
  needsYouItems,
  panelModel,
  reducePanel,
  reviewExpectRev,
  stalledMinutes,
  stalledPillText,
  summaryText,
  taskGlyph,
  taskStatusText,
  taskStatusTone,
  worktreeTasks,
  type PanelEvent,
} from './panel-view'

const repo = { key: 'k1', label: 'jawfish', path: '/repo' }
const other = { key: 'k2', label: 'other', path: '/other' }

function snap(over: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    connected: true,
    at: 1_700_000_100,
    focusedWorkspace: { path: '/repo', name: 'gar' },
    planner: {
      agent: 'Claude',
      usedPct: 17,
      pacePct: 12,
      verdict: 'on_pace',
      advice: 'Delegate multi-file edits.',
      mode: 'normal',
      resetsAt: 1_700_100_000,
      window: 'week',
      stale: false,
    },
    pause: null,
    repos: [],
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
      },
      {
        id: 'm1',
        kind: 'message',
        severity: 'decide',
        repo,
        taskId: 't-msg',
        executor: 'codex',
        title: 'Message for you',
        detail: 'hello',
        raisedAt: 40,
        since: 40,
        actions: [],
        notify: 'important',
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
      },
    ],
    running: [],
    queued: [],
    tasks: [
      {
        id: 't-review',
        rev: 3,
        title: 'Review task',
        repo,
        executor: 'cursor',
        state: 'done',
        updatedAt: 1_700_000_000,
        review: null,
        liveness: null,
        worktree: '/repo',
      },
      {
        id: 't-msg',
        rev: 1,
        title: 'Message task',
        repo,
        executor: 'codex',
        state: 'running',
        phase: 'working',
        attemptStartedAt: 1_700_000_000,
        updatedAt: 1_700_000_050,
        review: null,
        liveness: null,
        worktree: '/repo',
      },
      {
        id: 't-q',
        rev: 2,
        title: 'Question task',
        repo,
        executor: 'codex',
        state: 'needs_input',
        updatedAt: 1_700_000_000,
        review: null,
        liveness: null,
        worktree: '/repo',
        question: 'Keep or remove?',
      },
      {
        id: 't-other',
        rev: 1,
        title: 'Other worktree task',
        repo: other,
        executor: 'cursor',
        state: 'running',
        updatedAt: 1_700_000_000,
        review: null,
        liveness: null,
        worktree: '/other',
      },
      {
        id: 't-queued',
        rev: 1,
        title: 'Queued task',
        repo,
        executor: null,
        state: 'queued',
        updatedAt: 1_700_000_000,
        review: null,
        liveness: null,
        worktree: '/repo',
        nextExecutor: 'Cursor',
      },
      {
        id: 't-failed',
        rev: 1,
        title: 'Failed task',
        repo,
        executor: 'opencode',
        state: 'failed',
        updatedAt: 1_700_000_000,
        review: null,
        liveness: null,
        worktree: '/repo',
      },
      {
        id: 't-stalled',
        rev: 1,
        title: 'Stalled task',
        repo,
        executor: 'cursor',
        state: 'running',
        phase: 'working',
        attemptStartedAt: 1_699_999_000,
        updatedAt: 1_699_999_000,
        review: null,
        liveness: { stalled: true, reason: 'no_progress', since: 1_699_999_000 },
        worktree: '/repo',
      },
      {
        id: 't-deciding',
        rev: 1,
        title: 'Deciding task',
        repo,
        executor: 'cursor',
        state: 'running',
        updatedAt: 1_700_000_000,
        review: null,
        liveness: { stalled: false, reason: 'caller_decision', since: 1_700_000_000 },
        worktree: '/repo',
      },
    ],
    doneToday: [],
    executors: [],
    ...over,
  }
}

test('membership by repo.path excludes other worktrees and trailing slash', () => {
  const s = snap({ focusedWorkspace: { path: '/repo/', name: 'gar' } })
  const ids = worktreeTasks(s).map((t) => t.id)
  assert.ok(ids.includes('t-msg'))
  assert.ok(!ids.includes('t-other'))
})

test('row classification', () => {
  const s = snap()
  const tasks = worktreeTasks(s)
  const byId = (id: string) => tasks.find((t) => t.id === id)!
  assert.equal(classifyTask(byId('t-q')), 'asked')
  assert.equal(classifyTask(byId('t-deciding')), 'caller-deciding')
  assert.equal(classifyTask(byId('t-msg')), 'running')
  assert.equal(classifyTask(byId('t-queued')), 'queued')
  assert.equal(classifyTask(byId('t-failed')), 'failed')
})

test('status text', () => {
  const s = snap()
  const tasks = worktreeTasks(s)
  const byId = (id: string) => tasks.find((t) => t.id === id)!
  const now = 1_700_000_100
  assert.equal(taskStatusText(byId('t-q'), now), 'asked caller')
  assert.equal(taskStatusText(byId('t-deciding'), now), 'caller deciding')
  assert.equal(taskStatusText(byId('t-queued'), now), 'queued')
  assert.equal(taskStatusText(byId('t-failed'), now), 'failed · caller told')
  assert.match(taskStatusText(byId('t-stalled'), now), /^no output \d+m$/)
})

test('glyphs', () => {
  const s = snap()
  const tasks = worktreeTasks(s)
  const byId = (id: string) => tasks.find((t) => t.id === id)!
  assert.equal(taskGlyph(byId('t-q')).glyph, '◐')
  assert.equal(taskGlyph(byId('t-msg')).glyph, '●')
  assert.equal(taskGlyph(byId('t-queued')).glyph, '○')
  assert.equal(taskGlyph(byId('t-failed')).glyph, '✕')
})

test('needs-you filtering: question not included, review and message included', () => {
  const s = snap()
  const items = needsYouItems(s)
  const ids = items.map((i) => i.id)
  assert.ok(ids.includes('r1'))
  assert.ok(ids.includes('m1'))
  assert.ok(!ids.includes('q1'))
})

test('summary text', () => {
  const s = snap()
  const text = summaryText(s, 1_700_000_100)
  // Needs you: r1, m1. Running: only t-stalled (t-msg is under Needs you, t-deciding waits on the caller). Asked: t-q.
  assert.equal(text, '2 needs you · 1 running · 1 asked caller · 1 queued')
})

test('settled tasks go to Done, never to the active list', () => {
  const now = 1_700_000_100
  const s = snap({
    tasks: [
      { id: 'live', rev: 1, title: 'Live', repo, executor: 'cursor#cursor', state: 'running', attemptStartedAt: now - 120, updatedAt: now - 60 },
      { id: 'fin', rev: 1, title: 'Finished', repo, executor: 'cursor#cursor', state: 'done', updatedAt: now - 300, review: { accepted: true } },
      { id: 'old-fail', rev: 1, title: 'Failed and retried', repo, executor: 'cursor#cursor', state: 'failed', updatedAt: now - 400 },
    ],
    attention: [],
  })
  assert.deepEqual(activeTasks(s).map((t) => t.id), ['live'])
  assert.deepEqual(doneTasks(s, now).map((t) => t.id), ['fin', 'old-fail'])
  assert.equal(summaryText(s, now), '1 running')
})

test('a task under Needs you is not repeated in the active list or Done', () => {
  const s = snap()
  const needs = new Set(needsYouItems(s).map((a) => a.taskId))
  for (const t of activeTasks(s)) assert.equal(needs.has(t.id), false)
  for (const t of doneTasks(s, 1_700_000_100)) assert.equal(needs.has(t.id), false)
})

test('a failed task the caller was told about counts in the summary', () => {
  const now = 1_700_000_100
  const s = snap({
    tasks: [{ id: 'f', rev: 1, title: 'Broke', repo, executor: 'cursor#cursor', state: 'failed', updatedAt: now - 60 }],
    attention: [{ id: 'a-f', kind: 'failed', severity: 'blocked', repo, taskId: 'f', title: 'Broke', detail: '', raisedAt: now, since: now, actions: [], notify: 'important' }],
  })
  assert.equal(summaryText(s, now), '1 failed')
})

test('empty summary', () => {
  const s = snap({ tasks: [], attention: [] })
  assert.equal(summaryText(s, 1_700_000_100), 'no tasks yet')
})

test('done window and cap', () => {
  const now = 1_700_000_100
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: `done-${i}`,
    rev: 1,
    title: `Done ${i}`,
    repo,
    executor: 'cursor',
    state: 'done',
    updatedAt: now - i,
    review: null,
    liveness: null,
    worktree: '/repo',
  }))
  const s = snap({ tasks: [...(snap().tasks ?? []).filter(() => false), ...tasks], attention: [] })
  // make focused
  const done = doneTasks(s, now)
  assert.equal(done.length, 12)
  const model = panelModel({ ...initialPanelState(), snapshot: s }, now)
  assert.equal(model.kind, 'ready')
  if (model.kind === 'ready') {
    assert.equal(model.doneTasks.length, 10)
    assert.equal(model.doneMore, 2)
  }
})

test('empty/no-focus/not-connected', () => {
  let state = initialPanelState()
  assert.equal(panelModel(state, 1).kind, 'loading')

  state = reducePanel(state, { type: 'load-error' }).state
  assert.equal(panelModel(state, 1).kind, 'load-error')

  const s = snap({ connected: false })
  state = reducePanel(initialPanelState(), { type: 'snapshot', snapshot: s }).state
  assert.equal(panelModel(state, 1).kind, 'not-connected')

  const noFocus = snap({ focusedWorkspace: null, tasks: [], attention: [] })
  state = reducePanel(initialPanelState(), { type: 'snapshot', snapshot: noFocus }).state
  const model = panelModel(state, 1)
  assert.equal(model.kind, 'ready')
  if (model.kind === 'ready') assert.equal(model.tasks.length, 0)
})

test('one-expanded-row reducer', () => {
  let state = initialPanelState()
  state = reducePanel(state, { type: 'snapshot', snapshot: snap() }).state
  state = reducePanel(state, { type: 'toggle-task', id: 't-msg' }).state
  assert.equal(state.ui.expandedTaskId, 't-msg')
  state = reducePanel(state, { type: 'toggle-task', id: 't-q' }).state
  assert.equal(state.ui.expandedTaskId, 't-q')
  state = reducePanel(state, { type: 'toggle-task', id: null }).state
  assert.equal(state.ui.expandedTaskId, null)
})

test('answer-yourself params include text', () => {
  const action = { label: 'Answer', op: 'task.answer', params: { id: 't-q' } }
  assert.deepEqual(answerActionParams(action, 'postgres', 2), { id: 't-q', text: 'postgres', expect_rev: 2 })
})

test('controlBusy/answerDisabled', () => {
  assert.equal(controlBusy({ 'run:x': true }, 'run:x'), true)
  assert.equal(answerDisabled('', false), true)
  assert.equal(answerDisabled('hi', false), false)
  assert.equal(answerDisabled('hi', true), true)
})

test('stalled minutes and pill', () => {
  assert.equal(stalledMinutes(1_699_999_000, 1_700_000_100), 18) // approx
  assert.equal(stalledPillText(12), 'No output for 12 min')
})

test('done glyph', () => {
  const t = { id: 'd', rev: 1, title: 'd', repo, executor: 'cursor', state: 'done', updatedAt: 1, review: { accepted: true }, liveness: null, worktree: '/repo' }
  assert.deepEqual(doneGlyph(t), { glyph: '✓', tone: 'good', label: 'Accepted' })
})

test('reviewExpectRev', () => {
  const s = snap()
  assert.equal(reviewExpectRev(s, 't-q'), 2)
})

test('absolute time', () => {
  const tz = 'UTC'
  const now = Date.UTC(2026, 10, 22, 12, 0, 0) / 1000
  const today = Date.UTC(2026, 10, 22, 15, 21, 0) / 1000
  assert.equal(absoluteTime(today, now, tz), '15:21')
})

test('status tone: amber for asked, caller deciding and stalled; red for failed; muted otherwise', () => {
  const base = { rev: 1, title: 't', repo, executor: 'cursor', updatedAt: 1, review: null }
  assert.equal(taskStatusTone({ ...base, id: 'a', state: 'needs_input', question: 'q', liveness: null }), 'warn')
  assert.equal(taskStatusTone({ ...base, id: 'b', state: 'running', liveness: { stalled: false, reason: 'caller_decision', since: 1 } }), 'warn')
  assert.equal(taskStatusTone({ ...base, id: 'c', state: 'running', liveness: { stalled: true, reason: 'no_progress', since: 1 } }), 'warn')
  assert.equal(taskStatusTone({ ...base, id: 'd', state: 'failed', liveness: null }), 'bad')
  assert.equal(taskStatusTone({ ...base, id: 'e', state: 'running', liveness: null }), 'muted')
  assert.equal(taskStatusTone({ ...base, id: 'f', state: 'queued', liveness: null }), 'muted')
})
