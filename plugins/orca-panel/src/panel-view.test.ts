// Tests for the html panel's pure view-model. Runner-agnostic like pacer-client.test.ts:
// node:test/node:assert, so both `bun test` and `orca plugin test` (Node's runner) run it.
/// <reference types="@types/bun" />
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  emptyMessage,
  initialPanelState,
  panelModel,
  reducePanel,
  relativeTime,
  rowFor,
  scopeHeading,
} from './panel-view'
import type { AttentionAction } from './pacer-client'
import type { AttentionRow, PanelSnapshot } from './protocol'

const noConfirmAction: AttentionAction = {
  label: 'Dismiss',
  op: 'attention.dismiss',
  params: { id: 'a1' },
}

const confirmAction: AttentionAction = {
  label: 'Reject',
  op: 'task.review',
  params: { id: 't1', verdict: 'reject' },
  style: 'danger',
  confirm: { title: 'Reject this?', body: 'The executor will be told the work was rejected.' },
}

const NOW = 1_800_000_000

const item = (over: Partial<AttentionRow> = {}): AttentionRow => ({
  id: 'a1',
  kind: 'review',
  severity: 'decide',
  title: 'Review the patch',
  detail: 'task t1 settled',
  raisedAt: NOW - 240,
  since: NOW - 240,
  actions: [noConfirmAction],
  notify: false,
  ...over,
})

const snapshot = (over: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  connected: true,
  scope: 'global',
  attention: [],
  ...over,
})

test("relativeTime formats short plain 'ago' text and clamps the future", () => {
  assert.equal(relativeTime(NOW, NOW), 'now')
  assert.equal(relativeTime(NOW + 30, NOW), 'now')
  assert.equal(relativeTime(NOW - 59, NOW), 'now')
  assert.equal(relativeTime(NOW - 240, NOW), '4m ago')
  assert.equal(relativeTime(NOW - 3 * 3600, NOW), '3h ago')
  assert.equal(relativeTime(NOW - 5 * 86_400, NOW), '5d ago')
  assert.equal(relativeTime(NOW - 14 * 86_400, NOW), '2w ago')
})

test('scopeHeading shows the repo label for scope repo and All repos for global', () => {
  assert.equal(scopeHeading(snapshot({ scope: 'repo', repoLabel: 'jawfish' })), 'jawfish')
  assert.equal(scopeHeading(snapshot({ scope: 'repo' })), 'Repo')
  assert.equal(scopeHeading(snapshot({ scope: 'global' })), 'All repos')
})

test('emptyMessage is scope-appropriate', () => {
  assert.equal(emptyMessage(snapshot({ scope: 'repo' })), 'Nothing needs you')
  assert.equal(emptyMessage(snapshot({ scope: 'global' })), 'Nothing needs you across any repo')
})

test('rowFor builds title, detail, relative time and per-action buttons with danger flags', () => {
  const row = rowFor(item({ since: NOW - 240, actions: [noConfirmAction, confirmAction] }), NOW, false)
  assert.equal(row.id, 'a1')
  assert.equal(row.title, 'Review the patch')
  assert.equal(row.detail, 'task t1 settled')
  assert.equal(row.time, '4m ago')
  assert.deepEqual(
    row.actions.map((button) => ({ label: button.label, danger: button.danger })),
    [
      { label: 'Dismiss', danger: false },
      { label: 'Reject', danger: true },
    ],
  )
  assert.deepEqual(row.actions[1]?.action, confirmAction)
})

test('rowFor carries repoLabel only when showRepo is true', () => {
  const withRepo = item({ repoLabel: 'jawfish' })
  assert.equal(rowFor(withRepo, NOW, true).repoLabel, 'jawfish')
  assert.equal(rowFor(withRepo, NOW, false).repoLabel, undefined)
  assert.equal(rowFor(item({}), NOW, true).repoLabel, undefined)
})

test("panelModel shows each row's repoLabel in the global view, but not the repo-scoped view", () => {
  const items = [item({ id: 'a1', repoLabel: 'jawfish' }), item({ id: 'a2', repoLabel: 'other-repo' })]
  const global = panelModel({ snapshot: snapshot({ scope: 'global', attention: items }), pending: null, loadError: false }, NOW)
  assert.equal(global.kind, 'ready')
  if (global.kind === 'ready') assert.deepEqual(global.rows.map((row) => row.repoLabel), ['jawfish', 'other-repo'])

  const scoped = panelModel(
    { snapshot: snapshot({ scope: 'repo', repoLabel: 'jawfish', attention: items }), pending: null, loadError: false },
    NOW,
  )
  assert.equal(scoped.kind, 'ready')
  if (scoped.kind === 'ready') assert.deepEqual(scoped.rows.map((row) => row.repoLabel), [undefined, undefined])
})

test('panelModel shows loading before the first snapshot', () => {
  assert.equal(panelModel(initialPanelState(), NOW).kind, 'loading')
})

test('panelModel shows load-error when the initial request itself failed', () => {
  const { state } = reducePanel(initialPanelState(), { type: 'load-error' })
  assert.equal(panelModel(state, NOW).kind, 'load-error')
})

test('a later snapshot clears a load-error', () => {
  const errored = reducePanel(initialPanelState(), { type: 'load-error' }).state
  const { state } = reducePanel(errored, { type: 'snapshot', snapshot: snapshot({ connected: false }) })
  assert.equal(panelModel(state, NOW).kind, 'not-connected')
})

test('panelModel shows the not-connected state when connected is false', () => {
  const model = panelModel({ snapshot: snapshot({ connected: false }), pending: null, loadError: false }, NOW)
  assert.equal(model.kind, 'not-connected')
})

test('panelModel builds the ready view with heading, empty message, rows and no confirm', () => {
  const model = panelModel(
    {
      snapshot: snapshot({
        scope: 'repo',
        repoLabel: 'jawfish',
        attention: [item({ id: 'a1' }), item({ id: 'a2', since: NOW - 30 })],
      }),
      pending: null,
      loadError: false,
    },
    NOW,
  )
  assert.equal(model.kind, 'ready')
  if (model.kind !== 'ready') return
  assert.equal(model.heading, 'jawfish')
  assert.equal(model.empty, 'Nothing needs you')
  assert.deepEqual(
    model.rows.map((row) => ({ id: row.id, time: row.time })),
    [
      { id: 'a1', time: '4m ago' },
      { id: 'a2', time: 'now' },
    ],
  )
  assert.equal(model.confirm, null)
})

test('panelModel carries the pending confirm view and clears it with the snapshot', () => {
  const state = reducePanel(initialPanelState(), { type: 'press', action: confirmAction }).state
  const model = panelModel({ ...state, snapshot: snapshot() }, NOW)
  if (model.kind !== 'ready') return assert.fail('expected ready')
  assert.deepEqual(model.confirm, {
    title: 'Reject this?',
    body: 'The executor will be told the work was rejected.',
    danger: true,
  })
  // Any new snapshot (including a pacer.changed re-render) clears the gate.
  const next = panelModel(reducePanel({ ...state, snapshot: snapshot() }, { type: 'snapshot', snapshot: snapshot() }).state, NOW)
  if (next.kind !== 'ready') return assert.fail('expected ready')
  assert.equal(next.confirm, null)
})

test('pressing an action with no confirm fires pacer.act immediately', () => {
  const { state, run } = reducePanel(initialPanelState(), { type: 'press', action: noConfirmAction })
  assert.deepEqual(state, initialPanelState())
  assert.deepEqual(run, { op: 'attention.dismiss', params: { id: 'a1' } })
})

test('pressing an action with a confirm starts the gate without firing', () => {
  const { state, run } = reducePanel(initialPanelState(), { type: 'press', action: confirmAction })
  assert.deepEqual(state, { snapshot: null, pending: confirmAction, loadError: false })
  assert.equal(run, null)
})

test('confirm fires the pending action and clears the gate', () => {
  const started = reducePanel(initialPanelState(), { type: 'press', action: confirmAction }).state
  const { state, run } = reducePanel(started, { type: 'confirm' })
  assert.deepEqual(state, { snapshot: null, pending: null, loadError: false })
  assert.deepEqual(run, { op: confirmAction.op, params: confirmAction.params })
})

test('cancel clears the gate without firing', () => {
  const started = reducePanel(initialPanelState(), { type: 'press', action: confirmAction }).state
  const { state, run } = reducePanel(started, { type: 'cancel' })
  assert.deepEqual(state, { snapshot: null, pending: null, loadError: false })
  assert.equal(run, null)
})

test('confirm with nothing pending is a no-op', () => {
  const { state, run } = reducePanel(initialPanelState(), { type: 'confirm' })
  assert.deepEqual(state, initialPanelState())
  assert.equal(run, null)
})

test('a snapshot event replaces the snapshot and clears any pending confirm', () => {
  const started = reducePanel(initialPanelState(), { type: 'press', action: confirmAction }).state
  const { state, run } = reducePanel(started, { type: 'snapshot', snapshot: snapshot({ connected: false }) })
  assert.deepEqual(state, { snapshot: snapshot({ connected: false }), pending: null, loadError: false })
  assert.equal(run, null)
})
