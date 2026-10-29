import {useEffect,useState} from "preact/hooks";
import type {ComponentType} from "preact";
import type {TaskNodeView} from "../../../../src/view-model/task-tree";
import type {TaskCardView} from "../../ds/TaskCard";

export interface TaskAsideProps{node:TaskNodeView;parent?:TaskNodeView;position:string;href(id:string):string;viewHref(id:string,view:TaskCardView):string}
/** The selected-task panel loads after the list so the app bundle stays within budget (UI-3). */
export function LazyTaskAside(props:TaskAsideProps){
 const[View,setView]=useState<ComponentType<TaskAsideProps>|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{let active=true;void import("./TaskAside").then(m=>{if(active)setView(()=>m.TaskAside);}).catch(()=>{if(active)setFailed(true);});return()=>{active=false;};},[]);
 return View?<View {...props}/>:<aside className="pc-task-aside" aria-label="Selected task" aria-busy={!failed}>{failed&&<p role="alert" className="pc-task-aside__section">Selected task unavailable.</p>}</aside>;
}

/** Root branches arrive from task.get, using the same deferred screen module as the aside. */
export function LazyTaskBranch({id}:{id:string}){
 const[View,setView]=useState<ComponentType<{id:string}>|null>(null);
 useEffect(()=>{let active=true;void import("./TaskAside").then(m=>{if(active)setView(()=>m.TaskBranch);}).catch(()=>{});return()=>{active=false;};},[]);
 return View?<View id={id}/>:<span className="pc-task-card__branch">—</span>;
}
