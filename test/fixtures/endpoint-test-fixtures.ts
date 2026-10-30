/** Explicit test-only endpoint transport. Production always dispatches the registry child. */
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {testTask} from '../../plugins/pacer-endpoints/test-task';
import {projectEndpointAccounts} from '../../src/plugins/endpoint-adapter';
import {readKey} from '../../src/endpoints/keys';
import {execProcess,executorEnv,type ExecSpec,type ExecResult} from '../../src/exec/process';
import {redactEndpointError} from '../../src/endpoints/state';
import type {testManagedEndpoint} from '../../src/plugins/endpoint-test';
export function endpointTestFromSpawn(spawn:(spec:ExecSpec)=>Promise<ExecResult>):typeof testManagedEndpoint{return async(ctx,accounts,name,runner)=>{
 const account=accounts[name]!,connection=account.connection!,key=await readKey(ctx,name,connection.key);
 if(connection.key!=='none'&&!key)return {state:'not_working',detail:`test task failed: Key missing for endpoint ${name}`};
 const root=join(ctx.pacerHome,'endpoints');mkdirSync(root,{recursive:true,mode:0o700});const repository=mkdtempSync(join(root,'test-'));
 const projected=projectEndpointAccounts(accounts),selected=projected.find(value=>value.name===name)!;
 const host={fs:{mkdir:async(path:string)=>{mkdirSync(path,{recursive:true,mode:0o700});},write:async(path:string,text:string)=>{writeFileSync(path,text,{mode:0o600});},remove:async()=>{}},call:async(method:string,params:any)=>{
 if(method==='capability.fs.read'){try{return {text:readFileSync(params.path,'utf8')};}catch{return {missing:true};}}
 const env=Object.fromEntries(Object.entries(params.env).map(([name,value])=>[name,typeof value==='string'?value:key??'']));
 const spec={argv:params.argv,cwd:params.cwd,env:executorEnv(ctx.env,env),timeoutMs:params.timeoutMs};return params.argv[0]==='git'?execProcess(spec):spawn(spec);
 }};
 try{const result=await testTask(host as any,{account:selected,accounts:projected,pacerHome:ctx.pacerHome,runner:{id:runner.id,model:runner.model??''},repository,env:{},checkedAt:new Date(ctx.now*1000).toISOString()});return {...result,...('detail'in result?{detail:redactEndpointError(result.detail??'',[key??''])}:{})};}
 finally{rmSync(repository,{recursive:true,force:true});}
};}
