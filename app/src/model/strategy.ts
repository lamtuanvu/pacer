export interface ConfigData { keys: Record<string,{value:unknown;source?:string}>; planners:string[]; terminalChoices?: {value:string;label:string}[] }
export const pacingFields = ['pacing.policy','pacing.planner_reserve','pacing.accounts','pacing.fill_threshold'] as const;
export type PacingDraft = Record<typeof pacingFields[number],string>;
export function pacingDraft(keys:ConfigData['keys']):PacingDraft { return Object.fromEntries(pacingFields.map(k=>[k,String(keys[k]?.value ?? '')])) as PacingDraft; }
export function pacingChanges(keys:ConfigData['keys'],draft:PacingDraft) {
 return pacingFields.flatMap(key=>{
 const text=draft[key]; let value:string|number=text;
 if(key==='pacing.planner_reserve'||key==='pacing.fill_threshold') { if(!/^\d+(\.\d+)?$/.test(text)||(key==='pacing.planner_reserve'?Number(text)>=100:Number(text)<50||Number(text)>100)) throw Error('Planner reserve must be 0–99%; fill threshold must be 50–100%.'); value=Number(text); }
 if(key==='pacing.policy'&&!['priority','even','burn-before-reset','cheapest-first'].includes(text)) throw Error('Choose a policy.');
 if(key==='pacing.accounts'&&!['spread','fill'].includes(text)) throw Error('Choose spread or fill.');
 return value===keys[key]?.value?[]:[{key,value}];
 });
}
export interface StrategyRow {name:string;active:boolean;summary:string;description?:string}
export function strategyRows(rows:StrategyRow[]) { return rows.map(r=>({...r,removable:!r.active&&r.name!=='default'})); }
