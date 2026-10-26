import type { Command } from "./types";
import type { Draft, JSONValue } from "../strategy/service";
import * as service from "../strategy/service";
import { build } from "../strategy/launcher";
import { withLock } from "../core/lock";
export function parseStrategyArgs(args:string[]) {
  const pos:string[]=[], opts:Record<string,string>={}, set:Record<string,JSONValue>={}, unset:string[]=[]; let overwrite=false, activeOk=false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i]; if(!arg.startsWith("--")){pos.push(arg);continue;}
    if(arg==="--allow-active"){activeOk=true;continue;}
    if(arg==="--overwrite"){overwrite=true;continue;}
    if(!["--from","--set","--unset","--reason","--agent","--brief"].includes(arg))throw new Error(`unknown option ${arg}`);
    const value=args[++i]; if(value===undefined||value.startsWith("--"))throw new Error(`${arg} requires a value`);
    if(arg==="--set") {const at=value.indexOf("="); if(at<1)throw new Error("--set requires k=v"); set[value.slice(0,at)]=Bun.YAML.parse(value.slice(at+1)) as JSONValue;}
    else if(arg==="--unset")unset.push(value); else opts[arg.slice(2)]=value;
  }
  return {pos,opts,set,unset,overwrite,activeOk};
}
export const COMMANDS:Command[]=[{name:"strategy",usage:"strategy list|show|preview|save|use|rm|build      inspect, draft and build strategies",run:async(args,ctx)=>{
  try {
    const {pos,opts,set,unset,overwrite,activeOk}=parseStrategyArgs(args), [cmd,name]=pos;
    const draft:Draft={from:opts.from??"default",set,unset}; let result:unknown;
    switch(cmd){
      case "list":result=service.list(ctx);break;
      case "show":result=service.show(ctx,name??"");break;
      case "preview":result=await service.preview(ctx,draft);break;
      case "save":result=await withLock(ctx,"strategy",async()=>service.save(ctx,name??"",draft,opts.reason??"",{overwrite,activeOk,who:"user"}));break;
      case "use":result=await withLock(ctx,"strategy",async()=>({name,path:await service.use(ctx,name??"")}));break;
      case "rm":result=await withLock(ctx,"strategy",async()=>service.remove(ctx,name??""));break;
      case "build":result=await build(ctx,{agent:opts.agent,from:opts.from,brief:opts.brief});break;
      default:throw new Error("usage: pacer strategy list|show <name>|preview --from <name> --set k=v|save <name> --from <name> --set k=v --reason <text>|use <name>|rm <name>|build");
    }
    return {code:cmd==="preview" && !(result as {ok:boolean}).ok?2:0,out:JSON.stringify(result,null,2),err:""};
  }catch(e){return {code:2,out:"",err:`pacer strategy: ${(e as Error).message.replaceAll("overwrite:true","--overwrite").replaceAll("activeOk:true","--allow-active")}`};}
}}];
