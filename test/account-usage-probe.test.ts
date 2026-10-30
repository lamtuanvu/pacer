import {expect,test} from "bun:test";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {executorEnv} from "../src/exec/process";
import {probeClaudeUsage} from "../src/usage/claude-probe";
import {loadStrategy} from "../src/config/strategy";
import {claudeCacheFile} from "../src/usage/claude";
import {fakeCtx} from "./helpers";
function setup(named=true){
 const ctx=fakeCtx({now:1800000000,env:{CLAUDE_CONFIG_DIR:'/wrong-planner',CLAUDECODE:'parent',PACER_REPORT_TOKEN:'secret'}});
 mkdirSync(ctx.pacerHome,{recursive:true});
 mkdirSync(join(ctx.home,named?"work":".claude"),{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify({planner:{agent:'claude-code',account:'work'},accounts:{work:{kind:'claude',...(named?{home:join(ctx.home,'work')}: {})}},runners:{},routing:[]}));
 return {ctx,account:loadStrategy(ctx).accounts.work};
}
const telemetry=JSON.stringify({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{seven_day:{utilization:.33,resetsAt:1800036000},five_hour:{utilization:.1,resetsAt:1800003600}}}});
for(const named of [true,false])test(`consented probe selects ${named?'named':'default'} account, isolates session and captures only telemetry`,async()=>{
 const {ctx,account}=setup(named);let cwd='';
 await probeClaudeUsage(ctx,account,async spec=>{
  cwd=spec.cwd;expect(spec.env.CLAUDE_CONFIG_DIR).toBe(join(ctx.home,named?'work':'.claude'));
  expect(spec.env.CLAUDECODE).toBeUndefined();expect(spec.env.PACER_REPORT_TOKEN).toBeUndefined();
  expect(spec.argv).toContain('--strict-mcp-config');expect(spec.argv.slice(spec.argv.indexOf('--tools'),spec.argv.indexOf('--tools')+2)).toEqual(['--tools','']);
  expect(spec.timeoutMs).toBe(60000);expect(spec.cwd.startsWith(ctx.pacerHome)).toBe(true);
  return {code:0,stdout:telemetry,stderr:'',timedOut:false};
 });
 expect(existsSync(cwd)).toBe(false);
 expect(JSON.parse(readFileSync(claudeCacheFile(ctx,account),'utf8'))).toMatchObject({captured_at:ctx.now,seven_day:{used_percentage:33}});
});
test('successful process without new telemetry cannot reuse a prior complete reading',async()=>{
 const {ctx,account}=setup();mkdirSync(join(ctx.pacerHome,'cache'),{recursive:true});const path=claudeCacheFile(ctx,account);writeFileSync(path,'prior');
 await expect(probeClaudeUsage(ctx,account,async()=>({code:0,stdout:'OK',stderr:'',timedOut:false}))).rejects.toThrow('No new usage observation');
 expect(readFileSync(path,'utf8')).toBe('prior');
});
test('failed process keeps old telemetry and does not expose process output',async()=>{
 const {ctx,account}=setup();
 await expect(probeClaudeUsage(ctx,account,async()=>({code:1,stdout:telemetry,stderr:'private provider secret',timedOut:false}))).rejects.toThrow('Check this account’s sign-in');
 expect(existsSync(claudeCacheFile(ctx,account))).toBe(false);
});
test('account job bypasses a current cached Claude reading after collecting complete telemetry',async()=>{
 const {fakeCtx:pluginCtx,cleanupUsageFixtures}=await import('./usage-plugin-fixtures');
 const {checkAccountUsage}=await import('../src/core/account-usage-check');
 const {readAccountUsage}=await import('../src/usage');
 const ctx=pluginCtx({now:1800000000});mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify({planner:{agent:'claude-code',account:'work'},accounts:{work:{kind:'claude',home:join(ctx.home,'work')}},runners:{},routing:[]}));
 const strategy=loadStrategy(ctx),account=strategy.accounts.work;
 mkdirSync(account.home!,{recursive:true});
 mkdirSync(join(ctx.pacerHome,'cache'),{recursive:true});writeFileSync(claudeCacheFile(ctx,account),JSON.stringify({captured_at:ctx.now-100,seven_day:{used_percentage:12,resets_at:ctx.now+3600},five_hour:{used_percentage:1,resets_at:ctx.now+3600}}));
 try {
  const before=await readAccountUsage(ctx,account,[]);expect(before.windows[0]?.usedPct).toBe(12);
  const job=await checkAccountUsage(ctx,'work',true,{probe:(ctx,account)=>probeClaudeUsage(ctx,account,async()=>({code:0,stdout:telemetry,stderr:'',timedOut:false}))});
  expect(job.state).toBe('passed');
  const after=await readAccountUsage(ctx,account,[],false,true);expect(after.capturedAt).toBe(ctx.now);expect(after.windows[0]?.usedPct).toBe(33);
  const {list:listAccounts}=await import("../src/core/accounts");
  const expired=await listAccounts({...ctx,now:ctx.now+100000});
  expect(expired.find(a=>a.name==="work")?.usageReading.stale).toBe(true);
 } finally {await cleanupUsageFixtures();}
});

for (const source of ["named", "default", "orca"] as const) test(`probe ignores hostile provider overrides for ${source} subscription`, async () => {
  const {ctx, account} = setup(source !== "default");
  const hostile = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_BEARER_TOKEN_BEDROCK", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "CLOUD_ML_REGION", "AZURE_CLIENT_SECRET", "AZURE_FEDERATED_TOKEN_FILE", "ANTHROPIC_FOUNDRY_RESOURCE", "NODE_OPTIONS", "BUN_OPTIONS", "HTTP_PROXY", "CLAUDE_CONFIG_DIR"];
  for (const key of hostile) ctx.env[key] = "synthetic-override";
  ctx.env.PATH = "/safe/bin";
  ctx.env.PACER_HOME = ctx.pacerHome;
  let folder = join(ctx.home, source === "default" ? ".claude" : "work");
  if (source === "orca") {
    ctx.env.ORCA_USER_DATA_PATH = join(ctx.home, "orca");
    folder = join(ctx.env.ORCA_USER_DATA_PATH, "claude-profiles", "selected", "home");
    mkdirSync(folder, {recursive: true});
    Object.assign(account, {source: "orca", orcaAccount: "selected"});
  }
  await probeClaudeUsage(ctx, account, async spec => {
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe(folder);
    for (const key of hostile.filter(key => key !== "CLAUDE_CONFIG_DIR")) expect(spec.env[key]).toBeUndefined();
    expect(spec.env.HOME).toBe(ctx.home);
    expect(spec.env.PATH).toBe("/safe/bin");
    expect(spec.env.PACER_HOME).toBe(ctx.pacerHome);
    return {code: 0, stdout: telemetry, stderr: "", timedOut: false};
  });
});
test("unavailable linked account refuses before launching instead of falling back", async () => {
  const {ctx, account} = setup();
  Object.assign(account, {source: "orca", orcaAccount: "missing"});
  let launched = false;
  await expect(probeClaudeUsage(ctx, account, async () => { launched = true; throw Error("unexpected spawn"); })).rejects.toThrow("Account folder unavailable");
  expect(launched).toBe(false);
});

test("missing named config directory refuses without asking Claude to create or select a login", async () => {
  const {ctx, account} = setup();
  account.home = join(ctx.home, "unavailable");
  let launched = false;
  await expect(probeClaudeUsage(ctx, account, async () => {launched = true; throw Error("unexpected");})).rejects.toThrow("Account folder unavailable");
  expect(launched).toBe(false);
});

test("normal endpoint executors keep their intentionally configured provider authentication", () => {
  const env = {ANTHROPIC_API_KEY: "synthetic-key", ANTHROPIC_BASE_URL: "https://provider.invalid", CLAUDE_CODE_USE_BEDROCK: "1"};
  expect(executorEnv(env, {})).toMatchObject(env);
});
