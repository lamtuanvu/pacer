import { expect, test } from "bun:test";
import { postFallback } from "../src/notify/fallback";
import { fakeCtx } from "./helpers";

test("macOS passes quotes, backslashes, newlines and shell text as literal argv",async()=>{
 const title='Title "quoted"\\\n$(touch bad)',body='Body "\\\n';const calls:string[][]=[];
 const ctx=fakeCtx({which:bin=>bin==="osascript"?"/usr/bin/osascript":null,run:async argv=>{calls.push(argv);return {code:0,stdout:"",stderr:""};}});
 expect(await postFallback(title,body,{...ctx,platform:"darwin"})).toBe(true);
 expect(calls).toEqual([["/usr/bin/osascript","-e","on run argv","-e","display notification (item 2 of argv) with title (item 1 of argv)","-e","end run",title,body]]);
});

test("Linux uses literal notify-send arguments and missing tools never run",async()=>{
 const calls:string[][]=[];const ctx=fakeCtx({run:async argv=>{calls.push(argv);return {code:1,stdout:"",stderr:"failed"};}});
 expect(await postFallback("-title","body",{...ctx,platform:"linux"})).toBe(false);
 expect(calls).toEqual([["/usr/bin/fake","--","-title","body"]]);
 expect(await postFallback("title","body",{...ctx,platform:"linux",which:()=>null})).toBe(false);
 expect(await postFallback("title","body",{...ctx,platform:"win32"})).toBe(false);
 expect(calls).toHaveLength(1);
 expect(await postFallback("title","body",{...ctx,platform:"darwin",run:async()=>{throw Error("missing");}})).toBe(false);
});
