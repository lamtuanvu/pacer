import {expect,test} from 'bun:test';
import {createCallAuthority} from '../src/plugins/authority';
import {fakeCtx} from './helpers';
import {PluginProcess,type ProcessHooks} from '../src/plugins/process';
const MAX=1024*1024;
const peer=`const readline=require('node:readline');let parent;readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='probe'){parent=m.id;console.log(JSON.stringify({jsonrpc:'2.0',id:'界'.repeat(40),method:'capability.net.http',params:{old:true},_meta:{capabilityCall:m._meta.capabilityCall,extra:'\\u0000'.repeat(60)}}));}else if(m.id)console.log(JSON.stringify({jsonrpc:'2.0',id:parent,result:m.error?{error:m.error}:m.result}));});`;
function start(onRequest:ProcessHooks["onRequest"]){const owner=createCallAuthority(fakeCtx(),{reads:[],commands:[],stores:[]},{deadlineMs:Date.now()+5000});const p=new PluginProcess({argv:[process.execPath,'-e',peer],cwd:process.cwd(),env:{...process.env}},{onRequest,onStderr:()=>{},onExit:()=>{}});return {p,owner};}
test('actual child transport captures features and exact inbound and reply envelopes',async()=>{
 let checked=false;const offered=['httpBodyChunks'];
 const {p,owner}=start(async(method,_params,meta,deliver,t)=>{
  if(!t)throw new Error("missing transport context");
  expect(typeof deliver).toBe('function');expect(t.features).toEqual(['httpBodyChunks']);expect(Object.isFrozen(t.features)).toBe(true);
  const id='界'.repeat(40),replacement={body:'\0'.repeat(174700)};
  const req=(v:unknown)=>Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id,method,params:v,_meta:meta})+'\n')<=MAX;
  expect(t.requestFits(replacement)).toBe(req(replacement));
  for(const n of [MAX-400,MAX-200,MAX]){const r={body:'a'.repeat(n)};expect(t.resultFits(r)).toBe(Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id,result:r})+'\n')<=MAX);expect(t.requestFits(r)).toBe(req(r));}
  checked=true;return {ok:true};
 });p.setFeatures(offered);offered.push('mutated');try{expect(await p.request('probe',{},3000,{authority:owner,metadata:{capabilityCall:owner.token}})).toEqual({ok:true});expect(checked).toBe(true);}finally{await p.terminate();await owner.revoke();}
});
test('actual child oversized capability result receives safe error instead of overlimit line',async()=>{
 const {p,owner}=start(async()=>({body:'secret'.repeat(MAX)}));try{const r=await p.request<{error:{data:{code:string}}}>('probe',{},3000,{authority:owner,metadata:{capabilityCall:owner.token}});expect(r.error.data.code).toBe('too_large');expect(JSON.stringify(r)).not.toContain('secret');}finally{await p.terminate();await owner.revoke();}
});
