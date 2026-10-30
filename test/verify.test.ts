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
  expect(v.acceptance).toMatchObject({ cmd: "test -f new.txt && echo ok", passed: true, tail: "ok" });
});

test("failing acceptance keeps the last 20 lines; no changes is reported", async () => {
  const dir = await gitRepo();
  const v = await verifyRepo(dir, "for i in $(seq 1 30); do echo line$i; done; exit 1", env);
  expect(v.files).toBe("(no changes)");
  expect(v.acceptance?.passed).toBe(false);
  expect(v.acceptance?.exitCode).toBe(1);
  const lines = v.acceptance!.tail.split("\n");
  expect(lines.length).toBe(20);
  expect(lines[19]).toBe("line30");
});

test("stderr stays in the tail even when stdout is empty", async () => {
  const v = await verifyRepo(await gitRepo(), "echo oops 1>&2; exit 1", env);
  expect(v.acceptance?.tail).toBe("oops");
  expect(v.acceptance?.exitCode).toBe(1);
});

test("not a git repo and no acceptance command", async () => {
  const v = await verifyRepo(tmpDir(), undefined, env);
  expect(v).toEqual({ files: "(not a git repository)" });
});

test("acceptance runs as written by default: a pipeline's exit code is the last command's, not pipefail's", async () => {
  const v = await verifyRepo(await gitRepo(), "false | cat", env);
  expect(v.acceptance?.passed).toBe(true);
  expect(v.acceptance?.exitCode).toBe(0);
  expect(v.acceptance?.shell).toBe("bash -c");
});

test("acceptance_pipefail opts in to failing on a non-final pipeline stage", async () => {
  const v = await verifyRepo(await gitRepo(), "false | cat", env, undefined, true);
  expect(v.acceptance?.passed).toBe(false);
  expect(v.acceptance?.exitCode).toBe(1);
  expect(v.acceptance?.shell).toBe("bash -o pipefail -c");
});

test("regression: grep -v with no matches into a negated grep keeps passing without forced pipefail", async () => {
  // git status --short is empty in a clean repo; grep -v on empty input exits 1,
  // which only matters if pipefail is forced (issue #450).
  const v = await verifyRepo(await gitRepo(), "git status --short | grep -v '^??' | (! grep .)", env);
  expect(v.acceptance?.passed).toBe(true);
  expect(v.acceptance?.exitCode).toBe(0);
});

test("regression: grep -q short-circuiting a long pipe keeps passing without forced pipefail", async () => {
  const v = await verifyRepo(await gitRepo(), "git log -50 --format=%s | grep -q 'init'", env);
  expect(v.acceptance?.passed).toBe(true);
  expect(v.acceptance?.exitCode).toBe(0);
});

test("a 141 (SIGPIPE) exit under opted-in pipefail gets a hint", async () => {
  const v = await verifyRepo(await gitRepo(), "seq 1 1000000 | head -1", env, undefined, true);
  expect(v.acceptance?.exitCode).toBe(141);
  expect(v.acceptance?.passed).toBe(false);
  expect(v.acceptance?.hint).toContain("141 (SIGPIPE)");
});

test("an instant, empty-output failure gets a hint even without pipefail", async () => {
  const v = await verifyRepo(await gitRepo(), "exit 7", env);
  expect(v.acceptance?.exitCode).toBe(7);
  expect(v.acceptance?.tail).toBe("");
  expect(v.acceptance?.hint).toContain("exited 7");
});

test("a passing acceptance records its exit code and shell with no hint", async () => {
  const v = await verifyRepo(await gitRepo(), "test -f a.txt", env);
  expect(v.acceptance?.exitCode).toBe(0);
  expect(v.acceptance?.shell).toBe("bash -c");
  expect(v.acceptance?.hint).toBeUndefined();
});

for (const [output, summary] of [["38 passed", "38 passed"], ["36 pass\n2 fail", "36 passed · 2 failed"], ["2 failed", "2 failed"], ["ok", undefined]] as const) {
  test(`acceptance timing and summary: ${output}`, async () => {
    const v = await verifyRepo(await gitRepo(), `printf '%s' '${output}'`, env);
    expect(v.acceptance?.passed).toBe(true);
    expect(v.acceptance?.summary).toBe(summary);
    expect(v.acceptance?.durationS).toBeGreaterThanOrEqual(0);
    expect(v.acceptance?.machine).toBeNull();
  });
}

test("timed-out acceptance records the deadline and a hint, preserving output", async () => {
  const v = await verifyRepo(await gitRepo(), "echo started; sleep 5", env, 50);
  expect(v.acceptance).toMatchObject({ passed: false, timedOut: true });
  expect(v.acceptance?.tail).toContain("started");
  expect(v.acceptance?.tail).toContain("acceptance timed out after 0.05 s (acceptance_timeout_min=");
  expect(v.acceptance?.summary).toContain("acceptance timed out after 0.05 s");
  expect(v.acceptance?.hint).toContain("Raise acceptance_timeout_min");
});

test("a genuine exit 137 is not classified as a timeout", async () => {
  const v = await verifyRepo(await gitRepo(), "exit 137", env);
  expect(v.acceptance?.exitCode).toBe(137);
  expect(v.acceptance?.timedOut).toBeUndefined();
  expect(v.acceptance?.tail).toBe("");
  expect(v.acceptance?.summary).toBeUndefined();
});
