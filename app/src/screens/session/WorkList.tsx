import {useEffect,useState} from "preact/hooks";
import {Button,ButtonLink} from "../../ds/Button";
import {SectionHeading} from "../../ds/SectionHeading";
import {StatusPill} from "../../ds/StatusPill";
import {ErrorMessage,useQuery} from "../task-shared";
import {taskStatus,executorLabel} from "../../../../src/view-model/words";
import {ChoicePicker} from "../../ds/ChoicePicker";
import {Field} from "../../ds/Controls";
import {withQuery,type RouteQuery} from "../../router";

type WorkRow={id:string;parentId:string|null;rootId:string;depth:number;title:string;state:string;executor:string|null;rev:number};
type WorkPage={tasks:WorkRow[];next:string|null};

/** Work overview reuses the same task detail route as the tree and timeline. */
export function WorkList({query}:{query:RouteQuery}){
 const [relation,setRelation]=useState<"roots"|"children"|"all">("roots");
 const [state,setState]=useState("");
 const [before,setBefore]=useState<string>();
 const [rows,setRows]=useState<WorkRow[]>([]);
 const page=useQuery<WorkPage>("dispatch.list",{relation,...(state?{state}:{}),...(query.repo?{repo:query.repo}:{}),...(before?{before}:{})});
 useEffect(()=>{setBefore(undefined);setRows([]);},[relation,state,query.repo]);
 useEffect(()=>{if(page.data)setRows(previous=>before?[...new Map([...previous,...page.data!.tasks].map(row=>[row.id,row])).values()]:page.data!.tasks);},[page.data,before]);
 return <section aria-label="Dispatched work"><SectionHeading>Dispatched work</SectionHeading>
  <div className="row"><Field label="Show"><ChoicePicker value={relation} onValueChange={value=>setRelation(value as typeof relation)} options={[{value:"roots",label:"Work roots"},{value:"children",label:"Child work"},{value:"all",label:"All work"}]}/></Field>
  <Field label="Status"><ChoicePicker value={state} onValueChange={setState} options={[{value:"",label:"All statuses"},{value:"queued",label:"Queued"},{value:"running",label:"Working"},{value:"done",label:"Completed"},{value:"partial",label:"Incomplete"},{value:"failed",label:"Failed"},{value:"limit",label:"Out of quota"},{value:"stopped",label:"Stopped"},{value:"needs_input",label:"Needs your answer"}]}/></Field></div>
  {page.error&&<ErrorMessage error={page.error}/>}
  {page.loading&&!rows.length?<p className="muted">Loading work…</p>:rows.length?<ul role="list" className="pc-sessions-rows">{rows.map(row=><li key={row.id}><div className="pc-list-row pc-list-row--compact"><div className="pc-list-row__content"><strong>{row.title}</strong><p className="muted"><StatusPill status={taskStatus(row)}/> · {row.parentId?"Child work":"Work root"} · {executorLabel(row.executor)}</p></div><div className="pc-list-row__actions"><ButtonLink size="sm" href={withQuery(`#/tasks/${encodeURIComponent(row.id)}`,query)}>Open work</ButtonLink></div></div></li>)}</ul>:!page.error?<p className="muted">No work matches these filters.</p>:null}
  {page.data?.next&&<Button size="sm" busy={page.loading} onClick={()=>setBefore(page.data!.next!)}>Load older work</Button>}
 </section>;
}
