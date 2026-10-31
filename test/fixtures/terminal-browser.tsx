import {render} from "preact";
import {useEffect,useState} from "preact/hooks";
import {TerminalScreen} from "../../app/src/screens/terminal/Terminal";
import {TaskContext} from "../../app/src/screens/task-shared";
import {NavigationProvider} from "../../app/src/navigation";
import {resolveRoute} from "../../app/src/router";
import {initialState} from "../../app/src/data/store";
import {ApiError} from "../../app/src/data/api";
import type {TerminalRecord} from "../../src/terminal/workspace";

const records:TerminalRecord[]=[];
let next=0;
let createError="";
if(!crypto.randomUUID) Object.defineProperty(crypto,"randomUUID",{value:()=>`11111111-1111-4111-8111-${String(++next).padStart(12,"0")}`});
const api={
  async call(op:string,params:Record<string,any>={}) {
    if(op==="terminal.list") return [...records];
    if(op==="terminal.create") {
      if(createError) throw new ApiError(createError,"Launch refused",undefined,403);
      const id=`00000000-0000-4000-8000-${String(++next).padStart(12,"0")}`;
      const record:TerminalRecord={id,kind:"shell",title:"Shell",cwd:params.cwd??"/workspace",createdAt:next,rev:1,live:true,exit:null,cols:80,rows:24,attach:{ws:`/v3/terminals/${id}/session`}};
      records.push(record);return record;
    }
    if(op==="terminal.rename") {const record=records.find(item=>item.id===params.id)!;record.title=params.title;record.rev++;return {...record};}
    if(op==="terminal.close") {const index=records.findIndex(item=>item.id===params.id);records.splice(index,1);return {closed:true};}
    throw Error(op);
  },hello:async()=>({}),snapshot:async()=>({}),
};
const state={...initialState(),connected:true,features:{readModel:true,ops:new Set(["terminal.create"])}};
function App(){
  const [hash,setHash]=useState(location.hash);
  const [open,setOpen]=useState(true);
  const embedded=location.hash.includes("embedded");
  useEffect(()=>{const update=()=>setHash(location.hash);addEventListener("hashchange",update);return()=>removeEventListener("hashchange",update);},[]);
  const resolved=resolveRoute(hash);
  const id="name" in resolved && resolved.name==="terminal" ? resolved.id : undefined;
  const route={name:"terminal" as const,id,query:{repo:null,scope:null}};
  return <NavigationProvider route={route}><TaskContext.Provider value={{api:api as any,state}}>{embedded && <button onClick={()=>setOpen(!open)}>Toggle panel</button>}{open && <TerminalScreen embedded={embedded} id={id} query={route.query}/>}</TaskContext.Provider></NavigationProvider>;
}
(globalThis as any).terminalTest={setCreateError(value:string){createError=value;},records};
render(<App/>,document.getElementById("root")!);
