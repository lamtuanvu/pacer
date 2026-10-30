import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import type {AccountCfg,RunnerCfg} from '../config/accounts';
import type {Ctx} from '../types';
import {readKey} from '../endpoints/keys';
import {redactEndpointError,type EndpointState} from '../endpoints/state';
import {CoreError} from '../core/errors';
import {endpointState} from './endpoint-protocol';
import {pluginRegistry} from './index';
import type {PluginRegistry} from './registry';
import {projectEndpointAccounts,queueEndpointConfigWrite} from './endpoint-adapter';
/** Host owns disposable resources and key storage; the plugin owns fixed test behavior. */
export async function testManagedEndpoint(ctx:Ctx,accounts:Record<string,AccountCfg>,name:string,runner:RunnerCfg,registry:Pick<PluginRegistry,'find'|'call'>=pluginRegistry(ctx)):Promise<EndpointState>{
 const selected=accounts[name],connection=selected?.connection;
 if(!connection)throw new CoreError('invalid_input','configured endpoint connection required');
 if(runner.host)throw new CoreError('invalid_input','remote runner test tasks are not supported yet');
 const projected=projectEndpointAccounts(accounts),account=projected.find(value=>value.name===name)!;
 const id=registry.find(ctx,'endpoint',value=>Array.isArray(value.apis)&&value.apis.includes('openai-compatible'));
 if(!id)throw new CoreError('plugin_unavailable','no enabled plugin provides OpenAI-compatible endpoints');
 const configSource=ctx.env.OPENCODE_CONFIG_CONTENT??'{}';let inline:unknown;
 try{inline=JSON.parse(configSource);}catch{throw new CoreError('invalid_input','Invalid OPENCODE_CONFIG_CONTENT: expected a JSON object');}
 if(!inline||typeof inline!=='object'||Array.isArray(inline))throw new CoreError('invalid_input','Invalid OPENCODE_CONFIG_CONTENT: expected a JSON object');
 const config=JSON.stringify({...inline,default_agent:'build',...(runner.model?{model:runner.model}:{})});
 const configRef='endpoint:launchConfig',plain:Record<string,string>={HOME:ctx.home,PATH:ctx.env.PATH??'/usr/bin:/bin',PACER_ROLE:'executor'};
 for(const key of ['LANG','LC_ALL','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','OPENCODE_DISABLE_MODELS_FETCH'])if(ctx.env[key]!==undefined)plain[key]=ctx.env[key]!;
 const root=join(ctx.pacerHome,'endpoints');mkdirSync(root,{recursive:true,mode:0o700});const repository=mkdtempSync(join(root,'test-'));
 const dir=join(ctx.pacerHome,'opencode'),path=join(dir,'opencode.json'),keyEnv=`PACER_KEY_${name.toUpperCase().replaceAll('-','_')}`;
 const secretEnv={OPENCODE_CONFIG_CONTENT:configRef,...(account.keyRef?{[keyEnv]:account.keyRef}:{})};
 const argv=['opencode','run','--standalone','--agent','build','-m',runner.model??'','--auto','--title','pacer endpoint-test','Create a file named hello.txt containing exactly: ok'];
 const keySource=connection.key;let resolvedKey:string|null=null;
 try{
 const result=await queueEndpointConfigWrite(ctx,()=>registry.call(ctx,id,'endpoint.test',{account,accounts:projected,pacerHome:ctx.pacerHome,runner:{id:runner.id,model:runner.model??''},repository,env:plain,configRef,checkedAt:new Date(ctx.now*1000).toISOString()},{resources:{reads:[{path:join(repository,'hello.txt'),kind:'file'}],writes:[{path:dir,kind:'directory',operations:['mkdir']},{path,kind:'file',operations:['write']}],commands:[{argv:['git','init','-q',repository],timeoutMs:10000,cwd:repository,env:plain},{argv,timeoutMs:120000,cwd:repository,env:{...plain,OPENCODE_CONFIG:path},secretEnv}],stores:[]},credentialBindings:[{ref:configRef,resolve:async()=>config},...(account.keyRef?[{ref:account.keyRef,resolve:async()=>resolvedKey=await readKey(ctx,name,keySource)}]:[])]}));
 const parsed=endpointState.safeParse(result);if(!parsed.success)throw new CoreError('plugin_refused','endpoint plugin returned an invalid test state');
 return {...parsed.data,...(parsed.data.detail?{detail:redactEndpointError(parsed.data.detail,[resolvedKey??'',config])}:{})};
 }catch(error){return {state:'not_working',detail:redactEndpointError(`test task failed: ${error instanceof Error?error.message:'unknown error'}`,[resolvedKey??'',config])};}
 finally{rmSync(repository,{recursive:true,force:true});}
}
