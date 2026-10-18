import type { BrowserApi } from '../../data/api';
import type { SessionInfo } from '../../../../src/session/service';
export type TakeoverState='starting'|'driving'|'ended';
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
