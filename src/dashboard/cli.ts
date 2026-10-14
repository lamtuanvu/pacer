import { StringDecoder } from "node:string_decoder";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { readLatest } from "../link/store";
import { listStrategies } from "../link/strategies";
import { taskData } from "../link/pump";
import { toBudget } from "../link/budget";
import { computeStatus } from "../engine/status";
import { loadStrategy } from "../config/strategy";
import { listTasks, readTask } from "../tasks/store";
import { delegate, taskStatus, taskStop } from "../tasks/api";
import { use as switchStrategy } from "../strategy/service";
import { selfHandle, resolveWorktreePath } from "../console/cli";
import { consoleCommands, type ConsoleDeps } from "../console/console";
import { cards } from "./model";
import { renderDashboard } from "./render";
import { Keys, moveSelection, selectionAction } from "./input";
export const ENTER_SCREEN="\x1b[?1049h\x1b[?25l";
export const LEAVE_SCREEN="\x1b[0m\x1b[?25h\x1b[?1049l";
export async function runDashboard(args:string[],ctx:Ctx):Promise<Result> {
 if(args.length)return {code:2,out:"",err:"usage: pacer dashboard\n"};
 if(!process.stdin.isTTY||!process.stdout.isTTY)return {code:2,out:"",err:"pacer dashboard needs an interactive terminal\n"};
 let selected=0,help=false,message="",messageUntil=0,busy=false,closed=false,exitError="";
 let statusTimer:ReturnType<typeof setTimeout>|undefined;
 let prompt:null|{type:"delegate"|"strategy";step:number;value:string;goal:string;repo:string;names:string[]}=null;
 let snapshot=readLatest(ctx),refreshing=false;
 let computed: typeof snapshot.budget=null;
 const fresh=():Ctx=>({...ctx,now:Date.now()/1000});
 const draw=()=>{if(closed)return;process.stdout.write("\x1b[H\x1b[2J"+renderDashboard(snapshot,process.stdout.columns||80,process.stdout.rows||24,Date.now()/1000,{selected,help,noColor:ctx.env.NO_COLOR!==undefined,message:Date.now()<messageUntil?message:"",prompt:prompt?`${prompt.type==="strategy"?`Strategy (${prompt.names.map((n,i)=>`${i+1}:${n}`).join(" ")})`: ["Goal",`Repo [${prompt.repo}]`,"Kind (optional)"][prompt.step]}: ${prompt.value}`:undefined}));};
 const report=(text:string)=>{message=text.split(/\r?\n/).filter(Boolean).at(-1)??"";messageUntil=Date.now()+5000;clearTimeout(statusTimer);statusTimer=setTimeout(draw,5000);draw();};
 const refresh=()=>{
  const c=fresh(),selectedId=cards(snapshot,c.now).flatMap(g=>g.cards)[selected]?.id; snapshot=readLatest(c);
  if(computed && computed.generatedAt>=(snapshot.budget?.generatedAt??0))snapshot={...snapshot,budget:computed,at:computed.generatedAt};
  snapshot.tasks=listTasks(c,20).map(t=>({...snapshot.tasks.find(old=>old.id===t.id),...taskData(taskStatus(c,t.id)??t)}));
  const updated=cards(snapshot,c.now).flatMap(g=>g.cards),index=updated.findIndex(card=>card.id===selectedId);
  selected=index>=0?index:Math.max(0,Math.min(selected,updated.length-1));draw();
  // Status work runs in the background; terminal polling never waits for it.
  if(!refreshing){refreshing=true;void Promise.resolve().then(()=>computeStatus({...c,readOnly:true},loadStrategy(c))).then(st=>{computed=toBudget(st);refresh();}).catch(e=>report(String(e))).finally(()=>{refreshing=false;});}
 };
 const use=async(name:string)=>{if(!listStrategies(fresh()).includes(name))throw Error(`unknown strategy ${name}`);await switchStrategy(fresh(),name);report(`active strategy: ${name}`);};
 const deps:ConsoleDeps={delegate,readTask,taskStop,configuredExecutors:c=>Object.keys(loadStrategy(c).providers),useStrategy:switchStrategy,listStrategies,statusText:async()=>"",pump:async()=>{refresh();return [];},heartbeat(){},resolveWorktreePath,selfHandle,every:()=>()=>{},pid:process.pid,cwd:process.cwd()};
 const startDelegate=(repo:string)=>{prompt={type:"delegate",step:0,value:"",goal:"",repo,names:[]};};
 const chooseStrategy=()=>{prompt={type:"strategy",step:0,value:"",goal:"",repo:"",names:listStrategies(fresh())};};
 const command=consoleCommands(ctx,deps,report,{startDelegate,chooseStrategy,use,refresh:async()=>{refresh();report("Refreshed");}});
 let finish!:(code:number)=>void;const done=new Promise<number>(resolve=>{finish=resolve;});
 const quit=(code=0)=>{if(closed)return;closed=true;finish(code);};
 const handle=async(key:string)=>{
  if(key==="interrupt"){quit(130);return;}
  if(prompt){
   if(key==="escape"){prompt=null;draw();return;}
   if(key==="backspace")prompt.value=Array.from(prompt.value).slice(0,-1).join("");
   else if(key==="enter"){
    const p=prompt,value=p.value.trim();p.value="";
    if(p.type==="strategy"){prompt=null;if(value)await use(/^\d+$/.test(value)?p.names[Number(value)-1]??value:value);}
    else if(p.step===0){if(!value){prompt=null;report("Delegate cancelled");}else{p.goal=value;p.step++;}}
    else if(p.step===1){p.repo=value||p.repo;p.step++;}
    else {prompt=null;const task=delegate(fresh(),{brief:{goal:p.goal,repo:p.repo},kind:value||null});report(`${task.id} queued`);refresh();}
   }else if(key.length && !["up","down"].includes(key)&&!/[\x00-\x1f\x7f]/.test(key))prompt.value+=key;
   draw();return;
  }
  if(key==="q"){quit();return;}
  if(key==="?"){help=!help;draw();return;}
  const all=cards(snapshot,Date.now()/1000).flatMap(g=>g.cards),card=all[selected];
  if(["up","down","j","k"].includes(key))selected=moveSelection(key,selected,all.length);
  else if(key==="d")startDelegate(process.cwd());
  else if(key==="s")chooseStrategy();
  else if(key==="r")refresh();
  else {const action=selectionAction(key,card);if(action)await command(action);}
  draw();
 };
 const keys=new Keys(),decoder=new StringDecoder("utf8");let escapeTimer:ReturnType<typeof setTimeout>|undefined;
 let queue=Promise.resolve();
 const run=(key:string)=>{
  if(key==="interrupt" || key==="q"&&busy&&!prompt){quit(key==="interrupt"?130:0);return;}
  queue=queue.then(async()=>{if(closed)return;busy=true;try{await handle(key);}catch(e){report(`pacer: ${e instanceof Error?e.message:String(e)}`);}finally{busy=false;}});
 };
 const input=(chunk:Buffer)=>{clearTimeout(escapeTimer);for(const key of keys.feed(decoder.write(chunk)))run(key);escapeTimer=setTimeout(()=>{for(const key of keys.flush())run(key);},30);};
 const interrupt=()=>quit(130),terminate=()=>quit(143),hangup=()=>quit(129);
 const crash=(error:unknown)=>{exitError=`pacer: ${error instanceof Error?error.message:String(error)}`;report(exitError);quit(1);};
 const raw=process.stdin.isRaw;
 const restore=()=>{process.stdin.setRawMode(raw);process.stdout.write(LEAVE_SCREEN);};
 let timer:ReturnType<typeof setInterval>|undefined;
 process.on("exit",restore);
 try {
  process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(ENTER_SCREEN);
  process.stdin.on("data",input);process.stdin.on("end",quit);process.stdout.on("resize",draw);
  process.on("SIGINT",interrupt);process.on("SIGTERM",terminate);process.on("SIGHUP",hangup);process.on("uncaughtException",crash);process.on("unhandledRejection",crash);
  refresh();timer=setInterval(()=>{try{refresh();}catch(e){report(String(e));}},2000);
  return {code:await done,out:"",err:exitError};
 }finally{
  closed=true;clearInterval(timer);clearTimeout(escapeTimer);clearTimeout(statusTimer);process.stdin.off("data",input);process.stdin.off("end",quit);process.stdin.pause();process.stdout.off("resize",draw);
  process.off("SIGINT",interrupt);process.off("SIGTERM",terminate);process.off("SIGHUP",hangup);process.off("uncaughtException",crash);process.off("unhandledRejection",crash);process.off("exit",restore);restore();
 }
}
