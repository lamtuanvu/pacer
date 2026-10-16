import type { LinkSnapshot, ProviderLine, TaskData } from "../../../src/link/envelope";
import { h } from "./shared";
import { tone, providerLabel } from "./model";
export function placementLine(t:TaskData):string {return t.placement?`<small class="muted">${h(`${t.placement.mode} worktree${t.placement.mode==="new"&&t.worktree?` ${t.worktree}`:""} (${t.placement.why})`)}</small>`:"";}
export function meter(p:ProviderLine, slim=false): string {
 if(p.usedPct===null) return "";
 const used=Math.max(0,Math.min(100,p.usedPct)), pace=p.pacePct==null?null:Math.max(0,Math.min(100,p.pacePct));
 return `<div class="meter ${slim?"slim":""} ${tone(p.verdict)}" role="progressbar" aria-label="${h(providerLabel(p))} usage${pace===null?"":`, pace ${pace}%`}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${used}%"></div>${pace===null?"":`<div class="pace" style="left:${pace}%"></div>`}</div>`;
}

import { renderStatusPage } from "../panel";
/** Compatibility for consumers of the old overview renderer. */
export function overview(s:LinkSnapshot, nowS:number, reachable:boolean, _commands:unknown, _text:unknown):string {
 return renderStatusPage(s,{nowS,reachable,transport:null});
}
