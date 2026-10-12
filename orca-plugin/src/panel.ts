import { liveConsole, type CmdData, type LinkSnapshot } from "../../src/link/envelope";
import type { TransportId } from "./transports/choose";
import { h, jsonForScript } from "./panel/shared";
import { initialView, rankedProviders, mutedProviders, providerDetail, unavailableDetail, tone, verdictWords } from "./panel/model";
import { overview } from "./panel/overview";
import { setup } from "./panel/setup";
import { delegateView } from "./panel/delegate";
import { style } from "./panel/style";
import { paths } from "./panel/icons";
import { client } from "./panel/client";
export { escapeHtml, jsonForScript } from "./panel/shared";
export function renderPanel(s:LinkSnapshot, view:{nowS:number;transport:TransportId|null;reachable:boolean}):string {
 const console=liveConsole(s,view.nowS), selected=initialView(s,view.reachable,view.nowS);
 const commands:Record<string,CmdData>={strategy:{cmd:"use"},refresh:{cmd:"refresh"}};
 const text:Record<string,string>={};
 const main=overview(s,view.nowS,view.reachable,commands,text);
 const disable=(html:string)=>console?html:html.replace(/(data-command="[^"]+"|data-live)(?=[ >])/g,"$1 disabled");
 const payload = {handle:console?.handle??null,expires:(console?.heartbeatAt??0)*1000+30000,commands,text,paths,rows:rankedProviders(s).map(p=>({id:p.id,usedPct:p.usedPct,pacePct:p.pacePct,detail:providerDetail(p,view.nowS),tone:tone(p.verdict),words:verdictWords(p.verdict)})),muted:mutedProviders(s).map(p=>({id:p.id,verdict:p.verdict,detail:unavailableDetail(p,view.nowS)}))};
 const plain=jsonForScript(payload), encoded=jsonForScript({encoded:Buffer.from(JSON.stringify(payload),"utf8").toString("base64")});
 const data=encoded.length<plain.length?encoded:plain;
 return `<!doctype html><html lang="en" data-transport="${h(view.transport??"none")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>pacer budget</title><style>${style}</style></head><body>
 <main class="view" data-page="overview"${selected==="overview"?"":" hidden"}>${disable(main)}</main>
 <main class="view" data-page="setup"${selected==="setup"?"":" hidden"}>${setup(s,view.nowS,view.reachable)}</main>
 <main class="view" data-page="delegate" hidden>${disable(delegateView(s,view.nowS))}</main>
 <p id="status" role="status" aria-live="polite"></p>
 <script type="application/json" id="pacer-actions">${data}</script><script>
${client}</script></body></html>`;
}
