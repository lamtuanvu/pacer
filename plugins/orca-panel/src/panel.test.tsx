// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { AttentionAction, AttentionItem } from './pacer-client'
import type { PanelSnapshot } from './protocol'

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

const oneItem: AttentionItem = {
  id: 'a1',
  kind: 'review',
  severity: 'decide',
  title: 'Review the patch',
  detail: 'task t1 settled',
  raisedAt: 1_700_000_000,
  since: 1_700_000_000,
  actions: [noConfirmAction],
  notify: false,
}

const confirmItem: AttentionItem = {
  ...oneItem,
  id: 'a2',
  title: 'Failed run',
  actions: [confirmAction],
}

function snapshot(over: Partial<PanelSnapshot> & Pick<PanelSnapshot, 'connected' | 'scope'>): PanelSnapshot {
  return { attention: [], ...over }
}

test('shows a not-connected state when the worker reports connected:false', async () => {
  const host = mockHost({
    requests: { 'pacer.snapshot': async () => snapshot({ connected: false, scope: 'global' }) },
  })
  const view = await mount(panel, { host })
  assert.match(view.find({ text: /Not connected/i })?.text ?? '', /Not connected/i)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test("renders each attention item's title and its actions as buttons", async () => {
  const host = mockHost({
    requests: {
      'pacer.snapshot': async () =>
        snapshot({ connected: true, scope: 'repo', repoLabel: 'jawfish', attention: [oneItem] }),
    },
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: oneItem.title })?.text, oneItem.title)
  assert.ok(view.find({ role: 'button', text: noConfirmAction.label }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test("pressing a button with no confirm calls pacer.act with that action's op and params", async () => {
  const actCalls: { op: string; params: Record<string, unknown> }[] = []
  const host = mockHost({
    requests: {
      'pacer.snapshot': async () =>
        snapshot({ connected: true, scope: 'repo', repoLabel: 'jawfish', attention: [oneItem] }),
      'pacer.act': async (input) => {
        actCalls.push(input)
        return { ok: true }
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ role: 'button', text: noConfirmAction.label })
  assert.deepEqual(actCalls, [{ op: noConfirmAction.op, params: noConfirmAction.params }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('pressing a button with confirm shows the confirm text and does not call pacer.act until accepted', async () => {
  const actCalls: { op: string; params: Record<string, unknown> }[] = []
  const host = mockHost({
    requests: {
      'pacer.snapshot': async () =>
        snapshot({ connected: true, scope: 'repo', repoLabel: 'jawfish', attention: [confirmItem] }),
      'pacer.act': async (input) => {
        actCalls.push(input)
        return { ok: true }
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ role: 'button', text: confirmAction.label })
  assert.match(view.find({ text: /The executor will be told/ })?.text ?? '', /The executor will be told/)
  assert.equal(actCalls.length, 0)
  await view.press({ role: 'button', text: 'Cancel' })
  assert.equal(actCalls.length, 0)
  await view.press({ role: 'button', text: confirmAction.label })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.deepEqual(actCalls, [{ op: confirmAction.op, params: confirmAction.params }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a pacer.changed event re-renders the attention list', async () => {
  const host = mockHost({
    requests: {
      'pacer.snapshot': async () =>
        snapshot({ connected: true, scope: 'repo', repoLabel: 'jawfish', attention: [oneItem] }),
    },
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: oneItem.title }))
  const next: AttentionItem = { ...oneItem, id: 'a9', title: 'New attention item' }
  await view.post('pacer.changed', {
    snapshot: snapshot({ connected: true, scope: 'repo', repoLabel: 'jawfish', attention: [next] }),
  })
  assert.ok(view.find({ text: 'New attention item' }))
  assert.equal(view.find({ text: oneItem.title }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test("falls back to a labeled global view when scope is 'global'", async () => {
  const host = mockHost({
    requests: { 'pacer.snapshot': async () => snapshot({ connected: true, scope: 'global' }) },
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'All repos' })?.text, 'All repos')
  assert.match(view.find({ text: /Nothing needs you across any repo/ })?.text ?? '', /Nothing needs you across any repo/)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
