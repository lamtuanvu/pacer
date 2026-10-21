import { expect, test } from 'bun:test';
import { createApi } from '../app/src/data/api';

test('task history requests a cursor page rather than a legacy summary array',async()=>{
 const original=globalThis.fetch;
 const paths:string[]=[];
 globalThis.fetch=(async(input)=>{paths.push(String(input));return Response.json({result:{tasks:[],next:null}});}) as typeof fetch;
 try {
  await createApi().call('task.list',{all:true,limit:20});
  expect(paths).toEqual(['/v3/ops/task.list']);
 }finally{globalThis.fetch=original;}
});

test('an older service still returns a cursor page for history',async()=>{
 const original=globalThis.fetch;
 const calls:{path:string;params:any}[]=[];
 globalThis.fetch=(async(input,init)=>{calls.push({path:String(input),params:JSON.parse(String(init?.body??'{}'))});return String(input).startsWith('/v3/')?Response.json({error:{code:'not_found',message:'Unknown version'}},{status:404}):Response.json({result:{tasks:[],next:null}});}) as typeof fetch;
 try {
  expect(await createApi().call<{tasks:unknown[];next:null}>('task.list',{all:true,limit:20})).toEqual({tasks:[],next:null});
  expect(calls[1]?.path).toBe('/v2/ops/task.list');
  expect(calls[1]?.params.states).toContain('done');
 }finally{globalThis.fetch=original;}
});
