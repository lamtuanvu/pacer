import { parse } from 'yaml';
import { validateStrategy, type Strategy } from '../../../src/config/strategy';

/** Read strategy configuration only; account homes and credentials are never read. */
export function readPanelSettings(readText:(path:string)=>string|null, home:string, name='default'):{strategyConfig?:Strategy;updateCheck:boolean;error?:string} {
 try {
  const text=readText(name==='default'?`${home}/strategy.yaml`:`${home}/strategies/${name}.yaml`);
  if(!text)return {updateCheck:true};
  const raw=parse(text);
  return {strategyConfig:validateStrategy(raw,'active strategy',name),updateCheck:raw.update_check!==false};
 } catch {return {updateCheck:true,error:'Settings unavailable: fix the active strategy in a pacer terminal.'};}
}
