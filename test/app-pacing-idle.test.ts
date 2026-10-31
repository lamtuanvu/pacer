import {expect,test} from 'bun:test';
import {resourceRevision} from '../app/src/screens/settings/shared';
import {queryRevision} from '../app/src/screens/task-shared';
import {createQuery} from '../app/src/data/query';
import {initialState} from '../app/src/data/store';

test('account and routing queries stay idle through a minute of unrelated events',async()=>{
 for(const op of ['account.list','routing.status']) {
  let calls=0;
  const query=createQuery(async()=>{calls++;return [];},()=>{});
  for(let second=0;second<60;second++) {
   const invalidations={update:second,plugin:second,delegation:second};
   query.update(op,'{}',resourceRevision(op,invalidations));
   await Promise.resolve();await Promise.resolve();
   expect(queryRevision({...initialState(),invalidations},op,{})).toBe(queryRevision(initialState(),op,{}));
  }
  expect(calls).toBe(1);
  query.update(op,'{}',resourceRevision(op,{accounts:1}));
  await Promise.resolve();
  expect(calls).toBe(2);query.dispose();
 }
});

test('control claims and setup checks have bounded sequential idle polling',async()=>{
 const {startPolling}=await import('../app/src/data/poll');
 const {startClientControl}=await import('../app/src/data/control');
 let now=0;
 const timers:{at:number;run:()=>void;cancelled:boolean}[]=[];
 const schedule=(run:()=>void,delay:number)=>{const timer={at:now+delay,run,cancelled:false};timers.push(timer);return()=>{timer.cancelled=true;};};
 const calls:Record<string,number>={};
 const call=async(op:string)=>{calls[op]=(calls[op]??0)+1;return op==='client.control.enroll'?{client_id:'client',worker_token:'private'}:null;};
 const stopControl=startClientControl({hello:async()=>({ops:['client.control.enroll']}),call} as any,'main',async()=>true,schedule);
 const stopSetup=startPolling(async()=>{await call('setup.check');},30000,schedule);
 const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 await settle();
 for(let second=1;second<=60;second++) {
  now=second*1000;
  for(const timer of [...timers])if(!timer.cancelled&&timer.at<=now){timer.cancelled=true;timer.run();}
  await settle();
  if(second===30)expect((calls['client.control.claim']??0)-1+(calls['setup.check']??0)-1).toBeLessThanOrEqual(5);
 }
 expect(calls['client.control.enroll']).toBe(1);
 expect(calls['client.control.claim']).toBe(7);
 expect(calls['setup.check']).toBe(3);
 stopControl();stopSetup();
 expect(timers.filter(timer=>!timer.cancelled)).toHaveLength(0);
 // A slow request must not schedule another tick until it finishes.
 let finish!:()=>void;
 const stopSlow=startPolling(()=>new Promise<void>(resolve=>{finish=resolve;}),1000,schedule);
 expect(timers.filter(timer=>!timer.cancelled)).toHaveLength(0);
 stopSlow();finish();await settle();
 expect(timers.filter(timer=>!timer.cancelled)).toHaveLength(0);
});

test('budget queries refetch when account usage events carry a new reading',()=>{
 const state={...initialState(),snapshot:{accounts:[{name:'team',usedPct:20,capturedAt:1}]}} as any;
 for(const op of ['account.list','routing.status']) {
  const before=queryRevision(state,op,{});
  expect(queryRevision({...state,snapshot:{accounts:[{name:'team',usedPct:25,capturedAt:2}]}},op,{})).not.toBe(before);
 }
});
