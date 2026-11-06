import { Database } from "bun:sqlite";
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/errors";
import { clearFilesSearchCache } from "../src/core/files-search";
import { defaultRun } from "../src/ctx";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";

const ROOT = join(import.meta.dir, "..");
let probe = "";
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpDir() };

beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--bin", "files_search_probe", "--locked"], { cwd: ROOT });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: ROOT }).toString());
  probe = join(metadata.target_directory, "debug", "files_search_probe");
}, 600_000);
beforeEach(() => clearFilesSearchCache());

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
function repoWith(files: Record<string, string>, ignored: Record<string, string> = {}): string {
  const repo = realpathSync(gitRepo());
  for (const [path, text] of Object.entries({ ...files, ...ignored })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
  git(repo, "add", "--", ...Object.keys(files));
  git(repo, "commit", "-q", "-m", "files");
  return repo;
}
function home(repos: Record<string, string>) {
  const pacerHome = tmpDir();
  mkdirSync(join(pacerHome, "state"), { recursive: true });
  const registry = Object.fromEntries(Object.entries(repos).map(([key, path], i) => [path, { key, path, lastUsed: 100 - i }]));
  writeFileSync(join(pacerHome, "state", "repos.json"), JSON.stringify(registry));
  return pacerHome;
}
function runningTask(pacerHome: string, record: Record<string, unknown>) {
  const db = new Database(join(pacerHome, "state", "tasks.db"));
  db.run("CREATE TABLE IF NOT EXISTS tasks (id TEXT, state TEXT, record TEXT)");
  db.query("INSERT INTO tasks VALUES (?, 'running', ?)").run(String(record.id), JSON.stringify({ state: "running", attempts: [], ...record }));
  db.close();
}

async function typescript(pacerHome: string, params: unknown) {
  const ctx = fakeCtx({ home: pacerHome, pacerHome, env, run: defaultRun });
  try { return { result: await callOp(ctx, "files.search", params as Record<string, unknown>) }; }
  catch (error) {
    const { code, message, hint } = toApiError(error);
    return { error: { code, message, ...(hint ? { hint } : {}) } };
  }
}
function rust(pacerHome: string, params: unknown) {
  return JSON.parse(execFileSync(probe, [pacerHome, JSON.stringify(params)], { env }).toString());
}
async function same(pacerHome: string, params: unknown) {
  const ts = await typescript(pacerHome, params);
  expect(JSON.stringify(rust(pacerHome, params))).toBe(JSON.stringify(ts));
  return ts;
}

test("ranking, ranges, sizes and key order match TypeScript", async () => {
  const repo = repoWith({ "src/remote/access.ts": "x", "src/access/index.ts": "", "src/a/c/c/e/s/s.ts": "", "docs/readme.md": "", "b.ts": "12", "a/b.ts": "" });
  const pacerHome = home({ "github.com/acme/app": repo });
  const ts = await same(pacerHome, { query: "access" });
  expect((ts as any).result.results).toHaveLength(3);
  for (const query of [" ACC ", "r e a", "ts", "b.ts", "zzz", "/"]) await same(pacerHome, { query });
  await same(pacerHome, { query: "s", limit: 2 });
});

// Both runtimes learn that a path is missing only after an earlier read probes it, and the probe
// process starts cold, so a missing repository is compared on its first search only.
test("a missing repository reads as an error on the first search in both runtimes", async () => {
  const a = repoWith({ "one.ts": "" });
  const pacerHome = home({ "local:a": a, "local:gone": join(dirname(a), `missing-${Date.now()}`) });
  const ts = await same(pacerHome, { query: "one" });
  expect((ts as any).result.repos).toEqual([{ key: "local:a", state: "ok" }, { key: "local:gone", state: "error" }]);
});

test("labels, repo filter and ignored files match TypeScript", async () => {
  const a = repoWith({ "one.ts": "", ".gitignore": "secret.env\n" }, { "secret.env": "k" }), b = repoWith({ "one.ts": "", "two.ts": "" });
  const pacerHome = home({ "github.com/acme/app": a, "gitlab.com/acme/app": b });
  await same(pacerHome, { query: "one" });
  await same(pacerHome, { query: "e" });
  await same(pacerHome, { query: "one", repo: "gitlab.com/acme/app" });
  await same(pacerHome, { query: "one", repo: "github.com/acme/none" });
});

test("non-ASCII paths, case folding and UTF-16 ranges match TypeScript", async () => {
  const repo = repoWith({ "Ünï/Straße.ts": "ß", "ΟΔΟΣ.md": "", "emoji/😀/face.ts": "", "\uFF61x.ts": "", "😀x.ts": "", "İstanbul.txt": "" });
  const pacerHome = home({ "local:u": repo });
  for (const query of ["straße", "ünï", "οδος", "ΟΔΟΣ", "face", "x.ts", "😀", "istanbul", "i̇stan", "ü s"]) await same(pacerHome, { query });
});

test("running-task annotations and ordering match TypeScript", async () => {
  const repo = repoWith({ "src/remote/access.ts": "a", "src/remote/accessor.ts": "b", "src/acc.ts": "", "src/shared.ts": "" });
  const base = git(repo, "rev-parse", "HEAD").stdout.toString().trim();
  const worktree = join(realpathSync(dirname(repo)), `wt-${Date.now()}`);
  git(repo, "worktree", "add", "-q", "-b", "task", worktree);
  writeFileSync(join(worktree, "src/remote/accessor.ts"), "changed");
  writeFileSync(join(worktree, "src/shared.ts"), "changed");
  writeFileSync(join(repo, "src/shared.ts"), "in place");
  git(repo, "commit", "-qam", "in place");
  const pacerHome = home({ "github.com/econ-v1/node": repo });
  const ref = { key: "github.com/econ-v1/node", path: repo, label: "econ-v1/node" };
  runningTask(pacerHome, { id: "t-20261028-100000-aaaa", title: "Harden access", repo: ref, brief: { repo }, baseSha: base, run: { mode: "new", workdir: worktree } });
  runningTask(pacerHome, { id: "t-20261028-100000-bbbb", repo: ref, brief: { repo }, run: { mode: "new", workdir: "/nowhere", host: "box" } });
  runningTask(pacerHome, { id: "t-20261028-100000-cccc", title: "", repo: ref, brief: { repo }, startSha: base, run: { mode: "current", workdir: repo } });
  runningTask(pacerHome, { id: "t-20261028-100000-dddd", repo: { key: "other" }, brief: { repo }, run: { mode: "new", workdir: worktree } });
  await same(pacerHome, { query: "access" });
  await same(pacerHome, { query: "src" });
});

test("validation, blank queries and unknown keys match TypeScript errors", async () => {
  const pacerHome = home({ "local:x": repoWith({ "a.ts": "" }) });
  for (const params of [
    {}, null, [], "s", 5, { query: "" }, { query: "   " }, { query: "\uFEFF\u3000" }, { query: "x".repeat(201) }, { query: ` ${"x".repeat(200)}` },
    { query: "a", limit: 0 }, { query: "a", limit: 51 }, { query: "a", limit: 1.5 }, { query: "a", limit: "3" }, { query: "a", limit: 1e20 }, { query: "a", limit: -1e20 },
    { query: "a", limit: null }, { query: "a", bogus: 1 }, { z: 1, query: 1, repo: 3, limit: 0, y: 2 }, { query: [] }, { query: Array(201).fill(1) },
    { query: { length: 0 } }, { query: "a", repo: "" }, { query: "a", repo: "x".repeat(513) }, { query: "a", repo: null }, { 'a"b': 1, query: "a" },
    { query: "a", limit: 50 }, { query: "\u0085a" },
  ]) await same(pacerHome, params);
});
