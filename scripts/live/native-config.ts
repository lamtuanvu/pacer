/** Fixed P2-C fixture. No caller-selected operation, payload, path or environment. */
import {existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {isDeepStrictEqual} from "node:util";
import golden from "../../test/fixtures/config-writes-goldens.json";
import {freePort, healthy, pacerArgv, record, sandboxEnv, type Session} from "./core";
import {createFixtureHome, settingsFixtureRoot} from "./settings";

export const configSteps = [
  {op:"notifications.get",params:{}},
  {op:"notifications.set",params:{level:"all"}},
  {op:"strategy.save",params:{name:"review",draft:{from:"default",description:"Live config fixture"},reason:"Fixed live fixture"}},
  {op:"strategy.use",params:{name:"review"}},
  {op:"routing.set",params:{rules:[{kinds:["docs"],executors:["cursor"]},{executors:["codex","cursor"]}]}},
  {op:"runner.set",params:{id:"codex",enabled:true,model:null,max_tasks:2,rank:1}},
  {op:"runner.reorder",params:{ids:["cursor","codex"]}},
  {op:"runner.remove",params:{id:"cursor"}},
  {op:"strategy.use",params:{name:"default"}},
  {op:"strategy.remove",params:{name:"review"}},
  {op:"runner.set",params:{id:"codex",rank:1.5},error:"invalid_input"},
  {op:"strategy.remove",params:{name:"default"},error:"not_allowed"},
] as const;

function normalized(value: unknown, home: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(home,"$HOME").replace(/on \d{4}-\d\d-\d\dT[^ ]+: Fixed live fixture/g,"on $DATE: Fixed live fixture"));
}
function files(home: string) {
  return Object.fromEntries(["strategy.yaml","active","strategies/review.yaml","settings.json","opencode/opencode.json"].map(file=>{
    const path=join(home,file);
    if (!existsSync(path)) return [file,null];
    if ((statSync(path).mode & 0o077) !== 0) throw Error(`Nonprivate fixture state: ${file}`);
    return [file,readFileSync(path,"utf8")];
  }));
}
function fixtureEnv(session: Session, home: string, forwarded: boolean) {
  return {...sandboxEnv(session),HOME:home,PACER_HOME:home,PACER_BIN:pacerArgv(session)[0],
    PACER_ORCA_USER_DATA:join(home,"orca-user-data"),CODEX_HOME:join(home,".codex"),CLAUDE_CONFIG_DIR:join(home,".claude"),
    XDG_CONFIG_HOME:join(home,".config"),XDG_DATA_HOME:join(home,".local/share"),PACER_DEBUG_NATIVE:"1",PACER_NO_SELF_REPAIR:"1",
    PACER_FORWARD_OPS:forwarded?"*":""};
}
function prepare(home: string) {
  createFixtureHome(home);
  writeFileSync(join(home,"strategy.yaml"),golden.initial,{mode:0o600,flag:"wx"});
}
async function stdio(session: Session, home: string, forwarded: boolean) {
  const child=Bun.spawn([...pacerArgv(session),"api","--stdio"],{cwd:join(session.root,"repo"),env:fixtureEnv(session,home,forwarded),stdin:"pipe",stdout:"pipe",stderr:"pipe",timeout:120000});
  const errors=new Response(child.stderr).text();
  const reader=child.stdout.getReader(); let buffer="";
  const decoder=new TextDecoder();
  const request=async (id: number, method: string, params: unknown) => {
    await child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");
    await child.stdin.flush();
    while (true) {
      const at=buffer.indexOf("\n");
      if (at>=0) {
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        const reply=JSON.parse(line);
        if (reply.id!==id) throw Error("Unexpected fixture reply");
        if (reply.error) return {error:{code:reply.error.data.code,message:reply.error.message,...(reply.error.data.hint?{hint:reply.error.data.hint}:{})}};
        return {result:reply.result};
      }
      const next=await reader.read();
      if (next.done) throw Error("Fixture stdio ended before reply");
      buffer+=decoder.decode(next.value,{stream:true});
    }
  };
  try {
    const hello=await request(1,"hello",{protocol:3});
    if (hello.result?.protocol!=="3.0.0") throw Error("Fixture protocol negotiation failed");
    let endpointReady=false;
    for(let attempt=0;attempt<3;attempt++) {
      const warm=await request(-1,"plugin.doctor",{id:"pacer-endpoints"});
      if(warm.result?.reports?.[0]?.ok){endpointReady=true;break;}
    }
    if(!endpointReady) throw Error("Fixture endpoint plugin did not become ready");
    const states=[];
    for (const [i,step] of configSteps.entries()) {
      // A delayed save must use request time, rather than connection-start time.
      if (step.op === "strategy.save") await Bun.sleep(1100);
      const started=Date.now();
      const reply=await request(i+2,step.op,step.params);
      checkReply(step,reply);
      const state=files(home);
      if (step.op === "strategy.save") {
        const saved=String(state["strategies/review.yaml"]).match(/ on ([^ ]+): Fixed live fixture/);
        if (!saved || Date.parse(saved[1]) < started-10 || Date.parse(saved[1]) > Date.now()) throw Error("Stdio save used stale request time");
      }
      states.push({reply,files:state});
    }
    await child.stdin.end();
    if (await child.exited!==0) throw Error("Fixture stdio failed");
    const stderr=await errors;
    checkTrace(stderr,forwarded);
    return {states:normalized(states,home),trace:stderr};
  } finally {
    await Promise.resolve(child.stdin.end()).catch(()=>{});
    if (child.exitCode===null) child.kill();
    await child.exited;
  }
}
function checkReply(step: typeof configSteps[number], reply: {error?:{code:string};result?:unknown}) {
  if ("error" in step ? reply.error?.code!==step.error : reply.error || reply.result===undefined) throw Error(`Fixed ${step.op} returned an unexpected result: ${JSON.stringify(reply)}`);
}
function checkTrace(trace: string, forwarded: boolean) {
  for (const op of new Set(configSteps.map(s=>s.op))) {
    const count=trace.split("\n").filter(line=>line.startsWith(`native ${op}`)).length;
    const expected=forwarded?0:configSteps.filter(s=>s.op===op).length;
    if (count!==expected) throw Error(`Native dispatch evidence differs for ${op}`);
  }
}
async function http(session: Session, home: string, forwarded: boolean, log: string) {
  const port=await freePort();
  const fd=openSync(log,"wx",0o600);
  const child=Bun.spawn([...pacerArgv(session),"serve","--port",String(port)],{cwd:join(session.root,"repo"),env:{...fixtureEnv(session,home,forwarded),PACER_PORT:String(port)},stdin:"ignore",stdout:fd,stderr:fd});
  closeSync(fd);
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if (child.exitCode!==null) throw Error("Fixture HTTP service exited");
      try {
        const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)});
        if (response.ok && (await response.json()).pid===child.pid) {ready=true;break;}
      } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw Error("Fixture HTTP service did not become healthy");
    const token=readFileSync(join(home,"token"),"utf8").trim();
    let coreReady=false;
    for(let i=0;i<100;i++) {
      try {
        const response=await fetch(`http://127.0.0.1:${port}/v3/ops/version.get`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(500)});
        if(response.ok){coreReady=true;break;}
      } catch {}
      await Bun.sleep(100);
    }
    if(!coreReady) throw Error("Fixture private core did not become ready");
    let endpointReady=false;
    for(let attempt=0;attempt<3;attempt++) {
      const response=await fetch(`http://127.0.0.1:${port}/v3/ops/plugin.doctor`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({id:"pacer-endpoints"}),signal:AbortSignal.timeout(30000)});
      const warm=await response.json();
      if(warm.result?.reports?.[0]?.ok){endpointReady=true;break;}
    }
    if(!endpointReady) throw Error("Fixture endpoint plugin did not become ready");
    const states=[];
    for (const step of configSteps) {
      const response=await fetch(`http://127.0.0.1:${port}/v3/ops/${step.op}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(step.params),signal:AbortSignal.timeout(30000)});
      const reply=await response.json();checkReply(step,reply);
      states.push({reply,files:files(home)});
    }
    const stream=await fetch(`http://127.0.0.1:${port}/v3/events?since=0`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
    const reader=stream.body?.getReader();
    if (!stream.ok || !reader) throw Error("Fixture SSE subscription failed");
    let frames="";
    try {
      while ((frames.match(/event: config\n/g)??[]).length<9) {
        const next=await reader.read();if(next.done) throw Error("Fixture SSE ended before config events");
        frames+=new TextDecoder().decode(next.value);
      }
    } finally {await reader.cancel();}
    if (!frames.includes("strategy-switch")) throw Error("Strategy alert missing from public SSE replay");
    const privateRoute=await fetch(`http://127.0.0.1:${port}/_internal/config-sync`,{method:"POST",headers:{authorization:`Bearer ${token}`}});
    if (privateRoute.status!==404) throw Error("Private sync route exposed publicly");
    return normalized(states,home);
  } finally {
    if (child.exitCode===null) child.kill();
    await child.exited;
  }
}

export async function exerciseNativeConfig(session: Session): Promise<void> {
  if (session.frontDoor!=="rust" || !session.nativeTestOps || session.nativeForwardEcho || session.realKeychain || !await healthy(session)) throw Error("Native config fixture requires a healthy UI-seeded Rust test-ops sandbox with private Keychain stub");
  // Reuse canonical ownership and evidence checks; this fixture has its own exclusive root.
  const root=join(settingsFixtureRoot(session),"..");
  const fixture=join(root,"native-config-fixture");createFixtureHome(fixture);
  const comparisons: Record<string,unknown>={};
  const previousUmask=process.umask(0o077);
  try {
    for (const transport of ["stdio","http"] as const) {
      const results=[];
      for (const forwarded of [false,true]) {
        const name=`${transport}-${forwarded?"forwarded":"native"}`,home=join(fixture,name);prepare(home);
        const log=join(fixture,`${name}.log`);
        if (transport==="stdio") {
          const result=await stdio(session,home,forwarded);
          writeFileSync(log,result.trace,{mode:0o600,flag:"wx"});
          results.push(result.states);
        } else {
          results.push(await http(session,home,forwarded,log));
          checkTrace(readFileSync(log,"utf8"),forwarded);
        }
      }
      if (!isDeepStrictEqual(results[0],results[1])) {
        writeFileSync(join(fixture,`${transport}-difference.json`),JSON.stringify(results,null,2),{mode:0o600,flag:"wx"});
        throw Error(`${transport} native/forwarded config parity differs`);
      }
      comparisons[transport]=results[0];
      for (const op of new Set(configSteps.map(s=>s.op))) record(session,{kind:"note",behavior:`P2-C ${op}`,surface:`${transport} API`,verdict:"PASS",text:"Fixed native and PACER_FORWARD_OPS=* results and file states match; native trace verified. Endpoint plugin synchronization exercised for document edits."});
    }
    writeFileSync(join(fixture,"results.json"),JSON.stringify(comparisons,null,2),{mode:0o600,flag:"wx"});
    record(session,{kind:"note",behavior:"P2-C client rendering",surface:"desktop/tray/TUI/web",verdict:"UNVERIFIED",text:"API persistence and dispatch exercised. Native desktop, browser rendering and interactive TUI were not driven by this fixed fixture."});
  } catch(error) {
    record(session,{kind:"note",behavior:"P2-C native config fixture",surface:"API",verdict:"FAIL",text:(error as Error).message});throw error;
  } finally { process.umask(previousUmask); }
}
