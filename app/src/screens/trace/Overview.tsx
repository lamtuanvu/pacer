import {clock,durationWords} from '../../../../src/view-model/time';
import type { TaskDetail } from '../../../../src/core/task-detail';
import { agentInfo, markAgent } from '../../../../src/view-model/agents';
import { ButtonLink } from '../../ds/Button';
import { hrefFor, routes } from '../../router';
import { TaskOutputPreview } from './TaskOutputPreview';
import { tokenValue } from './model';

export function NowCard({task:t,compact=false}:{task:TaskDetail;compact?:boolean}) {
 const failed=t.acceptance.state==='failed'||['failed','partial','limit'].includes(t.state);
 const active=['running','queued','needs_input'].includes(t.state);
 const tone=failed?'bad':t.state==='needs_input'?'warn':'info';
 const executor=t.executor||t.attempts.at(-1)?.executor;
 const identity=executor?agentInfo(markAgent(executor)).name:null;
 const agent=identity&&!/^unknown$/i.test(identity)?identity:'The agent';
 const account=executor?.split('@')[0]?.split('#')[1]||t.cost.executor?.account;
 const phase=t.state==='needs_input'?'waiting':t.progress?.phase==='testing'?'testing':['needs-input','idle','lost-contact','starting'].includes(t.progress?.phase??'')?'waiting':'editing';
 const title=failed?'What failed':t.review?t.review.accepted?'Result accepted':'Result rejected':active?t.state==='needs_input'?`${agent} is waiting now`:t.state==='queued'?'Waiting to start':`${agent} is ${phase} now`:'Ready for your review';
 const filesAvailable=t.derived?.files!=='unavailable';
 const touched=t.progress?.files??(filesAvailable?t.files.length:null);
 const detail=t.review?t.review.accepted?'The accepted result and report are recorded on this task.':'The rejected result and review note are recorded on this task.':failed?t.acceptance.summary??'Inspect the failing check output before retrying.':active?[agent,account&&!/^unknown$/i.test(account)&&account.toLocaleLowerCase()!==agent.toLocaleLowerCase()?account:null,touched===null?'File changes unavailable':`${touched} files touched so far`,t.brief.acceptance?'runs acceptance when it finishes':null].filter(Boolean).join(' · '):`${filesAvailable?`${t.files.length} files changed`:'File changes unavailable'} · ${t.acceptance.state==='passed'?'Checks passed':'Checks not recorded'} · the planner summary is in Notes`;
 const output=failed?t.acceptance.tail:'';
 return <section aria-label="Now" className={`pc-task-now pc-task-now--${tone}${compact?' pc-task-now--compact':''}`}><div className="pc-task-now__body"><span className="pc-trace__circle" aria-hidden="true">{failed?'✕':'◐'}</span><div><h2>{title}</h2><span className="pc-trace__cap pc-trace__detail">{detail}</span></div>{!compact&&<ButtonLink href={hrefFor(routes.workspace(t.id,failed?'changes':active?'session':'changes'))}>{failed?'Inspect in the workspace':active?'Follow in the workspace':'Review changes in the workspace'}</ButtonLink>}</div>{!compact&&(output?<pre tabIndex={0} aria-label="Failed check output" className="pc-task-now__output pc-trace__mono">{output}</pre>:active&&!failed?<TaskOutputPreview key={t.id} task={t}/>:null)}</section>;
}
export function CostTiles({task:t,compact=false,tokens=t.tokens,agentsUsed,attempts=t.attempts.length,subtasks=0,retries=Math.max(0,t.attempts.length-1)}:{task:TaskDetail;compact?:boolean;tokens?:TaskDetail["tokens"];agentsUsed?:number;attempts?:number;subtasks?:number;retries?:number}) {
 return <section aria-label="Cost summary" className={`pc-trace__cost${compact?' pc-trace__cost--compact':''}`}>
 <div><span className="pc-trace__label">Total tokens</span><strong>{tokenValue(tokens)}</strong>{!compact&&<span className="pc-trace__cap">Repository average: Not recorded</span>}</div>
 <div><span className="pc-trace__label">Outside planner</span><strong>Not recorded</strong></div>
 <div><span className="pc-trace__label">Agents used</span><strong>{agentsUsed??new Set(t.attempts.map(a=>a.executor)).size}</strong>{!compact&&<span className="pc-trace__cap">{subtasks} subtasks · {attempts} attempts · {retries} retries</span>}</div>
 <div><span className="pc-trace__label">Changed</span><strong>{t.derived?.files==='unavailable'?'Not recorded':`${t.files.length} files`}</strong>{!compact&&t.derived?.files!=='unavailable'&&<span className="pc-trace__cap">+{t.files.reduce((n,f)=>n+f.added,0)} −{t.files.reduce((n,f)=>n+f.removed,0)}</span>}</div></section>;
}
export function Acceptance({task:t,compact=false}:{task:TaskDetail;compact?:boolean}) {
 const at=t.timeline.findLast(e=>e.text.toLowerCase()===`acceptance ${t.acceptance.state}`)?.at;
 const settled=t.acceptance.state==='passed'||t.acceptance.state==='failed';
 return <section className={compact?'pc-task-acceptance':'pc-task-acceptance pc-trace__card pc-trace__acceptance'} aria-label="Acceptance"><h2>Acceptance</h2>{(t.acceptance.cmd??t.brief.acceptance)&&<code className="pc-trace__command pc-trace__mono">{t.acceptance.cmd??t.brief.acceptance}</code>}<span className="pc-trace__cap pc-trace__acceptance-result">{settled&&<span aria-hidden="true" className={`pc-trace__state pc-trace__state--${t.acceptance.state==='passed'?'good':'bad'}`}>{t.acceptance.state==='passed'?'✓':'✕'}</span>}{[settled?t.acceptance.state==='passed'?'Passed':'Failed':t.acceptance.state==='running'?'Checks running':'Runs when the session ends',t.acceptance.durationS==null?null:durationWords(t.acceptance.durationS),t.acceptance.summary,at==null?null:clock(at,Date.now()/1000)].filter(Boolean).join(' · ')}</span></section>;
}
