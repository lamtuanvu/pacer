import {expect,test} from 'bun:test';
import {fakeCtx} from './helpers';
import {ReadOwner} from '../src/plugins/read-owner';
import {EventSubscription} from '../src/plugins/event-subscription';
import {eventsSince} from '../src/api/events';
import {publish} from '../src/link/publish';
import type {PluginManifest} from '../src/plugins/protocol';
const manifest:PluginManifest={id:'event-test',publisher:'pacer',version:'1.0.0',host:'^1.5',capabilities:[{name:'events.subscribe'},{name:'tasks.read'}],contributes:{policy:{}},reentrant:true,tier:'free'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('subscriptions begin at current canonical v3 cursor and filter only future events',async()=>{
 const ctx=fakeCtx();await publish(ctx,[{type:'task',data:{id:'before',state:'queued',goal:'before',executor:null,backend:null,worktree:null,updatedAt:ctx.now}}]);
 const owner=new ReadOwner(ctx,manifest,['events.subscribe'],()=>true),received:unknown[]=[];
 const subscription=new EventSubscription(owner,['task'],{read:cursor=>eventsSince(owner.readContext(),cursor,3),deliver:async(event,guard)=>{guard();received.push(event);}});
 expect(subscription.cursor).toBe(eventsSince(ctx,0,3).last);
 await subscription.pump();await tick();expect(received).toEqual([]);
 await publish(ctx,[{type:'task',data:{id:'after',state:'queued',goal:'after',executor:null,backend:null,worktree:null,updatedAt:ctx.now}},{type:'mode',data:{mode:'normal',previous:null,strategy:'default',at:ctx.now}}]);
 await Promise.all([subscription.pump(),subscription.pump(),subscription.pump()]);await tick();
 expect(received).toHaveLength(1);expect(received[0]).toMatchObject({type:'task',data:{id:'after'}});subscription.retire();
});
test('overflow replaces obsolete queue with bounded resnapshot and retires on failed delivery',async()=>{
 const owner=new ReadOwner(fakeCtx(),manifest,['events.subscribe'],()=>true);let cursor=0,rows:any[]=[];
 let reject!: (error:Error)=>void;const delivered:any[]=[];let retired='';
 const subscription=new EventSubscription(owner,['task'],{read:()=>({events:rows,last:cursor,reset:false}),deliver:async(event,guard)=>{guard();delivered.push(event);await new Promise<void>((_,r)=>{reject=r;});},onRetire:reason=>{retired=reason;}});
 rows=Array.from({length:200},(_,n)=>({seq:n+1,at:1,type:'task',data:{id:`t${n}`}}));cursor=200;
 await subscription.pump();await tick();expect(subscription.pending.count).toBeLessThanOrEqual(128);expect(subscription.pending.bytes).toBeLessThanOrEqual(256*1024);
 expect(delivered[0]).toMatchObject({type:'reset',seq:200});expect(subscription.cursor).toBe(200);
 reject(Error('blocked transport'));await tick();expect(retired).toContain('delivery');expect(subscription.pending).toEqual({count:0,bytes:0});
 expect(()=>owner.assertActive()).toThrow('retired');
});
test('oversized and canonical retention reset notifications stay bounded regardless requested types',async()=>{
 const owner=new ReadOwner(fakeCtx(),manifest,['events.subscribe'],()=>true);let rows:any[]=[];let cursor=0;const received:any[]=[];
 const subscription=new EventSubscription(owner,['task'],{read:()=>({events:rows,last:cursor,reset:rows.some(e=>e.type==='reset')}),deliver:async(event,guard)=>{guard();received.push(event);}});
 rows=[{seq:1,at:1,type:'task',data:{payload:'x'.repeat(300*1024)}}];cursor=1;await subscription.pump();await tick();
 expect(received[0]).toMatchObject({type:'reset',seq:1});expect(Buffer.byteLength(JSON.stringify(received[0]))).toBeLessThan(1024);
 rows=[{seq:2,at:1,type:'reset',data:{reason:'canonical retention'}}];cursor=2;await subscription.pump();await tick();expect(received[1]).toMatchObject({type:'reset',seq:2});subscription.retire();
});
test('retirement forbids queued or new sends and executor work grants cannot subscribe globally',async()=>{
 const ctx=fakeCtx(),owner=new ReadOwner(ctx,manifest,['events.subscribe'],()=>true);let rows:any[]=[];let sent=0;
 const sub=new EventSubscription(owner,['task'],{read:()=>({events:rows,last:rows.length,reset:false}),deliver:async(_event,guard)=>{guard();sent++;}});
 rows=[{seq:1,at:1,type:'task',data:{}}];sub.retire();await sub.pump();expect(sent).toBe(0);
 const scoped=new ReadOwner({...ctx,env:{PACER_WORK_GRANT:'synthetic'}},manifest,['events.subscribe'],()=>true);
 expect(()=>new EventSubscription(scoped,['task'],{read:cursor=>eventsSince(scoped.readContext(),cursor,3),deliver:async()=>{}})).toThrow('global');
});
test('an active near-limit delivery still leaves bounded space for a reset',async()=>{
 const owner=new ReadOwner(fakeCtx(),manifest,['events.subscribe'],()=>true);let cursor=0,rows:any[]=[];let finish!:()=>void;
 const sub=new EventSubscription(owner,['task'],{read:()=>({events:rows,last:cursor,reset:false}),deliver:async()=>{await new Promise<void>(resolve=>{finish=resolve;});}});
 rows=[{seq:1,at:1,type:'task',data:{large:'x'.repeat(256*1024-150)}}];cursor=1;await sub.pump();
 rows=Array.from({length:200},(_,n)=>({seq:n+2,at:1,type:'task',data:{}}));cursor=201;await sub.pump();
 expect(sub.pending.count).toBeLessThanOrEqual(128);expect(sub.pending.bytes).toBeLessThanOrEqual(256*1024);sub.retire();finish();
});
