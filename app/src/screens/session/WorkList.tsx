import {useEffect,useState} from "preact/hooks";
import {Button} from "../../ds/Button";
import {SectionHeading} from "../../ds/SectionHeading";
import {TaskTree} from "../../ds/TaskTreeNode";
import {ErrorMessage,useQuery,useTaskContext} from "../task-shared";
import {needsYou} from "../../../../src/view-model/selectors";
import {taskTree,type TreeTask} from "../../../../src/view-model/task-tree";
import type {ClientSnapshot} from "../../../../src/view-model/snapshot";
import {ChoicePicker} from "../../ds/ChoicePicker";
import {Field} from "../../ds/Controls";
import {withQuery,type RouteQuery} from "../../router";

type WorkRow={id:string;parentId:string|null;rootId:string;depth:number;title:string;state:string;executor:string|null;rev:number};
type WorkPage={tasks:WorkRow[];next:string|null};

/**
 * Work rows carry the parent link but not the machine or update time, so those facts stay unknown (omitted) unless the
 * snapshot holds the same task. Children nest under a parent on the loaded page; server order holds within each group.
 */
function workTree(rows:WorkRow[],snapshot:ClientSnapshot|null|undefined){
 const known=new Map((snapshot?.tasks??[]).map(task=>[task.id,task]));
 const tasks=rows.map((row):TreeTask=>({...(known.get(row.id)??{id:row.id,goal:row.title,title:row.title,executor:row.executor,backend:null,worktree:null,updatedAt:0}),state:row.state,parentId:row.parentId}));
 return taskTree({tasks,attention:snapshot?needsYou(snapshot,{repo:null}):[]},{now:Date.now()/1000});
}
/** Work overview reuses the same task detail route as the tree and timeline. */
export function WorkList({query}:{query:RouteQuery}){
 const {state:{snapshot}}=useTaskContext();
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
  {page.loading&&!rows.length?<p className="muted">Loading work…</p>:rows.length?<TaskTree nodes={workTree(rows,snapshot)} density="compact" href={id=>withQuery(`#/tasks/${encodeURIComponent(id)}`,query)} label="Dispatched work"/>:!page.error?<p className="muted">No work matches these filters.</p>:null}
  {page.data?.next&&<Button size="sm" busy={page.loading} onClick={()=>setBefore(page.data!.next!)}>Load older work</Button>}
 </section>;
}
