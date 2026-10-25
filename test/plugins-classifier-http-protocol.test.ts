import { expect, test } from "bun:test";
import * as protocol from "../src/plugins/protocol";
import * as authorities from "../src/plugins/authority";
import { fakeCtx } from "./helpers";
const MAX=4*1024*1024, CHUNK=256*1024;
const ask=()=>protocol.EXTENSION_METHODS["classifier.ask"]!;
const cap=(name:string)=>protocol.CAPABILITY_METHODS[name]!;
test("1.2 adds classifier without losing existing extension methods",()=>{
 expect(protocol.PLUGIN_PROTOCOL_VERSION).toBe("1.3.0");
 for(const point of ["diagnostic","agentSession","usage","classifier"])expect(protocol.EXTENSION_POINTS as readonly string[]).toContain(point);
 for(const name of ["usage.read", "diagnostic.ping"])expect(protocol.EXTENSION_METHODS[name]).toBeDefined();
 expect(protocol.EXTENSION_METHODS["classifier.adapters"]?.deadlineMs).toBe(2000);
 const manifest={id:"private-classifier",version:"0.2.0",publisher:"fixture",host:"^1.2",contributes:{classifier:{adapters:["rules"]}}};
 expect(protocol.helloParams.safeParse({protocol:"1.2.0",pacer:"fixture",manifest,features:["httpBodyChunks"],config:{},grants:[]}).success).toBe(true);
});
test("question and rich answers preserve false zero string and optional fields",()=>{
 expect(ask()).toBeDefined();
 for(const question of [{type:"choice",id:"a",instructions:"pick",criteria:{a:"one"}},{type:"score",id:"b",instructions:"score",min:0,max:1},{type:"yesno",id:"c",instructions:"safe"}])expect(ask().params.safeParse({adapter:"rules",state:"s",question,timeoutMs:3000}).success).toBe(true);
 for(const value of [false,0,"a"]){const r={value,confidence:.8,latencyMs:0,costUsd:.01,probabilities:{a:.8}};expect(ask().result.parse(r)).toEqual(r);}
});
test("ask preserves an opaque provider-neutral host config projection",()=>{
 expect(ask()).toBeDefined();
 const value={adapter:"ollama",state:"s",question:{type:"yesno",id:"q",instructions:"safe"},timeoutMs:3000,config:{baseUrl:"http://localhost:1234/v1",model:"m",maxTokens:512,keyRef:"secrets:KEY"}};
 expect(ask().params.parse(value)).toEqual(value);
 expect((ask().params.parse({...value,config:{custom:{flag:false,count:0},keyRef:"secrets:KEY"}}) as any).config).toEqual({custom:{flag:false,count:0},keyRef:"secrets:KEY"});
 expect(ask().params.safeParse({...value,config:{invalid:()=>"not JSON"}}).success).toBe(false);
});
test("HTTP full4MiB UTF8 text cap is bytes not UTF16 characters",()=>{
 expect(cap("capability.net.http")).toBeDefined();const body="界".repeat(Math.floor(MAX/3))+"x".repeat(MAX%3);const r={url:"http://127.0.0.1/x",method:"POST",body,timeoutMs:1000};
 expect(cap("capability.net.http").params.safeParse(r).success).toBe(true);expect(cap("capability.net.http").params.safeParse({...r,body:body+"x"}).success).toBe(false);
});
test("HTTP wire body reference is strict and response byte count bounded",()=>{
 expect(cap("capability.net.http")).toBeDefined();const r={url:"https://example.test/x",method:"POST",body:{handle:"opaque"},timeoutMs:1000};expect(cap("capability.net.http").params.parse(r)).toEqual(r);
 expect(cap("capability.net.http").params.safeParse({...r,body:{handle:"opaque",path:"/wrong"}}).success).toBe(false);
 expect(cap("capability.net.http").result.safeParse({status:200,headers:{},body:{handle:"response",bytes:MAX}}).success).toBe(true);
 expect(cap("capability.net.http").result.safeParse({status:200,headers:{},body:{handle:"response",bytes:MAX+1}}).success).toBe(false);
});
test("HTTP methods explicitly map net.http and bounded canonical chunks",()=>{
 for(const op of ["begin","stageChunk","readChunk","release"])expect(protocol.capabilityOf("capability.net.http.body."+op)).toBe("net.http");
 const begin=cap("capability.net.http.body.begin");expect(begin?.params.safeParse({bytes:MAX}).success).toBe(true);expect(begin.params.safeParse({bytes:MAX+1}).success).toBe(false);
 const stage=cap("capability.net.http.body.stageChunk");expect(stage.params.safeParse({handle:"h",offset:0,base64:Buffer.alloc(CHUNK).toString("base64")}).success).toBe(true);
 for(const base64 of ["AB==","AAB=","AA=","!!!!",Buffer.alloc(CHUNK+1).toString("base64")])expect(stage.params.safeParse({handle:"h",offset:0,base64}).success).toBe(false);
 const read=cap("capability.net.http.body.readChunk");for(const change of [{offset:-1},{offset:Infinity},{offset:Number.MAX_SAFE_INTEGER+1},{length:CHUNK+1}])expect(read.params.safeParse({handle:"h",offset:0,length:CHUNK,...change}).success).toBe(false);
});
test("presence schema returns only boolean and valid references",()=>{
 const method=cap("capability.secrets.resolve");expect(method).toBeDefined();for(const ref of ["env:KEY","secrets:KEY_A","endpoint:account.name"])expect(method.params.safeParse({ref}).success).toBe(true);
 for(const ref of ["file:/etc/x","env:","env:KEY/path"])expect(method.params.safeParse({ref}).success).toBe(false);
 expect(method.result.parse({present:false,value:"hidden"})).toEqual({present:false});expect(protocol.capabilityOf("capability.secrets.resolve")).toBe("secrets.resolve");
});
test("new transfer feature is additive and legacy hello stays valid",()=>{
 expect(protocol.HTTP_BODY_CHUNK_FEATURE).toBe("httpBodyChunks");const old={protocol:"1.0.0",id:"legacy",version:"1.0.0",contributes:["diagnostic"]};expect(protocol.helloResult.parse(old)).toEqual(old);
 expect(protocol.helloResult.parse({...old,protocol:"1.2.0",features:["chunkedResults","httpBodyChunks"]}).features).toEqual(["chunkedResults","httpBodyChunks"]);
});
test("http optional resources deeply clone and freeze host names",async()=>{
 const resources:any={reads:[],commands:[],stores:[],http:{hosts:["127.0.0.1"]}};const authority=authorities.createCallAuthority(fakeCtx(),resources,{deadlineMs:Date.now()+1000,grants:["net.http"]});
 try{resources.http.hosts[0]="evil.test";const http=(authority.resources as any).http;expect(http.hosts).toEqual(["127.0.0.1"]);expect(Object.isFrozen(http)).toBe(true);expect(Object.isFrozen(http.hosts)).toBe(true);}finally{await authority.revoke();}
});

test("ask preserves positive finite configured timeouts independently of HTTP cap",()=>{
 const params={adapter:"rules",state:"s",question:{type:"yesno",id:"q",instructions:"safe"}};
 for(const timeoutMs of [.5,120001,9e15])expect(ask().params.safeParse({...params,timeoutMs}).success).toBe(true);
 for(const timeoutMs of [0,-1,Infinity,NaN])expect(ask().params.safeParse({...params,timeoutMs}).success).toBe(false);
 for(const timeoutMs of [.5,120001,9e15])expect(cap("capability.net.http").params.safeParse({url:"http://localhost/x",method:"GET",timeoutMs}).success).toBe(false);
});
