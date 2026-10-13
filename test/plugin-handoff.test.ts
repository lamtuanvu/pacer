import { expect, test } from "bun:test";
import { buildPluginAssets } from "../orca-plugin/build";
import { createPlugin } from "../orca-plugin/src/plugin";
import type { OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { ManualTimers, flush } from "./plugin-transports.test";

test("unmanaged worker never mutates its plugin root or opens consoles", async () => {
 const timers = new ManualTimers(), writes: string[] = [], requests: string[] = [];
 const plugin = createPlugin({home:"/tmp/home",pluginRoot:"/tmp/verified",nowS:()=>timers.now/1000,timers,
  fs:{exists:()=>false,readText:()=>"token",writeTextAtomic(path){writes.push(path);throw Error("verified root write");}},
  http:{get:async url=>{requests.push(url);return {status:200,headers:{"x-pacer":"1"},body:"{}"};},post:async url=>{requests.push(url);return {status:200,body:"{}"};},stream:()=>()=>{}},
 });
 const ctx={host:{call:async(m:string)=>m==="settings.get"?{settings:{}}:m==="workspace.readContext"?{branch:"main",terminals:[]}:{value:null}},commands:{register(){}},events:{on(){}},log(){}} as unknown as OrcaWorkerContext;
 await plugin.activate(ctx);await flush();await timers.advance(120000);await plugin.deactivate();
 expect(writes).toEqual([]);expect(requests).toEqual([]);
});

test("shipped bootstrap panel shows one-time steps without terminal actions",async()=>{
 const {panel}=await buildPluginAssets("0.1.17");
 expect(panel).toContain("Set up pacer");expect(panel).not.toContain("Not connected");expect(panel).toContain("connect-src 'none'");
 expect(panel).toContain("uninstall this pacer");expect(panel).toContain("Development");expect(panel).toContain("~/.pacer/orca-plugin");
 expect(panel).toContain("the notification shows its full path");expect(panel).toContain("Enable pacer");
 expect(panel).not.toContain("terminal.sendText");expect(panel).not.toContain("postMessage");expect(panel).not.toContain("<button");
});

test("marker detection opts only pacer-managed folders into live mode", async()=>{
 const {pluginMode}=await import("../orca-plugin/src/mode");
 const seen:string[]=[];const files=new Set<string>();const fs={exists:(path:string)=>{seen.push(path);return files.has(path);}};
 expect(pluginMode("/tmp/plugin",fs)).toBe("bootstrap");files.add("/tmp/plugin/.pacer-managed");expect(pluginMode("/tmp/plugin",fs)).toBe("live");
 expect(seen).toEqual(["/tmp/plugin/.pacer-managed","/tmp/plugin/.pacer-managed"]);
});
test("bundle guard rejects a managed marker even inside a nested published directory",async()=>{
 const {assertPublishedBundle}=await import("../orca-plugin/build");const {mkdirSync,writeFileSync}=await import("node:fs");const {join}=await import("node:path");const {tmpDir}=await import("./helpers");
 const root=tmpDir();mkdirSync(join(root,"nested"));assertPublishedBundle(root);writeFileSync(join(root,"nested/.pacer-managed"),"{}");expect(()=>assertPublishedBundle(root)).toThrow("must never be published");
});
