import {expect,test} from 'bun:test';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeCtx} from './helpers';
import {build} from '../src/strategy/launcher';
test('any planner opens through terminal with a prompt and safe paths',async()=>{
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n');
 for(const [agent,bin] of [['cursor','cursor-agent'],['opencode','opencode'],['codex','codex'],['claude-code','claude']]) {
 let argv:string[]=[];const result=await build(ctx,{agent,brief:'Do this'}, {open:async(_ctx,o)=>{argv=o.argv;return {opened:true,target:'terminal',command:'cmd'};}});
 expect(argv[0]).toBe(bin);expect(argv.at(-1)).toContain('Do this');expect(result.target).toBe('terminal');expect(readFileSync(result.path,'utf8')).toContain('Do this');
 }
});
