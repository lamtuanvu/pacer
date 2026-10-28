import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionFile } from "../src/session/files";
import { fakeCtx, tmpDir } from "./helpers";
import { writeJsonAtomic } from "../src/fsutil";
import { CoreError } from "../src/core/errors";
import { callOp } from "../src/api/ops";
import { v2Hello } from "../src/api/v2-compat";

const id = "t-20261028-120000-abcd";

function setup(privateStateInside = false, run: Record<string, unknown> = {}) {
  const home = tmpDir();
  const workdir = join(home, "repo");
  const ctx = fakeCtx({ home, pacerHome: join(privateStateInside ? workdir : home, ".pacer") });
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeJsonAtomic(join(ctx.pacerHome, "tasks", `${id}.json`), {
    id, rev: 1, state: "running", createdAt: 1,
    brief: { goal: "edit", repo: workdir }, attempts: [],
    run: { attempt: 2, workdir, dir: join(ctx.pacerHome, "runs", id, "2"), host: null, mode: "current", ...run },
  } as any);
  return { ctx, workdir };
}

function errorCode(action: () => unknown): string {
  try { action(); return "none"; }
  catch (error) { return error instanceof CoreError ? error.code : "wrong_error_type"; }
}

test("resolves a workspace file with its identity and location", () => {
  const { ctx, workdir } = setup();
  writeFileSync(join(workdir, "src", "main.ts"), "export {};\n");
  const root = realpathSync(workdir);
  const info = statSync(join(root, "src", "main.ts"));
  expect(resolveSessionFile(ctx, { id, attempt: 2, reference: "src/main.ts:3:5" })).toEqual({
    root, path: "src/main.ts", absolute: join(root, "src", "main.ts"), dev: info.dev, ino: info.ino, line: 3, column: 5,
  });
});

test("hands off binary and oversized files that the viewer cannot preview", () => {
  const { ctx, workdir } = setup();
  writeFileSync(join(workdir, "image.png"), Buffer.from([0x89, 0x50, 0, 0]));
  writeFileSync(join(workdir, "large.log"), "x".repeat(600_000));
  expect(resolveSessionFile(ctx, { id, attempt: 2, reference: "image.png" }).path).toBe("image.png");
  expect(resolveSessionFile(ctx, { id, attempt: 2, reference: "large.log" }).path).toBe("large.log");
});

test("applies the bounded read's refusals", () => {
  const { ctx, workdir } = setup(true);
  const outside = join(ctx.home, "secret.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(workdir, "src", "outside.txt"));
  symlinkSync(join(workdir, "src"), join(workdir, "linked"));
  writeFileSync(join(workdir, "src", "inner.ts"), "x");
  writeFileSync(join(ctx.pacerHome, "state.txt"), "secret");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 1, reference: "src/inner.ts" }))).toBe("conflict");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "../secret.txt" }))).toBe("not_allowed");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "/etc/hosts" }))).toBe("not_allowed");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "src/outside.txt" }))).toBe("not_allowed");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "linked/inner.ts" }))).toBe("not_allowed");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: ".pacer/state.txt" }))).toBe("not_allowed");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "src" }))).toBe("not_allowed");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "src/gone.ts" }))).toBe("not_found");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "src/inner.ts\n" }))).toBe("invalid_input");
});

test("refuses remote sessions", () => {
  const { ctx, workdir } = setup(false, { host: "build-box" });
  writeFileSync(join(workdir, "a.txt"), "a");
  expect(errorCode(() => resolveSessionFile(ctx, { id, attempt: 2, reference: "a.txt" }))).toBe("not_allowed");
});

test("is a v3-only versioned operation", async () => {
  const { ctx, workdir } = setup();
  writeFileSync(join(workdir, "a.txt"), "a");
  expect(await callOp(ctx, "session.file.resolve", { id, attempt: 2, reference: "a.txt:7" })).toMatchObject({ path: "a.txt", line: 7 });
  await expect(callOp(ctx, "session.file.resolve", { id, attempt: 2, reference: "" })).rejects.toMatchObject({ code: "invalid_input" });
  expect(v2Hello().ops).not.toContain("session.file.resolve");
});
