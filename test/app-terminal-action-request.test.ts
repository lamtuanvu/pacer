import {expect,test} from "bun:test";
import {TerminalActionRequests} from "../app/src/data/terminal-action-request";
import {createApi} from "../app/src/data/api";

test("ambiguous action failure retries with the same launch ID",()=>{
  let count=0;
  const requests=new TerminalActionRequests(()=>`request-${++count}`);
  const first=requests.prepare("host.terminal",{alias:"devbox"});
  requests.finish(first.key,0);
  expect(requests.prepare("host.terminal",{alias:"devbox"}).params).toEqual(first.params);
  expect(requests.prepare("host.terminal",{alias:"other"}).params).toMatchObject({request_id:"request-2"});
  requests.finish(first.key,403);
  expect(requests.prepare("host.terminal",{alias:"devbox"}).params).toMatchObject({request_id:"request-3"});
});

test("successful action clears its pending launch ID",()=>{
  let count=0;
  const requests=new TerminalActionRequests(()=>`request-${++count}`);
  const first=requests.prepare("strategy.build",{brief:"Plan"});
  requests.finish(first.key);
  expect(requests.prepare("strategy.build",{brief:"Plan"}).params).toMatchObject({request_id:"request-2"});
  expect(requests.prepare("terminal.list",{}).params).toEqual({});
});

test("a successful app action opens its built-in terminal route",async()=>{
  const originalFetch=globalThis.fetch;
  const originalLocation=Object.getOwnPropertyDescriptor(globalThis,"location");
  const calls:string[]=[];
  const id="ca830324-75a6-41d3-9684-d8537c89ea4c";
  Object.defineProperty(globalThis,"location",{configurable:true,value:{hash:"#/settings"}});
  globalThis.fetch=(async(input:RequestInfo|URL)=>{
    const path=String(input);calls.push(path);
    if(path==="/v3/hello") return Response.json({protocol:"3.0.0",ops:[],events:[]});
    if(path==="/v3/ops/account.signin") return Response.json({result:{terminalId:id,opened:true}});
    return new Response("unexpected request",{status:500});
  }) as typeof fetch;
  try {
    const result=await createApi().call<{terminalId:string}>("account.signin",{account:"team"});
    expect(result.terminalId).toBe(id);
    expect((globalThis as typeof globalThis & {location:{hash:string}}).location.hash).toBe(`#/terminal/${id}`);
    expect(calls).toEqual(["/v3/hello","/v3/ops/account.signin"]);
  } finally {
    globalThis.fetch=originalFetch;
    if(originalLocation) Object.defineProperty(globalThis,"location",originalLocation);
    else delete (globalThis as {location?:unknown}).location;
  }
});
