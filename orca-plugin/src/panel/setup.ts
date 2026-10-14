import { actionStatus } from "./shared";
import type { LinkSnapshot } from "../../../src/link/envelope";
import { setupChecklist, type SetupChecklist } from "../../../src/setup/checklist";
import type { BootstrapState } from "../bootstrap";
import { h } from "./shared";
import { mark } from "./icons";
export function legacyChecklist(s:LinkSnapshot,now:number,reachable:boolean,bootstrap?:BootstrapState):SetupChecklist {
 return setupChecklist({version:bootstrap?.install.status==="done"?(s.console?.version??"installed"):null,planner:s.budget?.planner??null,service:{installed:bootstrap?.start.status==="done"||!!s.serviceInstalled,running:reachable},link:reachable,live:true,agents:bootstrap?.agents??[]},now);
}
function detail(i:SetupChecklist["items"][number]):string {
 if(i.detail) return i.detail.replace(/^Optional · /, "").replace(/^not connected$/, "Not connected");
 if(i.status==="failed") return "Needs attention";
 if(i.status==="done") return i.id==="service"?"Running":i.id==="strategy"?"Configured":"Connected";
 return i.id==="service"?"Not running yet":i.id==="binary"?"Not installed yet":i.id==="strategy"?"Not configured yet":"Not connected";
}
export function checklist(s:SetupChecklist,consoleLive:boolean):string {
 const rows=(required:boolean)=>s.items.filter(i=>i.required===required).map(i=>`<div class="step ${i.status}"><span class="step-num" aria-hidden="true">${i.status==="done"?"✓":i.status==="failed"?"!":"·"}</span><div class="stack grow"><strong>${h(i.title)}</strong><small>${h(detail(i))}</small></div></div>`).join("");
 const optional=rows(false);
 return `<div class="stack"><div class="list">${rows(true)}</div>${optional?`<section class="stack optional"><h2>Optional</h2><div class="list">${optional}</div></section>`:""}<small data-setup-checked="${s.checkedAt}">Checked 0 s ago</small>${consoleLive?'<button type="button" data-command="checkSetup" data-setup-check>Check now</button>':""}<small data-setup-auto${consoleLive?" hidden":""}>Re-checks every 5 seconds</small></div>`;
}
export function setup(s:LinkSnapshot,now:number,reachable:boolean,bootstrap?:BootstrapState,state?:SetupChecklist,consoleLive=false,consoleHint=""):string {
 return `<div class="content"><header class="brand">${mark}<strong class="grow">pacer</strong><button type="button" data-view="settings" aria-label="Settings">⚙</button></header><h1 class="headline">Setup</h1><div class="note stack"><strong>Finish setup in a terminal:</strong><code class="command" style="user-select:all">pacer init</code></div>${checklist(state??legacyChecklist(s,now,reachable,bootstrap),consoleLive)}${consoleHint}</div><div class="actionbar">${actionStatus}</div>`;
}
