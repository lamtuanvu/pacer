// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('shows the worker total and adds the step', async () => {
  let total = 4
  // Stands in for src/worker.ts: what each plugin.request answers.
  const host = mockHost({
    requests: {
      'counter.get': () => ({ total }),
      'counter.add': ({ by }) => ({ total: (total += by) })
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ role: 'status' })?.text, '4')

  await view.press({ text: 'Add 1' })
  assert.equal(view.find({ role: 'status' })?.text, '5')

  await view.press({ text: 'Step 10' })
  await view.press({ text: 'Add 10' })
  assert.equal(view.find({ role: 'status' })?.text, '15')

  // Another open panel added: the worker posts the new total.
  await view.post('counter.changed', { total: 20 })
  assert.equal(view.find({ role: 'status' })?.text, '20')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
