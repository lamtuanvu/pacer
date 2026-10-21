import {expect,test} from 'bun:test';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeCtx} from './helpers';
import * as runners from '../src/core/runners-config';
import {loadStrategy} from '../src/config/strategy';
import {rankExecutors} from '../src/engine/rank';
import {executorCommand} from '../src/executors/command';
export function runnerCtx() {
 const ctx=fakeCtx(); mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),`# keep me\nplanner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  codex: {} # keep runner\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [codex]\n`); return ctx;
}
test('disable preserves comments, excludes ranking and warns',()=>{
 const ctx=runnerCtx(); expect(runners.set(ctx,'codex',{enabled:false}).warnings).toEqual(["routing rule 'docs' has no enabled executor left", "routing rule 'default' has no enabled executor left"]);
 expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toContain('# keep runner');
 expect(loadStrategy(ctx).runners.codex.enabled).toBe(false);
 expect(rankExecutors('docs',loadStrategy(ctx),{}).excluded).toContainEqual(expect.objectContaining({id:'codex',account:'codex',reason:'disabled'}));
 expect(()=>runners.set(ctx,'claude-code',{enabled:false})).toThrow(expect.objectContaining({code:'not_allowed'}));
});
test('reorder requires a permutation; add stores options and joins matching kinds',()=>{
 const ctx=runnerCtx(); expect(()=>runners.reorder(ctx,[])).toThrow(expect.objectContaining({code:'invalid_input'}));
 const result=runners.add(ctx,{agent:'cursor',kinds:['docs'],rank:0,max_tasks:3,test:false});
 expect(result).not.toHaveProperty('job');
 const s=loadStrategy(ctx); expect(s.routing[0].executors).toEqual(['codex','cursor']); expect(s.runners.cursor.maxTasks).toBe(3);
 expect((Bun.YAML.parse(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')) as any).runners.cursor.test).toBe(false);
 expect(runners.reorder(ctx,['cursor','codex']).order).toEqual(['cursor','codex']);
 runners.set(ctx,'codex',{model:'m',max_tasks:2,rank:0}); expect(loadStrategy(ctx).pacing.order).toEqual(['codex','cursor']);
 runners.set(ctx,'codex',{model:null}); expect(loadStrategy(ctx).runners.codex.model).toBeNull();
});
test('executor set parses flags',async()=>{const ctx=runnerCtx(); expect((await executorCommand(['set','codex','--enabled','false','--max-tasks','2'],ctx)).code).toBe(0);expect(loadStrategy(ctx).runners.codex.enabled).toBe(false);});
test('add creates a kinds rule before default and retains routing comments',()=>{
 const ctx=runnerCtx(),path=join(ctx.pacerHome,'strategy.yaml');writeFileSync(path,readFileSync(path,'utf8').replace('  - default:', '  # default comment\n  - default:'));
 runners.add(ctx,{agent:'cursor',kinds:['feature'],test:true});
 expect(loadStrategy(ctx).routing.map(r=>r.kinds)).toEqual([['docs'],['feature'],null]);
 expect(readFileSync(path,'utf8')).toContain('# default comment');
});
