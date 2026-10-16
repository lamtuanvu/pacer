import type { Ctx } from '../types';
import type { TaskData } from '../link/envelope';
import { sessionInfo } from './service';
const cache=new Map<string,{at:number;session:NonNullable<TaskData['session']>}>();
/** Publish session changes at most once per second without delaying task state changes. */
export async function sessionTaskData(ctx:Ctx,data:TaskData,orcaLive:boolean):Promise<TaskData>{
 const key=`${ctx.pacerHome}\0${data.id}`,previous=cache.get(key);
 let session=previous?.session;
 if(!previous||ctx.now-previous.at>=1||ctx.now<previous.at){
  try{const info=await sessionInfo(ctx,data.id,orcaLive,false);session={host:info.host,live:info.live,controller:info.controller,viewers:info.viewers};}
  catch{session={host:'none',live:false,controller:null,viewers:0};}
  cache.set(key,{at:ctx.now,session});
  if(cache.size>1000)cache.delete(cache.keys().next().value!);
 }
 return {...data,session,terminalPresent:session?.host==='orca'&&session.live};
}
