import { useState } from 'preact/hooks';
import type { HostCheck } from '../../../src/remote/hosts';
import { Button } from '../ds/Button';
import { Card } from '../ds/Card';
import { Pill } from '../ds/Pill';
import { useQuery,useAction,useDraft,ErrorMessage } from './task-shared';
type Host={alias:string;ssh:string;running:number;maxTasks:number};
export function Hosts() {
 const query=useQuery<Host[]>('host.list',{}), action=useAction(); const [draft,setDraft]=useDraft('pacer.host.add',{alias:'',ssh:''});
 return <section className="screen"><h1>Hosts</h1><p className="muted">Other machines pacer can run work on, over SSH. Results come back as a branch you review here.</p><ErrorMessage error={query.error}/>{query.data?.map(host=><HostRow key={host.alias} host={host} reload={query.reload}/>)}{query.data?.length===0&&<p>No remote hosts yet. Add an SSH host below.</p>}<Card><h2>Add host</h2><form onSubmit={e=>{e.preventDefault();void action.run('host.add',draft,()=>{setDraft({alias:'',ssh:''});query.reload();});}}><div className="form-row"><label className="field">Alias<input required value={draft.alias} onInput={e=>setDraft({...draft,alias:e.currentTarget.value})}/></label><label className="field">SSH target<input required value={draft.ssh} onInput={e=>setDraft({...draft,ssh:e.currentTarget.value})}/></label></div><Button variant="primary" type="submit" disabled={action.busy}>Add host</Button><div aria-live="polite"><ErrorMessage error={action.error}/>{action.message}</div></form></Card></section>;
}
function HostRow({host,reload}:{host:Host;reload:()=>void}) {
 const action=useAction(),[check,setCheck]=useState<HostCheck>();
 return <Card><div className="row"><strong>{host.alias}</strong><Pill tone={check?check.ok?'good':'bad':'neutral'}>{check?check.ok?'Reachable':'Needs attention':'Not checked'}</Pill><span className="grow muted">SSH target {host.ssh} · {host.running} of {host.maxTasks} tasks running</span><Button disabled={action.busy} onClick={()=>void action.run<HostCheck>('host.check',{alias:host.alias},setCheck)}>Check{check?' again':''}</Button><Button disabled={action.busy} onClick={()=>void action.run('host.remove',{alias:host.alias},reload)}>Remove</Button></div>{check&&<ul className="admin-checklist">{check.checks.map(c=><li><Pill tone={c.ok?'good':'bad'}>{c.ok?'Passed':'Failed'}</Pill> {c.name}{c.detail&&` · ${c.detail}`}</li>)}</ul>}<div aria-live="polite"><ErrorMessage error={action.error}/>{action.message}</div></Card>;
}
