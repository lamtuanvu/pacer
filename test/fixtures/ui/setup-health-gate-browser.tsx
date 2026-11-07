import { render } from 'preact';
import type { BrowserApi } from '../../../app/src/data/api';
import { SetupHealthGate } from '../../../app/src/screens/setup/SetupHealthGate';
import type { SetupHealthReport } from '../../../src/view-model/setup-health';

const outcome = (new URLSearchParams(location.search).get('outcome') ?? 'ok') as SetupHealthReport['outcome'];
const state = outcome === 'ok' ? 'passed' : outcome === 'warnings' ? 'needs_attention' : 'failed';
const report: SetupHealthReport & { skipFullWindow: boolean } = {
  trigger: 'startup', title: 'Checking setup', support: 'Making sure agents can work through pacer.',
  steps: [
    { id: 'service', title: 'Service ready', state: 'passed' },
    { id: 'detect_agents', title: 'Detect agents', state },
    { id: 'integrations', title: 'Integrations & hooks', state: 'passed' },
    { id: 'usage_eligibility', title: 'Usage & eligibility', state: 'passed' },
    { id: 'ready', title: 'Ready to take work', state },
  ],
  outcome, attentionCount: outcome === 'ok' ? 0 : 1, checkedAt: 100, skipFullWindow: false,
};
const api = { call: async (op: string) => {
  if (op !== 'setup.health') throw Error(`unexpected ${op}`);
  return report;
} } as unknown as BrowserApi;

render(<SetupHealthGate api={api} connected enabled onReady={summary => {
  document.body.dataset.ready = summary?.outcome ?? 'none';
}} />, document.getElementById('root')!);
