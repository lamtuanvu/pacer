import { actionStatus } from "./shared";
import { info } from "./icons";
import type { LinkSnapshot } from "../../../src/link/envelope";
import { connectionIndicator } from "./overview";
export function strategyView(s:LinkSnapshot,now:number,reachable:boolean):string {
 const agents=["claude-code","codex"].filter(id=>id===s.budget?.planner||s.budget?.providers.some(p=>p.id===id));
 return `<div class="content"><header><button type="button" data-view="overview" aria-label="Back to overview">←</button><strong>Strategy</strong><span class="grow"></span>${connectionIndicator(s,now,reachable)}</header>
 <section class="stack"><h2>Switch to</h2><div class="list strategy-list" id="strategy-list"></div></section>
 <div id="strategy-form" role="group" class="card stack strategy-builder"><strong>Build a new strategy with an agent</strong><small>Describe what you want. The agent drafts it, shows how routing would change, and asks before saving.</small>
 <label for="strategy-brief">What should it do?</label><textarea id="strategy-brief" rows="4" maxlength="2000" placeholder="e.g. Protect Claude this week. Burn Codex before it resets on Sunday."></textarea>
 <div class="row"><label class="stack grow">Start from<select id="strategy-from"></select></label><label class="stack grow">Agent<select id="strategy-agent">${agents.map(id=>`<option value="${id}"${id===s.budget?.planner?" selected":""}>${id==="claude-code"?"Claude Code":"Codex"}${id===s.budget?.planner?" (planner)":""}</option>`).join("")}</select></label></div>
 <div class="note row">${info}<small>Opens a new terminal in this worktree with the agent already briefed. You chat with it there; nothing changes until you approve the save. Switching stays a separate click here.</small></div></div>
 <section id="strategy-after" class="stack" hidden></section></div><div class="actionbar"><div class="actions"><button type="button" data-view="overview">Done</button><button type="button" id="strategy-send" class="primary grow" data-live${agents.length?"":" disabled"}>Start session</button></div>${actionStatus}</div>`;
}
