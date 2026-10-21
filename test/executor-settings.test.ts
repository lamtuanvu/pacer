import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCtx } from './helpers';
const runnerCtx=()=>{
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'# keep runner\nplanner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  codex: {}\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [codex]\n');
 return ctx;
};
import { readExecutorSettings, saveExecutorSettings } from '../src/core/executor-settings';
import { loadStrategy } from '../src/config/strategy';

test('batch save is atomic and preserves comments and unrelated settings',async()=>{
 const ctx=runnerCtx(), base=readExecutorSettings(ctx);
 const result=await saveExecutorSettings(ctx,{expectedRevision:base.revision,order:base.order,runners:base.runners.map(r=>({...r,enabled:false,maxTasks:3}))});
 expect(result.revision).not.toBe(base.revision);
 expect(loadStrategy(ctx).runners.codex).toMatchObject({enabled:false,maxTasks:3});
 expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toContain('# keep runner');
 expect(result.warnings).toHaveLength(2);
});
for(const maxTasks of [0,17,1.5])test(`invalid capacity ${maxTasks} saves nothing`,async()=>{
 const ctx=runnerCtx(),base=readExecutorSettings(ctx),path=join(ctx.pacerHome,'strategy.yaml'),before=readFileSync(path,'utf8');
 await expect(saveExecutorSettings(ctx,{expectedRevision:base.revision,order:base.order,runners:base.runners.map(r=>({...r,maxTasks}))})).rejects.toMatchObject({code:'invalid_input'});
 expect(readFileSync(path,'utf8')).toBe(before);
});
test('stale revision and duplicate/missing/planner ids are rejected',async()=>{
 const ctx=runnerCtx(),base=readExecutorSettings(ctx);
 for(const order of [[],['codex','codex'],['claude-code']])await expect(saveExecutorSettings(ctx,{expectedRevision:base.revision,order,runners:base.runners})).rejects.toMatchObject({code:'invalid_input'});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')+'\n# another client\n');
 await expect(saveExecutorSettings(ctx,{expectedRevision:base.revision,order:base.order,runners:base.runners})).rejects.toMatchObject({code:'conflict'});
});
test('two clients saving the same base revision have one winner',async()=>{
 const ctx=runnerCtx(),base=readExecutorSettings(ctx);
 const input={expectedRevision:base.revision,order:base.order,runners:base.runners.map(r=>({...r,maxTasks:2}))};
 const results=await Promise.allSettled([saveExecutorSettings(ctx,input),saveExecutorSettings(ctx,input)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'conflict'}});
});
test('legacy settings migrate through the existing backup flow before batch editing',async()=>{
 const ctx=runnerCtx(),path=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(path,'# legacy\nplanner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n');
 const before=readFileSync(path,'utf8'),base=readExecutorSettings(ctx);
 const result=await saveExecutorSettings(ctx,{expectedRevision:base.revision,order:base.order,runners:base.runners.map(r=>({...r,maxTasks:2}))});
 expect(result.runners[0].maxTasks).toBe(2);
 expect(readFileSync(`${path}.pre-accounts.bak`,'utf8')).toBe(before);
});
