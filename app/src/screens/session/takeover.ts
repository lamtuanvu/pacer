import type { BrowserApi } from '../../data/api';
import type { SessionInfo } from '../../../../src/session/service';
import { interactiveHost } from '../../term/activity';
export type TakeoverState='starting'|'driving'|'ended';
/** Take over is offered for a headless run that can be taken over, or a live 1.1 session; a live 1.2 session already types. */
export function offersTakeover(session?:Pick<SessionInfo,'host'|'live'|'takeover'|'sessionMinor'>|null,runtimeShared?:boolean):boolean{
 if(!session)return false;
 return session.takeover.available||session.host==='builtin'&&session.live&&!interactiveHost(session,runtimeShared);
}
/** Asked before a 1.2 takeover session hands back: task.hand_back ends it and sends the task to review. */
export const HAND_BACK_CONFIRM='Hand back? This ends your session and sends the task to review.';
/** Ends a takeover session on a 1.2 host, where releasing control no longer hands back (ADR 0023). */
export async function handBackSession({id,call}:{id:string;call:BrowserApi['call']}){
 await call('task.hand_back',{id});
}
/** A retry resumes polling an accepted takeover rather than submitting it again. */
export async function takeoverSession({id,call,state,starting,ready,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),signal}:{id:string;call:BrowserApi['call'];state?:TakeoverState;starting:()=>void;ready:(session:SessionInfo)=>void;sleep?:(ms:number)=>Promise<unknown>;signal?:AbortSignal}) {
 const check=()=>{if(signal?.aborted)throw new Error('Takeover cancelled');};
 check();
 state??=(await call<{state:TakeoverState}>('task.takeover',{id})).state;
 check();
 if(state==='ended')return;
 const timeout=()=>new Error('Interactive session did not start within 30 seconds. Try again.');
 let timer:ReturnType<typeof setTimeout>|undefined,expired=false;
 const poll=async()=>{
  if(state==='starting')starting();
  for(let i=0;i<60;i++){
   if(state==='starting')await sleep(500);
   check();if(expired)throw timeout();
   const session=await call<SessionInfo>('task.session',{id});
   check();if(expired)throw timeout();
   if(session.driving||session.live||state==='driving'){ready(session);return session;}
  }
  throw timeout();
 };
 try{return await Promise.race([poll(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(timeout());},30_000);})]);}
 finally{clearTimeout(timer);}
}
