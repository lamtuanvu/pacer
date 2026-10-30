import {expect,test} from 'bun:test';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {configCmd} from '../src/commands/config';
import {loadStrategy} from '../src/config/strategy';
import {commandCtx} from './commands-accounts.test';

test('get lists effective values with provenance and CLI JSON shape',async()=>{
 const ctx=commandCtx(); const all=JSON.parse((await configCmd(['get','--json'],ctx)).out);
 expect(all['pacing.accounts']).toEqual({value:'spread',source:'default'});
 expect(all['pacing.policy']).toMatchObject({value:'priority',source:join(ctx.pacerHome,'strategy.yaml')});
 expect(JSON.parse((await configCmd(['get','planner','--json'],ctx)).out).value).toBe('claude-code');
});
for(const [key,value] of [['pacing.order','codex,claude-code'],['pacing.policy','even'],['pacing.planner_reserve','25'],['pacing.accounts','fill'],['pacing.fill_threshold','95'],['update_check','false']]) test(`set ${key} preserves comments and prints undo`,async()=>{
 const ctx=commandCtx(); const r=await configCmd(['set',key,value],ctx);
 expect(r.code).toBe(0); expect(r.out).toContain(`Undo: pacer config set ${key}`);
 expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toContain('# keep layout');
 expect(JSON.parse((await configCmd(['get',key,'--json'],ctx)).out).value).toEqual(key==='pacing.order'?['codex','claude-code']:key==='update_check'?false:key.includes('threshold')||key.includes('reserve')?Number(value):value);
});
test('planner set moves integration to runner account and supplies undo',async()=>{
 const ctx=commandCtx(); const path=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(path,readFileSync(path,'utf8').replace('  spare:', '  team: {kind: codex, home: ~/.codex-team}\n  spare:'));
 const r=await configCmd(['set','planner','codex#team'],ctx);
 expect(r.code).toBe(0); expect(loadStrategy(ctx).planner).toEqual({agent:'codex',account:'team'});
 expect(existsSync(join(ctx.home,'.codex-team/skills/pacer/SKILL.md'))).toBe(true);
 expect(r.out).toContain('Undo: pacer config set planner claude-code');
});
for(const [key,value] of [['unknown','x'],['pacing.policy','bad'],['pacing.accounts','bad'],['pacing.fill_threshold','49'],['pacing.fill_threshold','101'],['pacing.planner_reserve','NaN'],['pacing.planner_reserve','100'],['pacing.order','invented'],['update_check','yes'],['planner','codex#personal']]) test(`refuses ${key}=${value} without edits`,async()=>{
 const ctx=commandCtx(); const p=join(ctx.pacerHome,'strategy.yaml'),before=readFileSync(p,'utf8');
 expect((await configCmd(['set',key,value],ctx)).code).not.toBe(0); expect(readFileSync(p,'utf8')).toBe(before);
});
test('migration saves original and prints restore command',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml'); const old='planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n'; writeFileSync(p,old);
 const r=await configCmd(['migrate'],ctx); expect(r.code).toBe(0); expect(r.out).toContain('Restore: cp'); expect(readFileSync(p+'.pre-accounts.bak','utf8')).toBe(old);
 expect((await configCmd(['migrate'],ctx)).out).toContain('already');
});

test('planner installation failure leaves strategy byte identical',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(p,readFileSync(p,'utf8').replace('  spare:', '  team: {kind: codex, orca_account: missing}\n  spare:'));
 const before=readFileSync(p,'utf8'); expect((await configCmd(['set','planner','codex#team'],ctx)).code).not.toBe(0);
 expect(readFileSync(p,'utf8')).toBe(before);
});
test('planner switch removes recorded old integration',async()=>{
 const {installPlanner}=await import('../src/install');
 const ctx=commandCtx(); await installPlanner({ctx,pacerArgv:['pacer']},{agent:'claude-code',account:'personal'});
 expect((await configCmd(['set','planner','codex'],ctx)).code).toBe(0);
 expect(existsSync(join(ctx.home,'.claude/skills/pacer/SKILL.md'))).toBe(false);
 expect(existsSync(join(ctx.home,'.codex/skills/pacer/SKILL.md'))).toBe(true);
});
test('config CLI dispatch and active strategy writes',async()=>{
 const {main}=await import('../src/cli'); const {mkdirSync}=await import('node:fs');
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml'),before=readFileSync(p,'utf8');
 mkdirSync(join(ctx.pacerHome,'strategies')); writeFileSync(join(ctx.pacerHome,'strategies/work.yaml'),before); writeFileSync(join(ctx.pacerHome,'active'),'work');
 expect((await main(['config','set','pacing.accounts','fill'],ctx)).code).toBe(0);
 expect(readFileSync(p,'utf8')).toBe(before); expect(loadStrategy(ctx).pacing.accounts).toBe('fill');
});
test('switching OpenCode endpoint accounts retains integration in their shared folder',async()=>{
 const {installPlanner}=await import('../src/install'); const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(p,'accounts: {first: {kind: endpoint, usage: unmetered, model: local/a}, second: {kind: endpoint, usage: unmetered, model: local/b}}\nplanner: opencode#first\nrouting: [{default: [opencode#second]}]\n');
 await installPlanner({ctx,pacerArgv:['pacer']},{agent:'opencode',account:'first'});
 expect((await configCmd(['set','planner','opencode#second'],ctx)).code).toBe(0);
 expect(existsSync(join(ctx.home,'.config/opencode/skills/pacer/SKILL.md'))).toBe(true);
});
test('pacing order undo can restore an empty list',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml'); writeFileSync(p,readFileSync(p,'utf8').replace('order: [codex]','order: []'));
 const changed=await configCmd(['set','pacing.order','codex'],ctx); expect(changed.out).toContain("Undo: pacer config set pacing.order ''");
 expect((await configCmd(['set','pacing.order',''],ctx)).code).toBe(0); expect(loadStrategy(ctx).pacing.order).toEqual([]);
});
test('execution.backend get and set print the Orca warning and undo',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml');
 expect(JSON.parse((await configCmd(['get','execution.backend','--json'],ctx)).out)).toEqual({value:'direct',source:'default'});
 const r=await configCmd(['set','execution.backend','orca'],ctx);
 expect(r.code).toBe(0); expect(r.out).toContain("Orca isn't running; tasks run directly until it is."); expect(r.out).toContain('Undo: pacer config set execution.backend direct');
 expect(loadStrategy(ctx).execution).toMatchObject({backend:'orca'});
 expect(JSON.parse((await configCmd(['get','execution.backend','--json'],ctx)).out).value).toBe('orca');
 const before=readFileSync(p,'utf8'),bad=await configCmd(['set','execution.backend','auto'],ctx);
 expect(bad.code).toBe(2); expect(bad.err).toContain('execution.backend must be orca or direct'); expect(readFileSync(p,'utf8')).toBe(before);
});

test('automatic cleanup defaults true and accepts boolean settings only', async () => {
  const ctx = commandCtx();
  const {validateExecution} = await import('../src/config/execution');
  expect(validateExecution(undefined).autoClean).toBe(true);
  expect(validateExecution({auto_clean: false}).autoClean).toBe(false);
  expect(() => validateExecution({auto_clean: 'false'})).toThrow('auto_clean must be a boolean');
  expect((await configCmd(['set', 'execution.auto_clean', 'false'], ctx)).code).toBe(0);
  expect(loadStrategy(ctx).execution.auto_clean).toBe(false);
  expect((await configCmd(['set', 'execution.auto_clean', 'yes'], ctx)).code).not.toBe(0);
});
