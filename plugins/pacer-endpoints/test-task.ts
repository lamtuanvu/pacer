import type {HostClient} from '@pacer/plugin';
import {join} from 'node:path';
import {launchEnv,type LaunchInput} from './launch-env';
export interface TestInput extends LaunchInput {account:NonNullable<LaunchInput['account']>;runner:{id:string;model:string};repository:string;env:Record<string,string>;checkedAt:string;configRef?:string}
interface SpawnResult {code:number;stdout?:string;stderr?:string;timedOut:boolean}
const prompt='Create a file named hello.txt containing exactly: ok';
/** Disposable directory identity and exact commands are issued by the host. */
export async function testTask(host:Pick<HostClient,'fs'|'call'>,input:TestInput){
 try{
  const launch=await launchEnv(host,input);
  const git=await host.call<SpawnResult>('capability.process.spawn',{argv:['git','init','-q',input.repository],cwd:input.repository,env:input.env,timeoutMs:10000});
  if(git.code!==0||git.timedOut)throw Error('could not create test git repo');
  const env={...input.env,...launch.env,...(input.configRef?{OPENCODE_CONFIG_CONTENT:{secretRef:input.configRef}}:{}),...Object.fromEntries(Object.entries(launch.secretEnv).map(([name,secretRef])=>[name,{secretRef}]))};
  const result=await host.call<SpawnResult>('capability.process.spawn',{argv:['opencode','run','--standalone','--agent','build','-m',input.runner.model,'--auto','--title','pacer endpoint-test',prompt],cwd:input.repository,env,timeoutMs:120000});
  if(result.timedOut)throw Error('test task timed out');
  if(result.code!==0)throw Error(result.stderr?.trim()||result.stdout?.trim()||`test task exited ${result.code}`);
  const file=await host.call<{text?:string;missing?:true}>('capability.fs.read',{path:join(input.repository,'hello.txt')});
  if(file.text!=='ok')throw Error('test task did not create hello.txt containing exactly: ok');
  return {state:'ready' as const,checked_at:input.checkedAt};
 }catch(error){return {state:'not_working' as const,detail:`test task failed: ${error instanceof Error?error.message:'unknown error'}`};}
}
