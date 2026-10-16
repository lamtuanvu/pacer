import { expect, test } from "bun:test";
import { readSettings } from "../orca-plugin/src/settings";
import { selfHandle } from "../src/console/cli";
import { fakeCtx } from "./helpers";
import { fakeRun } from "./fixtures/orca/fake";

test("worker ignores legacy autoConsole settings",()=>{
 for(const autoConsole of [true,false,"off"])
  expect(readSettings({autoConsole},"/tmp")).toEqual(readSettings({},"/tmp"));
});
test("auto-created terminal resolves its exported Orca handle without CLI calls",async()=>{
 const f=fakeRun([]);expect(await selfHandle(fakeCtx({env:{ORCA_TERMINAL_HANDLE:"term_created"},run:f.run}))).toEqual({handle:"term_created",paneKey:null});expect(f.calls).toHaveLength(0);
});
