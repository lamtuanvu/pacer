import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { terminalRecipe, attachCommand } from '../src/session/targets';
import { BuiltinSessionHost, OrcaSessionHost, sessionInfo, openSession } from '../src/session/service';
import { callOp } from '../src/api/ops';
import { fakeCtx } from './helpers';
import { writeJsonAtomic } from '../src/fsutil';
const id='t-20261016-120000-abcd';
function task(ctx:ReturnType<typeof fakeCtx>){writeJsonAtomic(join(ctx.pacerHome,"tasks",`${id}.json`),{id,state:'done',createdAt:1,brief:{goal:'view',repo:ctx.home},kind:null,requestedExecutor:null,executor:'codex',backend:'direct',attempts:[],timeoutS:300} as any);}
test('terminal presets produce executable argv and custom templates split without shell',()=>{
 const expected:Record<string,string>={ghostty:'ghostty',iterm:'osascript','terminal-app':'osascript',wezterm:'wezterm',kitty:'kitty',alacritty:'alacritty','gnome-terminal':'gnome-terminal','x-terminal-emulator':'x-terminal-emulator'};
 for(const [preset,exe] of Object.entries(expected))expect(terminalRecipe(preset,id,'linux')[0]).toBe(exe);
 expect(terminalRecipe('my-terminal --title "watch now" -- {cmd}',id,'linux')).toEqual(['my-terminal','--title','watch now','--','pacer','attach',id]);
 expect(terminalRecipe('my-terminal --command {cmd}',id,'linux').slice(-3)).toEqual(['pacer','attach',id]);
 expect(terminalRecipe('ghostty',id,'darwin').slice(0,4)).toEqual(['open','-na','Ghostty','--args']);
 expect(()=>terminalRecipe('kitty','x;touch BAD','linux')).toThrow();
 expect(()=>terminalRecipe('custom missing placeholder',id,'linux')).toThrow();
 expect(attachCommand(id)).toBe(`pacer attach ${id}`);
});
test('absent session returns none metadata and launch fallback, API registered',async()=>{
 const ctx=fakeCtx();task(ctx);
 expect(await sessionInfo(ctx,id)).toMatchObject({host:'none',live:false,targets:[],controller:null,viewers:0});
 expect(await openSession(ctx,id,'tmux')).toEqual({opened:false,command:`pacer attach ${id}`});
 expect(await callOp(ctx,'task.session',{id})).toMatchObject({host:'none'});
 await expect(callOp(ctx,'task.session',{id:'../escape'})).rejects.toThrow();
});
test('offline builtin offers replay viewers and no app socket',async()=>{
 const ctx=fakeCtx();task(ctx);const dir=join(ctx.pacerHome,'runs',id,'1');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'session.ckpt'),JSON.stringify({cols:80,rows:24}));writeFileSync(join(dir,'exit'),'0');
 expect(await sessionInfo(ctx,id)).toMatchObject({host:'builtin',live:false,cols:80,rows:24,targets:expect.arrayContaining(['here'])});
});
test('builtin and Orca adapters conform to RunIO and refuse unsupported control',async()=>{
 const ctx=fakeCtx();const builtin=new BuiltinSessionHost(ctx.home);
 expect(builtin.id).toBe('builtin');expect(builtin.capabilities.control).toBe(false);
 expect((await builtin.read()).alive).toBe(false);expect(builtin.attachTarget().kind).toBe('socket');
 const orca=new OrcaSessionHost(ctx,{dispatchId:'d',terminal:'term',startedAt:1,taskId:id,executor:'codex',worktree:null});
 expect(orca.id).toBe('orca');expect(orca.attachTarget()).toEqual({kind:'orca',terminal:'term'});
 expect(await orca.start({dir:ctx.home,argv:[],cwd:ctx.home,env:{}})).toHaveProperty('error');
});
test('custom template expands standalone placeholders, including quoted argv words',()=>{
 expect(terminalRecipe('viewer --command {cmd}',id,'linux')).toEqual(['viewer','--command','pacer','attach',id]);
 expect(terminalRecipe('viewer --command "{cmd}"',id,'linux')).toEqual(['viewer','--command','pacer','attach',id]);
});
test('Orca adapter uses worker lifecycle receipts for read and stop',async()=>{
 const calls:string[][]=[];const ctx=fakeCtx({run:async argv=>{
  calls.push(argv);return {code:0,stderr:'',stdout:JSON.stringify({ok:true,result:argv.includes('worker-show')?{worker:{state:'succeeded'}}:{state:'stopped'}})};
 }});
 const host=new OrcaSessionHost(ctx,{dispatchId:'dispatch',terminal:'term',startedAt:1,taskId:id,executor:'codex',worktree:null});
 expect(await host.read()).toMatchObject({alive:false,exit:0});expect(await host.stop({graceMs:20,sleep:async()=>{}})).toEqual({code:143,killed:false});
 expect(calls.map(a=>a.slice(0,3))).toEqual([['orca','orchestration','worker-show'],['orca','orchestration','worker-stop']]);
});
test('terminal.open is editable and malformed template settings are rejected',async()=>{
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n');
 expect(await callOp(ctx,'config.set',{key:'terminal.open',value:'kitty'})).toMatchObject({key:'terminal.open',value:'kitty'});
 await expect(callOp(ctx,'config.set',{key:'terminal.open',value:'invalid'})).rejects.toThrow();
});
test('terminal viewers return promptly while keeping a long-lived process alive',async()=>{
 const { launchViewer }=await import('../src/session/targets');
 const ctx=fakeCtx({env:{PATH:process.env.PATH}}),marker=join(ctx.home,'viewer-alive');
 const began=Date.now();
 expect(await launchViewer(ctx,[process.execPath,'-e',"setTimeout(()=>Bun.write(process.argv.at(-1),'alive'),400)",marker])).toBe(true);
 expect(Date.now()-began).toBeLessThan(350);
 for(let i=0;i<30;i++){if((await Bun.file(marker).exists()))break;await Bun.sleep(25);}
 expect(await Bun.file(marker).text()).toBe('alive');
 expect(await launchViewer(ctx,[process.execPath,'-e','process.exit(1)'])).toBe(false);
});
test('desktop viewer availability rejects SSH and Linux without a display',async()=>{
 const { hasDesktop }=await import('../src/session/targets');
 expect(hasDesktop(fakeCtx({env:{TERM_PROGRAM:'ghostty'}}),'linux')).toBe(false);
 expect(hasDesktop(fakeCtx({env:{SSH_CONNECTION:'remote',TERM_PROGRAM:'Apple_Terminal'}}),'darwin')).toBe(false);
 expect(hasDesktop(fakeCtx({env:{DISPLAY:':0'}}),'linux')).toBe(true);
});
test('publishing session metadata never probes viewer launch availability',async()=>{
 const {sessionTaskData}=await import('../src/session/link');let probes=0;
 const ctx=fakeCtx({run:async()=>{probes++;return {code:1,stdout:'',stderr:''};}});task(ctx);
 const dir=join(ctx.pacerHome,'runs',id,'1');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'session.ckpt'),'{}');
 await sessionTaskData(ctx,{id,state:'done',goal:'g',executor:null,backend:'direct',worktree:null,updatedAt:0},false);
 expect(probes).toBe(0);
});
test('stale socket files do not advertise a live app viewer',async()=>{
 const ctx=fakeCtx();task(ctx);const dir=join(ctx.pacerHome,'runs',id,'1');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'session.log'),'');writeFileSync(join(dir,'session.sock'),'stale');
 expect(await sessionInfo(ctx,id)).toMatchObject({host:'builtin',live:false,targets:expect.not.arrayContaining(['app'])});
});
