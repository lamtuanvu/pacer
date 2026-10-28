import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { assertCallerCanInvoke } from "../src/api/caller-policy";
import { V3_ONLY_OPS } from "../src/api/v2-compat";
import { clearFilesSearchCache, matchPath, safeRepoPath, searchFiles, FILES_SEARCH_LIMITS } from "../src/core/files-search";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import type { RunFn } from "../src/types";

beforeEach(() => clearFilesSearchCache());

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
function repoWith(files: Record<string, string>, ignored: Record<string, string> = {}): string {
  const repo = realpathSync(gitRepo());
  for (const [path, text] of Object.entries({ ...files, ...ignored })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
  git(repo, "add", "--", ...Object.keys(files));
  git(repo, "commit", "-q", "-m", "files");
  return repo;
}
function setup(repos: Record<string, string>, run: RunFn = realRun) {
  const ctx = fakeCtx({ run });
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  const registry = Object.fromEntries(Object.entries(repos).map(([key, path], i) => [path, { key, path, lastUsed: 100 - i }]));
  writeFileSync(join(ctx.pacerHome, "state", "repos.json"), JSON.stringify(registry));
  return ctx;
}
function runningTask(ctx: ReturnType<typeof fakeCtx>, record: Record<string, unknown>) {
  const path = join(ctx.pacerHome, "state", "tasks.db"), fresh = !existsSync(path);
  const db = new Database(path);
  if (fresh) db.run("CREATE TABLE tasks (id TEXT, state TEXT, record TEXT)");
  db.query("INSERT INTO tasks VALUES (?, 'running', ?)").run(String(record.id), JSON.stringify({ state: "running", attempts: [], ...record }));
  db.close();
}

test("basename matches rank above path matches and fuzzy matches, with ranges", async () => {
  const repo = repoWith({ "src/remote/access.ts": "x", "src/access/index.ts": "", "src/a/c/c/e/s/s.ts": "", "docs/readme.md": "" });
  const ctx = setup({ "github.com/acme/app": repo });
  const r = await searchFiles(ctx, { query: "access" });
  expect(r.query).toBe("access");
  expect(r.results.map(x => x.path)).toEqual(["src/remote/access.ts", "src/access/index.ts", "src/a/c/c/e/s/s.ts"]);
  expect(r.results[0]).toMatchObject({ repo: "github.com/acme/app", repoLabel: "acme/app", ranges: [[11, 17]], size: 1 });
  expect(r.results[1].ranges).toEqual([[4, 10]]);
  expect(r.results[2].ranges).toEqual([[4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15]]);
  expect(r.truncated).toBe(false);
  expect(r.repos).toEqual([{ key: "github.com/acme/app", state: "ok" }]);
});

test("matching is case-insensitive and ignores whitespace for the fuzzy tier", () => {
  expect(matchPath("src/Remote/Access.ts", "ACCESS")).toEqual({ tier: 0, ranges: [[11, 17]] });
  expect(matchPath("src/remote/access.ts", "rem acc")).toMatchObject({ tier: 2 });
  expect(matchPath("src/remote/access.ts", "zzz")).toBeNull();
});

test("only tracked files are listed: .gitignore, untracked files and .git are excluded", async () => {
  const repo = repoWith({ ".gitignore": "secret.env\nbuild/\n", "app.ts": "" }, { "secret.env": "k", "build/app.js": "" });
  writeFileSync(join(repo, "untracked-app.ts"), "");
  const ctx = setup({ "local:abc": repo });
  const paths = (await searchFiles(ctx, { query: "a" })).results.map(x => x.path);
  expect(paths).toContain("app.ts");
  expect(paths.some(p => p.includes("secret") || p.startsWith("build/") || p.startsWith(".git/") || p.includes("untracked"))).toBe(false);
});

test("the repo filter limits the search and an unknown key is invalid input", async () => {
  const a = repoWith({ "one.ts": "" }), b = repoWith({ "one.ts": "", "two.ts": "" });
  const ctx = setup({ "github.com/acme/a": a, "github.com/acme/b": b });
  expect((await searchFiles(ctx, { query: "one" })).results.map(x => x.repo).sort()).toEqual(["github.com/acme/a", "github.com/acme/b"]);
  const only = await searchFiles(ctx, { query: "one", repo: "github.com/acme/b" });
  expect(only.results.map(x => x.repo)).toEqual(["github.com/acme/b"]);
  expect(only.repos.map(x => x.key)).toEqual(["github.com/acme/b"]);
  await expect(searchFiles(ctx, { query: "one", repo: "github.com/acme/none" })).rejects.toMatchObject({ code: "invalid_input" });
});

test("results are capped by limit and report truncation", async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, ""]));
  const ctx = setup({ "local:many": repoWith(files) });
  const def = await searchFiles(ctx, { query: "f" });
  expect(def.results).toHaveLength(FILES_SEARCH_LIMITS.defaultLimit);
  expect(def.truncated).toBe(true);
  const max = await searchFiles(ctx, { query: "f", limit: 50 });
  expect(max.results).toHaveLength(50);
  expect((await searchFiles(ctx, { query: "f00" })).truncated).toBe(false);
});

test("query and limit bounds are enforced through the operation", async () => {
  const ctx = setup({ "local:x": repoWith({ "a.ts": "" }) });
  for (const params of [{ query: "" }, { query: "   " }, { query: "x".repeat(201) }, { query: "a", limit: 0 }, { query: "a", limit: 51 }, { query: "a", bogus: 1 }, {}])
    await expect(callOp(ctx, "files.search", params)).rejects.toMatchObject({ code: "invalid_input" });
  expect(await callOp(ctx, "files.search", { query: " a " })).toMatchObject({ query: "a", results: [{ path: "a.ts" }] });
});

test("executors are refused by the caller policy and by the core", async () => {
  const ctx = setup({ "local:x": repoWith({ "a.ts": "" }) });
  const executor = { ...ctx, env: { PACER_ROLE: "executor" } };
  expect(() => assertCallerCanInvoke(executor, "files.search", { query: "a" })).toThrow(expect.objectContaining({ code: "not_allowed" }));
  await expect(searchFiles(executor, { query: "a" })).rejects.toMatchObject({ code: "not_allowed" });
  await expect(searchFiles({ ...ctx, env: { PACER_WORK_GRANT: "pwg_x" } }, { query: "a" })).rejects.toMatchObject({ code: "not_allowed" });
  expect(() => assertCallerCanInvoke(ctx, "files.search", { query: "a" })).not.toThrow();
});

test("the operation is protocol 3 only", () => {
  expect(V3_ONLY_OPS.has("files.search")).toBe(true);
});

test("unsafe paths from git are dropped and the query never reaches a subprocess", async () => {
  const root = realpathSync(gitRepo()), calls: string[][] = [];
  const run: RunFn = async argv => {
    calls.push(argv);
    return { code: 0, stdout: ["../etc/passwd", "/abs/passwd", ".git/config", "a/./passwd", "a//passwd", "ok/passwd.txt", ""].join("\0"), stderr: "" };
  };
  const ctx = setup({ "local:x": root }, run);
  const r = await searchFiles(ctx, { query: "passwd" });
  expect(r.results.map(x => x.path)).toEqual(["ok/passwd.txt"]);
  expect(calls.flat().some(a => a.includes("passwd"))).toBe(false);
  expect(calls[0]).toEqual(["git", "-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z", "--cached"]);
  expect(safeRepoPath("a\\b")).toBe(false);
  expect(safeRepoPath("src/a.ts")).toBe(true);
});

test("timeouts, failures and oversized listings are reported per repository", async () => {
  const slow = realpathSync(gitRepo()), broken = realpathSync(gitRepo()), big = realpathSync(gitRepo());
  const many = Array.from({ length: FILES_SEARCH_LIMITS.listPaths + 5 }, (_, i) => `d/f${i}.ts`).join("\0") + "\0";
  const run: RunFn = async argv => argv.includes(slow) ? { code: 124, stdout: "", stderr: "", timedOut: true }
    : argv.includes(broken) ? { code: 128, stdout: "", stderr: "fatal" } : { code: 0, stdout: many, stderr: "" };
  const ctx = setup({ "local:slow": slow, "local:broken": broken, "local:big": big }, run);
  const r = await searchFiles(ctx, { query: "f1.ts" });
  expect(Object.fromEntries(r.repos.map(x => [x.key, x.state]))).toEqual({ "local:slow": "timeout", "local:broken": "error", "local:big": "too_large" });
  expect(r.results[0]).toMatchObject({ repo: "local:big", path: "d/f1.ts" });
});

test("listings are cached briefly so keystrokes do not respawn git", async () => {
  const repo = repoWith({ "a.ts": "" });
  let lists = 0;
  const run: RunFn = (argv, ms, o) => { if (argv.includes("ls-files")) lists++; return realRun(argv, ms, o); };
  const ctx = setup({ "local:x": repo }, run);
  await searchFiles(ctx, { query: "a" }); await searchFiles(ctx, { query: "a." });
  expect(lists).toBe(1);
});

test("files changed by a running local task are annotated and ranked first in their tier", async () => {
  const repo = repoWith({ "src/remote/access.ts": "a", "src/remote/accessor.ts": "b", "src/acc.ts": "" });
  const base = git(repo, "rev-parse", "HEAD").stdout.toString().trim();
  const worktree = join(realpathSync(dirname(repo)), `wt-${Date.now()}`);
  git(repo, "worktree", "add", "-q", "-b", "task", worktree);
  writeFileSync(join(worktree, "src/remote/accessor.ts"), "changed");
  const ctx = setup({ "github.com/econ-v1/node": repo });
  runningTask(ctx, { id: "t-20261028-100000-aaaa", title: "Harden access", repo: { key: "github.com/econ-v1/node", path: repo, label: "econ-v1/node" }, brief: { repo }, baseSha: base, run: { mode: "new", workdir: worktree } });
  runningTask(ctx, { id: "t-20261028-100000-bbbb", repo: { key: "github.com/econ-v1/node", path: repo, label: "econ-v1/node" }, brief: { repo }, run: { mode: "new", workdir: "/nowhere", host: "box" } });
  const r = await searchFiles(ctx, { query: "access" });
  expect(r.results.map(x => x.path)).toEqual(["src/remote/accessor.ts", "src/remote/access.ts"]);
  expect(r.results[0].changedBy).toEqual([{ task: "t-20261028-100000-aaaa", title: "Harden access" }]);
  expect(r.results[1].changedBy).toBeUndefined();
});

test("a search writes nothing to the registry or the state directory", async () => {
  const repo = repoWith({ "a.ts": "" });
  const ctx = setup({ "local:x": repo, "local:gone": join(dirname(repo), "missing-repo") });
  const file = join(ctx.pacerHome, "state", "repos.json"), before = readFileSync(file, "utf8"), mtime = statSync(file).mtimeMs;
  const r = await searchFiles(ctx, { query: "a" });
  expect(r.results.map(x => x.path)).toEqual(["a.ts"]);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect(existsSync(join(ctx.pacerHome, "state", "tasks.db"))).toBe(false);
});
