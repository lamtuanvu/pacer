import { expect, test } from 'bun:test';
import { createWorkspaceManager, workspaceKey } from '../app/src/workspace/manager';
function storage() { const rows = new Map<string,string>(); return { rows, getItem: (k:string) => rows.get(k) ?? null, setItem: (k:string,v:string) => { rows.set(k,v); }, removeItem: (k:string) => { rows.delete(k); } }; }
test('workspace values are scoped by service and task, only drafts and open sessions survive reload', () => {
 const disk=storage(), manager=createWorkspaceManager(disk), a=workspaceKey('one','task'), b=workspaceKey('two','task');
 manager.set(a,'draft:answer','hello'); manager.set(a,'scroll',42); manager.set(a,'openSessions',['task']);
 expect(manager.get(b,'draft:answer','')).toBe('');
 manager.flush(); const reload=createWorkspaceManager(disk);
 expect(reload.get(a,'draft:answer','')).toBe('hello'); expect(reload.get(a,'scroll',0)).toBe(0); expect(reload.get<string[]>(a,'openSessions',[])).toEqual(['task']);
 manager.set(a,'draft:answer',''); manager.flush(); expect(createWorkspaceManager(disk).get(a,'draft:answer','')).toBe('');
});
test('draft cap counts UTF-8 bytes and clearing an identity removes memory and disk', () => {
 const disk=storage(), manager=createWorkspaceManager(disk), a=workspaceKey('one','task'), b=workspaceKey('two','task');
 manager.set(a,'draft:answer','😀'.repeat(20000)); manager.set(b,'draft:answer','other');
 expect(new TextEncoder().encode(manager.get(a,'draft:answer','')).length).toBeLessThanOrEqual(65536);
 manager.flush(); manager.clearIdentity('one'); expect(manager.get(a,'draft:answer','')).toBe(''); expect(createWorkspaceManager(disk).get(b,'draft:answer','')).toBe('other');
});
test('denied and malformed storage retain memory state', () => {
 const manager=createWorkspaceManager({getItem:()=>'{',setItem:()=>{throw Error('denied');},removeItem:()=>{throw Error('denied');}}), key=workspaceKey('one','a');
 manager.set(key,'draft:thread','still editable'); expect(manager.get(key,'draft:thread','')).toBe('still editable'); manager.flush(); manager.clearIdentity('one'); expect(manager.get(key,'draft:thread','')).toBe('');
});
test('subscriptions only notify the changed field and writes are debounced', () => {
 const disk=storage(), manager=createWorkspaceManager(disk), key=workspaceKey('service','a'); let calls=0;
 manager.subscribe(key,'draft:answer',()=>calls++);
 manager.set(key,'position',{}); expect(calls).toBe(0);
 manager.set(key,'draft:answer','a'); manager.set(key,'draft:answer','ab'); expect(calls).toBe(2); expect(disk.rows.size).toBe(0);
 manager.flush(); expect(createWorkspaceManager(disk).get(key,'draft:answer','')).toBe('ab');
});
test('manager caps keys at 200 and prunes missing tasks after 24 hours', () => {
 const manager=createWorkspaceManager();
 for(let i=0;i<201;i++) manager.set(workspaceKey('service',String(i)),'position',i);
 expect(manager.has(workspaceKey('service','0'),'position')).toBe(false);
 const now=Date.now(); manager.prune('service',new Set(['200']),now); manager.prune('service',new Set(['200']),now+86400001);
 expect(manager.has(workspaceKey('service','1'),'position')).toBe(false);
 expect(manager.has(workspaceKey('service','200'),'position')).toBe(true);
});
import { reconcileIdentity } from '../app/src/workspace/manager';
test('changing hello identity clears old persisted drafts and sign-out clears the current service', () => {
 const disk=storage(),manager=createWorkspaceManager(disk),old=workspaceKey('hello-one','task'),next=workspaceKey('hello-two','task');
 manager.set(old,'draft:answer','old');manager.set(next,'draft:answer','new');manager.flush();
 reconcileIdentity(manager,'hello-one','hello-two',false);expect(manager.get(old,'draft:answer','')).toBe('');expect(manager.get(next,'draft:answer','')).toBe('new');expect(createWorkspaceManager(disk).get(old,'draft:answer','')).toBe('');
 reconcileIdentity(manager,'hello-two','hello-two',true);expect(manager.get(next,'draft:answer','')).toBe('');
});

import { initialState, reduceStore } from '../app/src/data/store';
import { resolveWorkspaceIdentity } from '../app/src/workspace/identity';
test('same machine and origin retain drafts and open sessions across a version upgrade and reload', async () => {
 const disk=storage(),origin='http://pacer.test',call=async<T,>()=>({id:'machine-a'} as T);
 const hello={pacer:'1.0.0',protocol:'3.0.0',ops:['machine.get'],events:[]} as any;
 let state=reduceStore(initialState(),{type:'hello',hello});
 const first=await resolveWorkspaceIdentity(origin,state.features.ops,call),manager=createWorkspaceManager(disk),key=workspaceKey(first,'task');
 manager.selectIdentity(origin,first);manager.set(key,'draft:answer','upgrade draft');manager.set(key,'openSessions',['task']);manager.flush();
 state=reduceStore(state,{type:'hello',hello:{...hello,pacer:'2.0.0'}});expect(state.version).toBe('2.0.0');
 const upgraded=await resolveWorkspaceIdentity(origin,state.features.ops,call),reload=createWorkspaceManager(disk);
 reload.selectIdentity(origin,upgraded);
 expect(upgraded).toBe(first);expect(reload.get(key,'draft:answer','')).toBe('upgrade draft');expect(reload.get<string[]>(key,'openSessions',[])).toEqual(['task']);
});
test('different machine on the same origin clears previous drafts even across a page reload', async () => {
 const disk=storage(),origin='http://pacer.test',first=await resolveWorkspaceIdentity(origin,new Set(['machine.get']),async<T,>()=>({id:'a'} as T)),manager=createWorkspaceManager(disk),key=workspaceKey(first,'task');
 manager.selectIdentity(origin,first);manager.set(key,'draft:answer','old');manager.flush();
 const next=await resolveWorkspaceIdentity(origin,new Set(['machine.get']),async<T,>()=>({id:'b'} as T)),reload=createWorkspaceManager(disk);reload.selectIdentity(origin,next);
 expect(next).not.toBe(first);expect(reload.get(key,'draft:answer','')).toBe('');expect(createWorkspaceManager(disk).get(key,'draft:answer','')).toBe('');
 expect(await resolveWorkspaceIdentity('http://other.test',new Set(['machine.get']),async<T,>()=>({id:'b'} as T))).not.toBe(next);
});
test('unavailable or failed machine lookup falls back to the page origin', async () => {
 const origin='http://pacer.test';let calls=0;
 expect(await resolveWorkspaceIdentity(origin,new Set(),async<T,>()=>{calls++;return {} as T;})).toBe(origin);expect(calls).toBe(0);
 expect(await resolveWorkspaceIdentity(origin,new Set(['machine.get']),async()=>{throw Error('unavailable');})).toBe(origin);
 expect(await resolveWorkspaceIdentity(origin,new Set(['machine.get']),async<T,>()=>({id:''} as T))).toBe(origin);
});
