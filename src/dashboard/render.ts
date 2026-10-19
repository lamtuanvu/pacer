import { setupHints } from "./setup";
import { setupText, type SetupChecklist } from "../setup/checklist";
import type { ClientSnapshot } from "../view-model/snapshot";
import { dashboardModel } from "./model";
import { ago, clock, elapsed, meterText } from "../view-model/format";
import { attentionStatus, executorLabel, modeWords, phaseWords, taskStatus, verdictWords, type StatusTone } from "../view-model/words";
import { displayName } from "../render/accounts";
import { parseRunnerId } from "../config/runner-id";
import { cards } from "./model";

import { currentVersion } from "../update/version";
import type { DashboardSettings } from "./settings";
export interface View { repo?: string; branch?: string; version?: string; ops?: readonly string[]; settings?: DashboardSettings; setup?: SetupChecklist; updateLine?: string; selected: number; help?: boolean; preview?:string[]; prompt?: string; message?: string; noColor?: boolean }
export const safeText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
/** Width in terminal cells, rather than UTF-16 code units. */
export function cellWidth(text: string): number {
 return Array.from(safeText(text)).reduce((n,char)=>n+charWidth(char),0);
}
function charWidth(char:string):number {
 const cp=char.codePointAt(0)!;
 return /\p{Mark}/u.test(char)?0:cp>=0x1100&&(cp<=0x115f||cp>=0x2e80&&cp<=0xa4cf||cp>=0xac00&&cp<=0xd7af||cp>=0xf900&&cp<=0xfaff||cp>=0xfe10&&cp<=0xfe6f||cp>=0xff01&&cp<=0xff60||cp>=0x1f300)?2:1;
}
/** Every shortened value ends in an ellipsis, including wide Unicode text. */
export function clip(text: string, width: number): string {
 text=safeText(text);width=Math.max(0,width);
 if(cellWidth(text)<=width)return text;
 if(width<1)return "";
 let result="",cells=0;
 for(const char of text){const size=charWidth(char);if(cells+size>width-1)break;result+=char;cells+=size;}
 return result.trimEnd()+"…";
}
type Tone = "muted"|"amber"|"good"|"bad"|"info";
const terminalTone = (tone: StatusTone): Tone => tone === "warn" ? "amber" : tone === "neutral" ? "muted" : tone;
type Part = {text:string;tone?:Tone};
type Row = {parts:Part[];selected?:boolean;dim?:boolean};
const part=(text:string,tone?:Tone):Part=>({text:safeText(text),tone});
const field=(text:string,width:number,tone?:Tone):Part=>{
 const value=clip(text,Math.max(0,width-1));return part(value+" ".repeat(Math.max(0,width-cellWidth(value))),tone);
};
const row=(text:string):Row=>({parts:[part(text)]});
function ends(left:string,right:string,width:number):string {
 const r=clip(right,width),l=clip(left,Math.max(0,width-cellWidth(r)-2));
 return l+" ".repeat(Math.max(0,width-cellWidth(l)-cellWidth(r)))+r;
}
const shortExecutor=(id:string|null|undefined)=>{
 if(id&&parseRunnerId(id)?.agent==="opencode")return displayName(id);
 return executorLabel(id?.split("@")[0]?.split("#")[0]);
};
const windowName=(value:string|null|undefined)=>({weekly:"week",monthly:"month",daily:"day"}[value??""]??value??"—");
export function budgetBar(used: number|null, pace: number|null, size: number): string {
 const pct=(n:number)=>Math.max(0,Math.min(100,n));
 const filled=Math.round(pct(used??0)*size/100), marker=pace===null?-1:Math.min(size-1,Math.floor(pct(pace)*size/100));
 return `[${Array.from({length:size},(_,i)=>i===marker?"|":i<filled?"#":"-").join("")}]`;
}
export function renderDashboard(s:ClientSnapshot,width:number,height:number,now:number,v:View):string {
 const supports=(op:string)=>v.ops===undefined||v.ops.includes(op);
 width=Math.max(1,Math.floor(width)); height=Math.max(1,Math.floor(height));
 if(v.settings?.open){
  let section="";const body=v.settings.rows().flatMap((r,i)=>{const lines:string[]=[];if(section!==r.section){section=r.section;lines.push(section.toUpperCase());}lines.push(`${i===v.settings!.selected?">":" "} ${r.text}${r.reason?` · ${r.reason}`:""}`);return lines;});
  const space=Math.max(0,height-3),index=body.findIndex(l=>l.startsWith(">")),offset=Math.max(0,index-space+1),lines=[`▬┃ pacer › settings · strategy ${v.settings.strategyName()}`,...body.slice(offset,offset+space)];
  while(lines.length<height-2)lines.push("");
  lines.push(v.settings.prompt?`${v.settings.prompt.question}: ${v.settings.prompt.value}`:v.message??"","j/k select · Enter change · a add · l link · [/] order · b on/off · t check · Esc back");
  return lines.slice(0,height).map(l=>clip(l,width)).join("\n");
 }
 const model=dashboardModel(s), p=model.planner;
 const strategy=s.strategies?.find((x): x is import("../link/envelope").StrategyData=>typeof x!=="string"&&x.active);
 const live=s.at>0 && now-s.at<30;
 const time=new Date((live?now:s.at)*1000).toISOString().slice(11,19);
 const repo=v.repo??(s.repos?.length===1?s.repos[0]!.label:s.repos?.length?`${s.repos.length} repos`:"local");
 const header=`▬┃ pacer  [${modeWords(s.mode?.mode??p?.mode??"unknown").toUpperCase()}]  strategy ${strategy?.name??s.mode?.strategy??"default"}  ${repo} · ${v.branch??"—"}`;
 const setupKeys=v.setup?setupHints(v.setup,v.ops??[]):"";
 const fixed=[ends(header,`${live?"● live":"○ updated"} ${time}`,width)];
 if(p) {
  fixed.push(`${executorLabel(p.runner)} planner  ${windowName(p.window)} ${budgetBar(p.usedPct,p.pacePct,width>=120?20:8)} ${meterText(p.usedPct,p.pacePct,"full")}`);
  fixed.push([verdictWords(p.verdict),p.deltaPts===null?null:`${p.deltaPts>0?"+":""}${p.deltaPts} pts`,p.activeHoursLeft===null?null:`${p.activeHoursLeft} active-h`,p.resetsAt===null?null:`resets ${clock(p.resetsAt,now,"UTC")}`].filter(Boolean).join(" · "));
  if(p.advice)fixed.push(`→ ${p.advice}`);
 } else fixed.push("Planner · waiting for service data");
 if(v.setup&&!v.preview){
  const hints:string[]=[];
  for(const hint of setupKeys.split(" · ").filter(Boolean)){
   const last=hints.at(-1);
   if(last&&cellWidth(`${last} · ${hint}`)<=width)hints[hints.length-1]=`${last} · ${hint}`;else hints.push(hint);
  }
  fixed.splice(1,0,...setupText(v.setup).split("\n"),...hints);
 }
 if(v.updateLine)fixed.push(v.updateLine);
 const c=model.counts,body:Row[]=[];
 let index=0,attachSelected=false;
 const groups=cards(s,now,v.ops);
 const selectedRow=(parts:Part[],card:typeof groups[number]["cards"][number],dim=false):Row=>{
  const selected=index++===v.selected;if(selected&&card.sessionTaskId)attachSelected=true;
  return {parts:[part(selected?"> ":"  "),...parts],selected,dim};
 };
 for(const group of groups) {
  if(body.length)body.push(row(""));
  const count=group.title==="NEEDS YOU"?c?.attention:group.title==="RUNNING"?c?.running:group.title==="WHO RUNS NEXT"?c?.executors:s.today?.done;
  const suffix=group.title==="RUNNING"?` · QUEUED ${c?.queued??"?"}`:group.title==="DONE TODAY"&&s.today?` · ${s.today.accepted} accepted`:"";
  body.push(row(`${group.title} ${count??"?"}${suffix}`));
  if(!group.cards.length)body.push(row("  (none)"));
  if(group.title==="WHO RUNS NEXT") {
   const wide=width>=120;
   const sizes=wide?[3,14,10,7,22,6,16,17,7]:[2,12,8,7,10,5,14,14,6];
   const columns=(values:string[],dim=false)=>values.map((value,i)=>field(value,sizes[i]!,dim?"muted":undefined));
   body.push({parts:[part("  "),...columns(["#","EXECUTOR","ACCOUNT","WINDOW",wide?"USED | PACE":"METER","USED","STATUS","RESETS","SLOTS"])]});
   for(const card of group.cards) {
    const r=card.executor!,account=s.accounts?.find(a=>a.executors.includes(r.id));
    const unavailable=!r.enabled||["down","blocked","disabled","exhausted","failing","checking"].includes(r.state);
    const planner=r.rank==="planner"?p:null;
    const status=unavailable?r.state:account?verdictWords(account.verdict):planner?verdictWords(planner.verdict):verdictWords(r.paceReason==="unmetered"?"UNMETERED":"unknown");
    const parts=columns([r.rank==="planner"?"P":String(r.rank),shortExecutor(r.id),r.account===r.agent?"—":r.account,
     windowName(account?.window??planner?.window),r.paceReason==="unmetered"?"unmetered":budgetBar(r.usedPct,r.pacePct,wide?18:6),
     r.usedPct===null?"—":`${Math.round(r.usedPct)}%`,status,
     (account?.resetsAt??planner?.resetsAt)!=null?clock((account?.resetsAt??planner?.resetsAt)!,now,"UTC"):"—",`${r.slots.used}/${r.slots.max}`],unavailable);
    // Give unavailable rows room for the service's reason without hiding identity or slots.
    if(unavailable){
     const prefix=parts.slice(0,3),tail=field(`${r.state} · ${r.reason??r.sub}`,sizes.slice(3,8).reduce((a,b)=>a+b,0),"muted");
     body.push(selectedRow([...prefix,tail,parts[8]!],card,true));
    }else body.push(selectedRow(parts,card));
   }
  } else if(group.title==="NEEDS YOU") {
   for(const card of group.cards) {
    const item=model.needsYou.find(a=>a.id===card.id)!;
    const status=attentionStatus(item,s.tasks);
    const hints=card.actions?.map((a,i)=>`[${i===0?"⏎":i+1} ${a.label.toLowerCase()}]`).join(" ")??"";
    const reason=[item.executor?shortExecutor(item.executor):item.host,card.detail].filter(Boolean).join(" · ");
    const room=Math.max(0,width-6-cellWidth(hints));
    const titleWidth=Math.floor(room*(width>=120?0.52:0.5));
    body.push(selectedRow([part(`${status.glyph} `,terminalTone(status.tone)),field(card.text,titleWidth),part(" "),field(reason,Math.max(0,room-titleWidth-1),"muted"),part(" "+hints)],card));
   }
  } else if(group.title==="RUNNING") {
   const wide=width>=120;
   const sizes=wide?[48,14,12,8,19,17]:[22,12,9,5,16,14];
   const columns=(values:string[])=>values.map((value,i)=>field(value,sizes[i]!,i===5&&value.startsWith("idle")?"amber":undefined));
   body.push({parts:[part("  "),...columns(["TASK","EXECUTOR","PHASE","TIME","CHANGES","OUTPUT"])]});
   for(const card of group.cards){
    const t=model.running.find(t=>`running:${t.id}`===card.id)!,queued=t.state==="queued";
    const last=t.progress?.lastOutputAt;
    const output=queued||last==null?"—":t.progress?.phase==="idle"?`idle ${elapsed(now-last)}`:ago(last,now);
    body.push(selectedRow(columns([card.text,queued?"queued":shortExecutor(t.executor),queued?"waiting":t.progress?phaseWords(t.progress.phase):"—",elapsed(now-(t.attemptStartedAt??t.updatedAt)),t.progress?(wide?`${t.progress.files} files ${t.progress.commits} commits`:`${t.progress.files} files ${t.progress.commits}c`):"—",output]),card));
   }
  } else {
   const cols=width>=120?2:1,cell=Math.floor((width-(cols-1)*2)/cols);
   for(let i=0;i<group.cards.length;i+=cols){
    const parts:Part[]=[];let selected=false;
    for(let j=0;j<cols&&i+j<group.cards.length;j++){
     const card=group.cards[i+j]!,t=model.doneToday.find(t=>`done:${t.id}`===card.id)!;
     const status=taskStatus(t);
     const duration=t.attemptStartedAt==null?"—":elapsed(t.updatedAt-t.attemptStartedAt);
     const tail=`${status.label} · ${shortExecutor(t.executor)} ${duration} · ${clock(t.updatedAt,now,"UTC")}`;
     const r=selectedRow([part(`${status.glyph} `,terminalTone(status.tone)),field(card.text,Math.max(0,cell-5-cellWidth(tail))),part(" "),part(tail,"muted")],card);
     if(j)parts.push(part("  "));parts.push(...r.parts);selected ||= !!r.selected;
    }
    body.push({parts,selected});
   }
  }
 }
 if(v.help) {body.splice(0,body.length,...["Keys", setupKeys.includes("k skip")?"↑/↓ or j: select · Enter: primary action":"↑/↓ or j/k: select · Enter: primary action", [supports("task.delegate")?"d: delegate":"",supports("task.dismiss")?"x: dismiss":"",supports("runner.block")||supports("runner.unblock")?"b: block/unblock":""].filter(Boolean).join(" · "), [supports("strategy.use")&&!setupKeys.includes("s install")?"s: strategy":"",",: settings","r: refresh",supports("update.check")&&!setupKeys.includes("c connect")?"c: check updates":"",supports("update.apply")?"u: update":"","?: help","q: quit"].filter(Boolean).join(" · "), "Sessions: Enter attaches here · t: terminal window · m: tmux pane.", "1-9: inline actions · Esc cancels prompts. Budget bar: # used, | pace."].map(text=>row(text)));}
 if(v.preview)body.splice(0,body.length,...v.preview.flatMap(text=>{
  const lines:string[]=[];let line="";
  for(const word of text.split(" ")){if(line&&cellWidth(`${line} ${word}`)>width){lines.push(line);line=word;}else line+=`${line?" ":""}${word}`;}
  lines.push(line);return lines.map(text=>row(text));
 }));
 const space=Math.max(0,height-fixed.length-2), selected=body.findIndex(row=>row.selected), offset=selected>=space?Math.min(Math.max(0,body.length-space),selected-space+1):0;
 const visible=body.slice(offset,offset+space);
 const lines:Row[]=[...fixed.map(text=>row(text)),...visible];
 while(lines.length<height-2)lines.push(row(""));
 lines.push(row(v.prompt??v.message??""));
 const shortcuts=setupKeys?"↑/↓ select  ⏎ action  , settings  r refresh  ? help":"j/k select  ⏎ action  d delegate  x dismiss  b block  s strategy  , settings  r refresh  ? help";
 const compactShortcuts=setupKeys?"↑/↓ select  ⏎ action  , settings":"j/k select  ⏎ action  d delegate  x dismiss  b block";
 const status=`v${v.version??currentVersion()} · ${/^update available/i.test(v.updateLine??"")?"update available":"up to date"}`;
 // At 80 columns split the legend across the two footer lines.
 const legend=attachSelected?"⏎ Attach  t terminal window  m tmux  ? help":shortcuts;
 if(cellWidth(legend)+cellWidth(status)+2>width&&!v.prompt&&!v.message){
  const short=attachSelected?legend:compactShortcuts;
  lines[height-2]=row(clip(short,width));
  lines.push(row(ends(setupKeys?", settings  r refresh  ? help":"s strategy  , settings  r refresh  ? help",status,width)));
 }else lines.push(row(ends(legend,status,width)));
 const codes={muted:2,amber:33,good:32,bad:31,info:36};
 return lines.slice(0,height).map(line=>{
  let remaining=width;
  const text=line.parts.map(p=>{
   const text=clip(p.text,remaining);remaining=Math.max(0,remaining-cellWidth(text));
   return !v.noColor&&p.tone&&text?`\x1b[${codes[p.tone]}m${text}\x1b[${line.selected?"7":"0"}m`:text;
  }).join("");
  return v.noColor?text:`${line.selected?"\x1b[7m":""}${line.dim?"\x1b[2m":""}${text}${line.selected||line.dim?"\x1b[0m":""}`;
 }).join("\n");
}
