import { cmdToOp } from "../api/cmd";
import type { CmdData, LinkSnapshot, ProviderLine } from "../link/envelope";
import { attentionGroups, attentionText, mutedProviders, rankedProviders, verdictWords } from "../view-model/panel";
import { accountGroups, runnerLabel } from "../render/accounts";
export interface Card { id: string; text: string; account?: string; action?: CmdData; dismiss?: CmdData; provider?: ProviderLine }
export function cards(s: LinkSnapshot, now: number, ops?: readonly string[]): { title: string; cards: Card[] }[] {
 const provider = (p: ProviderLine): Card => ({ id: `executor:${p.id}`, provider:p, ...(p.agent?{account:p.account}:{}), text:`${runnerLabel(p)}: ${verdictWords(p.verdict)} · ${p.usedPct === null ? "unmetered / unknown" : `${Math.round(p.usedPct)}% used`}${p.blockedReason ? " · blocked" : p.brokenReason ? ` · ${p.brokenReason}` : p.unavailableReason ? ` · usage-only: ${p.unavailableReason}` : ""}` });
 const grouped=(rows:ProviderLine[])=>accountGroups(rows).flatMap(g=>g.rows).map(provider);
 const attention=attentionGroups(s,now);
 const groups: {title:string;cards:Card[]}[] = [
  {title:"Who runs next",cards:grouped(rankedProviders(s))},
  {title:"Unavailable executors",cards:grouped(mutedProviders(s))},
  {title:"Needs attention",cards:attention.map(g=>({id:g.latest.id,text:`${g.goal} · ${attentionText(g,now)}${g.stuck?(ops===undefined||ops.includes("task.stop")?" · stop":""):g.retry&&(ops===undefined||ops.includes("task.retry"))?` · retry on ${g.retry.id}`:""}`,action:g.stuck?{cmd:"stop",taskId:g.latest.id}:g.retry?{cmd:"retry",taskId:g.latest.id,executor:g.retry.id}:undefined,dismiss:g.tasks.length?{cmd:"dismiss",taskIds:g.tasks.map(t=>t.id)}:undefined}))},
  {title:"Running tasks",cards:s.tasks.filter(t=>["running","queued"].includes(t.state)).map(t=>({id:`running:${t.id}`,text:`${t.goal} · ${t.executor??"queued"} · ${Math.max(0,Math.floor(now-(t.attemptStartedAt??t.updatedAt)))}s${t.progress?` · ${t.progress.phase}${t.progress.files?` · ${t.progress.files} files`:""}${t.progress.lastOutputAt!==null?` · output ${Math.max(0,Math.floor(now-t.progress.lastOutputAt))}s ago`:""}`:""}`,action:{cmd:t.terminalPresent?"focus":"stop",taskId:t.id}}))},
  {title:"Recently done",cards:s.tasks.filter(t=>t.state==="done"&&!t.dismissed).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,3).map(t=>({id:t.id,text:`${t.goal} · ${t.executor??"done"}`,action:t.terminalPresent?{cmd:"focus",taskId:t.id}:undefined,dismiss:{cmd:"dismiss",taskId:t.id}}))},
 ];
 const retryIds=attention.filter(group=>!group.stuck).flatMap(group=>group.tasks.map(task=>task.id));
 if(retryIds.length && ops?.includes("task.retry_all"))groups.find(g=>g.title==="Needs attention")!.cards.push({id:"retry-all",text:"Retry all",action:{cmd:"retry-all",taskIds:retryIds}});
 return groups.map(group=>({...group,cards:group.cards.map((card:Card)=>{
   const available=(action?:CmdData)=>!action||ops===undefined||!cmdToOp(action)||ops.includes(cmdToOp(action)!.op);
   return {...card,action:available(card.action)?card.action:undefined,dismiss:available(card.dismiss)?card.dismiss:undefined};
 })}));
}
