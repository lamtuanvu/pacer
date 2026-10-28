import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionFile } from "../src/session/files";
import { fakeCtx, tmpDir } from "./helpers";
import { writeJsonAtomic } from "../src/fsutil";
import { CoreError } from "../src/core/errors";
import { callOp } from "../src/api/ops";

const id = "t-20261027-120000-abcd";

function setup(privateStateInside = false) {
  const home = tmpDir();
  const workdir = join(home, "repo");
  const ctx = fakeCtx({ home, pacerHome: join(privateStateInside ? workdir : home, ".pacer") });
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeJsonAtomic(join(ctx.pacerHome, "tasks", `${id}.json`), {
    id, rev: 1, state: "running", createdAt: 1,
    brief: { goal: "view", repo: workdir }, attempts: [],
    run: { attempt: 2, workdir, dir: join(ctx.pacerHome, "runs", id, "2"), host: null, mode: "current" },
  } as any);
  return { ctx, workdir };
}

function errorCode(action: () => unknown): string {
  try { action(); return "none"; }
  catch (error) { return error instanceof CoreError ? error.code : "wrong_error_type"; }
}

test("reads a relative file from the matching local attempt", () => {
  const { ctx, workdir } = setup();
  writeFileSync(join(workdir, "src", "main.ts"), "const answer = 42;\n");
  expect(readSessionFile(ctx, { id, attempt: 2, reference: "src/main.ts:1:7" })).toMatchObject({
    path: "src/main.ts", kind: "code", text: "const answer = 42;\n", line: 1, column: 7,
  });
});

test("refuses a stale attempt and a path outside the workspace", () => {
  const { ctx } = setup();
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 1, reference: "src/main.ts" }))).toBe("conflict");
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "../secret.txt" }))).toBe("not_allowed");
});

test("refuses a symlink to outside and Pacer private state", () => {
  const { ctx, workdir } = setup(true);
  const outside = join(ctx.home, "secret.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(workdir, "src", "outside.txt"));
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "src/outside.txt" }))).toBe("not_allowed");
  writeFileSync(join(ctx.pacerHome, "state.txt"), "secret");
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: ".pacer/state.txt" }))).toBe("not_allowed");
  if (existsSync(join(workdir, ".PACER")))
    expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: ".PACER/state.txt" }))).toBe("not_allowed");
});

test("refuses binary and oversized files", () => {
  const { ctx, workdir } = setup();
  writeFileSync(join(workdir, "binary.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(workdir, "large.txt"), "x".repeat(600_000));
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "binary.bin" }))).toBe("invalid_input");
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "large.txt" }))).toBe("too_large");
});

test("reports a missing file separately from a denied target", () => {
  const { ctx } = setup();
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "src/gone.ts" }))).toBe("not_found");
});

test("session API exposes attempt identity and reads through a versioned operation", async () => {
  const { ctx, workdir } = setup();
  writeFileSync(join(workdir, "README.md"), "# Hello\n");
  const dir = join(ctx.pacerHome, "runs", id, "2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.ckpt"), "{}");
  expect(await callOp(ctx, "task.session", { id })).toMatchObject({ attempt: 2 });
  expect(await callOp(ctx, "session.file.read", { id, attempt: 2, reference: "README.md" }))
    .toMatchObject({ kind: "markdown", text: "# Hello\n" });
  await expect(callOp(ctx, "session.file.read", { id, attempt: 1, reference: "README.md" })).rejects.toMatchObject({ code: "conflict" });
});

test("reads files in a pacer task worktree but still refuses the rest of private state", () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  const workdir = join(ctx.pacerHome, "worktrees", "repo-0123abcd", id);
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "src", "main.ts"), "export {};\n");
  writeJsonAtomic(join(ctx.pacerHome, "tasks", `${id}.json`), {
    id, rev: 1, state: "running", createdAt: 1,
    brief: { goal: "view", repo: workdir }, attempts: [],
    run: { attempt: 2, workdir, dir: join(ctx.pacerHome, "runs", id, "2"), host: null, mode: "worktree" },
  } as any);
  expect(readSessionFile(ctx, { id, attempt: 2, reference: "src/main.ts" })).toMatchObject({ path: "src/main.ts", text: "export {};\n" });
  symlinkSync(join(ctx.pacerHome, "tasks", `${id}.json`), join(workdir, "task.json"));
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "task.json" }))).toBe("not_allowed");
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "../../../tasks/" + id + ".json" }))).toBe("not_allowed");
});

test("refuses a session whose workspace is the worktrees directory or private state itself", () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  for (const workdir of [ctx.pacerHome, join(ctx.pacerHome, "worktrees")]) {
    mkdirSync(join(ctx.pacerHome, "worktrees"), { recursive: true });
    writeFileSync(join(ctx.pacerHome, "state.txt"), "secret");
    writeFileSync(join(ctx.pacerHome, "worktrees", "state.txt"), "secret");
    writeJsonAtomic(join(ctx.pacerHome, "tasks", `${id}.json`), {
      id, rev: 1, state: "running", createdAt: 1,
      brief: { goal: "view", repo: workdir }, attempts: [],
      run: { attempt: 2, workdir, dir: join(ctx.pacerHome, "runs", id, "2"), host: null, mode: "current" },
    } as any);
    expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "state.txt" }))).toBe("not_allowed");
  }
});

function worktreeSession(ctx: ReturnType<typeof fakeCtx>, workdir: string) {
  writeJsonAtomic(join(ctx.pacerHome, "tasks", `${id}.json`), {
    id, rev: 1, state: "running", createdAt: 1,
    brief: { goal: "view", repo: workdir }, attempts: [],
    run: { attempt: 2, workdir, dir: join(ctx.pacerHome, "runs", id, "2"), host: null, mode: "current" },
  } as any);
}

test("a per-repo worktrees directory cannot read sibling task worktrees", () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  const repoDir = join(ctx.pacerHome, "worktrees", "repo-0123abcd");
  mkdirSync(join(repoDir, "t-20261027-120000-ffff"), { recursive: true });
  writeFileSync(join(repoDir, "t-20261027-120000-ffff", "secret.txt"), "secret");
  worktreeSession(ctx, repoDir);
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "t-20261027-120000-ffff/secret.txt" }))).toBe("not_allowed");
});

test("a retried task reads the earlier task's worktree, and a sub directory workdir cannot read above itself", () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  const top = join(ctx.pacerHome, "worktrees", "repo-0123abcd", "t-20261026-090000-0aa0");
  mkdirSync(join(top, "pkg", "src"), { recursive: true });
  writeFileSync(join(top, "root.txt"), "top");
  writeFileSync(join(top, "pkg", "src", "a.ts"), "a");
  worktreeSession(ctx, top);
  expect(readSessionFile(ctx, { id, attempt: 2, reference: "root.txt" }).text).toBe("top");
  worktreeSession(ctx, join(top, "pkg"));
  expect(readSessionFile(ctx, { id, attempt: 2, reference: "src/a.ts" }).text).toBe("a");
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "../root.txt" }))).toBe("not_allowed");
});

test("a symlinked worktrees directory never widens the exemption", () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(join(ctx.pacerHome, "runs", "repo-0123abcd", id), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "runs", "repo-0123abcd", id, "log.txt"), "secret");
  symlinkSync(join(ctx.pacerHome, "runs"), join(ctx.pacerHome, "worktrees"));
  worktreeSession(ctx, join(ctx.pacerHome, "worktrees", "repo-0123abcd", id));
  expect(errorCode(() => readSessionFile(ctx, { id, attempt: 2, reference: "log.txt" }))).toBe("not_allowed");
});
