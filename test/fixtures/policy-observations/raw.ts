import {createInterface} from 'node:readline';
const waiting=new Map<string,{resolve:(value:any)=>void;reject:(error:any)=>void}>();let next=1;
const send=(value:unknown)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value as object})+'\n');
const request=(method:string,params:unknown,meta:unknown)=>new Promise<any>((resolve,reject)=>{const id=`raw${next++}`;waiting.set(id,{resolve,reject});send({id,method,params,_meta:meta});});
const input=createInterface({input:process.stdin});
input.on('line',line=>{void (async()=>{
 const message=JSON.parse(line);
 if(typeof message.id==='string'){const pending=waiting.get(message.id);if(!pending)return;waiting.delete(message.id);if(message.error)pending.reject(message.error);else pending.resolve(message.result);return;}
 if(message.method==='plugin.hello'){send({id:message.id,result:{protocol:process.argv[2]==='old'?'1.4.0':message.params.protocol,id:message.params.manifest.id,version:message.params.manifest.version,contributes:Object.keys(message.params.manifest.contributes),features:['old','no-feature'].includes(process.argv[2]??'')?[]:['policyObservations']}});return;}
 if(message.method==='$/event'){if(message.params.type==='reset')process.stderr.write('RESET_RECEIVED\n');return;}
 if(message.method==='usage.read'){
  try{await request('capability.events.subscribe',{types:['task']},message._meta);send({id:message.id,result:{admission:'allowed'}});}catch(error){send({id:message.id,error});}return;
 }
 if(message.method!=='diagnostic.ping')return;
 if(message.params.mode==='reads'){
  const codes:string[]=[];
  for(const [method,params] of [['capability.tasks.list',{}],['capability.tasks.read',{id:'missing'}]] as const){
   try{await request(method,params,message._meta);codes.push('allowed');}catch(error){codes.push((error as any).data?.code??'unknown');}
  }
  send({id:message.id,result:{ok:true,uptimeS:0,codes}});return;
 }
 if(message.params.mode==='late'){
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{ok:true,uptimeS:0}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:'late',method:'capability.events.subscribe',params:{types:['task']},_meta:message._meta})+'\n');
  waiting.set('late',{resolve:()=>process.stderr.write('LATE_ACCEPTED\n'),reject:()=>process.stderr.write('LATE_DENIED\n')});return;
 }
 const subscription=await request('capability.events.subscribe',{types:['task','repo']},message._meta);const meta={readOwner:subscription.readOwner};
 const denials:string[]=[];
 if(message.params.mode==='effects'){
  const root=process.env.HOME!;
  for(const [method,params,authority] of [
   ['capability.fs.read',{path:root+'/sentinel'},meta],['capability.fs.write',{path:root+'/sentinel',text:'changed'},meta],
   ['capability.process.spawn',{argv:[process.execPath,'-e',`Bun.write(${JSON.stringify(root+'/effect')},"effect")`],cwd:root,env:{},timeoutMs:1000},meta],
   ['capability.tasks.list',{}, {readOwner:'foreign'}],['capability.tasks.list',{}, {...meta,...message._meta}],
   ['capability.tasks.list',{}, {readOwner:message.params.foreign??'unknown'}],
  ] as const){try{await request(method,params,authority);denials.push('allowed');}catch(error){denials.push((error as any).data?.code??'unknown');}}
 }
 send({id:message.id,result:{ok:true,uptimeS:0,readOwner:subscription.readOwner,denials,pid:process.pid}});
 if(message.params.mode==='blocked'){input.pause();process.stdin.pause();}
})().catch(error=>{process.stderr.write('RAW_FAILURE '+String(error?.message??error)+'\n');});});
