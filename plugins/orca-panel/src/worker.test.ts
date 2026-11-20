// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('adds to the stored total and tells open panels', async () => {
  const host = mockHost({ storage: { total: 2 } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('counter.get'), { total: 2 })
  assert.deepEqual(await worker.request('counter.add', { by: 3 }), { total: 5 })
  assert.deepEqual(worker.posts, [{ event: 'counter.changed', payload: { total: 5 } }])
  assert.deepEqual(host.data().storage, { total: 5 })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
