import { expect, test } from 'bun:test';
import { createApi } from '../app/src/data/api';

test('task history requests a cursor page rather than a legacy summary array',async()=>{
 const original=globalThis.fetch;
 const paths:string[]=[];
 globalThis.fetch=(async(input)=>{paths.push(String(input));return Response.json(String(input).endsWith('/hello')?{protocol:'3.0.0',pacer:'0.2.3',ops:['task.list'],events:[]}:{result:{tasks:[],next:null}});}) as typeof fetch;
 try {
  await createApi().call('task.list',{all:true,limit:20});
  expect(paths).toEqual(['/v3/hello','/v3/ops/task.list']);
 }finally{globalThis.fetch=original;}
});

test('an older service still returns a cursor page for history',async()=>{
 const original=globalThis.fetch;
 const calls:{path:string;params:any}[]=[];
 globalThis.fetch=(async(input,init)=>{
  const path=String(input);
  calls.push({path,params:JSON.parse(String(init?.body??'{}'))});
  if(path.startsWith('/v3/')) return Response.json({error:{code:'not_found',message:'Unknown version'}},{status:404});
  return Response.json(path.endsWith('/hello')?{protocol:'2.1.0',pacer:'0.2.3',ops:['task.list'],events:[]}:{result:{tasks:[],next:null}});
 }) as typeof fetch;
 try {
  expect(await createApi().call<{tasks:unknown[];next:null}>('task.list',{all:true,limit:20})).toEqual({tasks:[],next:null});
  expect(calls.map(call=>call.path)).toEqual(['/v3/hello','/v2/hello','/v3/ops/task.list','/v2/ops/task.list']);
  expect(calls[2]?.params).toEqual({all:true,limit:20});
  expect(calls[3]?.params).toEqual({all:true,limit:20,states:['queued','running','done','partial','failed','limit','stopped','needs_input']});
 }finally{globalThis.fetch=original;}
});
