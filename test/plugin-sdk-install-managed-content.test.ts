import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {managedContent} from "../packages/plugin-sdk/src/install/managed-content";
import {sha256} from "../packages/plugin-sdk/src/install/helpers";
import {managedContent as hostContent} from "../src/install/managed-content";
import type {PlannerRecord,UndoOp} from "../packages/plugin-sdk/src/install/undo";
test("managed hooks ignore unrelated settings but detect timeout changes",()=>{
 const ops:UndoOp[]=[{kind:"hooks",format:"claude",commands:["pacer guard --planner codex"],restore:[]}];
 const text=JSON.stringify({hooks:{PreToolUse:[{matcher:"spawn_agent",hooks:[{command:"pacer guard --planner codex",timeout:15}]}]}});
 expect(managedContent(text,ops)).toBe(managedContent(text.replace('{"hooks"','{"theme":"dark","hooks"'),ops));
 expect(managedContent(text,ops)).not.toBe(managedContent(text.replace('"timeout":15','"timeout":30'),ops));
});
test("ambiguous managed blocks are rejected",()=>{
 const block='<!-- >>> pacer >>> -->\nhello\n<!-- <<< pacer <<< -->\n';
 expect(()=>managedContent(block+block,[{kind:"block",style:"md"}])).toThrow();
 expect(()=>managedContent('<!-- >>> pacer >>> -->',[{kind:"block",style:"md"}])).toThrow();
});
for(const agent of ["claude-code","codex","cursor","opencode"])test(`${agent} SDK ownership hash agrees with real host install fixture`,()=>{
 const fixture=JSON.parse(readFileSync(join(import.meta.dir,"fixtures/install",agent+".json"),"utf8")) as {manifest:{planners:Record<string,PlannerRecord>};after:Record<string,{text:string}>};
 for(const file of fixture.manifest.planners[agent]!.files){
  if(!file.managed)continue;
  const text=fixture.after[file.path]!.text;
  expect(managedContent(text,file.undo)).toBe(hostContent(text,file.undo));
  expect(sha256(managedContent(text,file.undo))).toBe(file.managed.hash);
 }
});
