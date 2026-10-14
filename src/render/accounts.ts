import { parseRunnerId } from "../config/runner-id";
export const names: Record<string,string> = {"claude-code":"Claude",codex:"Codex",cursor:"Cursor",agy:"Antigravity",byteplus:"BytePlus",local:"Local",opencode:"OpenCode"};
const providerName=(id:string)=>(Object.hasOwn(names,id) ? names[id] : undefined) ?? id.charAt(0).toUpperCase()+id.slice(1);
export function displayName(id: string): string {
  const runner = parseRunnerId(id);
  if (runner?.agent === "opencode" && runner.account) return providerName(runner.account);
  if (runner?.account) return `${runner.agent === "claude-code" ? "Claude Code" : providerName(runner.agent)} (${runner.account})`;
  return providerName(runner?.agent ?? id);
}

export interface RunnerRow { id: string; account?: string; agent?: string }
export function runnerLabel(p: RunnerRow): string {
  return p.agent === "opencode" && p.account ? providerName(p.account) : displayName(p.id);
}
/** First-seen account order, stable runner order within each account. */
export function accountGroups<T extends RunnerRow>(rows: T[]): {account?: string; rows: T[]}[] {
  const groups: {account?: string; rows:T[]}[]=[];
  for(const row of rows) {
    const account=row.agent ? row.account : undefined;
    let group=groups.find(g=>g.account===account);
    if(!group) {group={account,rows:[]};groups.push(group);}
    group.rows.push(row);
  }
  return groups;
}

export function renderRoute(rows: (RunnerRow & {index: number; reason: string})[]): string[] {
  if (!accountGroups(rows).some(g=>g.account && g.rows.length >= 2)) {
    return rows.map(e=>`${e.index+1}. ${e.id} (${runnerLabel(e)}): ${e.reason}`);
  }
  return accountGroups(rows).flatMap(g=>[...(g.account && g.rows.length >= 2 ? [`Account ${g.account}`] : []),...g.rows.map(e=>`${e.index+1}. ${e.id} (${runnerLabel(e)}): ${e.reason}`)]);
}
