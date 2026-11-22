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

test('an older v2-only service is not compatible: the app calls only /v3 and rejects',async()=>{
 const original=globalThis.fetch;
 const calls:{path:string;params:any}[]=[];
 globalThis.fetch=(async(input,init)=>{
  const path=String(input);
  calls.push({path,params:JSON.parse(String(init?.body??'{}'))});
  // The app is protocol-3 only: it never falls back to /v2, it just asks once.
  return Response.json({error:{code:'not_found',message:'Unknown version'}},{status:404});
 }) as typeof fetch;
 try {
  await expect(createApi().call('task.list',{all:true,limit:20})).rejects.toMatchObject({code:'unsupported_protocol'});
  expect(calls.map(call=>call.path)).toEqual(['/v3/hello']);
 }finally{globalThis.fetch=original;}
});
