import { test, expect } from "bun:test";
import { buildPluginAssets } from "../orca-plugin/build";
import pkg from "../package.json";
test("worker bundle uses only allowed Node imports and no Bun runtime",async()=> {
 const worker=await Bun.file("orca-plugin/dist/worker.mjs").text();expect(worker).not.toContain("Bun.");expect(worker).not.toContain("child_process");expect(worker).not.toContain("require(");
 for(const m of worker.matchAll(/from\s+"([^"]+)"/g))expect(m[1]).toMatch(/^node:(http|fs|path|url)$/);
});
test("committed assets are fresh: run `bun run plugin:build`",async()=> {
 const a=await buildPluginAssets(pkg.version);for(const [path,text] of [["orca-plugin/dist/orca-plugin.json",a.manifest],["orca-plugin/dist/worker.mjs",a.worker],["orca-plugin/dist/panel/live.html",a.panel],["src/plugin/assets.generated.ts",a.generated]])expect(await Bun.file(path!).text(),"run `bun run plugin:build`").toBe(text!);
});
