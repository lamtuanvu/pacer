import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../core/errors';
import type { AccountCfg } from '../config/accounts';
import { loadStrategy } from '../config/strategy';
import { resolveRunner } from '../config/runner-id';
import { executorEnv } from '../exec/process';
import { runnerEnv } from '../exec/launch';
import { terminalEnv, profileKeys, profileColor, terminalUmask } from '../exec/login-env';
import { prepareAgentSession } from '../plugins/agent-session';
import { prepareSession } from './capabilities';
import { probeAgentSession } from './agent-probe';
import { conversationIdentity } from './native-identity';
import { materializeAgentReporting } from './agent-reporting';
import { prepareInteractive } from './reports';
import type { Ctx } from '../types';
import type { AgentLaunch, StoredAgentSession } from './agents';

export function agentAccountKey(agent:string,account:AccountCfg):string {
 return createHash('sha256').update(JSON.stringify({agent,name:account.name,kind:account.kind,source:account.source,home:account.home,orcaAccount:account.orcaAccount,provider:account.provider,connection:account.connection?{api:account.connection.api,base_url:account.connection.base_url,key:account.connection.key}:undefined})).digest('hex');
}

/** Native adapter launch with the selected account and per-session identity. */
export async function launchAgentSession(ctx:Ctx,s:StoredAgentSession,dir:string,resume:boolean):Promise<AgentLaunch> {
 const prepared=await prepareSession(ctx,{repo:s.cwd,executor:s.executor});
 const executor=prepared.executors.find(e=>e.id===s.executor);
 if(!executor?.available || resume&&!executor.capabilities.resume)throw new CoreError('not_allowed',executor?.reason??'This agent cannot start this session');
 const strategy=loadStrategy(ctx),cfg=strategy.providers[s.executor],runner=resolveRunner(strategy,s.executor);
 if(!cfg||!runner||runner.host)throw new CoreError('not_allowed','Choose a local interactive executor');
 const model=resume?s.model:cfg.model;
 const base=await terminalEnv(ctx.env,{cwd:ctx.home,workdir:s.cwd,now:ctx.now*1000});
 const env=executorEnv(base.env,await runnerEnv(ctx,resume?{...runner,model:s.model??null}:runner),undefined,profileKeys(base));
 // User-operated conversations have no delegated work/report authority over their task.
 for(const key of Object.keys(env))if(key.startsWith('PACER_'))delete env[key];
 env.HOME=ctx.home;env.PACER_HOME=ctx.pacerHome;env.PACER_ROLE='executor';env.PACER_RUN_DIR=dir;
 const accountKey=createHash('sha256').update(JSON.stringify([agentAccountKey(executor.agent,strategy.accounts[runner.account]),env.CODEX_HOME??ctx.home,env.CLAUDE_CONFIG_DIR??ctx.home,env.OPENCODE_CONFIG??null])).digest('hex');
 if(resume&&s.accountKey!==accountKey)throw new CoreError('conflict','The session account changed; restore it before resuming');
 const probe=await probeAgentSession(ctx,executor.agent,env);
 if(probe.reason)throw new CoreError('not_allowed',probe.reason);
 const identity=await conversationIdentity(ctx,{...probe,taskId:s.id,workspace:s.cwd,env,model:model??undefined,...(resume?{sessionId:s.nativeId}:{})});
 let request=s.request;
 if(Buffer.byteLength(request)>32768){const path=join(dir,'prompt.md');writeFileSync(path,request,{mode:0o600});request=`Read the request in ${JSON.stringify(path)} and continue this conversation.`;}
 const launch=await prepareAgentSession(ctx,{...probe,request,workspace:s.cwd,runDir:dir,attachments:[],permissionPolicy:'native',...(model?{model}:{}),...(resume?{sessionId:s.nativeId}:identity?{newSessionId:identity.id}:{})});
 materializeAgentReporting(dir,launch,env);
 const interactive=prepareInteractive(executor.agent,dir,launch,{attended:true});
 return {...interactive,env,identity:identity?.id,accountKey,model,umask:terminalUmask(base),keepColor:profileColor(base)};
}
