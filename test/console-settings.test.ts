import {expect,test} from 'bun:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeCtx} from './helpers';
import {consoleCommands,type ConsoleDeps} from '../src/console/console';
import {type CmdData} from '../src/link/envelope';
import {loadStrategy} from '../src/config/strategy';

function harness() {
 const ctx=fakeCtx({env:{PACER_BIN:'pacer'}}); mkdirSync(ctx.pacerHome,{recursive:true});
 const path=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(path,'# keep\naccounts: {personal: {kind: claude}, codex: {kind: codex}, spare: {kind: endpoint, usage: unmetered, model: local/test}}\nplanner: claude-code\nrouting: [{default: [codex, opencode#spare]}]\npacing: {policy: priority}\n');
 let output=''; const calls:string[][]=[];
 ctx.run=async argv=>{calls.push(argv);return {code:0,stderr:'',stdout:JSON.stringify({ok:true,result:{runtime:{state:'ready',reachable:true},terminal:{handle:'term_settings'}}})};};
 const deps:ConsoleDeps={delegate:()=>{throw Error('unexpected');},useStrategy:()=>'',listStrategies:()=>[],statusText:async()=>'',pump:async()=>[],heartbeat:()=>{},resolveWorktreePath:async()=>'/focused',selfHandle:async()=>({handle:null,paneKey:null}),every:()=>()=>{},pid:1,cwd:'/worker'};
 const run=async(data:Record<string,unknown>)=>{await consoleCommands(ctx,deps,s=>{output+=s+'\n';},{startDelegate(){},chooseStrategy(){},use:async()=>{},refresh:async()=>{}})(data as unknown as CmdData);};
 return {ctx,path,calls,run,deps,output:()=>output};
}
for(const [key,value,want] of [['pacing.policy','even','even'],['pacing.accounts','fill','fill'],['pacing.fill_threshold','95',95],['pacing.planner_reserve','25',25],['pacing.order','codex,claude-code',['codex','claude-code']],['update_check','false',false]] as const) test(`console writes ${key} through validated config`,async()=>{
 const h=harness();await h.run({cmd:'config-set',key,value});
 const raw=Bun.YAML.parse(readFileSync(h.path,'utf8')) as any;
 expect(key.split('.').reduce((v,k)=>v[k],raw)).toEqual(want);
 expect(h.output()).toContain('Undo: pacer config set');expect(readFileSync(h.path,'utf8')).toContain('# keep');
});
test('planner accepts a runner id and moves integration through the shared writer',async()=>{const h=harness();await h.run({cmd:'config-set',key:'planner',value:'codex'});expect(loadStrategy(h.ctx).planner.agent).toBe('codex');expect(h.output()).toContain('Undo:');});
test('invalid settings report validation errors without writing',async()=>{const h=harness(),before=readFileSync(h.path,'utf8');await h.run({cmd:'config-set',key:'pacing.fill_threshold',value:'49'});expect(h.output()).toContain('pacer:');expect(readFileSync(h.path,'utf8')).toBe(before);});
test('removals use the shared safeguards and report results',async()=>{const h=harness();await h.run({cmd:'account-remove',name:'spare'});expect(h.output()).toContain('in use');await h.run({cmd:'runner-remove',name:'opencode#spare'});expect(loadStrategy(h.ctx).runners['opencode#spare']).toBeUndefined();await h.run({cmd:'account-remove',name:'spare'});expect(loadStrategy(h.ctx).accounts.spare).toBeUndefined();expect(h.output()).toContain('Removed account spare');});
for(const [command,shell] of [['account-add','pacer account add'],['account-add-orca','pacer account add --orca'],['runner-add','pacer runner add'],['init','pacer init']]) test(`opens only fixed argv for ${command} in focused worktree`,async()=>{const h=harness();await h.run({cmd:'open-terminal',command,worktreeId:'repo::/focused',goal:'$(touch /tmp/pwn)'});const create=h.calls.find(argv=>argv[1]==='terminal')!;expect(create.slice(0,8)).toEqual(['orca','terminal','create','--worktree','id:repo::/focused','--title','pacer settings','--command']);expect(readFileSync(create[8],'utf8')).toBe(`#!/bin/sh\n${shell}\n`);expect(h.output()).toContain('pacer settings opened in terminal');});
test('open-terminal returns a copyable command when no terminal is available',async()=>{
 const h=harness();h.ctx.which=bin=>bin==='orca'?'/fake/orca':null;
 await h.run({cmd:'open-terminal',command:'init'});
 expect(h.calls).toContainEqual(['orca','worktree','show','--worktree','active','--json']);expect(h.output()).toContain('Run: pacer init');
 h.ctx.run=async()=>({code:1,stdout:JSON.stringify({ok:false,error:{message:'offline'}}),stderr:''});
 await h.run({cmd:'open-terminal',command:'init',worktreeId:'repo::/focused'});expect(h.output()).toContain('Run: pacer init');
});
test('fixed add commands collect arguments in the terminal before using shared writers',async()=>{
 const {accountCmd,runnerCmd}=await import('../src/commands/accounts');const h=harness();
 const answers=['codex','team'];
 expect((await accountCmd(['add'],h.ctx,{prompt:async()=>answers.shift()!,login:async()=>0})).code).toBe(0);
 expect(loadStrategy(h.ctx).accounts.team.kind).toBe('codex');
 expect((await runnerCmd(['add'],h.ctx,{prompt:async()=> 'codex#team'})).code).toBe(0);
 expect(loadStrategy(h.ctx).runners['codex#team']).toBeDefined();
});
test('fixed Orca link command prompts for label-safe identity and writes the linked account',async()=>{
 const {accountCmd}=await import('../src/commands/accounts');const h=harness();
 h.ctx.run=async()=>({code:0,stderr:'',stdout:JSON.stringify({rateLimits:{},codex:{accounts:[{id:'team-id',label:'Team',email:'private@example.invalid'}]}})});
 const answers=['codex','team','team-id'];
 const r=await accountCmd(['add','--orca'],h.ctx,{prompt:async()=>answers.shift()!});
 expect(r.code).toBe(0);expect(loadStrategy(h.ctx).accounts.team.orcaAccount).toBe('team-id');expect(r.out).not.toContain('private@example.invalid');
});
test('interactive endpoint add collects usage settings for the shared validator',async()=>{
 const {accountCmd}=await import('../src/commands/accounts');const h=harness();
 const answers=['endpoint','1','metered-api','http://endpoint.invalid/v1','','1','metered','1M','y'];
 const questions:string[]=[];let hidden=0,discovered=0,tested=0;
 const key='sk-console-endpoint-private';
 // Exercise an in-memory keychain, never the real user's store.
 h.ctx.run=async(argv,_timeout,options)=>{
  if(argv[1]==='-i')expect(Buffer.from(options!.stdin!.match(/-X ([0-9a-f]+)/)![1],'hex').toString()).toBe(key);
  return {code:0,stderr:'',stdout:argv.includes('-w')?key:''};
 };
 const r=await accountCmd(['add'],h.ctx,{
  prompt:async question=>{questions.push(question);expect(answers.length).toBeGreaterThan(0);return answers.shift()!;},
  promptSecret:async question=>{expect(question).toContain('hidden');hidden++;return key;},
  print:()=>{},
  // Rejects the OpenCode-picker's catalog and local-probe lookups (models.dev, 127.0.0.1:11434/1234) before
  // the endpoint-under-test assertions below, so picker detection never trips them or inflates `discovered`.
  fetch:async(url,init)=>{
   if(/models\.dev|127\.0\.0\.1:(11434|1234)/.test(String(url)))throw Error('blocked in tests');
   discovered++;expect(String(url)).toBe('http://endpoint.invalid/v1/models');expect((init!.headers as Record<string,string>).Authorization).toBe(`Bearer ${key}`);return Response.json({data:[{id:'model-a',context_length:128000,max_output_tokens:16000}]});
  },
  spawn:async spec=>{tested++;expect(spec.env.PACER_KEY_METERED_API).toBe(key);writeFileSync(join(spec.cwd,'hello.txt'),'ok');return {code:0,stdout:'',stderr:'',timedOut:false};},
 });
 expect(r.code).toBe(0);expect(r.out).toContain('Ready: opencode#metered-api');
 expect([hidden,discovered,tested]).toEqual([1,1,1]);expect(answers).toEqual([]);
 expect(questions.join('\n')).toContain('Models to use');expect(questions.join('\n')).toContain('Test with a short task');
 const account=loadStrategy(h.ctx).accounts['metered-api'];expect(account.weeklyTokens).toBe(1_000_000);expect(account.connection!.models[0].id).toBe('model-a');
 for(const text of [r.out,r.err,readFileSync(h.path,'utf8'),readFileSync(join(h.ctx.pacerHome,'opencode/opencode.json'),'utf8')])expect(text).not.toContain(key);
});

test('command-only terminal actions resolve Orca focus rather than the worker directory',async()=>{const h=harness();h.ctx.run=async argv=>{h.calls.push(argv);return {code:0,stderr:'',stdout:JSON.stringify({ok:true,result:argv[1]==='status'?{runtime:{state:'ready',reachable:true}}:argv[1]==='worktree'?{worktree:{id:'repo::/focused'}}:{terminal:{handle:'term_settings'}}})};};await h.run({cmd:'open-terminal',command:'init'});expect(h.calls).toContainEqual(['orca','worktree','show','--worktree','active','--json']);const create=h.calls.find(argv=>argv[1]==='terminal')!;expect(create.slice(0,8)).toEqual(['orca','terminal','create','--worktree','id:repo::/focused','--title','pacer settings','--command']);expect(readFileSync(create[8],'utf8')).toBe('#!/bin/sh\npacer init\n');expect(h.output()).toContain('pacer settings opened in terminal');});

for(const cmd of ['account-remove','runner-remove'] as const)for(const name of ['--help','-x','foo bar','foo#-bar'])test(`direct console ${cmd} rejects malformed name ${name}`,async()=>{const h=harness(),messages:string[]=[],before=readFileSync(h.path,'utf8');let refreshed=false;await consoleCommands(h.ctx,h.deps,s=>messages.push(s),{startDelegate(){},chooseStrategy(){},use:async()=>{},refresh:async()=>{refreshed=true;}})({cmd,name});expect(messages.join(' ')).toContain('invalid');expect(refreshed).toBe(true);expect(readFileSync(h.path,'utf8')).toBe(before);});

test('Orca terminal settings write presets and explain rejected custom templates',async()=>{
 const h=harness();
 for(const value of ['ghostty','iterm','terminal-app','wezterm','kitty','alacritty','gnome-terminal','x-terminal-emulator','auto']){
  await h.run({cmd:'config-set',key:'terminal.open',value});
  expect(loadStrategy(h.ctx).terminal?.open).toBe(value);
 }
 const before=readFileSync(h.path,'utf8');
 await h.run({cmd:'config-set',key:'terminal.open',value:'foot {cmd}'});
 expect(h.output()).toContain('terminal.open requires a preset');
 expect(h.output()).toContain('use pacer config set terminal.open');
 expect(readFileSync(h.path,'utf8')).toBe(before);
 expect(h.calls).toEqual([]);
});
