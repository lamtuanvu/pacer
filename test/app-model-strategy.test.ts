import { expect, test } from 'bun:test';
import { pacingDraft, pacingChanges, strategyRows } from '../app/src/model/strategy';
test('pacing sends only changed keys and numeric draft values', () => {
 const keys = {'pacing.policy':{value:'priority'},'pacing.planner_reserve':{value:15},'pacing.accounts':{value:'spread'},'pacing.fill_threshold':{value:90}};
 const draft = pacingDraft(keys);
 expect(pacingChanges(keys,draft)).toEqual([]);
 draft['pacing.planner_reserve']='20';
 expect(pacingChanges(keys,draft)).toEqual([{key:'pacing.planner_reserve',value:20}]);
 expect(() => pacingChanges(keys,{...draft,'pacing.fill_threshold':'101'})).toThrow();
 expect(() => pacingChanges(keys,{...draft,'pacing.planner_reserve':''})).toThrow();
});
test('protects default and active strategies from removal', () => {
 expect(strategyRows([{name:'default',active:false,summary:'Default'},{name:'night',active:true,summary:'Night'},{name:'old',active:false,summary:'Old'}]).map(r=>r.removable)).toEqual([false,false,true]);
});
test('pacing uses server policy names and percentage bounds', () => {
 const keys={'pacing.policy':{value:'priority'},'pacing.planner_reserve':{value:15},'pacing.accounts':{value:'spread'},'pacing.fill_threshold':{value:90}};
 const draft=pacingDraft(keys);
 expect(pacingChanges(keys,{...draft,'pacing.policy':'burn-before-reset'})).toEqual([{key:'pacing.policy',value:'burn-before-reset'}]);
 expect(()=>pacingChanges(keys,{...draft,'pacing.fill_threshold':'49'})).toThrow();
 expect(()=>pacingChanges(keys,{...draft,'pacing.planner_reserve':'100'})).toThrow();
});
