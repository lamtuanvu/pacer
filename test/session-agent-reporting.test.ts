import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpDir,fakeCtx} from './helpers';
import {prepare} from '../plugins/agent-session';
import {materializeAgentReporting} from '../src/session/agent-reporting';
import {readReport,writeReport,reportCommand} from '../src/session/reports';
import {createTask,readTask,updateTask} from '../src/tasks/store';
import {runTask} from '../src/tasks/runner';
import {validateStrategy} from '../src/config/strategy';

test('OpenCode reporting preserves model and existing plugins and follows only its own session',async()=>{
 const dir=tmpDir();writeFileSync(join(dir,'interactive.json'),JSON.stringify({interactionMode:'conversation'}));
 const launch=prepare({agent:'opencode',version:'2.1.2',newSessionId:'ses_owned',request:'Talk',workspace:dir,runDir:dir,attachments:[],permissionPolicy:'native'});
 const env={OPENCODE_CONFIG_CONTENT:JSON.stringify({model:'provider/model',plugins:['existing-plugin'],providers:{custom:{}}})};
 materializeAgentReporting(dir,launch,env);
 const config=JSON.parse(env.OPENCODE_CONFIG_CONTENT);
 const pluginPath=config.plugins[1];
 expect(config).toMatchObject({model:'provider/model',providers:{custom:{}},plugins:['existing-plugin',expect.any(String)]});
 const source=readFileSync(join(pluginPath,'index.ts'),'utf8');
 // OpenCode's external runtime is replaced only at its Plugin.define boundary.
 const testFile=join(dir,'test-hook.ts');
 writeFileSync(testFile,source.replace('import { Plugin } from "@opencode/plugin";', 'const Plugin = {define: (value: any) => value};'));
 const plugin=(await import(testFile)).default;
 const events=[{type:'session.execution.started',data:{sessionID:'ses_owned'}},{type:'permission.asked',data:{sessionID:'ses_other'}}];
 const cleanup=await plugin.setup({event:{subscribe:async function*(){for(const event of events)yield event;}},session:{context:async()=>[]}});
 await Bun.sleep(20);
 expect(readReport(dir)?.status).toBe('running');cleanup();
 const second=[{type:'permission.asked',data:{sessionID:'ses_owned'}}];
 const clean2=await plugin.setup({event:{subscribe:async function*(){yield*second;}},session:{context:async()=>[]}});await Bun.sleep(20);
 expect(readReport(dir)?.status).toBe('needs-input');clean2();
 const third=[{type:'session.execution.succeeded',data:{sessionID:'ses_owned'}}];
 const clean3=await plugin.setup({event:{subscribe:async function*(){yield*third;}},session:{context:async()=>[{type:'assistant',content:[{type:'text',text:'Native answer'}]}]}});await Bun.sleep(20);
 expect(readReport(dir)?.status).toBe('turn-ended');
 expect(readFileSync(join(dir,'transcript-report.md'),'utf8')).toBe('Native answer');clean3();
 writeReport(dir,'running','Old run');
 const clean4=await plugin.setup({event:{subscribe:async function*(){}},session:{context:async()=>[]}});await Bun.sleep(20);
 expect(readReport(dir)?.status).toBe('turn-ended');clean4();
 const clean5=await plugin.setup({event:{subscribe:async function*(){throw Error('disconnected');}},session:{context:async()=>[]}});await Bun.sleep(20);
 expect(readReport(dir)?.status).toBe('needs-input');
 expect(readReport(dir)?.summary).toContain('reporting disconnected');clean5();
});
test('reporting refuses malformed JSON configuration without silently replacing user settings',()=>{
 const launch=prepare({agent:'opencode',version:'2.1.2',newSessionId:'ses_owned',request:'Talk',workspace:'/tmp/repo',runDir:'/tmp/run',attachments:[],permissionPolicy:'native'});
 expect(()=>materializeAgentReporting(tmpDir(),launch,{OPENCODE_CONFIG_CONTENT:'[]'})).toThrow();
});


function reportingRun() {
  const ctx = fakeCtx({now: Date.now() / 1000}), repo = tmpDir();
  const task = createTask(ctx, {brief: {goal: 'Report completion', repo}, kind: null, requestedExecutor: null, timeoutS: 30});
  const dir = join(ctx.pacerHome, 'runs', task.id, '1');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'interactive.json'), JSON.stringify({reportToken: 'owned-token'}));
  updateTask(ctx, task.id, t => {
    t.state = 'running'; t.attemptStartedAt = ctx.now;
    t.run = {dir, attempt: 1, executor: 'codex', startedAt: ctx.now, mode: 'current', workdir: repo, logFile: join(dir, 'log')};
  });
  ctx.env = {PACER_ROLE: 'executor', PACER_RUN_DIR: dir, PACER_REPORT_TOKEN: 'owned-token'};
  return {ctx, task, dir};
}
const completion = (ctx: ReturnType<typeof fakeCtx>, id?: string) => reportCommand([
  ...(id ? ['--task', id] : []), '--outcome', 'done', '--summary', 'Finished and checked',
], ctx);

test('agent report ignores an empty overridden home and the runner settles the launch task', async () => {
  const {ctx, task, dir} = reportingRun();
  const emptyHome = tmpDir();
  const result = completion({...ctx, pacerHome: emptyHome, env: {...ctx.env, PACER_HOME: emptyHome}}, task.id);
  expect(result.code).toBe(0);
  expect(result.err).toBe('pacer: PACER_HOME was ignored for this report; using the launch home from PACER_RUN_DIR');
  expect(readTask({...ctx, pacerHome: emptyHome}, task.id)).toBeNull();
  expect(readReport(dir)).toMatchObject({status: 'done', source: 'agent'});
  const strategy = validateStrategy({planner: 'claude-code', providers: {codex: {session: 'interactive'}}}, ctx.home);
  const settled = await runTask(ctx, task.id, {
    loadStrategy: () => strategy,
    computeStatus: async () => {throw Error('resumed attempt must not route again');},
    verifyRepo: async () => ({files: ''}),
  });
  expect(settled.state).toBe('done');
  expect(settled.result?.report).toContain('Finished and checked');
});

for (const token of ['wrong', 'other-token', 'éwned-token', '', undefined]) test(`agent report rejects token ${token ?? 'missing'} with an overridden home`, () => {
  const {ctx, dir} = reportingRun();
  const result = completion({...ctx, pacerHome: tmpDir(), env: {...ctx.env, PACER_REPORT_TOKEN: token}});
  expect(result.code).toBe(2);
  expect(result.err).toContain('PACER_REPORT_TOKEN mismatch or missing for this attempt');
  expect(readReport(dir)).toBeNull();
});

test('report explains a missing task in the launch store and missing user launch environment', () => {
  const {ctx, task} = reportingRun();
  const dir = join(tmpDir(), 'runs', task.id, '1'); mkdirSync(dir, {recursive: true});
  expect(completion({...ctx, env: {...ctx.env, PACER_RUN_DIR: dir}}).err).toContain('not found in the launch home derived from PACER_RUN_DIR');
  expect(completion({...ctx, pacerHome: tmpDir(), env: {}}, task.id).err).toContain("not found in PACER_HOME; pacer report must run in the executor's launch environment");
  expect(completion({...ctx, env: {PACER_ROLE: 'executor'}}, task.id).err).toContain("must run in the executor's launch environment");
});

for (const state of ['done', 'failed', 'queued'] as const) test(`report explains task state ${state}`, () => {
  const {ctx, task, dir} = reportingRun();
  updateTask(ctx, task.id, t => {t.state = state;});
  expect(completion(ctx).err).toContain(`is not running (state: ${state})`);
  expect(readReport(dir)).toBeNull();
});

test('report rejects a stale attempt number even if its saved path matches', () => {
  const {ctx, task, dir} = reportingRun();
  updateTask(ctx, task.id, t => {t.run!.attempt = 2;});
  expect(completion(ctx).err).toContain('report attempt mismatch');
  expect(readReport(dir)).toBeNull();
});

test('report rejects a stale attempt directory', () => {
  const {ctx, task, dir} = reportingRun();
  const next = join(ctx.pacerHome, 'runs', task.id, '2'); mkdirSync(next);
  updateTask(ctx, task.id, t => {t.run!.attempt = 2; t.run!.dir = next;});
  expect(completion(ctx).err).toContain('report attempt mismatch');
  expect(readReport(dir)).toBeNull();
});

test('report requires a local run', () => {
  const {ctx, task} = reportingRun();
  updateTask(ctx, task.id, t => {t.run!.host = 'remote';});
  expect(completion(ctx).err).toContain('has no active local run; report from its local executor');
});

test('report refuses another task even with the same token', () => {
  const first = reportingRun(), second = reportingRun();
  const result = completion({...first.ctx, env: {...first.ctx.env, PACER_RUN_DIR: second.dir}}, first.task.id);
  expect(result.code).toBe(2);
  expect(result.err).toContain("report task id does not match PACER_RUN_DIR's task directory");
  expect(readReport(first.dir)).toBeNull(); expect(readReport(second.dir)).toBeNull();
});

test('report accepts a whole-directory symlink alias to its launch run', () => {
  const {ctx, task, dir} = reportingRun();
  const alias = join(tmpDir(), 'launch-run');
  symlinkSync(dir, alias);
  const result = completion({...ctx, env: {...ctx.env, PACER_RUN_DIR: alias}}, task.id);
  expect(result.code).toBe(0);
  expect(readReport(dir)).toMatchObject({status: 'done', source: 'agent'});
});

test('report refuses a whole-directory alias to another task run', () => {
  const first = reportingRun(), second = reportingRun();
  writeFileSync(join(second.dir, 'interactive.json'), JSON.stringify({reportToken: 'other-token'}));
  const alias = join(tmpDir(), 'launch-run');
  symlinkSync(second.dir, alias);
  const ctx = {...first.ctx, env: {...first.ctx.env, PACER_RUN_DIR: alias}};
  const explicit = completion(ctx, first.task.id);
  expect(explicit.code).toBe(2);
  expect(explicit.err).toContain("report task id does not match PACER_RUN_DIR's task directory");
  const implicit = completion(ctx);
  expect(implicit.code).toBe(2);
  expect(implicit.err).toContain('PACER_REPORT_TOKEN mismatch or missing for this attempt');
  expect(readReport(first.dir)).toBeNull(); expect(readReport(second.dir)).toBeNull();
});

for (const suffix of ['outside', 'runs/not-a-task/1', 'runs/t-20261030-091103-abcd/0', 'runs/t-20261030-091103-abcd/1/extra']) test(`report refuses forged layout ${suffix}`, () => {
  const {ctx, dir} = reportingRun();
  const forged = join(tmpDir(), suffix); mkdirSync(forged, {recursive: true});
  writeFileSync(join(forged, 'interactive.json'), JSON.stringify({reportToken: 'owned-token'}));
  const result = completion({...ctx, env: {...ctx.env, PACER_RUN_DIR: forged}});
  expect(result.code).toBe(2); expect(result.err).toContain('invalid PACER_RUN_DIR layout');
  expect(readReport(dir)).toBeNull();
});

for (const component of ['runs', 'task', 'attempt']) test(`report refuses symlink escape at ${component}`, () => {
  const {ctx, task, dir} = reportingRun();
  const home = tmpDir();
  let forged: string;
  if (component === 'runs') {
    symlinkSync(join(ctx.pacerHome, 'runs'), join(home, 'runs'));
    forged = join(home, 'runs', task.id, '1');
  } else if (component === 'task') {
    mkdirSync(join(home, 'runs'));
    symlinkSync(join(ctx.pacerHome, 'runs', task.id), join(home, 'runs', task.id));
    forged = join(home, 'runs', task.id, '1');
  } else {
    mkdirSync(join(home, 'runs', task.id), {recursive: true});
    symlinkSync(dir, join(home, 'runs', task.id, '1'));
    forged = join(home, 'runs', task.id, '1');
  }
  expect(completion({...ctx, env: {...ctx.env, PACER_RUN_DIR: forged}}).err).toContain('invalid PACER_RUN_DIR layout');
  expect(readReport(dir)).toBeNull();
});
