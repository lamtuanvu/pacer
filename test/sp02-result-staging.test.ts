import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCallAuthority } from "../src/plugins/authority";
import { ResultStaging } from "../src/plugins/result-staging";
import { fakeCtx } from "./helpers";
const CHUNK = 262144;
function fixture(deadlineMs = Date.now() + 10000) {
  const authority = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [] }, { deadlineMs });
  return { authority, staging: new ResultStaging(authority) };
}
async function stage(staging: ResultStaging, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const part = bytes.subarray(offset, offset + CHUNK);
    expect(await staging.stage(offset, part.toString("base64"))).toEqual({ bytes: offset + part.length });
  }
}

test("staging preserves >1MiB rich fields and UTF8 across bounded physical chunks", async () => {
  const f = fixture();
  const rich = { windows: [], capturedAt: 100, stale: false, alternatives: [{ unknownFuture: "界".repeat(400000), spendUsd: 3 }], evidence: { unknownFuture: true } };
  try {
    const bytes = Buffer.from(JSON.stringify(rich));
    await stage(f.staging, bytes);
    expect(await f.staging.finish(bytes.length)).toEqual(rich);
    await expect(f.staging.stage(bytes.length, "eA==")).rejects.toMatchObject({ code: "conflict" });
    await expect(f.staging.finish(bytes.length)).rejects.toMatchObject({ code: "conflict" });
  } finally { await f.authority.revoke(); }
});

test("zero, malformed, oversized and noncontiguous chunks never advance accepted bytes", async () => {
  const f = fixture();
  try {
    for (const [offset, base64] of [[0, ""], [0, "!!!!"], [-1, "eA=="], [0.5, "eA=="], [1, "eA=="], [0, Buffer.alloc(CHUNK + 1).toString("base64")]] as const)
      await expect(f.staging.stage(offset, base64)).rejects.toBeInstanceOf(Error);
    await stage(f.staging, Buffer.from("{}"));
    await expect(f.staging.stage(0, "eA==")).rejects.toMatchObject({ code: "invalid_input" });
    expect(await f.staging.finish(2)).toEqual({});
  } finally { await f.authority.revoke(); }
});

test("one authority staging window rejects overlap without renewing the call", async () => {
  const f = fixture();
  try {
    const pending = f.staging.stage(0, "e30=");
    await expect(f.staging.stage(0, "e30=")).rejects.toMatchObject({ code: "conflict" });
    await pending;
    expect(await f.staging.finish(2)).toEqual({});
  } finally { await f.authority.revoke(); }
});

test("private0700/wx0600 staging is removed and fd closed when authority is revoked", async () => {
  const f = fixture(); await stage(f.staging, Buffer.from("{}"));
  const directory = (f.staging as any).directory as string, file = (f.staging as any).file;
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(directory, "result.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(directory, "result.json"), "utf8")).toBe("{}");
  await f.authority.revoke();
  expect(existsSync(directory)).toBe(false);
  await expect(file.stat()).rejects.toBeInstanceOf(Error);
  await expect(f.staging.finish(2)).rejects.toMatchObject({ code: "capability_denied" });
});

test("revoke waits pending work and cancelled result cannot be accepted", async () => {
  const f = fixture(); await stage(f.staging, Buffer.from("["));
  const directory = (f.staging as any).directory as string;
  const pending = f.staging.stage(1, Buffer.alloc(CHUNK, 32).toString("base64"));
  const observed = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await f.authority.revoke();
  expect((await observed).error).toMatchObject({ code: "capability_denied" });
  expect(existsSync(directory)).toBe(false);
});

test("length mismatch and malformed JSON are terminal without ordinary partial results", async () => {
  const a = fixture(), b = fixture();
  try {
    await stage(a.staging, Buffer.from("{}"));
    await expect(a.staging.finish(3)).rejects.toMatchObject({ code: "invalid_input" });
    await stage(b.staging, Buffer.from("{bad"));
    await expect(b.staging.finish(4)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(b.staging.stage(4, "fQ==")).rejects.toMatchObject({ code: "conflict" });
  } finally { await a.authority.revoke(); await b.authority.revoke(); }
});

test("directory substitution fails closed and cleanup never deletes foreign replacement", async () => {
  const f = fixture(); await stage(f.staging, Buffer.from("{}"));
  const directory = (f.staging as any).directory as string, displaced = directory + ".fixture-moved";
  renameSync(directory, displaced); mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, "foreign-marker"), "public-negative-control");
  try {
    await expect(f.staging.finish(2)).rejects.toMatchObject({ code: "conflict" });
    await expect(f.authority.revoke()).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(join(directory, "foreign-marker"), "utf8")).toBe("public-negative-control");
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(displaced, { recursive: true, force: true }); }
});

async function ioFault(mode: "reserve" | "short" | "failure") {
  const ctx = fakeCtx();
  const script = `
import {mock} from "bun:test";
import * as fs from "node:fs/promises";
import {existsSync} from "node:fs";
const actual={...fs};let writes=0;
mock.module("node:fs/promises",()=>({...actual,
 statfs:async()=>({bsize:4096,bavail:${mode === "reserve" ? 0 : 1000000}}),
 open:async(...args)=>{
  const file=await actual.open(...args);
  return new Proxy(file,{get(target,key){
   if(key==="write")return async(buffer,offset,length,position)=>{
    writes++;
    if(${JSON.stringify(mode)}==="failure"&&writes>1)throw Object.assign(Error("synthetic write failure"),{code:"ENOSPC"});
    return target.write(buffer,offset,Math.min(length,2),position);
   };
   const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
 }
}));
const {createCallAuthority}=await import(${JSON.stringify(new URL("../src/plugins/authority.ts", import.meta.url).href)});
const {ResultStaging}=await import(${JSON.stringify(new URL("../src/plugins/result-staging.ts", import.meta.url).href)});
const ctx={home:process.env.HOME,pacerHome:process.env.HOME,now:100,env:{},which:()=>null,run:async()=>({code:127,stdout:"",stderr:""})};
const authority=createCallAuthority(ctx,{reads:[],commands:[],stores:[]},{deadlineMs:Date.now()+10000});
const staging=new ResultStaging(authority);let ack=false,errorCode=null,result=null,finishRejected=false;
const text=${JSON.stringify(mode === "failure" ? "{} trailing-data" : '{"a":1234}')};
try{await staging.stage(0,Buffer.from(text).toString("base64"));ack=true;}catch(error){errorCode=error.code;}
const directory=staging.directory,size=(await actual.stat(directory+"/result.json")).size;
if(${JSON.stringify(mode)}==="short")result=await staging.finish(Buffer.byteLength(text));
if(${JSON.stringify(mode)}==="failure")try{await staging.finish(2);}catch{finishRejected=true;}
await authority.revoke();
console.log(JSON.stringify({ack,errorCode,size,writes,result,finishRejected,removed:!existsSync(directory)}));
`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir, env: { HOME: ctx.home, PACER_HOME: ctx.pacerHome, TMPDIR: ctx.home }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(`isolated fixture failed: ${stderr}`);
  return JSON.parse(stdout);
}

test("less than8MiB reserve refuses append with no ACK or file bytes and still cleans up", async () => {
  expect(await ioFault("reserve")).toMatchObject({ ack: false, errorCode: "plugin_unavailable", size: 0, writes: 0, removed: true });
});

test("short writes loop to complete JSON, while failed append cannot ACK or finish a valid prefix", async () => {
  const short = await ioFault("short");
  expect(short).toMatchObject({ ack: true, result: { a: 1234 }, removed: true });
  expect(short.writes).toBeGreaterThan(1);
  expect(await ioFault("failure")).toMatchObject({ ack: false, errorCode: "plugin_unavailable", size: 2, finishRejected: true, removed: true });
});
