import type { SetupChecklist, SetupItem } from '../../../../src/setup/checklist';
import type { BrowserApi } from '../../data/api';
export interface AgentPreview { files: string[]; detail?: unknown; undo: string }
export const SERVICE_CONSENT = 'Run pacer in the background at login? It keeps budgets fresh and runs delegated tasks.';
export const primaryItem = (check: SetupChecklist) => check.complete ? undefined : check.items.find(i => i.required && i.status !== 'done')?.id;
export const nextOptional = (check?: SetupChecklist) => check?.complete && !check.ready ? check.items.find(i => !i.required && i.status === 'pending') : undefined;
export const bannerKey = (check?: SetupChecklist) => nextOptional(check) ? JSON.stringify(check!.items.filter(i => !i.required && i.status === 'pending').map(i => i.id)) : null;
export const DISMISS_KEY = 'pacer.setup.dismissed';
export function readDismissal(): string | null { try { return localStorage.getItem(DISMISS_KEY); } catch { return null; } }
export function saveDismissal(key: string): void { try { localStorage.setItem(DISMISS_KEY, key); } catch { /* dismissal still lasts for this view */ } }
export async function performSetupAction(item: SetupItem, deps: {
  api: BrowserApi; confirm: (message: string, preview?: AgentPreview) => Promise<boolean>;
  refresh: () => void; navigate: (href: string) => void; running: (id: string, executor: string) => void;
}, skip = false): Promise<void> {
  try {
    if (skip) { await deps.api.call('onboarding.skip', {}); return; }
    switch (item.action) {
      case 'service.install':
        if (await deps.confirm(SERVICE_CONSENT)) await deps.api.call('service.install', { consent: true });
        break;
      case 'agent.connect': {
        const preview = await deps.api.call<AgentPreview>('agent.preview', { agent: item.agent });
        if (await deps.confirm('Connect this agent to pacer?', preview)) await deps.api.call('agent.connect', { agent: item.agent, consent: true });
        break;
      }
      case 'nav:add-executor': deps.navigate('#/settings/add-executor'); break;
      case 'onboarding.try': {
        const result = await deps.api.call<{ task_id: string; executor: string; repo: string }>('onboarding.try', {});
        deps.running(result.task_id, result.executor);
        deps.navigate(`#/sessions/${encodeURIComponent(result.task_id)}`);
        break;
      }
    }
  } finally { deps.refresh(); }
}
