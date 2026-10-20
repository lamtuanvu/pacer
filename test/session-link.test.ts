import { expect, test } from 'bun:test';
import { parseOutboxEvent, emptySnapshot } from '../src/link/envelope';
import { screenItems } from '../src/dashboard/render';
import { sessionTaskData } from '../src/session/link';
import { fakeCtx } from './helpers';
import { createTask } from '../src/tasks/store';
import { updateOrcaState } from '../src/exec/orca/state';
test('session envelope clips labels and viewer counts and rejects unknown hosts',()=>{
 const base={id:'t',state:'running',updatedAt:0};
 const e=parseOutboxEvent({type:'task',data:{...base,session:{host:'builtin',live:true,controller:'a'.repeat(100),viewers:1000}}});
 expect(e?.type==='task'&&e.data.session).toEqual({host:'builtin',live:true,controller:'a'.repeat(64),viewers:99});
 const bad=parseOutboxEvent({type:'task',data:{...base,session:{host:'evil',live:true}}});
 expect(bad?.type==='task'&&bad.data.session).toBeUndefined();
});
test('dashboard watches sessions here and offers terminal and tmux targets',()=>{
 const s=emptySnapshot();s.tasks=[{id:'t',state:'running',goal:'g',executor:null,backend:'direct',worktree:null,updatedAt:0,session:{host:'builtin',live:true,controller:null,viewers:0}}];
 const item=screenItems(s,1,{ops:['task.attach']}).find(i=>i.id==='task:t')!;
 expect(item.primary?.effect).toEqual({type:'attach',id:'t',target:'here'});
 expect(item.keys.t?.effect).toEqual({type:'attach',id:'t',target:'terminal'});
 expect(item.keys.m?.effect).toEqual({type:'attach',id:'t',target:'tmux'});
 expect(screenItems(s,1,{ops:[]}).find(i=>i.id==='task:t')!.primary?.effect).toEqual({type:'navigate',screen:'sessions',id:'t'});
});
test('link session data throttles lookups but reflects Orca terminal receipts at once',async()=>{
 const ctx=fakeCtx();const t=createTask(ctx,{brief:{goal:'g',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:30});
 updateOrcaState(ctx,s=>{s.workers.d={dispatchId:'d',taskId:t.id,executor:'codex',terminal:'term',startedAt:0,worktree:null};});
 const data={id:t.id,state:'running',goal:'g',executor:null,backend:'orca',worktree:null,updatedAt:0};
 const first=await sessionTaskData(ctx,data,true);expect(first.session?.live).toBe(true);expect(first.terminalPresent).toBe(true);
 const soon=await sessionTaskData({...ctx,now:ctx.now+0.5},data,false);expect(soon.session?.live).toBe(false);expect(soon.terminalPresent).toBe(false);
 expect((await sessionTaskData({...ctx,now:ctx.now+0.7},data,true)).terminalPresent).toBe(true);
});
test('dashboard names the selected session action Watch',async()=>{
 const {renderDashboard}=await import('../src/dashboard/render');const s=emptySnapshot();
 s.tasks=[{id:'t',state:'running',goal:'g',executor:null,backend:'direct',worktree:null,updatedAt:0,session:{host:'builtin',live:true,controller:null,viewers:0}}];
 expect(renderDashboard(s,100,30,1,{selected:0,noColor:true,ops:['task.attach']})).toContain('⏎ Watch');
});
