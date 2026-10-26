import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";

const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/repo-add.json"), "utf8")) as Record<string, {key?:string;label?:string;repos:string;aliases?:string|null}>;

test("TypeScript repo.add remote golden keeps result and registry bytes", async () => {
  const ctx=fakeCtx({run:realRun,now:12345}),repo=gitRepo();
  await realRun(["git","-C",repo,"remote","add","origin","git@github.com:Acme/API.git"],10000);
  const result=await callOp(ctx,"repo.add",{path:repo});
  const main=realpathSync(repo);
  expect(result).toEqual({key:golden.remote.key,path:main,label:golden.remote.label});
  expect(readFileSync(join(ctx.pacerHome,"state/repos.json"),"utf8")).toBe(golden.remote.repos.replaceAll("$MAIN",main));
});

test("TypeScript repo.add linked golden writes alias before main registry", async () => {
  const ctx=fakeCtx({run:realRun,now:12345}),repo=gitRepo(),linked=join(tmpDir(),"linked");
  await realRun(["git","-C",repo,"remote","add","origin","git@github.com:Acme/API.git"],10000);
  await realRun(["git","-C",repo,"worktree","add","-b","linked",linked],10000);
  const result=await callOp(ctx,"repo.add",{path:linked});
  const main=realpathSync(repo),top=realpathSync(linked);
  expect(result).toEqual({key:golden.linked.key,path:main,label:golden.linked.label});
  expect(readFileSync(join(ctx.pacerHome,"state/repos.json"),"utf8")).toBe(golden.linked.repos.replaceAll("$MAIN",main));
  expect(readFileSync(join(ctx.pacerHome,"state/repo-paths.json"),"utf8")).toBe(golden.linked.aliases!.replaceAll("$MAIN",main).replaceAll("$LINKED",top));
});

test("TypeScript repo.add fractional lastUsed bytes match the native supported range", async () => {
  const ctx=fakeCtx({run:realRun,now:1793042681.555}),repo=gitRepo();
  await realRun(["git","-C",repo,"remote","add","origin","git@github.com:Acme/API.git"],10000);
  await callOp(ctx,"repo.add",{path:repo});
  const main=realpathSync(repo);
  expect(readFileSync(join(ctx.pacerHome,"state/repos.json"),"utf8")).toBe(golden.fractional.repos.replaceAll("$MAIN",main));
});
