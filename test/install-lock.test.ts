import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeCtx } from "./helpers";
import { withInstallLock } from "../src/install/lock";

test("dead installation contenders do not leave a second unrecoverable lock", async () => {
  const ctx = fakeCtx(), dir = join(ctx.pacerHome, "install-locks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2000000000-dead.json"), JSON.stringify({ pid: 2000000000, ticket: null }));
  await withInstallLock(ctx, async () => { writeFileSync(join(ctx.pacerHome, "recovered"), "yes"); });
  expect(readFileSync(join(ctx.pacerHome, "recovered"), "utf8")).toBe("yes");
  expect(readdirSync(dir)).toEqual([]);
});

test("independent processes serialize installation read-modify-write", async () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  const counter = join(ctx.pacerHome, "counter"); writeFileSync(counter, "0");
  const source = `import {withInstallLock} from ${JSON.stringify(resolve("src/install/lock.ts"))}; import {readFileSync,writeFileSync} from 'node:fs'; const root=process.argv[1]; await withInstallLock({pacerHome:root}, async()=>{const n=Number(readFileSync(root+'/counter','utf8'));await Bun.sleep(100);writeFileSync(root+'/counter',String(n+1));});`;
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", source, ctx.pacerHome], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(child => child.exited));
  expect(results).toEqual([0, 0, 0, 0]);
  expect(readFileSync(counter, "utf8")).toBe("4");
});

test("a crashed contender with an incomplete record is reaped from its filename identity", async () => {
  const ctx = fakeCtx(), dir = join(ctx.pacerHome, "install-locks"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2000000000-crashed.json"), "");
  await withInstallLock(ctx, async () => {});
  expect(readdirSync(dir)).toEqual([]);
});
