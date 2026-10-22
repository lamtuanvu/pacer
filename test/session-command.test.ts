import {expect,test} from "bun:test";
import {parseSessionArgs} from "../src/commands/session";
test("session arguments preserve initial prompt and collect repeated attachments",()=>{
 expect(parseSessionArgs(["start","--repo","repo","--executor","codex","--base","main","--attach","a.png","--attach","b.txt","--","--flag","日本語"])).toMatchObject({command:"start",repo:"repo",executor:"codex",base:"main",attachments:["a.png","b.txt"],request:"--flag 日本語"});
 expect(()=>parseSessionArgs(["start","--base","main","--checkout","/tmp/r","--","hello"])).toThrow("exclusive");
 expect(parseSessionArgs(["end","task-id","--json"])).toMatchObject({command:"end",id:"task-id",json:true});
});
