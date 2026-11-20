import {expect,test} from 'bun:test';
import {budgetOf} from '../app/src/screens/insights/model';
import {usageStateFor} from './usage-fixtures';
import type {ClientSnapshot} from '../src/view-model/snapshot';
const snapshot=(account:object,executor:object={})=>({accounts:[{name:'sample',agent:'codex',executors:['codex#sample'],...account}],executors:[{id:'codex#sample',...executor}]} as ClientSnapshot);
test('Insights budget describes the one verdict vocabulary and freshness, not percentage thresholds',()=>{
 expect(budgetOf('codex',snapshot({verdict:'ahead',usedPct:4,usageState:usageStateFor({usedPct:4,verdict:'AHEAD'},1800000000)}))).toEqual({label:'Ahead of pace',tone:'warn'});
 expect(budgetOf('codex',snapshot({verdict:'behind',usedPct:90,usageState:usageStateFor({usedPct:90,verdict:'BEHIND'},1800000000)}))).toEqual({label:'Behind pace',tone:'good'});
 expect(budgetOf('codex',snapshot({verdict:'on_pace',usageState:usageStateFor({usedPct:20,verdict:'ON_PACE'},1800000000)}))).toEqual({label:'Available',tone:'good'});
 expect(budgetOf('codex',snapshot({verdict:'out',usageState:usageStateFor({usedPct:100,verdict:'EXHAUSTED'},1800000000)}))).toEqual({label:'Out of quota',tone:'bad'});
 expect(budgetOf('codex',snapshot({stale:true,verdict:'behind',usageState:usageStateFor({usedPct:20,stale:true},1800000000)}))).toEqual({label:'Stale reading',tone:'warn'});
 expect(budgetOf('codex',snapshot({verdict:'UNMETERED',usageState:usageStateFor({usedPct:null,verdict:'UNMETERED'},1800000000)},{paceReason:'unmetered'}))).toEqual({label:'Unmetered',tone:'good'});
 expect(budgetOf('codex',null)).toEqual({label:'Usage unknown',tone:'neutral'});
 expect(budgetOf('cursor',snapshot({verdict:'ahead',usageState:usageStateFor({usedPct:4,verdict:'AHEAD'},1800000000)}))).toEqual({label:'Usage unknown',tone:'neutral'});
});
