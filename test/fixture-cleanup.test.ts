import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupFixtureResources, registerFixtureCleanup } from "./fixture-cleanup";
import { tmpDir } from "./helpers";

test("owned cleanup continues after failures and preserves every original error", async () => {
  const errors = [new Error("first owner"), new Error("second owner")], calls: number[] = [];
  registerFixtureCleanup(() => { calls.push(1); throw errors[0]; });
  registerFixtureCleanup(async () => { calls.push(2); throw errors[1]; });
  registerFixtureCleanup(() => { calls.push(3); });
  const result = await cleanupFixtureResources().catch(error => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual(errors);
  expect(calls).toEqual([1, 2, 3]);
  await expect(cleanupFixtureResources()).resolves.toBeUndefined();
});

test("cached fixture helpers drain real plugin children and servers after every test file", async () => {
  const root = resolve(import.meta.dir, ".."), dir = tmpDir();
  const modulePath = (path: string) => JSON.stringify(join(root, path));
  writeFileSync(join(dir, "owned.ts"), `export const owned:any[]=[];export const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};`);
  for (const name of ["a", "b"]) writeFileSync(join(dir, `${name}.test.ts`), `
import {test,expect} from "bun:test";
import {readFileSync} from "node:fs";
import {fakeCtx} from ${modulePath("test/install-plugin-fixtures.ts")};
import {withVersionFixtures} from ${modulePath("test/planner-detect-fixtures.ts")};
import {withClaudeCommandFixture} from ${modulePath("test/planner-command-fixtures.ts")};
import {pluginRegistry} from ${modulePath("src/plugins/index.ts")};
import {owned} from "./owned";
test(${JSON.stringify(`owned resources in ${name}`)},async()=>{
 const ctx=fakeCtx();withVersionFixtures(ctx);
 const version=ctx.which("codex")!;withClaudeCommandFixture(ctx);const command=ctx.which("claude")!;
 const urls=[version,command].map(path=>readFileSync(path,"utf8").match(new RegExp("http://127[.]0[.]0[.]1:[0-9]+/[a-z0-9-]+"))![0]);
 const registry=pluginRegistry(ctx);await registry.call(ctx,"pacer-planners","diagnostic.ping",{});
 const pid=registry.list(ctx).find(p=>p.id==="pacer-planners")!.pid!;owned.push({ctx,pid,urls});expect(pid).toBeGreaterThan(0);
});`);
  writeFileSync(join(dir, "c.test.ts"), `
import {test,expect} from "bun:test";
import {cleanupFixtureResources} from ${modulePath("test/fixture-cleanup.ts")};
import {owned,alive} from "./owned";
test("every earlier file released its own children and servers",async()=>{
 try{expect(owned.length).toBe(2);expect(owned.map(o=>alive(o.pid))).toEqual([false,false]);
 for(const owner of owned)for(const url of owner.urls)expect(await fetch(url).then(()=>true,()=>false)).toBe(false);
 }finally{await cleanupFixtureResources();}
});`);
  const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", "--preload", join(root, "test/setup.ts"), ...["a", "b", "c"].map(name => join(dir, `${name}.test.ts`))], {
    cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 20000,
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr || stdout).toBe(0);
  expect(stderr).toContain("3 pass");
}, 25000);
