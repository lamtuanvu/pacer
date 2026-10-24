import {expect, test} from 'bun:test';
import {prepareSession} from '../src/session/capabilities';
import {fakeCtx, gitRepo, realRun, withLoginIndicators} from './helpers';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {blockExecutor} from '../src/executors/blocked';

for(const blocked of [false,true]) test(`explicit Claude conversation ${blocked?'retains operator block':'can select the configured planner'}`, async()=>{
 const repo=gitRepo();
 const ctx=withLoginIndicators(fakeCtx({run:async(argv,timeout,options)=>argv[0]==='claude'
   ? {code:0,stdout:argv[1]==='--version'?'2.1.281':'--session-id --resume --add-dir --model --settings',stderr:''}
   :realRun(argv,timeout,options)}));
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  codex: {}\nrouting:\n  - default: [codex]\n');
 if(blocked) blockExecutor(ctx,'claude-code');
 const result=await prepareSession(ctx,{repo});
 const claude=result.executors.find(e=>e.id==='claude-code')!;
 expect(claude.capabilities.interactive).toBe(true);
 expect(claude.available).toBe(!blocked);
 if(blocked) expect(claude.reason).toContain('Blocked');
});
