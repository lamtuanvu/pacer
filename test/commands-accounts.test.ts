import {expect, test} from "bun:test";
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {accountCmd, runnerCmd} from "../src/commands/accounts";
import {main} from "../src/cli";
import {loadStrategy} from "../src/config/strategy";
import {fakeCtx} from "./helpers";

export function commandCtx() {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"), '# keep layout\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  spare: {kind: endpoint, usage: unmetered}\nplanner: claude-code\nrouting:\n  - default: [codex]\npacing: {order: [codex], policy: priority}\n');
  return ctx;
}
test("account list JSON and CLI dispatch show identities, sources and runners", async () => {
  const ctx=commandCtx(); const r=await main(["account","list","--json"],ctx);
  expect(r.code).toBe(0); const a=JSON.parse(r.out);
  expect(a.find((x:any)=>x.name==='personal')).toMatchObject({kind:'claude',source:'default',runners:['claude-code'],signedIn:null});
});
for (const kind of ['claude','codex']) test(`${kind} add creates private home and uses injected interactive login`, async()=>{
  const ctx=commandCtx(); const calls:any[]=[];
  const r=await accountCmd(['add',kind,'work'],ctx,{login:async (argv,env)=>{calls.push({argv,env}); return 0;}});
  expect(r.code).toBe(0); const a=loadStrategy(ctx).accounts.work;
  expect(a.home).toBe(join(ctx.home, `.${kind}-work`));
  expect(statSync(a.home!).mode & 0o777).toBe(0o700);
  expect(calls).toEqual([{argv:kind==='codex'?['codex','login']:['claude'],env:{[kind==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']:a.home}}]);
  if(kind==='claude') expect(r.out).toContain('/login');
  expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toContain('# keep layout');
});
test("no-login honors explicit home and removal keeps it unless confirmed",async()=>{
  const ctx=commandCtx(); const home=join(ctx.home,'work');
  expect((await accountCmd(['add','claude','work','--home',home,'--no-login'],ctx,{login:async()=>{throw Error('unexpected login');}})).code).toBe(0);
  const before=readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8');
  expect((await accountCmd(['rm','work','--delete-home'],ctx,{confirm:async()=>false})).code).not.toBe(0);
  expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toBe(before);
  expect((await accountCmd(['rm','work','--delete-home'],ctx,{confirm:async()=>true})).code).toBe(0);
  expect(existsSync(home)).toBe(false);
});
test("endpoint budgets and canonical runner addition/removal",async()=>{
  const ctx=commandCtx();
  for(const [name,flags] of [['acme',['--usage','metered','--weekly-tokens','50M']],['quota',['--usage','quota','--quota-source','arkcli']],['local',['--usage','unmetered']]] as const)
    expect((await accountCmd(['add','endpoint',name,...flags],ctx)).code).toBe(0);
  expect(loadStrategy(ctx).accounts.acme.weeklyTokens).toBe(50e6);
  expect((await runnerCmd(['add','opencode#acme','--model','acme/gpt-x'],ctx)).code).toBe(0);
  expect(loadStrategy(ctx).routing.at(-1)!.executors).toContain('opencode#acme');
  const list=JSON.parse((await main(['runner','list','--json'],ctx)).out);
  expect(list.find((x:any)=>x.id==='opencode#acme')).toMatchObject({agent:'opencode',account:'acme',model:'acme/gpt-x'});
  expect((await runnerCmd(['rm','opencode#acme'],ctx)).code).toBe(0);
  expect(loadStrategy(ctx).runners['opencode#acme']).toBeUndefined();
  expect((await accountCmd(['rm','acme'],ctx)).code).toBe(0);
});
test("Orca links sanitized ids and labels and reports missing home as usage-only",async()=>{
  const ctx=commandCtx(); ctx.run=async()=>({code:0,stderr:'',stdout:JSON.stringify({claude:{accounts:[{id:'team-id',label:'Team',email:'secret@example.invalid'}]},rateLimits:{claude:{weekly:{usedPercent:30}}}})});
  expect((await accountCmd(['add','claude','team','--orca','team-id'],ctx)).code).toBe(0);
  const r=await accountCmd(['list','--json'],ctx); expect(r.out).not.toContain('secret');
  expect(JSON.parse(r.out).find((x:any)=>x.name==='team')).toMatchObject({label:'Team',orcaAccount:'team-id',runnable:false});
});
for(const [command,args] of [
  ['account',['rm','personal']], ['account',['rm','codex']], ['account',['add','claude','Bad/Name','--no-login']],
  ['account',['add','cursor','work','--no-login']], ['account',['add','endpoint','bad','--usage','metered']],
  ['account',['add','endpoint','bad','--usage','quota']], ['account',['add','claude','personal','--no-login']],
  ['runner',['rm','claude-code']], ['runner',['add','codex#personal']], ['runner',['add','codex@remote']],
  ['runner',['add','opencode#spare']], ['runner',['add','invented']], ['account',['rm','missing']], ['runner',['rm','missing']],
] as const) test(`refuses ${command} ${args.join(' ')} without changing bytes`,async()=>{
  const ctx=commandCtx(); const p=join(ctx.pacerHome,'strategy.yaml'),before=readFileSync(p,'utf8');
  const r=await (command==='account'?accountCmd:runnerCmd)([...args],ctx);
  expect(r.code).not.toBe(0); expect(readFileSync(p,'utf8')).toBe(before);
});
test('last runner refusal is byte identical',async()=>{
  const ctx=commandCtx(); const p=join(ctx.pacerHome,'strategy.yaml');
  writeFileSync(p,'accounts: {spare: {kind: endpoint, usage: unmetered, model: local/x}}\nplanner: opencode\nrunners: {opencode#spare: {}}\nrouting: [{default: [opencode#spare]}]\n');
  const before=readFileSync(p,'utf8'); expect((await runnerCmd(['rm','opencode#spare'],ctx)).code).not.toBe(0);
  expect(readFileSync(p,'utf8')).toBe(before);
});

test('removing the sole executor removes its routing rule and pacing reference',async()=>{
 const ctx=commandCtx(); const r=await runnerCmd(['rm','codex'],ctx);
 expect(r.code).toBe(0); expect(loadStrategy(ctx).runners.codex).toBeUndefined(); expect(loadStrategy(ctx).pacing.order).not.toContain('codex');
});
test('runner removal edits every rule and preserves unrelated comments',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(p,readFileSync(p,'utf8').replace('- default: [codex]','- kinds: [debug]\n    executors: [codex, claude-code] # rule comment\n  - default: [claude-code, codex]'));
 expect((await runnerCmd(['rm','codex'],ctx)).code).toBe(0);
 expect(loadStrategy(ctx).routing.map(r=>r.executors)).toEqual([['claude-code'],['claude-code']]);
 expect(readFileSync(p,'utf8')).toContain('# rule comment');
});
test('refused protected home deletion keeps bytes and folders',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(p,readFileSync(p,'utf8').replace('  spare:', '  work: {kind: claude, home: ~}\n  spare:'));
 const before=readFileSync(p,'utf8'); expect((await accountCmd(['rm','work','--delete-home'],ctx,{confirm:async()=>true})).code).not.toBe(0);
 expect(readFileSync(p,'utf8')).toBe(before); expect(existsSync(ctx.home)).toBe(true);
});
test('legacy edits migrate and print the migration once',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml'),before='planner: claude-code\nproviders: {codex: {}}\n'; writeFileSync(p,before);
 const lines:string[]=[];
 const r=await accountCmd(['add','claude','work','--no-login'],ctx,{print:line=>lines.push(line)});
 expect(r.code).toBe(0); expect(lines.filter(line=>line.startsWith('Backup:'))).toHaveLength(1);
 expect(readFileSync(p+'.pre-accounts.bak','utf8')).toBe(before);
 expect(readFileSync(p,'utf8')).toContain('accounts:');
});
test('removing an empty routing rule retains comments on surviving rules',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(p,readFileSync(p,'utf8').replace('- default: [codex]', '- kinds: [debug]\n    executors: [codex]\n  - default: [claude-code] # retain me'));
 expect((await runnerCmd(['rm','codex'],ctx)).code).toBe(0); expect(readFileSync(p,'utf8')).toContain('# retain me');
});
test('root home deletion is refused before confirmation',async()=>{
 const ctx=commandCtx(),p=join(ctx.pacerHome,'strategy.yaml');
 writeFileSync(p,readFileSync(p,'utf8').replace('  spare:', '  work: {kind: claude, home: /}\n  spare:'));
 let prompted=false;
 const r=await accountCmd(['rm','work','--delete-home'],ctx,{confirm:async()=>{prompted=true; return false;}});
 expect(r.err).toContain('protected'); expect(prompted).toBe(false);
});

for (const spacing of [false, true]) test(`runner add preserves flow spacing (${spacing}) without empty settings`, async () => {
 const ctx=commandCtx(), path=join(ctx.pacerHome,'strategy.yaml');
 const before=readFileSync(path,'utf8').replace('spare: {kind: endpoint, usage: unmetered}', 'work: {kind: codex, home: ~/.codex-work}').replace('[codex]', spacing ? '[ codex ]' : '[codex]');
 writeFileSync(path,before);
 expect((await runnerCmd(['add','codex#work'],ctx)).code).toBe(0);
 expect(readFileSync(path,'utf8')).toBe(before.replace(spacing ? '[ codex ]' : '[codex]', spacing ? '[ codex, codex#work ]' : '[codex, codex#work]'));
 expect(loadStrategy(ctx).runners['codex#work']).toBeDefined();
});
test('account add refuses an existing default folder without changing config',async()=>{
 const ctx=commandCtx(),path=join(ctx.pacerHome,'strategy.yaml'),before=readFileSync(path,'utf8');
 mkdirSync(join(ctx.home,'.claude-work'));
 expect((await accountCmd(['add','claude','work','--no-login'],ctx)).err).toContain('already exists');
 expect(readFileSync(path,'utf8')).toBe(before);
});
test('account list separates compact folders from source and JSON keeps full paths',async()=>{
 const ctx=commandCtx(),path=join(ctx.pacerHome,'strategy.yaml'),folder=join(ctx.home,'very-long-account-folder-name-for-work','nested-codex-home');
 writeFileSync(path,readFileSync(path,'utf8').replace('  spare:',`  work: {kind: codex, home: ${folder}}\n  spare:`));
 const out=(await accountCmd(['list'],ctx)).out, lines=out.split('\n'),headers=lines[0].split(/\s{2,}/);
 expect(headers).toEqual(['ACCOUNT','KIND','SOURCE','FOLDER','RUNNERS','USAGE']);
 const row=lines.find(l=>l.startsWith('work '))!.split(/\s{2,}/);
 expect(row[2]).toBe('pacer');expect(row[3]).toStartWith('~/');expect(row[3]).toContain('…');expect(row[3].length).toBeLessThanOrEqual(40);expect(row[3]).toEndWith('nested-codex-home');
 expect(JSON.parse((await accountCmd(['list','--json'],ctx)).out).find((a:any)=>a.name==='work').folder).toBe(folder);
});

test("runner add accepts a declared host and refuses an unknown one", async () => {
  const ctx = commandCtx();
  const file = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(file, readFileSync(file, "utf8") + "hosts:\n  box: {ssh: box-ssh}\n");
  const refused = await runnerCmd(["add", "codex@nowhere"], ctx).catch((e) => ({ code: 2, out: "", err: String(e) }));
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("unknown host nowhere (hosts: box)");
  expect((await runnerCmd(["add", "codex@box"], ctx)).code).toBe(0);
  expect(loadStrategy(ctx).runners["codex@box"]).toMatchObject({ agent: "codex", host: "box" });
});
