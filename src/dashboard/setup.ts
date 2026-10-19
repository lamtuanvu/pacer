import type { SetupChecklist } from "../setup/checklist";
import type { Action } from "../attention/types";
export function setupHints(setup:SetupChecklist,ops:readonly string[]):string {
 if(setup.ready)return "";
 const pending=(id:string)=>setup.items.some(i=>i.id===id&&i.status!=="done");
 return [pending("service")&&ops.includes("service.install")?"s install service":"",pending("connect")&&setup.items.find(i=>i.id==="connect")?.agent&&ops.includes("agent.connect")?"c connect planner":"",pending("executor")?"e add executor":"",pending("first")&&ops.includes("onboarding.try")?"t try first delegation":"",pending("first")&&ops.includes("onboarding.skip")?"k skip first delegation":""].filter(Boolean).join(" · ");
}
export function setupAction(key:string,setup:SetupChecklist,ops:readonly string[]):Action|"add-executor"|undefined {
 if(setup.ready)return;
 const id=({s:"service",c:"connect",e:"executor",t:"first",k:"first"} as Record<string,string>)[key];
 const item=setup.items.find(i=>i.id===id&&i.status!=="done");
 if(!item)return;
 if(key==="e")return "add-executor";
 const op=key==="k"?"onboarding.skip":item.action;
 if(!op||!ops.includes(op)||op.startsWith("nav:"))return;
 if(op==="agent.connect"&&!item.agent)return;
 return {label:key==="k"?"Skip first delegation":item.title,op,params:op==="agent.connect"?{agent:item.agent,consent:true}:op==="service.install"?{consent:true}:{},...(op==="service.install"?{confirm:"Run pacer in the background at login? It keeps budgets fresh and runs delegated tasks."}:{})};
}
