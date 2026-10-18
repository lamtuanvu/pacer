import { cmdToOp } from "../api/cmd";
import type { ExecutorRow } from "../api/read-model/types";
import type { Action } from "../attention/types";
import type { CmdData } from "../link/envelope";
import type { ClientSnapshot, ClientTask } from "../view-model/snapshot";
import { capacity, counts, doneToday, needsYou, plannerMeter, running } from "../view-model/selectors";
import { ago, clock, elapsed, meterText } from "../view-model/format";
import { executorLabel, phaseWords, taskStatus } from "../view-model/words";

export type DashboardAction = CmdData | Action;
export interface Card {
 id: string; text: string; detail?: string; account?: string;
 action?: DashboardAction; dismiss?: DashboardAction; actions?: Action[];
 executor?: ExecutorRow; sessionTaskId?: string;
}
/** The exact same selection, order and counts as the app. No client-side routing. */
export function dashboardModel(s: ClientSnapshot) {
 const scope = { repo: null };
 return { needsYou: needsYou(s, scope), running: running(s, scope), capacity: capacity(s),
  doneToday: doneToday(s, scope), counts: counts(s), planner: plannerMeter(s) };
}
export function actionAvailable(action: DashboardAction, ops?: readonly string[]): boolean {
 if("op" in action&&action.op==="ui.open")return true;
 const op = "op" in action ? action.op : action.cmd==="attach" ? "task.attach" : cmdToOp(action)?.op;
 return !op || ops === undefined || ops.includes(op);
}
export function cards(s: ClientSnapshot, now: number, ops?: readonly string[]): { title: string; cards: Card[] }[] {
 const model = dashboardModel(s);
 const taskCard = (t: ClientTask, recent = false): Card => {
  const sessionTaskId = t.session && t.session.host !== "none" && (ops===undefined||ops.includes("task.attach")) ? t.id : undefined;
  const action: CmdData | undefined = t.session && t.session.host !== "none" ? {cmd:"attach",taskId:t.id} : t.terminalPresent ? {cmd:"focus",taskId:t.id} : recent ? undefined : {cmd:"stop",taskId:t.id};
  const dismiss: CmdData | undefined = recent ? {cmd:"dismiss",taskId:t.id} : undefined;
  return {id: `${recent ? "done" : "running"}:${t.id}`, sessionTaskId,
   text: t.title ?? t.goal,
   detail: [executorLabel(t.executor), t.repo?.label, t.progress ? phaseWords(t.progress.phase) : taskStatus(t).label,
    recent ? clock(t.updatedAt,now,"UTC") : elapsed(now-(t.attemptStartedAt??t.updatedAt)),
    t.progress ? `${t.progress.files} files · ${t.progress.commits} commits` : undefined,
    t.progress?.lastOutputAt != null ? `output ${ago(t.progress.lastOutputAt,now)}` : undefined].filter(Boolean).join(" · "),
   action: action && actionAvailable(action,ops) ? action : undefined,
   dismiss: dismiss && actionAvailable(dismiss,ops) ? dismiss : undefined};
 };
 return [
  {title:"NEEDS YOU",cards:model.needsYou.map(item=>{
   const actions=item.actions.filter(action=>actionAvailable(action,ops));
   return {id:item.id,text:item.title,detail:item.detail,actions,action:actions[0],dismiss:actions.find(a=>a.op==="task.dismiss")};
  })},
  {title:"WHO RUNS NEXT",cards:model.capacity.map(row=>({
   id:`executor:${row.id}`, text:`${row.rank === "planner" ? "P" : row.rank} ${executorLabel(row.id)}${row.next ? " · next" : ""}`,
   detail:`${meterText(row.usedPct,row.pacePct,"full")} · ${row.sub} · ${row.slots.used}/${row.slots.max} tasks`,
   executor:row,
  }))},
  {title:"RUNNING",cards:model.running.map(t=>taskCard(t))},
  {title:"DONE TODAY",cards:model.doneToday.map(t=>taskCard(t,true))},
 ];
}
