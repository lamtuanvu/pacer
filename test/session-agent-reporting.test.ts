import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {tmpDir} from './helpers';
import {prepare} from '../plugins/agent-session';
import {materializeAgentReporting} from '../src/session/agent-reporting';
import {readReport,writeReport} from '../src/session/reports';

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
