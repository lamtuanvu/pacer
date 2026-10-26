import {beforeAll,expect,test} from "bun:test";
import {join} from "node:path";
import {tmpDir} from "./helpers";
async function ownedRun(argv: string[]) {
 const child=Bun.spawn(argv,{stdout:"pipe",stderr:"pipe",timeout:5000});
 try {
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  return {out,error,code};
 } finally { if(child.exitCode===null)child.kill("SIGKILL");await child.exited; }
}
let output: string;
beforeAll(async () => {
 if (process.platform !== "darwin") return;
 const started=performance.now();
 console.error("[permission-chip-setup] swift-compile begin");
 output=join(tmpDir(),"permission-layout");
 const build=Bun.spawn(["/usr/bin/swiftc","-parse-as-library",join(import.meta.dir,"../desktop/native/permission-chip.swift"),join(import.meta.dir,"fixtures/native-permission/layout-main.swift"),"-o",output],{stdout:"pipe",stderr:"pipe",timeout:120000});
 try {
  const [out,error,code]=await Promise.all([new Response(build.stdout).text(),new Response(build.stderr).text(),build.exited]);
  console.error(`[permission-chip-setup] swift-compile end elapsed_ms=${Math.round(performance.now()-started)} exit_code=${code}`);
  expect({code,error,out}).toEqual({code:0,error:"",out:""});
 } finally { if(build.exitCode===null)build.kill("SIGKILL");await build.exited; }
},125000);
test.skipIf(process.platform!=="darwin")("permission chip docks inside Settings and stays visible across focus changes",async()=>{
 const started=performance.now();
 const diagnostic=(stage:"swift-compile"|"compile-stderr"|"first-driver"|"driver-stdout"|"launcher"|"orphan-result",event:"begin"|"end",code?:number)=>{
  console.error(`[permission-chip-test] stage=${stage} event=${event} elapsed_ms=${Math.round(performance.now()-started)}${code===undefined?"":` exit_code=${code}`}`);
 };
 diagnostic("first-driver","begin");
 const run=await ownedRun([output]);
 diagnostic("driver-stdout","begin");
 const result=JSON.parse(run.out);
 diagnostic("driver-stdout","end");
 const runCode=run.code;
 expect(run.error).toBe("");
 diagnostic("first-driver","end",runCode);
 expect(runCode).toBe(0);
 expect(result.exclusive).toBe(true);
 expect(result.visibleWhileSettingsFrontmost).toBe(true);expect(result.visibleWhileAnotherAppFrontmost).toBe(true);expect(result.hiddenOffScreen).toBe(false);
 expect(result.launcherAlive).toBe(true);expect(result.launcherReplaced).toBe(false);expect(result.launcherMissing).toBe(false);
 const p=result.positions;
 expect(p[0].x).toBe(246);expect(p[1].x).toBe(946);expect(p[2].x).toBe(-1004);
 expect(p[3].x-p[0].x).toBe(50);
 expect(p.every((v:{contained:boolean})=>v.contained)).toBe(true);
 expect(p.every((v:{overlap:boolean})=>v.overlap)).toBe(true);
 expect(p[4].compact).toBe(false);expect(p[5].compact).toBe(true);
 const orphanResult=join(tmpDir(),"orphan-result.json");
 diagnostic("launcher","begin");
 const launcher=await ownedRun([output,"launcher",orphanResult]);
 const launcherCode=launcher.code;
 expect(launcher.error).toBe("");
 diagnostic("launcher","end",launcherCode);
 expect(launcherCode).toBe(0);
 diagnostic("orphan-result","begin");
 for(let attempt=0;attempt<100 && !await Bun.file(orphanResult).exists();attempt++) await Bun.sleep(20);
 expect((await Bun.file(orphanResult).json()).status).toBe("cancelled");
 diagnostic("orphan-result","end");
 expect(result.bundles).toEqual(["/Applications/Host.app",null,"/Applications/Ứng dụng.app"]);
},30000);
