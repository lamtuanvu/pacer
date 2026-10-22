import {expect,test} from 'bun:test';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeCtx} from './helpers';
import {build} from '../src/strategy/launcher';
import {reserveIdle} from '../src/update/desktop/admission';
test('any planner opens through terminal with a prompt and safe paths',async()=>{
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n');
 for(const [agent,bin] of [['cursor','cursor-agent'],['opencode','opencode'],['codex','codex'],['claude-code','claude']]) {
 let argv:string[]=[];const result=await build(ctx,{agent,brief:'Do this'}, {open:async(_ctx,o)=>{argv=o.argv;return {opened:true,target:'terminal',command:'cmd'};}});
 expect(argv[0]).toBe(bin);
 const flags = agent === 'codex' ? ['--dangerously-bypass-approvals-and-sandbox'] : agent === 'claude-code' ? ['--dangerously-skip-permissions'] : agent === 'cursor' ? ['--force', '--sandbox', 'disabled'] : ['--auto', '--standalone'];
 for (const flag of flags) expect(argv).toContain(flag);
 expect(argv.at(-1)).toContain('Do this');expect(result.target).toBe('terminal');expect(readFileSync(result.path,'utf8')).toContain('Do this');
 }
});
test('strategy planning refuses maintenance before opening even an injected terminal',async()=>{
 const ctx=fakeCtx(); let opened=0;
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: codex\nproviders:\n  codex: {}\n');
 await reserveIdle(ctx,'strategy-maintenance');
 await expect(build(ctx,{}, {open:async()=>{opened++;return {opened:true,target:'terminal',command:'cmd'};}})).rejects.toThrow('maintenance');
 expect(opened).toBe(0);
});
