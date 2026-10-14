import type { LinkSnapshot } from "../link/envelope";
import { cards } from "./model";
export interface View { selected: number; help?: boolean; prompt?: string; message?: string; noColor?: boolean }
export const safeText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
export function budgetBar(used: number|null, pace: number|null, size: number): string {
 const pct=(n:number)=>Math.max(0,Math.min(100,n));
 const filled=Math.round(pct(used??0)*size/100), marker=pace===null?-1:Math.min(size-1,Math.floor(pct(pace)*size/100));
 return `[${Array.from({length:size},(_,i)=>i===marker?"|":i<filled?"#":"-").join("")}]`;
}
export function renderDashboard(s:LinkSnapshot,width:number,height:number,now:number,v:View):string {
 width=Math.max(1,Math.floor(width)); height=Math.max(1,Math.floor(height));
 const b=s.budget,p=b?.providers.find(p=>p.id===b.planner), compact=width<60;
 const header=`◆ pacer · ${b?.mode??"unknown"} · ${b?.strategy??"no strategy"}`;
 const live=s.at>0 && now-s.at<30;
 const fixed=[header,`${live?"Live":"Updated"} · ${s.at?new Date(s.at*1000).toISOString().slice(11,19):"waiting for local data"}`,`Planner ${b?.planner??"?"}: ${p?.usedPct==null?"?":Math.round(p.usedPct)+"%"} ${budgetBar(p?.usedPct??null,p?.pacePct??null,Math.max(4,Math.min(compact?12:24,width-24)))}`];
 const body:{text:string;selected:boolean}[]=[];let index=0;
 for(const group of cards(s,now)) {
  body.push({text:group.title,selected:false});
  if(!group.cards.length) body.push({text:"  (none)",selected:false});
  for(const card of group.cards) {const selected=index++===v.selected;body.push({text:`${selected?">":" "} ${card.text}`,selected});}
 }
 if(v.help) {body.splice(0,body.length,...["Keys", "↑/↓ or j/k: select · Enter: primary action", "d: delegate · x: dismiss · b: block/unblock", "s: strategy · r: refresh · ?: help · q: quit", "Running: Enter focuses its terminal, or stops it.", "Esc cancels prompts. Budget bar: # used, | pace."].map(text=>({text,selected:false})));}
 const space=Math.max(0,height-fixed.length-2), selected=body.findIndex(row=>row.selected), offset=selected>=space?Math.min(Math.max(0,body.length-space),selected-space+1):0;
 const lines=[...fixed,...body.slice(offset,offset+space).map(row=>row.selected&&!v.noColor?`\x1b[7m${safeText(row.text).slice(0,width)}\x1b[0m`:safeText(row.text).slice(0,width))];
 while(lines.length<height-2)lines.push("");
 lines.push(v.prompt??v.message??"",compact?"j/k Enter d x b s r ? q":"↑/↓/j/k select · Enter action · d x b s r ? q");
 return lines.slice(0,height).map(line=>line.includes("\x1b[7m")?line:safeText(line).slice(0,width)).join("\n");
}
