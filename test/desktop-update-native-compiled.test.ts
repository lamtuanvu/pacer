import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { fakeCtx } from "./helpers";

function run(argv:string[],env?:Record<string,string>) {
  return Bun.spawnSync(argv,{env,stdout:"pipe",stderr:"pipe",timeout:30_000});
}
function success(argv:string[]) {const result=run(argv);expect(result.exitCode,result.stderr.toString()).toBe(0);}
test("compiled fixture transport requires its fixed signed native shim and never falls back to TinyCC", () => {
 if(process.platform!=="darwin")return;
 const ctx=fakeCtx(),lease=join(realpathSync(ctx.home),".work/live/socket-probe"),root=join(lease,"ota"),home=join(lease,"home"),nonce="a".repeat(32);
 for(const path of [root,home])mkdirSync(path,{recursive:true,mode:0o700});
 const policy={schema:1,root,nonce,home,port:54321,currentApp:join(root,"current.app"),serviceLabel:`com.pacer.live.${nonce}.service`,recoveryLabel:`com.pacer.live.${nonce}.recovery`,uid:process.getuid!()};
 writeFileSync(join(root,"record.json"),JSON.stringify({schema:1,phase:"prepared",root,nonce,pacerHome:home,innerPort:policy.port,currentApp:policy.currentApp,serviceLabel:policy.serviceLabel,recoveryLabel:policy.recoveryLabel,ownerUid:policy.uid}),{mode:0o600});
 const executable=join(root,"pacer"),library=join(root,"libpacer-native.dylib"),entitlements=join(root,"cli-entitlements.plist");
 writeFileSync(entitlements,'<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',{mode:0o600});
 success([process.execPath,"build","--compile","test/fixtures/desktop-update/compiled-socket.ts","--define",'PACER_BUILD_VERSION="0.2.3"',"--define",`PACER_BUILD_OTA_FIXTURE=${JSON.stringify(JSON.stringify(policy))}`,"--outfile",executable]);
 const sign=(path:string,identifier:string,extra:string[]=[])=>success(["/usr/bin/codesign","--force","--sign","-","--identifier",identifier,...extra,path]);
 sign(executable,"dev.pacer.cli",["--entitlements",entitlements]);
 const execute=()=>run([executable,"serve","--port","54321"],{HOME:home,PATH:"/usr/bin:/bin:/usr/sbin:/sbin"});
 const smokeDirectories=()=>readdirSync("/private/tmp").filter(name=>name.startsWith("pacer-native-smoke-")).sort();
 const beforeSmoke=smokeDirectories();
 const missing=execute();expect(missing.exitCode).not.toBe(0);
 success(["/usr/bin/xcrun","clang","-dynamiclib","-arch",process.arch==="arm64"?"arm64":"x86_64","-mmacosx-version-min=11.0","-O2","-Wall","-Wextra","-Werror","-Wl,-install_name,@rpath/libpacer-native.dylib",resolve("src/update/desktop/native-socket.c"),"-o",library]);
 chmodSync(library,0o700);sign(library,"dev.pacer.desktop.native-shim");
 for(let i=0;i<2;i++){const result=execute();expect(result.exitCode,result.stderr.toString()).toBe(0);expect(JSON.parse(result.stdout.toString())).toEqual({schema:1,role:"cli",version:"0.2.3",arch:process.arch==="arm64"?"aarch64":"x86_64",nativeTransportAbi:1,transport:"unix-audit-token",verified:true});}
 expect(smokeDirectories()).toEqual(beforeSmoke);
 const original=readFileSync(library);renameSync(library,library+".real");symlinkSync(library+".real",library);
 expect(execute().exitCode).not.toBe(0);unlinkSync(library);renameSync(library+".real",library);
 sign(library,"dev.pacer.wrong-shim");expect(execute().exitCode).not.toBe(0);
 writeFileSync(library,original,{mode:0o700});
 const badAbi=join(root,"wrong-abi.c");
 writeFileSync(badAbi,"int pacer_native_transport_abi(void){return 2;} int pacer_descriptor_flags(int fd){return fd<0?-1:0;}",{mode:0o600});
 success(["/usr/bin/xcrun","clang","-dynamiclib","-arch",process.arch==="arm64"?"arm64":"x86_64",badAbi,"-o",library]);
 chmodSync(library,0o700);sign(library,"dev.pacer.desktop.native-shim");expect(execute().exitCode).not.toBe(0);
 success(["/usr/bin/xcrun","clang","-dynamiclib","-arch",process.arch==="arm64"?"x86_64":"arm64",resolve("src/update/desktop/native-socket.c"),"-o",library]);
 chmodSync(library,0o700);sign(library,"dev.pacer.desktop.native-shim");expect(execute().exitCode).not.toBe(0);
 writeFileSync(library,original,{mode:0o700});
 // Ad-hoc libraries have no matching Apple Team. Whether hardened library validation refuses
 // them differs across macOS releases; either way the CLI must never fall back to unsigned
 // runtime compilation, which would leave a smoke directory behind.
 sign(executable,"dev.pacer.cli",["--options","runtime","--entitlements",entitlements]);
 const hardened=execute();
 if(hardened.exitCode!==0)expect(hardened.stdout.toString()).not.toContain("roundtrip passed");
 expect(smokeDirectories()).toEqual(beforeSmoke);
},60_000);
