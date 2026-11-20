// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. `requests` stubs pacer.snapshot so check shows connected / empty / not-connected without
// a live pacer service.
import { defineCheck } from 'orca/testing'
import type { AttentionItem } from './pacer-client'

const sampleItem: AttentionItem = {
  id: 'a1',
  kind: 'review',
  severity: 'decide',
  title: 'Review the patch',
  detail: 'task t1 settled',
  raisedAt: 1_700_000_000,
  since: 1_700_000_000,
  actions: [
    { label: 'Accept', op: 'task.review', params: { id: 't1', verdict: 'accept' } },
    {
      label: 'Reject',
      op: 'task.review',
      params: { id: 't1', verdict: 'reject' },
      style: 'danger',
      confirm: { title: 'Reject this?', body: 'The executor will be told the work was rejected.' },
    },
  ],
  notify: false,
}

export default defineCheck({
  connectedWithItems: {
    requests: {
      'pacer.snapshot': {
        connected: true,
        scope: 'repo',
        repoLabel: 'jawfish',
        attention: [sampleItem],
      },
    },
  },
  notConnected: {
    requests: {
      'pacer.snapshot': { connected: false, scope: 'global', attention: [] },
    },
  },
  empty: {
    requests: {
      'pacer.snapshot': {
        connected: true,
        scope: 'repo',
        repoLabel: 'jawfish',
        attention: [],
      },
    },
  },
})
