// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
// Minimal smoke tests for the placeholder panel; the real attention-queue tests come with the
// panel rewrite in the next task.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { AttentionItem } from './pacer-client'

const item = (id: string): AttentionItem => ({
  id,
  kind: 'review',
  severity: 'decide',
  title: `Item ${id}`,
  detail: `${id} needs you`,
  raisedAt: 1,
  since: 1,
  actions: [],
  notify: false,
})

test('shows a not-connected placeholder when the worker reports connected:false', async () => {
  const host = mockHost({ requests: { 'pacer.snapshot': async () => ({ connected: false, scope: 'global', attention: [] }) } })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Not connected' })?.text, 'Not connected')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows the scope and the attention count when the worker is connected', async () => {
  const host = mockHost({
    requests: {
      'pacer.snapshot': async () => ({
        connected: true,
        scope: 'repo',
        repoLabel: 'jawfish',
        attention: [item('a1'), item('a2')],
      }),
    },
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'jawfish' })?.text, 'jawfish')
  assert.match(view.find({ text: /2 need you/ })?.text ?? '', /2 need you/)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
