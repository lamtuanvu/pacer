import {expect,test} from "bun:test";
import {createValidationIpc} from "../app/src/desktop/validation";
test("native setup is macOS desktop only and sends no caller-supplied application path",async()=>{
 const calls:unknown[]=[];
 const ipc=createValidationIpc({platform:"MacIntel",invoke:async(command:string,args?:unknown)=>{calls.push([command,args]);return {status:"cancelled",accessibility:false};}});
 expect(ipc.supported).toBe(true);expect((await ipc.setup()).status).toBe("cancelled");
 expect(calls).toEqual([["native_validation_setup",undefined]]);
 expect(createValidationIpc({platform:"Linux x86_64",invoke:async()=>{throw Error("must not invoke");}}).supported).toBe(false);
 expect(createValidationIpc({platform:"MacIntel"}).supported).toBe(false);
 await expect(createValidationIpc({platform:"MacIntel"}).setup()).rejects.toThrow("macOS desktop");
});
