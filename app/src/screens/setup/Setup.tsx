import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import type { SetupChecklist, SetupItem } from '../../../../src/setup/checklist';
import type { AgentDetection } from '../../../../src/install/detection';
import type { RunnerRow } from '../../../../src/core/runners';
import type { Status as RoutingStatus } from '../../../../src/engine/status';
import type { TaskDetail } from '../../../../src/core/task-detail';
import { runnerAgent } from '../../../../src/view-model/agents';
import { Button } from '../../ds/Button';
import { AgentMark } from '../../ds/AgentMark';
import { StatusGlyph } from '../../ds/StatusGlyph';
import type { Account } from '../../model/accounts';
import { needsReview } from '../../model/tasks';
import type { RouteQuery } from '../../router';
import { ErrorMessage, useQuery, useTaskContext } from '../task-shared';
import { SetupContext } from './context';
import { createPlannerAutoInit, plannerOptions, nextSetupStep, signedOutRunners, setupRunners, type SetupConfig, completeRunnerOrder, SETUP_STEPS, SERVICE_CONSENT, changeExecutor, reviewFirstTask, type SetupStep, type AgentPreview } from './model';
import { PlannerChoices, ConnectChanges, ExecutorList, FirstTaskReview, setupAgentName } from './steps';

const autoInitPlanner = createPlannerAutoInit();
const titles = ['Planner', 'Background service', 'Connect your planner', 'Who does the work', 'Try a first task'];

function SetupError({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="status"><p>This step could not finish. Try again.</p><details className="pc-disclosure"><summary>Error details</summary><ErrorMessage error={error} /></details></div>;
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState<unknown>();
  return <details className="pc-disclosure"><summary>Sign-in command</summary><div className="pc-setup-command"><pre><code>{command}</code></pre><Button onClick={async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setError(undefined); }
    catch (error) { setError(error); }
  }}>{copied ? 'Copied' : 'Copy command'}</Button><SetupError error={error} /></div></details>;
}

function FirstRun({ id, run }: { id: string; run: (work: () => Promise<unknown>, advance?: boolean) => Promise<void> }) {
  const { api } = useTaskContext();
  const task = useQuery<TaskDetail>('task.get', { id });
  const diff = useQuery<{ diff: string; truncated?: boolean }>('task.diff', { id });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (task.data && !['running', 'queued'].includes(task.data.state)) return;
    const timer = setInterval(task.reload, 1500);
    return () => clearInterval(timer);
  }, [id, task.data?.state]);
  useEffect(() => { if (task.data && needsReview(task.data)) diff.reload(); }, [task.data?.rev]);
  return <><SetupError error={task.error ?? diff.error} />{task.data
    ? <FirstTaskReview task={task.data} diff={diff.data?.diff} busy={busy} review={async verdict => {
      setBusy(true);
      await run(async () => { await reviewFirstTask(api, task.data!, verdict); task.reload(); }, true);
      setBusy(false);
    }} /> : <p role="status">Following your first task…</p>}
    {diff.data?.truncated && <p className="muted">Showing the first part of the changes.</p>}
  </>;
}

export function SetupView({ checklist: initial }: { checklist: SetupChecklist; query: RouteQuery }) {
  const { api, state } = useTaskContext(), setup = useContext(SetupContext);
  const [checklist, setChecklist] = useState(initial);
  const [current, setCurrent] = useState<SetupStep>(() => nextSetupStep(initial));
  const [visited, setVisited] = useState<string[]>([]);
  const [selected, select] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false), panel = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(setup.running);
  const [preview, setPreview] = useState<AgentPreview>();
  const [previewError, setPreviewError] = useState<unknown>();
  const [revision, reload] = useState(0);
  const [notice, setNotice] = useState('');
  const detected = useQuery<AgentDetection[]>('agent.detect', {});
  const accounts = useQuery<Account[]>('account.list', {}, String(revision));
  const routing = useQuery<RoutingStatus>('routing.status', {}, String(revision));
  const runners = useQuery<RunnerRow[]>('runner.list', {}, String(revision));
  const config = useQuery<SetupConfig>('config.get', {}, String(revision));
  useEffect(() => { setChecklist(initial); }, [initial]);
  useEffect(() => { panel.current?.focus(); setError(undefined); setNotice(''); }, [current]);
  const item = checklist.items.find(i => i.id === current);
  const plannerItem = checklist.items.find(i => i.id === 'planner');
  const planner = typeof config.data?.keys.planner?.value === 'string' ? config.data.keys.planner.value : plannerItem?.detail?.split(' · ')[0] ?? checklist.items.find(i => i.id === 'connect')?.agent ?? '';
  const options = plannerOptions(plannerItem?.options, detected.data?.filter(a => a.found).map(a => a.agent) ?? [], config.data?.planners ?? []);
  const chosen = options.includes(selected) ? selected : options.includes(planner) ? planner : options[0] ?? '';
  const plannerName = planner ? setupAgentName(planner) : 'your planner';
  const signedIn = options.filter(id => accounts.data?.some(a => a.signedIn === true && (id.includes('#') ? a.name === id.split('#')[1] : a.kind === id || id === 'claude-code' && a.kind === 'claude')));

  async function run(work: () => Promise<unknown>, advance = false, skip = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); setNotice('');
    try {
      await work();
      const next = await api.call<SetupChecklist>('setup.check', {});
      setChecklist(next); setup.refresh(); reload(v => v + 1);
      if (advance) {
        const done = [...visited, ...(current === 'executor' || skip ? [current] : [])];
        setVisited(done);
        setCurrent(nextSetupStep(next, current, done));
      }
    } catch (error) { setError(error); setup.refresh(); }
    finally { pending.current = false; setBusy(false); }
  }
  const choosePlanner = (id: string) => run(() => api.call('setup.init', { planner: id }), true);
  useEffect(() => { if (plannerItem) void autoInitPlanner(plannerItem, choosePlanner); }, [plannerItem]);
  useEffect(() => {
    if (current !== 'connect' || !planner) return;
    let active = true; setPreview(undefined); setPreviewError(undefined);
    void api.call<AgentPreview>('agent.preview', { agent: runnerAgent(planner) }).then(value => { if (active) setPreview(value); }, error => { if (active) setPreviewError(error); });
    return () => { active = false; };
  }, [current, planner, revision]);

  const configuredRunners = setupRunners(runners.data ?? [], config.data);
  const executorIds = runners.data ? configuredRunners.map(r => r.id) : undefined;
  const railExecutors = executorIds ?? (checklist.items.find(i => i.id === 'executor')?.status === 'done' ? checklist.items.find(i => i.id === 'executor')!.detail?.split(', ').filter(Boolean) ?? [] : []);
  const count = SETUP_STEPS.filter(id => checklist.items.find(i => i.id === id)?.status === 'done').length;
  const version = (state.version ?? checklist.items.find(i => i.id === 'binary')?.detail ?? '').split(/[+-]/)[0];
  const excluded = signedOutRunners(routing.data?.providers ?? [], planner);
  const visibleRunners = configuredRunners.filter(r => !excluded.some(p => p.id === r.id));
  const step = SETUP_STEPS.indexOf(current);
  const headings = ['Which agent plans your work?', 'Keep pacer running in the background', `Connect ${plannerName}`, 'Who does the work', 'Try a first task'];
  const explanations = [
    'Your planner breaks work down, hands focused tasks to other agents, and reviews what comes back. Pick the one you talk to most.',
    SERVICE_CONSENT,
    `${plannerName} will see your budgets when a session starts, and hand focused tasks to your other agents.`,
    'Tasks go to the first agent with budget to spare, and move down the list when it runs low.',
    'Summarize a short README in a scratch folder, never in your code. Review the result the way your planner will review real work.',
  ];
  function visit(id: SetupStep) { if (!busy) setCurrent(id); }
  return <div className="pc-setup">
    <header className="pc-setup-header"><strong>Set up pacer</strong><span className="muted" role="status">{count} of 5 done{checklist.complete ? ' · pacer is ready' : ''}</span></header>
    <div className="pc-setup-layout">
      <aside className="pc-setup-rail"><ol aria-label="Setup steps">{SETUP_STEPS.map((id, index) => {
        const done = checklist.items.find(i => i.id === id)?.status === 'done';
        return <li key={id} aria-current={id === current ? 'step' : undefined} data-step={id}>
          <span className="pc-setup-number">{done ? <><StatusGlyph status={{ label: 'Done', glyph: '✓', tone: 'good' }} /><span className="sr-only">Done</span></> : index + 1}</span>
          <div><span>{id === 'connect' && planner ? `Connect ${plannerName}` : titles[index]}</span>
            <div className="pc-setup-value muted">{done ? id === 'planner' ? <><AgentMark agent={runnerAgent(planner)} size={16} labelled={false} />{plannerName} · <Button variant="ghost" onClick={() => visit('planner')}>Change</Button></>
              : id === 'service' ? 'Running at login' : id === 'connect' ? 'Connected'
              : id === 'executor' ? <>{railExecutors.map(id => <AgentMark key={id} agent={runnerAgent(id)} size={16} />)}{railExecutors.length} {railExecutors.length === 1 ? 'agent' : 'agents'}</>
              : 'Finished' : id === 'first' ? 'Optional' : visited.includes(id) ? <Button variant="ghost" onClick={() => visit(id)}>Skipped · return</Button> : 'Needs you'}</div>
          </div>
        </li>;
      })}</ol>{version && <p className="muted pc-setup-version">pacer {version}</p>}</aside>
      <section className="pc-setup-panel" ref={panel} tabIndex={-1} aria-label={headings[step]}>
        <div><p className="pc-setup-eyebrow">Step {step + 1} of 5{current === 'first' ? ' · optional' : ''}</p><h1>{headings[step]}</h1><p className="pc-setup-explanation">{explanations[step]}</p></div>
        {current === 'planner' && <>
          {options.length > 0 ? <><PlannerChoices options={options} selected={chosen} select={select} signedIn={signedIn} /><Button variant="primary" disabled={busy} onClick={() => void choosePlanner(chosen)}>Continue with {setupAgentName(chosen)}</Button><p className="muted">Nothing in {setupAgentName(chosen)} changes until step 3.</p></>
            : item?.command && item.action !== 'setup.init' ? <Command command={item.command} /> : <p>Install Claude Code, Codex, Cursor or OpenCode to plan your work.</p>}
          {item?.status !== 'done' && item?.command && item.action !== 'setup.init' && options.length > 0 && <Command command={item.command} />}
        </>}
        {current === 'service' && <Button variant="primary" disabled={busy} onClick={() => void run(() => api.call('service.install', { consent: true }), true)}>Install service</Button>}
        {current === 'connect' && <>
          {preview ? <ConnectChanges planner={planner} preview={preview} /> : <p role="status">{previewError ? 'Could not load the changes.' : 'Checking what will change…'}</p>}
          <div className="pc-setup-actions"><Button variant="primary" disabled={busy || !preview} onClick={() => void run(() => api.call('agent.connect', { agent: runnerAgent(planner), consent: true }), true)}>Connect {plannerName}</Button><Button variant="ghost" disabled={busy} onClick={() => void run(async () => {}, true, true)}>Skip for now</Button></div>
          <SetupError error={previewError} />{previewError && <Button onClick={() => reload(v => v + 1)}>Retry preview</Button>}
          <p className="muted">After you connect, this window stays open and moves to the next step. Restart any open {plannerName} sessions to pick up the change.</p>
        </>}
        {current === 'executor' && <>
          <ExecutorList runners={visibleRunners} providers={routing.data?.providers ?? []} busy={busy} change={(id, enabled) => run(() => changeExecutor(api, id, enabled))} reorder={ids => run(() => api.call('runner.reorder', { ids: completeRunnerOrder(configuredRunners, ids) }))} />
          {excluded.map(p => {
            const account = accounts.data?.find(a => a.name === p.account);
            return <p key={p.id} className="muted">Not listed: {setupAgentName(p.id)} is installed but signed out.{account?.signin_command && <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.call('account.signin', { name: account.name }))}>Sign in to {setupAgentName(p.id)}</Button>}</p>;
          })}
          <SetupError error={runners.error ?? routing.error ?? config.error} />
          {runners.loading && !runners.data ? <p role="status">Finding your executors…</p> : visibleRunners.length ? <Button variant="primary" disabled={busy} onClick={() => void run(async () => {}, true)}>Looks right</Button>
            : <><p>Add an executor to carry out your tasks. The setup window stays open while you add one in a terminal.</p><Button variant="primary" disabled={busy} onClick={() => void run(async () => { await api.call('runner.add', { interactive: 'runner-add' }); setNotice('Finish adding the executor in the terminal, then check again here.'); })}>Add executor</Button><Button onClick={() => void run(async () => {})}>Check again</Button></>}
        </>}
        {current === 'first' && (running ? <FirstRun id={running.id} run={run} /> : item?.status === 'done' ? <p role="status">Setup is finished. Give your planner a goal when you are ready.</p> : <>
          <div className="pc-setup-actions"><Button variant="primary" disabled={busy || !checklist.complete || !visibleRunners.some(r => r.state === 'ok')} onClick={() => void run(async () => {
            const result = await api.call<{ task_id: string; executor: string }>('onboarding.try', {});
            const value = { id: result.task_id, executor: result.executor };
            setRunning(value); setup.setRunning(value.id, value.executor);
          })}>Try a first task</Button><Button variant="ghost" disabled={busy} onClick={() => void run(() => api.call('onboarding.skip', {}), true)}>Skip for now</Button></div>
          {!checklist.complete && <p className="muted">Finish the required steps first.</p>}
          {checklist.complete && !visibleRunners.some(r => r.state === 'ok') && <p className="muted">An available executor is needed to try a task.</p>}
        </>)}
        {busy && <p role="status">Working…</p>}{notice && <p role="status">{notice}</p>}<SetupError error={error} />
      </section>
    </div>
  </div>;
}
export function Setup({ query }: { query: RouteQuery }) {
  const { checklist } = useContext(SetupContext);
  return checklist ? <SetupView checklist={checklist} query={query} /> : <p role="status">Checking setup…</p>;
}
