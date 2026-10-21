import { expect, test } from "bun:test";
import { startupCleanupIncarnations } from "../src/update/desktop/native-fixture-cleanup";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";
const processId = (pid: number) => ({pid,bootId:"boot",birth:`birth-${pid}`});
const record = () => ({exercise:null,runtime:{schema:1,state:"starting",request:null,driver:processId(11),sourceService:processId(12),desktop:processId(13)}});
test("fixture startup cleanup requires recorded never-ready lifecycle without any request",()=>{
 expect(startupCleanupIncarnations(record())).toEqual([processId(11),processId(12),processId(13)]);
 for(const change of [
  {exercise:{}}, {runtime:{...record().runtime,state:"ready"}},
  {runtime:{...record().runtime,request:{requestId:"armed"}}},
  {runtime:{...record().runtime,desktop:null}},
  {runtime:{...record().runtime,driver:{pid:11,bootId:"boot"}}},
 ]) expect(()=>startupCleanupIncarnations({...record(),...change})).toThrow();
});
test("source CLI has no fixture startup cleanup authority",async()=>{
 const result=await main(["--pacer-fixture-startup-cleanup"],fakeCtx());
 expect(result.code).not.toBe(0);
});
