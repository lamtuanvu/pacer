import {beforeAll,expect,test} from "bun:test";
import {join} from "node:path";
import {tmpDir} from "./helpers";
// Compile once as setup, using one frontend instead of importing AppKit twice.
let output: string;
beforeAll(async () => {
 if (process.platform !== "darwin") return;
 output=join(tmpDir(),"permission-layout");
 const build=Bun.spawn(["/usr/bin/swiftc","-parse-as-library","-whole-module-optimization",join(import.meta.dir,"../desktop/native/permission-chip.swift"),join(import.meta.dir,"fixtures/native-permission/layout-main.swift"),"-o",output],{stdout:"pipe",stderr:"pipe"});
 const error=await new Response(build.stderr).text();
 expect({code:await build.exited,error}).toEqual({code:0,error:""});
}, 30000);

test.skipIf(process.platform!=="darwin")("permission chip docks inside Settings and stays visible across focus changes",async()=>{
 const run=Bun.spawn([output],{stdout:"pipe",stderr:"pipe"});
 const result=JSON.parse(await new Response(run.stdout).text());expect(await run.exited).toBe(0);
 expect(result.exclusive).toBe(true);
 expect(result.visibleWhileSettingsFrontmost).toBe(true);expect(result.visibleWhileAnotherAppFrontmost).toBe(true);expect(result.hiddenOffScreen).toBe(false);
 expect(result.launcherAlive).toBe(true);expect(result.launcherReplaced).toBe(false);expect(result.launcherMissing).toBe(false);
 const p=result.positions;
 expect(p[0].x).toBe(246);expect(p[1].x).toBe(946);expect(p[2].x).toBe(-1004);
 expect(p[3].x-p[0].x).toBe(50);
 expect(p.every((v:{contained:boolean})=>v.contained)).toBe(true);
 expect(p.every((v:{overlap:boolean})=>v.overlap)).toBe(true);
 expect(p[4].compact).toBe(false);expect(p[5].compact).toBe(true);
 // Readiness is a pipe handshake in the fixture. Wait for its atomic result
 // within the test budget, without separate 1 s / 2 s startup deadlines.
 const orphanPath=join(tmpDir(),"orphan-result.json");
 const launcher=Bun.spawn([output,"launcher",orphanPath],{stdout:"ignore",stderr:"pipe"});
 const [launcherError, launcherCode] = await Promise.all([
   new Response(launcher.stderr).text(), launcher.exited,
 ]);
 expect({code:launcherCode,error:launcherError}).toEqual({code:0,error:""});
 // The orphan holds the launcher's stderr, so EOF above means it has exited; the bound only turns a crash into a clear failure.
 const deadline=Date.now()+5_000;
 while (!await Bun.file(orphanPath).exists() && Date.now()<deadline) await Bun.sleep(20);
 expect(await Bun.file(orphanPath).exists()).toBe(true);
 const orphanResult=await Bun.file(orphanPath).json();
 expect(orphanResult.finished).toBe(true);
 expect(orphanResult.result.status).toBe("cancelled");
 expect(result.bundles).toEqual(["/Applications/Host.app",null,"/Applications/Ứng dụng.app"]);
},30000);
