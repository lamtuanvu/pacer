import { expect,test } from "bun:test";
import { mkdirSync,realpathSync,symlinkSync,writeFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { nativeShimLocation } from "../src/update/desktop/native-shim";
import { fakeCtx } from "./helpers";
test("native shim path is fixed to app Frameworks or the detached executable sibling",()=>{
 const root=realpathSync(fakeCtx().home),app=join(root,"pacer.app"),bundled=join(app,"Contents/Resources/pacer"),detached=join(root,"detached/pacer");
 for(const file of [bundled,detached]){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,"test executable");}
 expect(nativeShimLocation(bundled)).toEqual({path:join(app,"Contents/Frameworks/libpacer-native.dylib"),app});
 const core=join(app,"Contents/Resources/pacer-core");writeFileSync(core,"test core");
 expect(nativeShimLocation(core)).toEqual({path:join(app,"Contents/Frameworks/libpacer-native.dylib"),app});
 expect(nativeShimLocation(detached)).toEqual({path:join(root,"detached/libpacer-native.dylib"),app:null});
 const alias=join(root,"alias");symlinkSync(detached,alias);expect(()=>nativeShimLocation(alias)).toThrow();
});

test("source and argument-bearing native transport diagnostics refuse without starting a service",async()=>{
 const {main}=await import("../src/cli");
 const {nativeServiceArgv}=await import("../src/update/desktop/native-service-argv");
 expect(()=>nativeServiceArgv()).toThrow("compiled signed baseline");
 for(const args of [["--pacer-native-transport-test"],["--pacer-native-transport-test","--path","arbitrary"]]){
  const result=await main(args,fakeCtx());expect(result.code).toBe(2);expect(result.out).toBe("");
 }
});
