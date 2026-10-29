import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ExecutorRow } from '../../../../src/api/read-model/types';
import { executorLabel } from '../../../../src/view-model/words';
import { executorEligibility } from '../../../../src/view-model/capacity';
import { createExecutorDraft, executorSavePayload, isExecutorDraftDirty, matchesExecutorDraft, moveExecutor, validateExecutorDraft, type ExecutorDraft, type ExecutorSettings } from '../../model/executor-settings';
import { useTaskContext, ErrorMessage } from '../task-shared';
import { registerNavigationGuard, canLeaveScreen } from '../../data/navigation-guard';
import { useNotifications } from '../../data/notification-context';
import { Alert } from '../../ds/Alert';
import { Button, ButtonLink, TextAction } from '../../ds/Button';
import { AgentMark } from '../../ds/AgentMark';
import { Field, TextInput, Switch } from '../../ds/Controls';
import { Dialog } from '../../ds/Dialog';
import { StatusPill } from '../../ds/StatusPill';
import { Pill } from '../../ds/Pill';
import { UsageMeter } from '../../ds/UsageMeter';
import { Card, ListRow, NavTabs, PageColumns } from '../../ds/Patterns';
import { SectionHeading } from '../../ds/SectionHeading';
import { Icon } from '../../ds/icons';
import { SettingRow } from '../../ds/SettingRow';
import { useDialogs } from '../../ds/useDialogs';
import { useResource, useOperation, Feedback, SettingsBoard, time, useScoped } from './shared';

export function ExecutorsSection() {
  const scoped = useScoped();
  const [selected, select] = useState<string>();
  const {state, api} = useTaskContext(), query = useResource<ExecutorSettings>('runner.settings.get');
  const notifications = useNotifications(), dialogs = useDialogs();
  const [saved, setSaved] = useState<ExecutorSettings>(), [draft, setDraft] = useState<ExecutorDraft>();
  const [enabledBusy, setEnabledBusy] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [announcement, announce] = useState('');
  const pending = useRef(false), leave = useRef<(value:boolean)=>void>();
  const [leaving, setLeaving] = useState(false);
  const dirty = !!saved && !!draft && isExecutorDraftDirty(draft, saved);
  const errors = draft ? validateExecutorDraft(draft) : {};
  const conflict = dirty && !!saved && !!query.data && saved.revision !== query.data.revision;
  const rows = state.snapshot?.executors;
  const knownRows=useRef(new Map<string,ExecutorRow>()), observed=useRef<ExecutorSettings>();
  if(query.data)observed.current=query.data;
  for(const row of rows??[])knownRows.current.set(row.id,row);
  const current = useRef({dirty,busy,save:async()=>false});
  useEffect(()=>{
    if (query.data && query.data.revision!==saved?.revision && !dirty && !pending.current) { setSaved(query.data); setDraft(createExecutorDraft(query.data)); }
  },[query.data]);
  const reload = () => { if(query.data){setSaved(query.data);setDraft(createExecutorDraft(query.data));setError(undefined);}query.reload(); };
  const edit = (fn:(next:ExecutorDraft)=>void) => {
    if (!draft || busy) return;
    const next = {order:[...draft.order], runners:Object.fromEntries(Object.entries(draft.runners).map(([id,r])=>[id,{...r}]))};
    fn(next);setDraft(next);setError(undefined);
  };
  const save = async ():Promise<boolean> => {
    if(!saved||!draft||!dirty||pending.current||!state.connected||Object.keys(errors).length||conflict)return false;
    pending.current=true;setBusy(true);setError(undefined);
    try {
      let result:ExecutorSettings & {warnings?:string[]};
      try { result=await api.call('runner.settings.save',executorSavePayload(draft,saved)); }
      catch (failure) {
        // A lost response can follow a committed write. Confirm actual values before retrying.
        const observed=await api.call<ExecutorSettings>('runner.settings.get',{}).catch(()=>null);
        if (!observed || observed.revision===saved.revision || !matchesExecutorDraft(draft,observed)) {query.reload();throw failure;}
        result=observed;
        notifications?.notify({key:'executor-save-confirmed',tone:'warning',title:'Saved settings confirmed',message:'The save response was interrupted. Review routing warnings before delegating.'});
      }
      // The response describes our write, not necessarily the latest settings:
      // another client can commit before that response reaches this window.
      const latest=await api.call<ExecutorSettings>('runner.settings.get',{}), event=observed.current;
      const confirmed=event&&event.revision!==saved.revision&&event.revision!==result.revision&&event.revision!==latest.revision?event:latest;
      if(!matchesExecutorDraft(draft,confirmed)){
        query.setData(confirmed);
        throw new Error('Settings changed after this save. Your draft is preserved. Reload saved settings before retrying.');
      }
      setSaved(confirmed);setDraft(createExecutorDraft(confirmed));query.setData(confirmed);
      notifications?.notify({key:'executor-save',tone:'success',title:'Executor settings saved'});
      if(result.warnings?.length)notifications?.notify({key:'executor-save-warnings',tone:'warning',title:'Routing needs attention',message:result.warnings.join(' ')});
      return true;
    } catch(failure){setError(failure);return false;}
    finally {pending.current=false;setBusy(false);}
  };
  // Takes work is an immediate write based exclusively on saved settings.
  const saveEnabled = async (id:string, enabled:boolean) => {
    if (!saved || pending.current || !state.connected) throw new Error('Wait for the service before changing Takes work.');
    pending.current = true;
    setEnabledBusy(true);
    try {
      const latest = await api.call<ExecutorSettings>('runner.settings.get', {});
      if (latest.revision !== saved.revision) {
        query.setData(latest);
        throw new Error('Settings changed elsewhere. Reload saved settings before retrying.');
      }
      const next = createExecutorDraft(latest);
      if (!next.runners[id]) throw new Error('This executor was removed. Reload saved settings.');
      next.runners[id].enabled = enabled;
      let result:ExecutorSettings & {warnings?:string[]};
      try { result = await api.call('runner.settings.save', executorSavePayload(next, latest)); }
      catch (failure) {
        const actual = await api.call<ExecutorSettings>('runner.settings.get', {}).catch(() => null);
        if (!actual || actual.revision === latest.revision || !matchesExecutorDraft(next, actual)) {
          query.reload();
          throw failure;
        }
        result = actual;
      }
      const confirmed = await api.call<ExecutorSettings>('runner.settings.get', {});
      if (!matchesExecutorDraft(next, confirmed)) {
        query.setData(confirmed);
        throw new Error('Settings changed after this save. Reload saved settings before retrying.');
      }
      setSaved(confirmed);
      // Preserve order and task-limit edits made in the page draft.
      setDraft(current => current ? {...current, runners:{...current.runners, [id]:{...current.runners[id], enabled}}} : createExecutorDraft(confirmed));
      query.setData(confirmed);
      if (!notifications) announce('Executor settings saved');
      notifications?.notify({key:'executor-save', tone:'success', title:'Executor settings saved'});
      if (result.warnings?.length) notifications?.notify({key:'executor-save-warnings', tone:'warning', title:'Routing needs attention', message:result.warnings.join(' ')});
    } finally {
      pending.current = false;
      setEnabledBusy(false);
    }
  };
  current.current={dirty,busy,save};
  useEffect(()=>{
    const unregister=registerNavigationGuard(()=>{
      if(!current.current.dirty)return Promise.resolve(true);
      if(leave.current)return Promise.resolve(false);
      setLeaving(true);return new Promise(resolve=>{leave.current=resolve;});
    });
    const unload=(event:BeforeUnloadEvent)=>{if(current.current.dirty){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',unload);
    return()=>{unregister();window.removeEventListener('beforeunload',unload);leave.current?.(false);};
  },[]);
  const finishLeave=(value:boolean)=>{const resolve=leave.current;leave.current=undefined;setLeaving(false);resolve?.(value);};
  const independent = async (action:()=>void|Promise<void>) => {
    if(dirty && !await canLeaveScreen())return;
    await action();
  };
  const ordered = rows ? [ ...rows.filter(r=>r.rank==='planner'&&!draft?.order.includes(r.id)), ...(draft?.order ?? rows.filter(r=>r.rank!=='planner').map(r=>r.id)).map(id=>rows.find(r=>r.id===id)??knownRows.current.get(id)).filter((r):r is ExecutorRow=>!!r)] : [];
  const picked = ordered.find(e=>e.id===selected), pickedAt = picked ? draft?.order.indexOf(picked.id) ?? -1 : -1;
  return <SettingsBoard id="executors" title="Agents" caption="Who plans, who executes, and what each one is allowed to use." actions={<ButtonLink variant="primary" href={scoped("#/settings/add-executor")}>Add agent</ButtonLink>}>
    {dialogs.dialog}
    {leaving&&<Dialog title="Unsaved executor changes" close={()=>finishLeave(false)}><p>Save your executor settings before leaving?</p><div className="u3-actions"><Button disabled={busy} onClick={()=>finishLeave(false)}>Stay</Button><Button disabled={busy} onClick={()=>{reload();finishLeave(true);}}>Discard changes</Button><Button variant="primary" busy={busy} disabled={!state.connected||!!conflict||Object.keys(errors).length>0} onClick={async()=>{if(await current.current.save())finishLeave(true);}}>Save and leave</Button></div><ErrorMessage error={error}/></Dialog>}
    <AgentsIntro tab="executors"/>
    <ErrorMessage error={query.error}/><ErrorMessage error={error}/>
    {conflict&&<Alert tone="warning" title="Settings changed elsewhere">Your draft is preserved. Reload the saved settings before making further changes. <Button size="sm" onClick={async()=>{if(await dialogs.confirm('Discard this draft and load the latest saved settings?','Reload saved settings','Reload'))reload();}}>Reload saved settings</Button></Alert>}
    <PageColumns layout="agents" className="u3-agents" main={!rows?<p>Loading executors…</p>:!rows.some(r=>r.rank!=='planner'||draft?.order.includes(r.id))?<p>No executors yet. Add an agent.</p>:<div className="u3-table-wrap u3-agents-table"><div className="u3-agents-scroll"><table><thead><tr>{['Priority','Executor','Status','This week','Parallel tasks','Details'].map(v=><th key={v} scope="col">{v}</th>)}</tr></thead><tbody>{ordered.filter(e=>draft?!!draft.order.includes(e.id):e.rank!=='planner').map(executor=><ExecutorRowEditor key={executor.id} executor={executor} selected={executor.id===selected} select={()=>select(id=>id===executor.id?undefined:executor.id)} removed={!rows!.some(r=>r.id===executor.id)} position={draft?.order.indexOf(executor.id)??rows!.filter(r=>r.rank!=='planner').findIndex(r=>r.id===executor.id)} count={draft?.order.length??0} value={draft?.runners[executor.id]} error={errors[executor.id]} disabled={busy||enabledBusy||!draft} edit={edit} announce={announce}/>)}</tbody></table></div></div>}
      aside={picked&&<ExecutorDetail key={picked.id} executor={picked} planner={pickedAt<0} saveEnabled={saveEnabled} savedEnabled={saved?.runners.find(r=>r.id===picked.id)?.enabled} value={draft?.runners[picked.id]} error={errors[picked.id]} disabled={busy||enabledBusy||!draft} edit={edit} independent={independent} close={()=>select(undefined)}/>}/>
    {!!(dirty||busy||error)&&<div className="u3-save-bar"><span>{busy?'Saving changes…':dirty?'Unsaved changes':'Changes could not be saved'}</span><div className="u3-actions"><Button disabled={!dirty||busy} onClick={reload}>Discard</Button><Button variant="primary" busy={busy} disabled={!dirty||enabledBusy||!state.connected||!!conflict||Object.keys(errors).length>0} onClick={()=>void save()}>Save changes</Button></div></div>}
    {Object.keys(errors).length>0&&<Alert tone="error" title="Check parallel task limits">Enter a whole number from 1 to 16 for each executor.</Alert>}
    {!state.connected&&<Alert tone="warning" title="Reconnecting">Your edits are preserved. Save will be available when the service reconnects.</Alert>}
    <p className="u3-muted">Priority applies under the Priority policy, within the <TextAction href={scoped("#/settings/dispatcher")}>Dispatcher</TextAction> rules. Saved changes apply on the next routing decision. Unavailable executors are skipped; warning states may still receive work.</p>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
  </SettingsBoard>;
}
/** The planner and the Executors and Accounts tabs, shared by both tabs of the Agents page. */
export function AgentsIntro({tab}:{tab:'executors'|'accounts'}) {
  const scoped = useScoped();
  const {state}=useTaskContext(), planner=state.snapshot?.planner, executors=state.snapshot?.executors?.filter(e=>e.rank!=='planner').length, accounts=state.snapshot?.accounts?.length;
  return <>{tab==='executors'&&planner&&<ListRow outlined layout="planner" aria-label="Planner" leading={<AgentMark agent={planner.agent} size={32}/>} content={<><strong>{executorLabel(planner.runner)}</strong> <Pill tone="info">Planner</Pill><div className="u3-muted">{planner.advice}</div></>} actions={<ButtonLink size="sm" href={scoped("#/settings/planner")}>Change planner</ButtonLink>}/>}
    <NavTabs label="Agent view" items={[{href:scoped('#/settings/executors'),label:`Executors${executors===undefined?'':` · ${executors}`}`,current:tab==='executors'},{href:scoped('#/settings/accounts'),label:`Accounts${accounts===undefined?'':` · ${accounts}`}`,current:tab==='accounts'}]}/></>;
}
function ExecutorRowEditor({executor,selected,select,removed,position,count,value,error,disabled,edit,announce}:{executor:ExecutorRow;selected:boolean;select:()=>void;removed:boolean;position:number;count:number;value?:{enabled:boolean;maxTasks:string};error?:string;disabled:boolean;edit:(fn:(draft:ExecutorDraft)=>void)=>void;announce:(text:string)=>void}) {
  const {state}=useTaskContext();
  const planner=position<0, name=executorLabel(executor.id), readiness=executorEligibility(executor,state.snapshot?.at??Date.now()/1000);
  const up=useRef<HTMLButtonElement>(null), down=useRef<HTMLButtonElement>(null), moved=useRef<number>();
  useLayoutEffect(()=>{
    if(moved.current===undefined)return;
    const target=moved.current<0?(position>0?up:down):(position<count-1?down:up);
    target.current?.focus();moved.current=undefined;
  },[position]);
  const move=(by:number)=>{moved.current=by;edit(d=>moveExecutor(d,executor.id,by));announce(`${name} moved to priority ${position+by+1}.`);};
  return <tr className={[selected&&'u3-row--selected',(executor.state==='failing'||readiness.tone==='bad')&&'u3-row--bad'].filter(Boolean).join(' ')}><td data-label="Priority">{planner?'Planner':<div className="u3-executor-order"><span>{position+1}</span><Button ref={up} size="sm" aria-label={`Move ${name} up`} title={position===0?'Already first in priority':'Move up'} disabled={disabled||position<=0} onClick={()=>move(-1)}>↑</Button><Button ref={down} size="sm" aria-label={`Move ${name} down`} title={position===count-1?'Already last in priority':'Move down'} disabled={disabled||position===count-1} onClick={()=>move(1)}>↓</Button></div>}</td>
    <td data-label="Executor"><div className="u3-agent"><AgentMark agent={executor.agent} size={24} labelled={false}/><div><strong>{name}</strong>{!(value?.enabled??executor.enabled)&&<span className="u3-muted"> · off</span>}<span className="u3-executor-model" title={executor.model??'Agent default'}>{executor.model??'Agent default'}</span>{removed&&<Alert tone="warning" title="Removed elsewhere" announce={false}>This executor is no longer configured. Your unsaved edits are retained until you reload.</Alert>}</div></div></td>
    <td data-label="Status"><StatusPill status={readiness}/><div className="u3-muted">{[readiness.detail,readiness.age].filter(Boolean).join(' · ')}</div></td>
    <td data-label="This week">{executor.usedPct==null?<span className="u3-muted">No usage reported</span>:<UsageMeter used={executor.usedPct} pace={executor.pacePct??null} tone={executor.tone==='muted'?'neutral':executor.tone} size="slim" text="compact" label={`${name} usage`} paceReason={executor.paceReason} stale={executor.stale}/>}</td>
    <td data-label="Parallel tasks"><strong>{value?.maxTasks??executor.slots.max}</strong>{state.snapshot?.machine?.max!==undefined&&<span className="u3-muted"> of {state.snapshot.machine.max}</span>}</td>
    <td data-label="Details"><Button size="sm" variant="quiet" aria-pressed={selected} data-details={executor.id} onClick={select}>Details<span className="sr-only"> for {name}</span></Button></td></tr>;
}
/** One executor's state and immediate Takes work switch; task limits join the page draft. */
function ExecutorDetail({executor,planner,value,error,disabled,edit,independent,close,saveEnabled,savedEnabled}:{executor:ExecutorRow;planner:boolean;saveEnabled:(id:string,enabled:boolean)=>Promise<void>;savedEnabled?:boolean;value?:{enabled:boolean;maxTasks:string};error?:string;disabled:boolean;edit:(fn:(draft:ExecutorDraft)=>void)=>void;independent:(action:()=>void|Promise<void>)=>Promise<void>;close:()=>void}) {
  const scoped = useScoped();
  const {state}=useTaskContext(), action=useOperation(), dialogs=useDialogs(), name=executorLabel(executor.id), panel=useRef<HTMLDivElement>(null);
  // Opening moves focus into the panel (it sits below the table on narrow screens); closing returns it to the row's button.
  useLayoutEffect(()=>{panel.current?.focus();panel.current?.scrollIntoView?.({block:'nearest'});},[]);
  const closePanel=()=>{close();queueMicrotask(()=>document.querySelector<HTMLElement>(`[data-details="${CSS.escape(executor.id)}"]`)?.focus());};
  useLayoutEffect(() => {
    const escape = (event:KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
        event.preventDefault(); closePanel();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const [switchBusy, setSwitchBusy] = useState(false), [switchError, setSwitchError] = useState<unknown>(), [optimistic, setOptimistic] = useState<boolean>();
  const switching = useRef(false);
  const toggle = async (enabled:boolean) => {
    if (switching.current) return;
    switching.current = true; setSwitchBusy(true); setSwitchError(undefined); setOptimistic(enabled);
    try { await saveEnabled(executor.id, enabled); }
    catch (failure) { setSwitchError(failure); }
    finally { switching.current = false; setSwitchBusy(false); setOptimistic(undefined); }
  };
  const readiness=executorEligibility(executor,state.snapshot?.at??Date.now()/1000);
  const blocked=executor.state==='blocked'||executor.eligibility?.reasons.some(r=>r.code==='blocked'), signIn=readiness.detail.includes('Sign-in');
  return <div role="region" aria-label={`${name} details`} tabIndex={-1} ref={panel} className="u3-agent-detail">
    {dialogs.dialog}
    <div className="u3-agent"><AgentMark agent={executor.agent} size={32}/><div><SectionHeading as="h3" variant="headline">{name}</SectionHeading><code>{executor.id}</code></div><Button size="sm" variant="quiet" aria-label={`Close ${name} details`} onClick={closePanel}><Icon name="close"/></Button></div>
    {(readiness.tone==='bad'||readiness.tone==='warn')&&<Card tone={readiness.tone==='bad'||executor.state==='failing'?'bad':undefined}><strong>{readiness.label}</strong><p className="u3-muted">{readiness.detail}</p>{(blocked||signIn)&&<div className="u3-actions">{blocked&&<Button size="sm" disabled={action.busy||disabled} onClick={()=>void independent(async()=>{await action.run('runner.unblock',{id:executor.id});})}>Unblock {name}</Button>}{signIn&&<TextAction href={scoped("#/settings/accounts")}>Fix sign-in</TextAction>}</div>}</Card>}
    <dl className="u3-agent-facts"><dt>Account</dt><dd>{executor.account}</dd><dt>Model</dt><dd>{executor.model??'Agent default'}</dd><dt>Runs on</dt><dd>{executor.host?<TextAction href={scoped(`#/settings/hosts/${encodeURIComponent(executor.host)}`)}>{executor.host}</TextAction>:'This machine'}</dd></dl>
    {!planner&&<SettingRow layout="stacked" label="Takes work" description="Applies now"><Switch aria-label={`Enable ${executor.id}`} checked={optimistic??savedEnabled??executor.enabled} disabled={disabled||switchBusy||!state.connected} aria-busy={switchBusy} onChange={e=>void toggle(e.currentTarget.checked)}/><ErrorMessage error={switchError}/></SettingRow>}
    {!planner&&<SettingRow layout="stacked" label="Parallel tasks" description={state.snapshot?.machine?.max!==undefined?`This machine's limit is ${state.snapshot.machine.max}.`:'Saved with the page'}><Field label={<span className="sr-only">Parallel tasks for {name}</span>} error={error}><TextInput type="number" min="1" max="16" step="1" required aria-label={`Parallel tasks for ${executor.id}`} value={value?.maxTasks??String(executor.slots.max)} disabled={disabled} onInput={e=>{const text=e.currentTarget.value;edit(d=>{d.runners[executor.id].maxTasks=text;});}}/></Field></SettingRow>}
    <SettingRow layout="stacked" label="Test task" description={executor.lastCheck?`${executor.lastCheck.passed?'Passed':'Failed'} ${time(executor.lastCheck.at)}`:'Not run yet'}><Button size="sm" disabled={action.busy} onClick={()=>void action.run('runner.check',{id:executor.id})}>Run test task<span className="sr-only"> for {name}</span></Button></SettingRow>
    <Feedback action={action}/>
    {!planner&&<footer className="u3-detail-footer"><span className="u3-muted">Removing keeps its task history.</span><Button size="sm" disabled={action.busy||disabled} onClick={()=>void independent(async()=>{if(await dialogs.confirm(`Remove executor ${name}?`,'Remove executor','Remove'))await action.run('runner.remove',{id:executor.id},()=>{close();queueMicrotask(()=>document.querySelector<HTMLElement>('#executors .u3-board-actions a')?.focus());});})}>Remove agent</Button></footer>}
  </div>;
}
