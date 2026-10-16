import { expect, test } from 'bun:test';
import { setupModel } from '../app/src/model/setup';
test('gates only required incomplete items and maps in-place actions', () => {
 const model=setupModel({checkedAt:0,complete:false,items:[{id:'strategy',title:'Strategy',status:'pending',required:true},{id:'service',title:'Login service',status:'failed',required:true},{id:'agent:codex',title:'Codex',status:'pending',required:false},{id:'live',title:'Live plugin',status:'pending',required:false}]});
 expect(model.complete).toBe(false);
 expect(model.items.map(i=>i.action)).toEqual(['planner','service','agent','plugin']);
 expect(model.items[1]!.command).toBe('pacer service install');
 expect(setupModel({checkedAt:0,complete:true,items:[{id:'live',title:'Live plugin',status:'pending',required:false}]}).complete).toBe(true);
});
