import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";

const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/host-suggest.json"), "utf8"));
const strategy = 'accounts: {personal: {kind: claude}}\nplanner: claude-code\nrouting: [{default: [claude-code]}]\nhosts: {devbox: {ssh: dev-ssh}}\n';

test("TypeScript host.suggest literal Include golden", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive:true});
  mkdirSync(join(ctx.home,".ssh"), {recursive:true});
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"), strategy);
  writeFileSync(join(ctx.home,".ssh/config"), 'Host dev-ssh fresh-box\nInclude "extra file"\nHost * !private qa?\nHost dev-ssh\n');
  writeFileSync(join(ctx.home,".ssh/extra file"), 'hOsT="quoted-box" # comment\n');
  expect(await callOp(ctx,"host.suggest",{})).toEqual(golden.literalInclude);
  expect(await callOp(ctx,"routing.get",{})).toEqual({rules:[{executors:["claude-code"]}],available:["claude-code"]});
});

test("TypeScript host.suggest missing config golden", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"), strategy);
  expect(await callOp(ctx,"host.suggest",{})).toEqual(golden.missingConfig);
});

test("TypeScript recognizes Unicode SSH directive whitespace", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive:true});
  mkdirSync(join(ctx.home,".ssh"), {recursive:true});
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"), strategy);
  writeFileSync(join(ctx.home,".ssh/config"), "Host\uFEFFfresh-box\n");
  expect(await callOp(ctx,"host.suggest",{})).toEqual(["fresh-box"]);
});
