#!/usr/bin/env bun
import {serve,type PluginManifest} from '@pacer/plugin';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
// The pid lets a case see this child exit even when the host does not report it.
writeFileSync(join(import.meta.dir,'pid'),String(process.pid));
const manifest=JSON.parse(readFileSync(join(import.meta.dir,'pacer-plugin.json'),'utf8')) as PluginManifest;
await serve({manifest,handlers:{'diagnostic.ping':async(_params,host)=>{const config=await host.config();await host.events.subscribe((config.types??['task']) as ['task']);return {ok:true,uptimeS:0};}},onEvent:async(event,host)=>{
 if(event.type==='reset'){await host.log('info','observation reset');return;}
 const data=event.data as {id?:string;taskId?:string};const id=event.type==='task'?data.id:data.taskId;if(!id)return;
 const task=await host.tasks.read(id);
 await host.log('info',JSON.stringify({type:event.type,id:task.id,state:task.state,hasEffects:'fs' in host||'call' in host}));
}});
