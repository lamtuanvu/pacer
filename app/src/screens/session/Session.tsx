import { Tabs, LoadingState, EmptyState } from '../../ds/Patterns';
import { Disclosure, Field } from '../../ds/Controls';
import { ChoicePicker } from '../../ds/ChoicePicker';
import { Dialog } from '../../ds/Dialog';
import { Prose } from '../../ds/Prose';
import { branchCopy } from '../../../../src/view-model/copy';
import { SectionHeading } from '../../ds/SectionHeading';
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { AgentMark } from '../../ds/AgentMark';
import { Button, IconButton } from '../../ds/Button';
import { FrameSlot } from '../../shell/slots';
import type { SessionSlots } from './Conversation';
import { Page, Stack } from '../../ds/Page';
import { AppButtonLink, AppLink } from '../../navigation';
import { routes } from '../../router';
import { StatusPill } from '../../ds/StatusPill';
import { LinkedTerminal } from './LinkedTerminal';
import { PlainLog } from './PlainLog';
import { sessionStatus, phaseWords, taskStatus, taskOutcome } from '../../../../src/view-model/words';
import type { Resource, SessionData, SessionActions, Action } from './types';
export type { SessionData, SessionActions, Resource } from './types';
export type SessionTab = 'terminal' | 'changes' | 'brief';
export interface SessionProps extends SessionActions {
  embedded?: boolean; data?: SessionData | null; loading?: boolean; error?: string | null; initialTab?: SessionTab; view?:SessionTab;
  onReload?: () => void; onTakeover?: () => void; takeoverBusy?: boolean; takeoverStarting?: boolean;
  takeoverError?: string; takeRequested?: boolean; onTakeSent?: () => void;
  /** Embedded in a task's screen: End session goes to the title bar and the activity and actions to the right panel. */
  slots?: SessionSlots;
}
export { ResourceView } from './resource';
import { ResourceView } from './resource';

export function Brief({ data }: { data: SessionData }) {
  return <div className="pc-session-brief">
    {data.briefSections?.length ? data.briefSections.map(section => <section key={section.label}>
      <SectionHeading as="h3">{section.label}</SectionHeading>
      {section.label === 'Repository' || section.label === 'Base'
        ? <code className="pc-session-repository">{section.text}</code>
        : <Prose text={section.text}/>}
    </section>) : <ResourceView value={data.brief} loading="Loading brief…" empty="No brief available.">{text => <Prose text={text}/>}</ResourceView>}
    <section><SectionHeading as="h3">Done when</SectionHeading>
      <ResourceView value={data.doneWhen} loading="Loading done-when command…" empty="No done-when command.">{text => <>
        <div className="pc-session-command"><code>{text}</code></div>
        <p className="pc-session-muted">pacer runs this after the executor exits and records the checks with the result.</p>
      </>}</ResourceView>
    </section>
    {!!data.briefSections?.length && data.brief?.data && <Disclosure className="pc-disclosure" summary="Original brief">
      <pre tabIndex={0} aria-label="Original brief">{data.brief.data}</pre>
    </Disclosure>}
  </div>;
}

export function Session({ embedded = false, data, loading, error, initialTab, view, onAction, onAttach, onReload, onTakeover,
  takeoverBusy, takeoverStarting, takeoverError, takeRequested, onTakeSent, slots, onReadFile }: SessionProps) {
  const [chosenTab, setTab] = useState<SessionTab | undefined>(initialTab);
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const [retryOpen, setRetryOpen] = useState(false);
  const run = async (action: Action) => {
    if (!onAction || busy) return;
    setBusy(true); setActionError('');
    try { await onAction(action); setRetryOpen(false); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const attach = async (target: 'orca' | 'terminal') => {
    if (!data || busy) return;
    setBusy(true); setActionError('');
    try {
      if (onAttach) {
        const result = await onAttach(data.id, target);
        if (result && !result.opened) setNotice(result.command ?? `pacer attach ${data.id}`);
      } else if (onAction) await onAction({ label: target === 'orca' ? 'Open in Orca terminal' : 'Open in my terminal', op: 'task.attach', params: { id: data.id, target } });
    } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  if (error) return <section className="pc-session" role="alert"><p>{error}</p>{onReload && <Button onClick={onReload}>Try again</Button>}</section>;
  if (!data) return <section className="pc-session" role="status">{loading ? 'Loading session…' : 'Session not found.'}</section>;
  const session = data.session, status = taskStatus(data);
  const canAttach = (target: 'orca' | 'terminal') => !!session?.targets.includes(target) && !!(onAttach || onAction) && !busy;
  const active = ['running', 'queued', 'needs_input'].includes(data.state);
  const tab = view ?? chosenTab ?? (active ? 'terminal' : 'brief');
  const waitingForReview = !!data.reviewRequest && ['done', 'partial'].includes(data.state) && !data.review && !data.resolved && !data.dismissed && !data.retriedBy;
  const driving = active && (!!session?.driving || data.phase === 'driving');
  const headless = session?.host === 'none';
  const takeover = active && !driving && session ? <span className="pc-control-with-reason">
    <Button variant={headless ? 'primary' : 'secondary'} disabled={takeoverBusy || !session.takeover.available || !onTakeover}
      title={!session.takeover.available ? session.takeover.reason : undefined}
      aria-describedby={!session.takeover.available ? `takeover-${data.id}-reason` : undefined} onClick={onTakeover}>Take over</Button>
    {!session.takeover.available && <span id={`takeover-${data.id}-reason`} className="pc-session-muted">{session.takeover.reason ?? 'Live takeover is unavailable for this session.'}</span>}
  </span> : null;
  const retries = data.retryOptions ?? [];
  const retry = retries.find(item => item.id === selected) ?? retries.find(item => item.available);
  const terminal = <Stack>
    {data.report && <section className="pc-session-report" aria-label="Executor report">
      <SectionHeading as="h3">Executor report</SectionHeading><Prose text={data.report}/>
    </section>}
    {data.sessionError ? <p role="alert">{data.sessionError}</p>
      : data.sessionLoading ? <LoadingState label="Loading session…"/>
      : !session ? <EmptyState title="Session unavailable."/>
      : session.host === 'orca' ? <div className="pc-session-empty"><p>This session runs in Orca</p><Button disabled={!canAttach('orca')} onClick={() => void attach('orca')}>Open in Orca</Button></div>
      : headless ? <div className="pc-session-log pc-stack pc-stack--normal">
        {active && <div className="pc-session-run"><p>This run is headless — Take over to work in it live</p>{takeover}</div>}
        {data.log ? <ResourceView value={data.log} loading="Loading output…" empty="Waiting for output…">{text =>
          <Disclosure className="pc-disclosure" summary="Technical session output"><pre role="log" tabIndex={0} aria-label="Session output" className="pc-session-follow-log">{text}</pre></Disclosure>
        }</ResourceView> : <PlainLog key={data.id} id={data.id}/>}
      </div> : <LinkedTerminal key={data.id} id={data.id} attempt={session.attempt ?? null} readFile={onReadFile} workspace={data.branch ?? data.repo} agent={data.agent} url={session.attach.ws} cols={session.cols} rows={session.rows}
        control={active && session.capabilities.control} resize={active && session.capabilities.resize} live={active && session.live}
        controller={session.controller} driving={driving} takeRequested={active && takeRequested} onTakeSent={onTakeSent} takeover={takeover}/>}
  </Stack>;
  const aside = <>
      <section><SectionHeading as="h3">Activity</SectionHeading>
        <ResourceView value={data.timeline} loading="Loading timeline…" empty="No timeline events yet.">{events => <>
          <ol className="pc-session-timeline">{events.map((event, index) => <li key={index}><time>{event.at}</time><span>{event.text}</span></li>)}</ol>
          {events.some(event => event.raw) && <Disclosure className="pc-disclosure" summary="Technical event details">
            {events.filter(event => event.raw).map((event, index) => <div key={index}><time>{event.at}</time><pre tabIndex={0}>{event.raw}</pre></div>)}
          </Disclosure>}
        </>}</ResourceView>
      </section>
      {!embedded && session && session.host !== 'none' && <section><SectionHeading as="h3">Session access</SectionHeading>
        {session.targets.includes('orca') && <Button disabled={!canAttach('orca')} onClick={() => void attach('orca')}>Open in Orca terminal</Button>}
        {!slots && session.targets.includes('terminal') && <Button onClick={() => setTab('terminal')}>View in Pacer</Button>}
        <div className="pc-session-copy"><code className="pc-code-scroll" tabIndex={0}>{session.attach.cli}</code>
          <Button size="sm" onClick={() => { void navigator.clipboard.writeText(session.attach.cli).then(() => setNotice('Attach command copied.')).catch(() => setActionError('Could not copy. Select the command and copy it.')); }}>Copy</Button>
        </div>
        <p className="pc-session-muted">Any terminal, tmux or SSH session works. Everyone sees the same stream.</p>
      </section>}
      <section className="pc-session-retry">
        {data.retryLoading ? <LoadingState label="Loading retry options…"/>
          : data.retryError ? <p role="alert">{data.retryError}</p>
          : retries.length ? <>
            <Button disabled={busy || !onAction} onClick={() => { setActionError(''); setRetryOpen(true); }}>{active ? 'Stop and retry…' : 'Retry session…'}</Button>
            {!onAction && <p className="pc-session-muted">Retry actions are unavailable in this view.</p>}
          </> : <p className="pc-session-muted">No retry options available.</p>}
      </section>
</>;
  return <Page width="full" embedded={embedded} className="pc-session">
    {!embedded && <nav aria-label="Breadcrumb" className="pc-session-breadcrumb"><AppLink to={routes.tasks()}>Tasks</AppLink></nav>}
    {loading && <LoadingState updating label="Updating session…"/>}
    {slots && <><FrameSlot name="title">{slots.title(null)}</FrameSlot><FrameSlot name="actions">{active && data.stop && onAction && <IconButton size="sm" variant="quiet" tone="bad" icon="end-session"
      aria-label="End session" title="End session (asks to confirm)" onClick={() => void run(data.stop!)}/>}</FrameSlot></>}
    {(!embedded || (!slots && active && data.stop)) && <header className="pc-session-header">
      {!embedded && <AgentMark agent={data.agent} size={28}/>}
      {!embedded && <div className="pc-session-heading">
        <div className="pc-session-identity"><span>{data.executor ?? 'Executor unknown'}</span><span>{data.repo}</span></div>
        <h2 className="pc-session-title" title={data.title ?? data.goal}>{data.title ?? data.goal}</h2>
        <div className="pc-session-meta"><span>{data.machine ?? session?.machine ?? 'Local machine'}</span>
          <span>{data.started ? `started ${data.started}` : 'Start time unknown'}</span>
          {data.elapsed && <span>{data.elapsed}</span>}
        </div>
        <code className="pc-session-branch pc-code-scroll" tabIndex={0}>{branchCopy(data.branch)}</code>
      </div>
      }<div className="pc-session-header-actions">
        {!embedded && !active && taskOutcome(data).label !== status.label && <span className="pc-session-muted">{taskOutcome(data).label}</span>}
        {!embedded && <StatusPill status={data.state === 'running' && driving ? sessionStatus('driving') : status}/>}
        {!embedded && waitingForReview && <AppButtonLink variant="primary" size="md" to={routes.task(data.id)}>Review</AppButtonLink>}
        {active && data.stop && <Button variant="danger" disabled={busy || !onAction} onClick={() => void run(data.stop!)}>{data.stop.label}</Button>}
      </div>
    </header>}
    {driving && <p>{phaseWords('driving')} · keystrokes go to the agent</p>}
    {active && takeoverStarting && <p role="status">Starting interactive session…</p>}
    {active && takeoverError && <p role="alert">{takeoverError} <Button disabled={takeoverBusy} onClick={onTakeover}>Try again</Button></p>}
    {actionError && !retryOpen && <p role="alert">{actionError}</p>}
    <div className="pc-session-notice" role="status" aria-live="polite">{notice}</div>
    <div className="pc-session-layout"><div className="pc-session-main">
      {!view&&<Tabs label="Session views" id={`session-${data.id}`} value={tab} options={[
        { value: 'brief', label: 'Brief' }, { value: 'terminal', label: 'Output' }, { value: 'changes', label: 'Changes' },
      ]} onChange={value => setTab(value as SessionTab)}/>}
      <div role={view?undefined:'tabpanel'} id={`session-${data.id}-${tab}-panel`} aria-labelledby={view?undefined:`session-${data.id}-${tab}-tab`} tabIndex={view?undefined:0} className="pc-session-panel">
        {tab === 'terminal' ? <>{terminal}{session?.host === 'orca' && takeover}</>
          : tab === 'changes' ? <div className="pc-session-changes">
            {data.changesSummary && <p className="pc-session-muted">{data.changesSummary}</p>}
            <ResourceView value={data.changes} loading="Loading changes…" empty="No changes so far.">{text => <pre tabIndex={0} aria-label="Changes">{text}</pre>}</ResourceView>
          </div> : <Brief data={data}/>}
      </div>
    </div>{slots ? <FrameSlot name="right">{slots.panel(<div className="pc-session-detail-group">{aside}</div>)}</FrameSlot>
      : <aside className="pc-session-aside" aria-label="Session activity and actions">{aside}</aside>}</div>
    {retryOpen && <Dialog title={active ? 'Stop and retry session' : 'Retry session'} close={() => setRetryOpen(false)}>
      <div className="pc-form">
        <p>{active ? 'The current run will stop before a new attempt starts.' : 'Start a new attempt with an available executor.'}</p>
        <Field label="Retry on"><ChoicePicker id={`session-${data.id}-retry`} value={retry?.id ?? ''} onValueChange={setSelected} disabled={busy}
          placeholder="No available executor" searchable options={retries.map(option => ({ value: option.id, label: option.label, disabled: !option.available, reason: option.reason }))} /></Field>
        {!retry && <p className="pc-session-muted">No executor is available. Try again when a slot is free.</p>}
        {actionError && <p role="alert">{actionError}</p>}
        <div className="row-actions"><Button onClick={() => setRetryOpen(false)}>Cancel</Button>
          {retry && <Button variant="primary" busy={busy} disabled={!retry.available || !onAction} onClick={() => void run(retry.action)}>{active ? 'Stop and retry' : 'Retry'}</Button>}
        </div>
      </div>
    </Dialog>}
  </Page>;
}
export default Session;
