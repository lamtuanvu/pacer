// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state, so
// the total lives in orca.storage (the storage:own capability).
import type { OrcaWorkerApi } from 'orca/worker'

const TOTAL = 'total'

async function storedTotal(orca: OrcaWorkerApi): Promise<number> {
  const value = await orca.storage.get(TOTAL)
  return typeof value === 'number' ? value : 0
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('counter.get', async () => ({ total: await storedTotal(orca) }))

  orca.panels.handle('counter.add', async ({ by }) => {
    const total = (await storedTotal(orca)) + by
    await orca.storage.set(TOTAL, total)
    // Every open panel hears it, so a second panel stays in step.
    orca.panels.post('counter.changed', { total })
    return { total }
  })
}
