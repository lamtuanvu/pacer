import { expect, test } from "bun:test";
import { consumeNativePairedBootstrap, configuredPairedNativeBootstrap } from "../src/update/desktop/native-paired-bootstrap";
import { fakeCtx } from "./helpers";

const key = "PACER_INTERNAL_NATIVE_BOOTSTRAP";
const valid = JSON.stringify({ schema: 1, argv: ["/private/example.app/Contents/Resources/pacer", "serve"], frontVersion: "0.7.2" });

test("private bootstrap is consumed from process and captured environment before validation", () => {
  const before = process.env[key];
  try {
    process.env[key] = valid;
    const env = { [key]: valid };
    expect(consumeNativePairedBootstrap(env)).toEqual(JSON.parse(valid));
    expect(env[key]).toBeUndefined();
    expect(process.env[key]).toBeUndefined();
    for (const value of ["not JSON", JSON.stringify({ schema: 1, argv: [], frontVersion: "0.7.2" }),
      JSON.stringify({ ...JSON.parse(valid), fd: 3 }), JSON.stringify({ ...JSON.parse(valid), frontVersion: "bad" }),
      JSON.stringify({ ...JSON.parse(valid), argv: ["a\u0000", "serve"] }), "x".repeat(65537)]) {
      process.env[key] = value;
      const bad = { [key]: value };
      expect(() => consumeNativePairedBootstrap(bad)).toThrow();
      expect(bad[key]).toBeUndefined();
      expect(process.env[key]).toBeUndefined();
    }
  } finally { if (before === undefined) delete process.env[key]; else process.env[key] = before; }
});

test("conflicting copies are removed and refused; absent bootstrap has no native authority", () => {
  const before = process.env[key];
  try {
    process.env[key] = valid;
    const env = { [key]: valid + " " };
    expect(() => consumeNativePairedBootstrap(env)).toThrow();
    expect(env[key]).toBeUndefined();
    expect(process.env[key]).toBeUndefined();
    expect(consumeNativePairedBootstrap({})).toBeNull();
    expect(configuredPairedNativeBootstrap(fakeCtx(), 4318, null)).toBeNull();
  } finally { if (before === undefined) delete process.env[key]; else process.env[key] = before; }
});

test("private JSON alone cannot enable native authority in an ordinary source build", () => {
  const parsed = JSON.parse(valid);
  expect(() => configuredPairedNativeBootstrap(fakeCtx(), 4318, parsed)).toThrow();
});

// Isolated boundary doubles exercise the ordering contract, never enable production
// unsigned trust. Real positive signed authority still requires the certificate fixture.
test("signed bootstrap boundary refuses forged ownership before receiving any descriptor", () => {
  const script = String.raw`
import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const root = fs.mkdtempSync(join(process.env.TMPDIR || "/tmp", "pacer-paired-factory-"));
const app = join(fs.realpathSync(root), "current.app"), resources = join(app,"Contents/Resources");
fs.mkdirSync(resources,{recursive:true,mode:0o700});
const corePath=join(resources,"pacer-core"), frontPath=join(resources,"pacer");
for(const path of [corePath,frontPath]) fs.writeFileSync(path,"fixture",{mode:0o700});
const rawRealpath=fs.realpathSync;
const realExec=process.execPath, own={pid:process.pid,bootId:"boot",birth:"core"}, parent={pid:process.ppid,bootId:"boot",birth:"front"};
let phase="", received=0, sent=0, checks=0, lastFd=-1, helperFd=-1;
Object.defineProperty(process,"platform",{value:"darwin"});
mock.module("node:fs",()=>({...fs,realpathSync:(p)=>p===realExec?corePath:rawRealpath(p),writeSync:(fd,b)=>{if(fd!==0||Buffer.from(b).toString()!=="S")throw Error("bad shutdown");sent++;return 1;}}));
mock.module("./src/update/desktop/process-identity.ts",()=>({ownProcessIdentity:()=>own,processIdentity:()=>parent,sameProcess:(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.bootId===b.bootId&&a.birth===b.birth}));
mock.module("./src/update/desktop/native-fixture.ts",()=>({compiledNativeFixture:()=>null,verifyNativeFixture(){}}));
mock.module("./src/update/desktop/native-os.ts",()=>({compiledSignerPins:()=>phase==="unconfigured"?null:{signingCertSha1:"A".repeat(40)},DarwinAuthority:{configured:()=>({
verifyPeer(token,role,expected){checks++;if(phase==="parent-signature")throw Error("signature");if(token.length!==32||role!=="cli"||expected.pid!==parent.pid||new DataView(token.buffer,token.byteOffset,token.byteLength).getUint32(20,true)!==parent.pid)throw Error("peer contract");return{process:{...parent,birth:phase==="parent-incarnation"?"wrong":parent.birth},uid:process.getuid(),executable:phase==="sibling"?join(resources,"other"):frontPath,auditToken:token,role:"cli"};},
verifyProcess(expected,role){checks++;if(phase==="core-signature"||phase==="post-receive"&&received>0)throw Error("signature");return{process:own,parentPid:phase==="parent-pid"?parent.pid+1:parent.pid,uid:process.getuid(),executable:corePath,name:"pacer-core"};},
verifyStatic(path,role){checks++;if(phase==="app-seal"&&role==="desktop")throw Error("seal");}
})}}));
mock.module("./src/update/desktop/native-socket.ts",()=>({receiveParentListener(){received++;lastFd=fs.openSync(corePath,"r");return lastFd;},receiveParentHelperChannel(){helperFd=fs.openSync(corePath,"r");return helperFd;},requestParentHelper(){throw Error("not exercised");}}));
const {configuredPairedNativeBootstrap}=await import("./src/update/desktop/native-paired-bootstrap.ts");
const {currentVersion}=await import("./src/update/version.ts");
const version=currentVersion(), arch=process.arch==="arm64"?"aarch64":"x86_64";
const metadata={schema:1,bundleId:"dev.pacer.desktop",version,arch,protocolMajors:[3],admissionProtocol:1,rollbackCompatible:true,nativeTransportAbi:1,cliLayout:"paired"};
const metadataPath=join(resources,"pacer-release.json");fs.writeFileSync(metadataPath,JSON.stringify(metadata),{mode:0o600});
const ctx={pacerHome:root}, input={schema:1,argv:[frontPath,"serve","--port","12345"],frontVersion:version};
try {
 for(phase of ["unconfigured","parent-signature","core-signature","parent-incarnation","parent-pid","sibling","app-seal","version","argv","metadata","symlink"]){
  received=0;
  const value=structuredClone(input);
  if(phase==="version")value.frontVersion="99.0.0";
  if(phase==="argv")value.argv.push("--extra");
  if(phase==="metadata")fs.writeFileSync(metadataPath,JSON.stringify({...metadata,cliLayout:undefined}));
  if(phase==="symlink"){fs.renameSync(metadataPath,metadataPath+".real");fs.symlinkSync(metadataPath+".real",metadataPath);}
  let refused=false;try{configuredPairedNativeBootstrap(ctx,12345,value);}catch{refused=true;}
  if(!refused||received!==0)throw Error("accepted or received before proof: "+phase);
  if(phase==="symlink"){fs.unlinkSync(metadataPath);fs.renameSync(metadataPath+".real",metadataPath);}
  fs.writeFileSync(metadataPath,JSON.stringify(metadata));
 }
 phase="post-receive";received=0;
 let refused=false;try{configuredPairedNativeBootstrap(ctx,12345,input);}catch{refused=true;}
 if(!refused||received!==1)throw Error("post-receive recheck");
 let closed=false;try{fs.fstatSync(lastFd);}catch{closed=true;}
 if(!closed)throw Error("descriptor leak");
 closed=false;try{fs.fstatSync(helperFd);}catch{closed=true;}
 if(!closed)throw Error("helper channel leak");
 phase="";received=0;
 const result=configuredPairedNativeBootstrap(ctx,12345,input);
 if(received!==1||result.owner.process.pid!==parent.pid||result.owner.transport.pid!==own.pid||result.listener.owner.pid!==parent.pid)throw Error("owner result");
 result.shutdown();result.shutdown();
 if(sent!==1)throw Error("shutdown count");
 closed=false;try{fs.fstatSync(helperFd);}catch{closed=true;}
 if(!closed)throw Error("shutdown did not retire helper channel");
 fs.closeSync(result.listener.fd);
 process.stdout.write("boundary PASS "+checks);
} finally {fs.rmSync(root,{recursive:true,force:true});}
`;
  const wrapper = "import socket,subprocess,sys; a,b=socket.socketpair(); r=subprocess.run([sys.argv[1],'-e',sys.argv[2]],stdin=b,timeout=10); sys.exit(r.returncode)";
  const result = Bun.spawnSync(["python3", "-c", wrapper, process.execPath, script], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("boundary PASS");
}, 30000);
