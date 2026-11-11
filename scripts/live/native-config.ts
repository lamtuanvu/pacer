/** Fixed P2-C fixture. No caller-selected operation, payload, path or environment. */
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {isDeepStrictEqual} from "node:util";
import golden from "../../test/fixtures/config-writes-goldens.json";
import {atomicWrite, freePort, healthy, pacerArgv, record, run, sandboxEnv, type Session} from "./core";
import {createFixtureHome, settingsFixtureRoot} from "./settings";

const blockRouting = golden.initial.replace(
  "  - kinds: [docs]\n    executors: [codex, cursor] # keep list\n  - default: [codex, cursor]",
  "  - kinds: \n      - docs\n    executors: \n      - codex\n  - kinds: [tests]\n    executors: [cursor] # c\n  - default: \n      - codex");
const connection = (id: string) => `        - {id: "${id}", context: 64000, output: 32000, tools: true}\n`;
const models = golden.initial
  .replace("  cursor: {kind: cursor}\n", "  cursor: {kind: cursor}\n  acme:\n    kind: endpoint\n    usage: unmetered\n    connection:\n      api: openai-compatible\n      base_url: https://api.example.com\n      key: none\n      models:\n"
    + ["a", "x😁", "xa"].map(connection).join("") + "  oc: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}\n")
  .replace("  cursor: {}\n", "  cursor: {}\n  opencode#acme: {model: pacer-acme/a}\n  opencode#oc: {model: acme/a}\n");
const listing = (age: number) => ({runner: "opencode#oc", models: [{id: "acme/a"}, {id: "acme/b"}, {id: "acme/zy"}], age});

export const configSteps = [
  {op:"notifications.get",params:{}},
  {op:"notifications.set",params:{level:"all"}},
  {op:"strategy.save",params:{name:"review",draft:{from:"default",description:"Live config fixture",set:{"pacing.planner_reserve":0.000001}},reason:"Fixed live fixture"}},
  {op:"strategy.use",params:{name:"review"}},
  {op:"routing.set",params:{rules:[{kinds:["docs"],executors:["cursor"]},{executors:["codex","cursor"]}]}},
  {op:"runner.set",params:{id:"codex",enabled:true,model:null,max_tasks:2,rank:1}},
  {op:"runner.reorder",params:{ids:["cursor","codex"]}},
  {op:"runner.remove",params:{id:"cursor"}},
  {op:"strategy.use",params:{name:"default"}},
  {op:"strategy.remove",params:{name:"review"}},
  {op:"runner.set",params:{id:"codex",rank:1.5},error:"invalid_input"},
  {op:"strategy.remove",params:{name:"default"},error:"not_allowed"},
  {op:"runner.remove",params:{id:"cursor"},fixture:blockRouting.replaceAll("\n","\r\n")},
  {op:"routing.set",params:{rules:[{kinds:["docs"],executors:["cursor"]},{executors:["codex"]}]},error:"invalid_input",fixture:blockRouting},
  {op:"routing.set",params:{rules:[{executors:["codex"]}]},error:"invalid_input",fixture:blockRouting.replaceAll("\n","\r\n")},
  {op:"runner.set",params:{id:"codex",enabled:false},fixture:golden.initial.replace("pacing:\n", "pacing:\n  ahead_threshold: .inf\n")},
  {op:"runner.reorder",params:{ids:["cursor","codex"]},fixture:golden.initial.replace("pacing:\n", "pacing:\n  behind_threshold: -.inf\n")},
  {op:"routing.set",params:{rules:[{kinds:["docs"],executors:["cursor","codex"]},{executors:["codex","cursor"]}]},fixture:golden.initial.replace("pacing:\n", "pacing:\n  planner_reserve: .nan\n")},
  {op:"runner.set",params:{id:"codex",enabled:false},error:"internal",fixture:golden.initial.replace("pacing:\n", "pacing:\n  planner_reserve: 1e400\n")},
  {op:"runner.set",params:{id:"codex",enabled:false},error:"internal",fixture:golden.initial.replace("pacing:\n", 'pacing:\n  planner_reserve: "\\0pacer-yaml-nan"\n')},
  {op:"strategy.save",params:{name:"review",draft:{from:"default",description:"Live config fixture"},reason:"Fixed live fixture"},fixture:golden.initial.replace("pacing:\n", "pacing:\n  planner_reserve: .nan\n  ahead_threshold: 1e400\n")},
  {op:"strategy.use",params:{name:"review"}},
  {op:"strategy.use",params:{name:"default"}},
  {op:"strategy.remove",params:{name:"review"}},
  {op:"runner.set",params:{id:"codex",enabled:false},error:"invalid_input",fixture:golden.initial.replace("  claude: {kind: claude}", '  claude: {"😀": 1, kind: claude, kind: claude}')},
  {op:"runner.set",params:{id:"codex",enabled:false},error:"invalid_input",fixture:golden.initial.replace("  claude: {kind: claude}", `  claude: {padding: "${"x".repeat(100)}", kind: claude, kind: claude}`)},
  {op:"runner.set",params:{id:"codex",enabled:false},error:"invalid_input",fixture:golden.initial.replace("  codex: {kind: codex}", "  codex: {kind: codex}\n  &k codex: {kind: codex}")},
  {op:"runner.set",params:{id:"codex",enabled:true},fixture:golden.initial},
  // Model checks: connection models and a fresh OpenCode listing are native; a stale listing forwards to `opencode models`.
  {op:"runner.set",params:{id:"opencode#acme",model:"pacer-acme/xa"},fixture:models},
  {op:"runner.set",params:{id:"opencode#acme",model:"pacer-acme/x😀"},error:"invalid_input",hint:"Available: pacer-acme/x😁, pacer-acme/xa, pacer-acme/a"},
  {op:"runner.set",params:{id:"opencode#oc",model:"acme/b",max_tasks:2},cache:listing(0)},
  {op:"runner.set",params:{id:"opencode#oc",model:"acme/zz"},error:"invalid_input",hint:"Available: acme/zy, acme/a, acme/b"},
  {op:"runner.set",params:{id:"opencode#oc",model:"acme/c"},cache:listing(601),forwards:true},
] as const;

function normalized(value: unknown, home: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(home,"$HOME").replace(/on \d{4}-\d\d-\d\dT[^ ]+: Fixed live fixture/g,"on $DATE: Fixed live fixture"));
}
function files(home: string) {
  return Object.fromEntries(["strategy.yaml","active","strategies/review.yaml","settings.json","opencode/opencode.json","opencode-calls.log"].map(file=>{
    const path=join(home,file);
    if (!existsSync(path)) return [file,null];
    if ((statSync(path).mode & 0o077) !== 0) throw Error(`Nonprivate fixture state: ${file}`);
    const text=readFileSync(path,"utf8");
    if(file==="strategies/review.yaml" && !text.includes("# created by alice on ")) throw Error("Save author environment was ignored");
    return [file,text];
  }));
}
function fixtureEnv(session: Session, home: string, forwarded: boolean) {
  const env=sandboxEnv(session);
  return {...env,PATH:`${join(home,"bin")}:${env.PATH ?? ""}`,HOME:home,PACER_HOME:home,PACER_BIN:pacerArgv(session)[0],
    PACER_ORCA_USER_DATA:join(home,"orca-user-data"),CODEX_HOME:join(home,".codex"),CLAUDE_CONFIG_DIR:join(home,".claude"),
    XDG_CONFIG_HOME:join(home,".config"),XDG_DATA_HOME:join(home,".local/share"),PACER_DEBUG_NATIVE:"1",PACER_NO_SELF_REPAIR:"1",
    PACER_AGENT:"alice",PACER_FORWARD_OPS:forwarded?"*":""};
}
function prepare(home: string) {
  createFixtureHome(home);
  writeFileSync(join(home,"strategy.yaml"),golden.initial,{mode:0o600,flag:"wx"});
  const legacy=join(home,"orca-user-data/plugins-data/lamtuanvu.pacer");
  mkdirSync(legacy,{recursive:true,mode:0o700});
  writeFileSync(join(legacy,"settings.json"),'{"notifications":"off"}',{mode:0o600,flag:"wx"});
  // Exercise Node-compatible replacement decoding during get migration and set.
  writeFileSync(join(home,"settings.json"), Buffer.concat([Buffer.from('{"keep":"'), Buffer.from([0xff]), Buffer.from('","notifications":"invalid"}')]), {mode:0o600,flag:"wx"});
  // Stand-in OpenCode for forwarded model listings: never the real CLI or its configuration.
  mkdirSync(join(home,"bin"),{mode:0o700});
  writeFileSync(join(home,"bin","opencode"),`#!/bin/sh\necho "$*" >> "$HOME/opencode-calls.log"\nprintf 'acme/a\\nacme/b\\nacme/c\\n'\n`,{mode:0o700,flag:"wx"});
}
function resetFixture(home: string, step: typeof configSteps[number]) {
  if ("cache" in step) {
    const dir=join(home,"cache","available-models");mkdirSync(dir,{recursive:true,mode:0o700});
    const {runner,models,age}=step.cache;
    atomicWrite(join(dir,`${createHash("sha256").update(runner).digest("hex")}.json`),JSON.stringify({runner,source:"opencode",models,fetchedAt:Date.now()/1000-age}));
  }
  if (!("fixture" in step)) return;
  const active=join(home,"active");
  const name=existsSync(active)?readFileSync(active,"utf8").trim():"default";
  atomicWrite(name==="default"?join(home,"strategy.yaml"):join(home,"strategies",`${name}.yaml`),step.fixture);
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
      resetFixture(home,step);
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
function checkReply(step: typeof configSteps[number], reply: {error?:{code:string;hint?:string};result?:unknown}) {
  if (step.op==="notifications.get" && (reply.result as {level?:string})?.level!=="off") throw Error("Legacy notification environment was ignored");
  if ("error" in step ? reply.error?.code!==step.error : reply.error || reply.result===undefined) throw Error(`Fixed ${step.op} returned an unexpected result: ${JSON.stringify(reply)}`);
  if ("hint" in step && reply.error?.hint!==step.hint) throw Error(`Fixed ${step.op} returned an unexpected hint: ${JSON.stringify(reply)}`);
}
function checkTrace(trace: string, forwarded: boolean) {
  for (const op of new Set(configSteps.map(s=>s.op))) {
    const count=trace.split("\n").filter(line=>line.startsWith(`native ${op}`)).length;
    const expected=forwarded?0:configSteps.filter(s=>s.op===op && !("forwards" in s)).length;
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
      resetFixture(home,step);
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
    for (const path of ["/_internal/config-sync", "/_internal/native-config-finish"]) {
      const privateRoute=await fetch(`http://127.0.0.1:${port}${path}`,{method:"POST",headers:{authorization:`Bearer ${token}`}});
      if (privateRoute.status!==404) throw Error("Private native hook exposed publicly");
    }
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
      record(session,{kind:"note",behavior:"runner.set model check",surface:`${transport} API`,verdict:"PASS",text:"Connection-account models (accepted, and refused with UTF-16 closest-model hints) and a fresh OpenCode listing cache are checked natively; a stale listing forwards to TypeScript, which lists through the stand-in opencode. Replies, hints, strategy bytes and opencode calls match PACER_FORWARD_OPS=*."});
      for (const op of new Set(configSteps.map(s=>s.op))) record(session,{kind:"note",behavior:`P2-C ${op}`,surface:`${transport} API`,verdict:"PASS",text:"Fixed native and PACER_FORWARD_OPS=* results and file states match; native trace verified. Legacy migration and alice author environment, CRLF/trailing-space rule removal, exact rejected-edit diagnostics, IEEE-754 infinity/NaN/overflow, literal marker rejection and endpoint synchronization exercised."});
    }
    writeFileSync(join(fixture,"results.json"),JSON.stringify(comparisons,null,2),{mode:0o600,flag:"wx"});
    await guardedCli(session, fixture);
    for (const op of new Set(configSteps.map(s=>s.op))) record(session,{kind:"note",behavior:`P2-C ${op}`,surface:"desktop",verdict:"UNVERIFIED",text:"Unsigned sandbox desktop exits before opening a window; covered by the desktop-only exception recorded 2026-11-02. API parity passes; non-desktop clients require their own evidence."});
  } catch(error) {
    record(session,{kind:"note",behavior:"P2-C native config fixture",surface:"API",verdict:"FAIL",text:(error as Error).message});throw error;
  } finally { process.umask(previousUmask); }
}

/** The ordinary D3 wrapper and D8 public proxy remain in the CLI path. */
async function guardedCli(session: Session, fixture: string): Promise<void> {
  const home = join(session.root, "home"), name = "native-cli", saved = "native-cli-saved";
  mkdirSync(join(home, "strategies"), {mode: 0o700, recursive: true});
  const path = join(home, "strategies", `${name}.yaml`);
  writeFileSync(path, golden.initial, {mode: 0o600, flag: "wx"});
  const call = async (op: string, params: unknown) => {
    const result = await run([sandboxEnv(session).PACER_BIN!, "api", "call", op, "--params", JSON.stringify(params), "--json"], session);
    if (result.code) throw Error(`Guarded CLI ${op} failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  await call("strategy.use", {name});
  const states = [];
  for (const step of configSteps) {
    if ("error" in step || "forwards" in step) continue;
    resetFixture(home,step);
    if (step.op === "strategy.save" && "fixture" in step) atomicWrite(path, step.fixture);
    const params = JSON.parse(JSON.stringify(step.params).replaceAll('"review"', JSON.stringify(saved)).replace('"from":"default"', `"from":"${name}"`));
    const reply = await call(step.op, params);
    const savedPath = join(home, "strategies", `${saved}.yaml`);
    const state = existsSync(savedPath) ? readFileSync(savedPath, "utf8") : null;
    if (step.op === "strategy.save" && !state?.includes("fixture" in step ? "planner_reserve: .nan" : "planner_reserve: 0.000001")) throw Error("Guarded CLI save number bytes differ");
    if (step.op === "strategy.remove" && state !== null) throw Error("Guarded CLI did not remove saved strategy");
    states.push({op: step.op, reply, strategy: state});
    record(session, {kind: "note", behavior: `P2-C ${step.op}`, surface: "CLI", verdict: "PASS", text: "Guarded checkout api call --json succeeded through the public proxy; fixed synthetic result and persisted strategy captured in native-config-fixture/cli-results.json."});
  }
  await call("strategy.remove", {name});
  writeFileSync(join(fixture, "cli-results.json"), JSON.stringify(states, null, 2), {mode: 0o600, flag: "wx"});
}
