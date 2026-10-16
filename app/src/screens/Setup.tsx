import { useEffect, useState } from 'preact/hooks';
import type { SetupChecklist } from '../../../src/setup/checklist';
import type { ConfigData } from '../model/strategy';
import { setupModel } from '../model/setup';
import { Button } from '../ds/Button';
import { Card } from '../ds/Card';
import { Pill } from '../ds/Pill';
import { useQuery,useAction,useDraft,ErrorMessage } from './task-shared';
import { Consent,CopyCommand,PluginInstall } from './Settings';
export function Setup() {
 const query=useQuery<SetupChecklist>('setup.check',{}),config=useQuery<ConfigData>('config.get',{}),action=useAction();
 const [planner,setPlanner]=useDraft('pacer.setup.planner',{value:'claude-code'}),[agent,setAgent]=useState('');
 useEffect(()=>{const id=setInterval(query.reload,5000);return()=>clearInterval(id);},[]);
 const model=query.data&&setupModel(query.data);
 const candidates=config.data?.planners??['claude-code','codex','cursor','opencode'];
 return <section className="screen"><h1>Setup</h1><p className="headline">{model?.complete?"You're set up":'A few things before pacer can work for you.'}</p>{model?.complete&&<a href="#/">Go to Home</a>}<ErrorMessage error={query.error}/>{model?.items.map(i=><Card key={i.id}><div className="row"><h2 className="grow">{i.title}{i.required?' · Required':' · Optional'}</h2><Pill tone={i.status==='done'?'good':i.status==='failed'?'bad':'neutral'}>{i.label}</Pill></div>{i.detail&&<p>{i.detail}</p>}{i.action==='planner'&&i.status!=='done'&&<form onSubmit={e=>{e.preventDefault();void action.run('setup.init',{planner:planner.value},()=>{query.reload();config.reload();});}}><label htmlFor="setup-planner" className="field">Planner<select id="setup-planner" value={planner.value} onChange={e=>setPlanner({value:e.currentTarget.value})}>{[...new Set([planner.value,...candidates])].map(p=><option value={p}>{p}</option>)}</select></label><Button type="submit" variant="primary" disabled={action.busy}>Choose planner</Button><div aria-live="polite"><ErrorMessage error={action.error}/>{action.message}</div></form>}{i.action==='service'&&i.status!=='done'&&<><p>{i.guidance??'Run this command in a terminal. This checklist checks again every 5 seconds.'}</p><CopyCommand command={i.command!}/><Button variant="ghost" onClick={query.reload}>Check again</Button></>}{i.action==='agent'&&<Button onClick={()=>setAgent(i.id.slice(6))}>{i.status==='done'?'Show changes':'Connect'}</Button>}{i.action==='plugin'&&<PluginInstall detail={i.detail} done={query.reload}/ >}{i.action==='check'&&<Button variant="ghost" onClick={query.reload}>Check again</Button>}</Card>)}{agent&&<Consent agent={agent} close={()=>setAgent('')} done={query.reload}/>}</section>;
}
