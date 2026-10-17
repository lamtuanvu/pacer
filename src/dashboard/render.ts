import { setupText, type SetupChecklist } from "../setup/checklist";
import type { LinkSnapshot } from "../link/envelope";
import { cards } from "./model";
import { runnerLabel } from "../render/accounts";
import type { DashboardSettings } from "./settings";
export interface View { ops?: readonly string[]; settings?: DashboardSettings; setup?: SetupChecklist; updateLine?: string; selected: number; help?: boolean; prompt?: string; message?: string; noColor?: boolean }
export const safeText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
export function budgetBar(used: number|null, pace: number|null, size: number): string {
 const pct=(n:number)=>Math.max(0,Math.min(100,n));
 const filled=Math.round(pct(used??0)*size/100), marker=pace===null?-1:Math.min(size-1,Math.floor(pct(pace)*size/100));
 return `[${Array.from({length:size},(_,i)=>i===marker?"|":i<filled?"#":"-").join("")}]`;
}
export function renderDashboard(s:LinkSnapshot,width:number,height:number,now:number,v:View):string {
 const supports=(op:string)=>v.ops===undefined||v.ops.includes(op);
 width=Math.max(1,Math.floor(width)); height=Math.max(1,Math.floor(height));
 if(v.settings?.open){
  let section="";const body=v.settings.rows().flatMap((r,i)=>{const lines:string[]=[];if(section!==r.section){section=r.section;lines.push(section);}lines.push(`${i===v.settings!.selected?">":" "} ${r.text}${r.reason?` · ${r.reason}`:""}`);return lines;});
  const space=Math.max(0,height-3),index=body.findIndex(l=>l.startsWith(">")),offset=Math.max(0,index-space+1),lines=["◆ pacer · Settings",...body.slice(offset,offset+space)];
  while(lines.length<height-2)lines.push("");
  lines.push(v.settings.prompt?`${v.settings.prompt.question}: ${v.settings.prompt.value}`:v.message??"","↑/↓ select · Enter change · a add · l link · x remove · [/] order · Esc back");
  return lines.slice(0,height).map(l=>safeText(l).slice(0,width)).join("\n");
 }
 const b=s.budget,p=b?.providers.find(p=>p.id===b.planner), compact=width<60;
 const header=`◆ pacer · ${b?.mode??"unknown"} · ${b?.strategy??"no strategy"}`;
 const live=s.at>0 && now-s.at<30;
 const fixed=[header,`${live?"Live":"Updated"} · ${s.at?new Date(s.at*1000).toISOString().slice(11,19):"waiting for local data"}`,`Planner ${runnerLabel(p ?? {id:b?.planner??"?"})}: ${p?.usedPct==null?"?":Math.round(p.usedPct)+"%"} ${budgetBar(p?.usedPct??null,p?.pacePct??null,Math.max(4,Math.min(compact?12:24,width-24)))}`];
 if(v.setup && !v.setup.complete)fixed.splice(1,0,...setupText(v.setup).split("\n"));
 if(v.updateLine)fixed.push(v.updateLine);
 const body:{text:string;selected:boolean}[]=[];let index=0;
 for(const group of cards(s,now,v.ops)) {
  body.push({text:group.title,selected:false});
  if(!group.cards.length) body.push({text:"  (none)",selected:false});
  let account:string|undefined;
  for(const card of group.cards) {if(card.account && card.account!==account) {body.push({text:`  Account ${card.account}`,selected:false});account=card.account;}const selected=index++===v.selected;body.push({text:`${selected?">":" "} ${card.text}`,selected});}
 }
 if(v.help) {body.splice(0,body.length,...["Keys", "↑/↓ or j/k: select · Enter: primary action", [supports("task.delegate")?"d: delegate":"",supports("task.dismiss")?"x: dismiss":"",supports("runner.block")||supports("runner.unblock")?"b: block/unblock":""].filter(Boolean).join(" · "), [supports("strategy.use")?"s: strategy":"",",: settings","r: refresh",supports("update.check")?"c: check updates":"",supports("update.apply")?"u: update":"","?: help","q: quit"].filter(Boolean).join(" · "), supports("task.stop")?"Running: Enter focuses its terminal, or stops it.":"Running: Enter focuses its terminal.", "Esc cancels prompts. Budget bar: # used, | pace."].map(text=>({text,selected:false})));}
 const space=Math.max(0,height-fixed.length-2), selected=body.findIndex(row=>row.selected), offset=selected>=space?Math.min(Math.max(0,body.length-space),selected-space+1):0;
 const shortcuts=[supports("task.delegate")?"d":"",supports("task.dismiss")?"x":"",supports("runner.block")||supports("runner.unblock")?"b":"",supports("strategy.use")?"s":"",",","r",supports("update.check")?"c":"",supports("update.apply")?"u":"","?","q"].filter(Boolean).join(" ");
 const lines=[...fixed,...body.slice(offset,offset+space).map(row=>row.selected&&!v.noColor?`\x1b[7m${safeText(row.text).slice(0,width)}\x1b[0m`:safeText(row.text).slice(0,width))];
 while(lines.length<height-2)lines.push("");
 lines.push(v.prompt??v.message??"",compact?`j/k Enter ${shortcuts}`:`↑/↓/j/k select · Enter action · ${shortcuts}`);
 return lines.slice(0,height).map(line=>line.includes("\x1b[7m")?line:safeText(line).slice(0,width)).join("\n");
}
