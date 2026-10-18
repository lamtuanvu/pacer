import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removableVolumeChecks } from "../src/install/removable-volume";
import { fakeCtx } from "./helpers";
test("doctor reads registered removable repo paths without touching them in-process", async () => {
  const ctx = fakeCtx();
  const path = ["", "Volumes", "Offline", "repo"].join("/");
  mkdirSync(join(ctx.pacerHome, "state"), {recursive:true});
  writeFileSync(join(ctx.pacerHome, "state", "repos.json"), JSON.stringify({[path]:{path, key:"local:test", lastUsed:ctx.now}}));
  const paths: string[] = [];
  ctx.run = async a => { if(a[0] === "/bin/ls") paths.push(a[2]); return {code:0, stdout:"", stderr:""}; };
  const checks = await removableVolumeChecks(ctx, {platform:"darwin"});
  expect(paths).toEqual([path]);
  expect(checks[0].level).toBe("ok");
});
test("thrown EPERM and timeouts include recovery instructions", async () => {
  for(const message of ["EPERM", "ETIMEDOUT"]) {
    const ctx = fakeCtx({run:async () => { throw Error(message); }});
    const checks = await removableVolumeChecks(ctx, {platform:"darwin", paths:[["", "Volumes", "External", "repo"].join("/")]});
    expect(checks[0].level).toBe("warn");
    expect(checks[0].fix).toContain("Removable Volumes");
  }
});
