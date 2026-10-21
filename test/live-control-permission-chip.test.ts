import {expect,test} from "bun:test";
import {join} from "node:path";
import {tmpDir} from "./helpers";
test.skipIf(process.platform!=="darwin")("permission chip follows Settings, flips sides and stays within each display",async()=>{
 const output=join(tmpDir(),"permission-layout");
 const build=Bun.spawn(["/usr/bin/swiftc","-parse-as-library",join(import.meta.dir,"../desktop/native/permission-chip.swift"),join(import.meta.dir,"fixtures/native-permission/layout-main.swift"),"-o",output],{stdout:"pipe",stderr:"pipe"});
 const error=await new Response(build.stderr).text();
 expect({code:await build.exited,error}).toEqual({code:0,error:""});
 const run=Bun.spawn([output],{stdout:"pipe",stderr:"pipe"});
 const result=JSON.parse(await new Response(run.stdout).text());expect(await run.exited).toBe(0);
 expect(result.exclusive).toBe(true);
 const p=result.positions;
 expect(p[0].x).toBe(712);expect(p[1].x).toBe(600);expect(p[2].x).toBe(-538);
 expect(p[3].x-p[0].x).toBe(50);
 expect(p.every((v:{contained:boolean})=>v.contained)).toBe(true);
 expect(p.slice(0,4).every((v:{overlap:boolean})=>!v.overlap)).toBe(true);
 expect(p[4].compact).toBe(true);expect(p[5].compact).toBe(true);
 expect(result.bundles).toEqual(["/Applications/Host.app",null,"/Applications/Ứng dụng.app"]);
},30000);
