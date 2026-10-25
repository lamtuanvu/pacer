import {expect,test} from 'bun:test';
import {createCallAuthority} from '../src/plugins/authority';
import {fakeCtx} from './helpers';
test('issued write resources are immutable snapshots of exact paths and operations', async()=>{
  const resources={reads:[],commands:[],stores:[],writes:[{path:'/owned/opencode.json',kind:'file' as const,operations:['write' as const]}]};
  const owner=createCallAuthority(fakeCtx(),resources,{deadlineMs:Date.now()+1000});
  try{
    resources.writes[0]!.path='/changed';
    expect((owner.resources as typeof resources).writes[0]!.path).toBe('/owned/opencode.json');
    expect(Object.isFrozen((owner.resources as typeof resources).writes)).toBe(true);
    expect(Object.isFrozen((owner.resources as typeof resources).writes[0]!.operations)).toBe(true);
  }finally{await owner.revoke();}
});
