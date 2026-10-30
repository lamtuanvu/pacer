import {serve,type PluginManifest} from '@pacer/plugin';
const manifest:PluginManifest={id:'observe-test',version:'1.0.0',publisher:'pacer',host:'^1.6',contributes:{policy:{}},capabilities:[{name:'tasks.read'},{name:'events.subscribe'},{name:'log'},{name:'config.get'}],reentrant:true,tier:'free'};
await serve({manifest,handlers:{'diagnostic.ping':async(_params,host)=>{
  const tasks=await host.tasks.list({states:['queued'],limit:1});
  await host.events.subscribe(['task']);
  return {ok:true,uptimeS:0,count:tasks.length};
}},onEvent:async(event,host)=>{
  if(event.type==='reset'){await host.log('info','reset');return;}
  const task=await host.tasks.read((event.data as {id:string}).id);
  await host.log('info',JSON.stringify({event:event.type,id:task.id,state:task.state,callbackHasCall:'call' in host,callbackHasFs:'fs' in host}));
}});
