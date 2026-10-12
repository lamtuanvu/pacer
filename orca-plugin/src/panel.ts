import { LIMITS, type CmdData, type LinkSnapshot } from "../../src/link/envelope";
import type { TransportId } from "./transports/choose";
import { h, jsonForScript, packPanelData } from "./panel/shared";
import { initialView, rankedProviders, mutedProviders, providerDetail, unavailableDetail, tone, verdictWords } from "./panel/model";
import { overview } from "./panel/overview";
import { setup } from "./panel/setup";
import { delegateView } from "./panel/delegate";
import { style } from "./panel/style";
import { paths } from "./panel/icons";
import { strategyView } from "./panel/strategy";
import { client } from "./panel/client";
export { escapeHtml, jsonForScript } from "./panel/shared";
export interface AutoConsoleOutcome { status: string; at: number }
export function renderPanel(s:LinkSnapshot, view:{nowS:number;transport:TransportId|null;reachable:boolean;autoConsole?:boolean;notifications?:"off"|"important"|"all";lastSeenAt?:number;autoConsoleOutcome?:AutoConsoleOutcome}):string {
 const reconnecting = !view.reachable && !!s.budget && view.lastSeenAt !== undefined && view.nowS-view.lastSeenAt >= 0 && view.nowS-view.lastSeenAt < 20;
 const consoles=[...(s.consoles ?? []), ...(s.console ? [s.console] : [])].filter(c=>c.handle && view.nowS-c.heartbeatAt<=LIMITS.heartbeatS).filter((c,i,a)=>a.findIndex(x=>x.handle===c.handle)===i), console=consoles[0], selected=reconnecting ? "overview" : initialView(s,view.reachable,view.nowS);
 const commands:Record<string,CmdData>={refresh:{cmd:"refresh"}};
 const text:Record<string,string>={};
 const main=overview(s,view.nowS,view.reachable,commands,text);
 const reasonText = (view.autoConsole ?? true) ? "The pacer console for this worktree is starting. Try again in a few seconds." : "Start the console first.";
 const disable=(html:string)=>(console ? html : html.replace(/(data-command="[^"]+"|data-live)(?=[ >])/g,"$1 disabled")).replace(/<button([^>]*\bdisabled[^>]*)>([\s\S]*?)<\/button>/g, (_match, attrs, label)=>`<button${attrs} title="${h(reasonText)}">${label}</button><small class="muted">${h(reasonText)}</small>`);
 const payload = {notifications:view.notifications??"important",actionErrors:s.alerts.filter(a=>a.key.startsWith("retry-")&&a.level!=="info").map(a=>({key:a.key,at:a.at,body:a.body})),sequence:s.seq,tasks:s.tasks.map(t=>({id:t.id,state:t.state,goal:t.goal,retryOf:t.retryOf,retriedBy:t.retriedBy,dismissed:t.dismissed})),autoConsole:view.autoConsole ?? true,buildAlert:s.alerts.find(a=>a.key==="strategy-build")??null,consoles:consoles.map(c=>({handle:c.handle,live:true})),strategies:s.strategies?.length?s.strategies:[s.budget?.strategy??"default"],strategy:s.budget?.strategy??"default",savedAlerts:s.alerts.filter(a=>a.key.startsWith("strategySaved-")),snapshotAt:s.budget?.generatedAt??s.at,updatedAt:s.at,reachable:view.reachable,commands,text,paths:Object.fromEntries(Object.entries(paths).filter(([id])=>[...rankedProviders(s),...mutedProviders(s)].some(p=>p.id===id))),rows:rankedProviders(s).map(p=>({id:p.id,usedPct:p.usedPct,pacePct:p.pacePct,detail:providerDetail(p,view.nowS),tone:tone(p.verdict),words:verdictWords(p.verdict),blocked:false})),muted:mutedProviders(s).map(p=>({id:p.id,verdict:p.verdict,detail:unavailableDetail(p,view.nowS),blocked:!!p.blockedReason}))};
 const strategy=strategyView(s,view.nowS,view.reachable,view.notifications??"important");
 const outcome=view.autoConsoleOutcome, waiting= !outcome || (outcome.status === "starting" && view.nowS-outcome.at<15);
 const reason=outcome ? outcome.status === "older-console" ? "An older pacer console is running here; it restarts automatically after updates. A fresh console is starting." : outcome.status === "starting" ? "Console startup is taking longer than expected." : `Auto-open: ${outcome.status}.` : "Press Enter in the terminal to start it.";
 const consoleHint=waiting && view.transport === "http" && (view.autoConsole ?? true) && view.reachable ? `<small class="muted"><span class="console-spinner" aria-hidden="true">◐</span> Starting pacer console in this worktree...</small>` : `<button type="button" data-setup="pacer console">Start console</button><small>${h(reason)}</small>`;
 const packed=packPanelData(payload), plain=jsonForScript(packed), encoded=jsonForScript({encoded:Buffer.from(JSON.stringify(packed),"utf8").toString("base64")});
 const data=encoded.length<plain.length?encoded:plain;

 return `<!doctype html><html lang="en" data-transport="${h(view.transport??"none")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>pacer budget</title><style>${style}</style></head><body>
 <main class="view" data-page="overview"${selected==="overview"?"":" hidden"}>${reconnecting?'<div role="status" class="note">Reconnecting...</div><div style="opacity:.45;pointer-events:none" inert>'+disable(main)+"</div>":disable(main)}</main>
 <main class="view" data-page="setup"${selected==="setup"?"":" hidden"}>${setup(s,view.nowS,view.reachable)}</main>
 <main class="view" data-page="delegate" hidden>${disable(delegateView(s,view.nowS,view.reachable))}</main>
 <main class="view" data-page="strategy" hidden>${disable(strategy)}</main>
 <p id="status" role="status" aria-live="polite"></p><div id="console-hint" class="note stack" hidden><strong>No pacer console in this worktree</strong>${consoleHint}</div>
 <script type="application/json" id="pacer-actions">${data}</script><script>
${client}</script></body></html>`;
}
