import { expect, test } from "bun:test";
import { verifyRepo } from "../src/exec/verify";
import { tmpDir } from "./helpers";

const env = { PATH: process.env.PATH, HOME: process.env.HOME };

async function gitRepo(): Promise<string> {
  const dir = tmpDir();
  const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd: dir, env });
  sh("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
  await Bun.write(`${dir}/a.txt`, "one\n");
  sh("git add a.txt && git -c user.email=t@t -c user.name=t commit -q -m a");
  return dir;
}

test("lists changed and untracked files; passing acceptance", async () => {
  const dir = await gitRepo();
  await Bun.write(`${dir}/a.txt`, "two\n");
  await Bun.write(`${dir}/new.txt`, "x\n");
  const v = await verifyRepo(dir, "test -f new.txt && echo ok", env);
  expect(v.files).toContain("a.txt");
  expect(v.files).toContain("untracked: new.txt");
  expect(v.acceptance).toEqual({ cmd: "test -f new.txt && echo ok", passed: true, tail: "ok" });
});

test("failing acceptance keeps the last 20 lines; no changes is reported", async () => {
  const dir = await gitRepo();
  const v = await verifyRepo(dir, "for i in $(seq 1 30); do echo line$i; done; exit 1", env);
  expect(v.files).toBe("(no changes)");
  expect(v.acceptance?.passed).toBe(false);
  const lines = v.acceptance!.tail.split("\n");
  expect(lines.length).toBe(20);
  expect(lines[19]).toBe("line30");
});

test("not a git repo and no acceptance command", async () => {
  const v = await verifyRepo(tmpDir(), undefined, env);
  expect(v).toEqual({ files: "(not a git repository)" });
});

test("pipeline failure fails acceptance even when the final command succeeds", async () => {
  const v = await verifyRepo(await gitRepo(), "false | cat", env);
  expect(v.acceptance?.passed).toBe(false);
});
