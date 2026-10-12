import { encodeCmdLine, type LinkSnapshot } from "../../../src/link/envelope";
import { connectionIndicator } from "./overview";
export interface WorktreeContext {worktreeId?:string;branch:string;displayName:string;terminals:{id:string}[]}
/** Reference encoder for form payloads. Reject oversized inputs; never shorten a brief. */
export function delegateLine(context:WorktreeContext|null, goal:string, acceptance:string, executor?:string):string {
 if(!context?.branch) throw new Error("Focus a worktree first.");
 if(!goal.trim()) throw new Error("What should be done is required.");
 if(goal.length>2000) throw new Error("Goal must be at most 2000 characters.");
 if(acceptance.length>500) throw new Error("Done when must be at most 500 characters.");
 if(executor&&!/^[a-z0-9-]{1,64}$/.test(executor)) throw new Error("Invalid executor.");
 return encodeCmdLine({cmd:"delegate",branch:context.branch,displayName:context.displayName,...(context.worktreeId?{worktreeId:context.worktreeId}:{}),goal,acceptance,...(executor?{executor}:{})});
}
export function delegateView(s:LinkSnapshot,now:number,reachable:boolean):string {
 return `<div id="delegate-form" role="group"><div class="content"><header><button type="button" data-view="overview" aria-label="Back to overview">←</button><strong>Delegate a task</strong><span class="grow"></span>${connectionIndicator(s,now,reachable)}</header><div class="muted">Write it the way you'd brief a colleague who can't see this chat. Claude plans; the task runs on an executor.</div><div class="stack"><label for="goal">What should be done?</label><textarea id="goal" name="goal" maxlength="2000" rows="5" placeholder="e.g. Make the owner-facing diag calls accept browser_turn_id, with a regression test"></textarea></div><div class="stack"><strong>Where</strong><div class="stack where"><strong data-worktree>—</strong><small>Branch <span id="worktree-branch">—</span> · focused worktree</small></div></div><div class="stack"><label for="done">Done when</label><input id="done" name="acceptance" type="text" maxlength="500" placeholder="A command that passes, e.g. bun test"><small>pacer runs it after the executor finishes and only reports done if it passes.</small></div><fieldset class="stack"><legend>Runs on</legend><label class="radio"><input type="radio" name="executor" value="" checked><span class="stack grow"><strong>Best available</strong><small><span id="ranked-order"></span></small></span><span class="pill">Recommended</span></label><div id="executor-options" class="stack"></div></fieldset><div class="row note"><strong aria-hidden="true">i</strong><small>Runs in its own worktree. You'll get a notification when it finishes, and it shows under Needs attention if it fails.</small></div></div><div class="actionbar"><div class="actions"><button type="button" data-view="overview">Cancel</button><button type="button" id="delegate-send" class="primary grow" data-live>Delegate</button></div></div></div>`;
}
