import {expect,test} from 'bun:test';
import {budgetOf} from '../app/src/screens/insights/model';
import type {ClientSnapshot} from '../src/view-model/snapshot';
const snapshot=(account:object,executor:object={})=>({accounts:[{name:'sample',agent:'codex',executors:['codex#sample'],...account}],executors:[{id:'codex#sample',...executor}]} as ClientSnapshot);
test('Insights budget describes authoritative pace and freshness, not percentage thresholds',()=>{
 expect(budgetOf('codex',snapshot({verdict:'ahead',usedPct:4}))).toEqual({label:'Ahead of pace',tone:'warn'});
 expect(budgetOf('codex',snapshot({verdict:'behind',usedPct:90}))).toEqual({label:'Under pace',tone:'good'});
 expect(budgetOf('codex',snapshot({verdict:'on_pace'}))).toEqual({label:'Ready',tone:'good'});
 expect(budgetOf('codex',snapshot({verdict:'out'}))).toEqual({label:'Budget exhausted',tone:'bad'});
 expect(budgetOf('codex',snapshot({stale:true,verdict:'behind'}))).toEqual({label:'Stale reading',tone:'warn'});
 expect(budgetOf('codex',snapshot({verdict:'unknown'},{paceReason:'unmetered'}))).toEqual({label:'Unmetered',tone:'neutral'});
 expect(budgetOf('codex',null)).toEqual({label:'Usage unknown',tone:'neutral'});
 expect(budgetOf('cursor',snapshot({verdict:'ahead'}))).toEqual({label:'Usage unknown',tone:'neutral'});
});
