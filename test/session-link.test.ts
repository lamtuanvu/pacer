import { expect, test } from 'bun:test';
import { parseEnvelope, parseCmd, emptySnapshot } from '../src/link/envelope';
import { cards } from '../src/dashboard/model';
import { viewerAction } from '../src/dashboard/input';
import { sessionTaskData } from '../src/session/link';
import { fakeCtx } from './helpers';
import { createTask } from '../src/tasks/store';
import { updateOrcaState } from '../src/exec/orca/state';
test('session envelope clips labels and viewer counts and rejects unknown hosts',()=>{
 const base={id:'t',state:'running',updatedAt:0};
 const e=parseEnvelope({v:1,type:'task',data:{...base,session:{host:'builtin',live:true,controller:'a'.repeat(100),viewers:1000}}});
 expect(e?.type==='task'&&e.data.session).toEqual({host:'builtin',live:true,controller:'a'.repeat(64),viewers:99});
 const bad=parseEnvelope({v:1,type:'task',data:{...base,session:{host:'evil',live:true}}});
 expect(bad?.type==='task'&&bad.data.session).toBeUndefined();
});
test('attach requires taskId, validates target; focus remains valid',()=>{
 const cmd=(data:unknown)=>parseCmd({v:1,type:'cmd',data});
 expect(cmd({cmd:'attach'})).toBeNull();expect(cmd({cmd:'attach',taskId:'t',target:'tmux'})).toBeNull();
 expect(cmd({cmd:'attach',taskId:'t',target:'terminal'})?.data.target).toBe('terminal');
 expect(cmd({cmd:'attach',taskId:'t'})?.data.target).toBe('orca');
 expect(cmd({cmd:'focus',taskId:'t'})?.data.cmd).toBe('focus');
});
test('dashboard shows Attach and chooses here, terminal and tmux targets',()=>{
 const s=emptySnapshot();s.tasks=[{id:'t',state:'running',goal:'g',executor:null,backend:'direct',worktree:null,updatedAt:0,session:{host:'builtin',live:true,controller:null,viewers:0}}];
 const card=cards(s,1).flatMap(g=>g.cards).find(c=>c.id==='running:t')!;
 expect(card.action).toMatchObject({cmd:'attach',taskId:'t'});
 expect(viewerAction('enter',card)).toEqual({id:'t',target:'here'});
 expect(viewerAction('t',card)).toEqual({id:'t',target:'terminal'});
 expect(viewerAction('m',card)).toEqual({id:'t',target:'tmux'});
});
test('link session data throttles lookups but reflects Orca terminal receipts at once',async()=>{
 const ctx=fakeCtx();const t=createTask(ctx,{brief:{goal:'g',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:30});
 updateOrcaState(ctx,s=>{s.workers.d={dispatchId:'d',taskId:t.id,executor:'codex',terminal:'term',startedAt:0,worktree:null};});
 const data={id:t.id,state:'running',goal:'g',executor:null,backend:'orca',worktree:null,updatedAt:0};
 const first=await sessionTaskData(ctx,data,true);expect(first.session?.live).toBe(true);expect(first.terminalPresent).toBe(true);
 const soon=await sessionTaskData({...ctx,now:ctx.now+0.5},data,false);expect(soon.session?.live).toBe(false);expect(soon.terminalPresent).toBe(false);
 expect((await sessionTaskData({...ctx,now:ctx.now+0.7},data,true)).terminalPresent).toBe(true);
});
test('dashboard names the selected session action Attach',async()=>{
 const {renderDashboard}=await import('../src/dashboard/render');const s=emptySnapshot();
 s.tasks=[{id:'t',state:'running',goal:'g',executor:null,backend:'direct',worktree:null,updatedAt:0,session:{host:'builtin',live:true,controller:null,viewers:0}}];
 expect(renderDashboard(s,100,30,1,{selected:0,noColor:true})).toContain('Enter Attach');
});
