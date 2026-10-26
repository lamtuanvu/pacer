import type { TargetedKeyboardEvent } from 'preact';
import type { RunnerRow } from '../../../../src/core/runners';
import type { ProviderStatus } from '../../../../src/engine/rank';
import type { TaskDetail } from '../../../../src/core/task-detail';
import { agentInfo, runnerAgent } from '../../../../src/view-model/agents';
import { executorStatus, paceStatus, taskStatus } from '../../../../src/view-model/words';
import { AgentMark } from '../../ds/AgentMark';
import { Button } from '../../ds/Button';
import { Pill } from '../../ds/Pill';
import { Checkbox, Disclosure, Radio } from '../../ds/Controls';
import { StatusGlyph } from '../../ds/StatusGlyph';
import { SectionHeading } from '../../ds/SectionHeading';
import { needsReview } from '../../model/tasks';
import type { AgentPreview } from './model';

export function setupAgentName(id: string): string {
  const [agent, account] = id.split('@')[0]!.split('#');
  const name = agentInfo(agent!).name;
  return account ? `${name} with ${account === 'ollama' ? 'Ollama' : agentInfo(account).name}` : name;
}
export function PlannerChoices({ options, selected, select, signedIn = [] }: {
  options: string[]; selected: string; select: (id: string) => void; signedIn?: string[];
}) {
  return <fieldset className="pc-setup-choices"><legend className="sr-only">Planner</legend>
    {options.map(id => <label className="pc-setup-choice" key={id}>
      <Radio name="planner" value={id} checked={id === selected} onChange={() => select(id)} />
      <AgentMark agent={runnerAgent(id)} size={36} labelled={false} />
      <span><strong>{setupAgentName(id)}</strong><span className="muted">{signedIn.includes(id) ? 'Installed · signed in' : 'Installed'}</span></span>
    </label>)}
  </fieldset>;
}
function scrollPreviewOnArrow(event: TargetedKeyboardEvent<HTMLPreElement>) {
  if ((event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const region = event.currentTarget;
  if (region.scrollWidth <= region.clientWidth) return;
  event.preventDefault();
  const step = Math.max(40, Math.floor(region.clientWidth / 3));
  region.scrollLeft += event.key === 'ArrowRight' ? step : -step;
}

export function ConnectChanges({ planner, preview }: { planner: string; preview: AgentPreview }) {
  const has = (pattern: RegExp) => preview.files.some(path => pattern.test(path));
  const additions = [has(/skills\//) && 'A pacer skill', has(/rules\//) && 'a short delegation rule'].filter(Boolean).join(' and ');
  const settings = has(/settings\.json|hooks\.json/);
  return <section className="pc-setup-card">
    <SectionHeading>What changes in {setupAgentName(planner)}</SectionHeading>
    <dl className="pc-setup-changes">
      <dt>Adds</dt><dd>{additions ? `${additions}, so your planner knows when to delegate.` : 'Delegation instructions for your planner.'}</dd>
      <dt>Edits</dt><dd>{settings ? 'Settings: budget checks when sessions start and before work is delegated.' : 'Planner instructions: how to read budgets and delegate focused work.'}
        {typeof preview.detail === 'string' && preview.detail.includes('left alone') && ' Your status line stays as it is.'}</dd>
    </dl>
    <Disclosure summary="Show the files">
      <pre className="pc-code-scroll" tabIndex={0} onKeyDown={scrollPreviewOnArrow}>{preview.files.join('\n')}</pre>
      {preview.detail && <pre className="pc-code-scroll" tabIndex={0} onKeyDown={scrollPreviewOnArrow}>{typeof preview.detail === 'string' ? preview.detail : JSON.stringify(preview.detail, null, 2)}</pre>}
      <p>To undo</p><pre className="pc-code-scroll" tabIndex={0} onKeyDown={scrollPreviewOnArrow}>{preview.undo}</pre>
    </Disclosure>
  </section>;
}
export function budgetLine(provider?: ProviderStatus) {
  if (provider?.usage === 'unmetered') return 'No subscription budget';
  const used = provider?.binding?.usedPct;
  return used == null ? 'No usage reading yet' : `${Math.round(used)}% of budget used · ${paceStatus(provider!.verdict).label.toLowerCase()}`;
}
export function ExecutorList({ runners, providers, busy, change, reorder }: {
  runners: RunnerRow[]; providers: ProviderStatus[]; busy: boolean;
  change: (id: string, enabled: boolean) => unknown; reorder: (ids: string[]) => unknown;
}) {
  const move = (index: number, offset: number) => {
    const ids = runners.map(row => row.id);
    [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
    return reorder(ids);
  };
  return <ol className="pc-setup-executors" aria-label="Executor priority">{runners.map((row, index) => {
    const name = setupAgentName(row.id);
    const status = executorStatus(row.state === 'ok' ? 'ready' : row.state === 'broken' ? 'down' : row.state);
    return <li key={row.id}>
      <span className="muted">{index + 1}</span><AgentMark agent={runnerAgent(row.id)} size={32} labelled={false} />
      <div className="pc-setup-executor-name"><strong>{name}</strong><span className="muted">{budgetLine(providers.find(p => p.id === row.id))}</span></div>
      <Pill tone={status.tone}><StatusGlyph status={status} /> {status.label}</Pill>
      <Checkbox label={<>Use {name}</>} aria-label={`Use ${name}`} checked={row.state !== 'blocked'} disabled={busy} onChange={e => change(row.id, e.currentTarget.checked)} />
      <div className="pc-setup-move">
        {index > 0 && <Button variant="ghost" aria-label={`Move ${name} up`} disabled={busy} onClick={() => move(index, -1)}>↑</Button>}
        {index < runners.length - 1 && <Button variant="ghost" aria-label={`Move ${name} down`} disabled={busy} onClick={() => move(index, 1)}>↓</Button>}
      </div>
    </li>;
  })}</ol>;
}
export function FirstTaskReview({ task, diff, busy, review }: {
  task: TaskDetail; diff?: string; busy: boolean; review: (verdict: 'accept' | 'reject') => unknown;
}) {
  const status = taskStatus(task), executor = task.executor;
  return <div className="pc-setup-first">
    {executor && <div className="pc-setup-picked"><AgentMark agent={runnerAgent(executor)} size={32} labelled={false} /><div><strong>Picked {setupAgentName(executor)}</strong><p className="muted">Chosen from your executor order with budget available for this task.</p></div></div>}
    <p role="status"><StatusGlyph status={status} /> {status.label}</p>
    {needsReview(task) && <>
      <SectionHeading>Review the result</SectionHeading>
      {diff === undefined ? <p role="status">Loading changes…</p> : <pre className="pc-setup-diff">{diff || 'No file changes.'}</pre>}
      <div className="pc-setup-actions"><Button variant="primary" disabled={busy || diff === undefined} onClick={() => review('accept')}>Accept and finish</Button><Button disabled={busy} onClick={() => review('reject')}>Reject</Button></div>
      <p className="muted">Either choice finishes setup.</p>
    </>}
    {task.review && <p>First task reviewed. Setup is finished.</p>}
  </div>;
}
