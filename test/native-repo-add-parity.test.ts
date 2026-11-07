import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {fakeCtx, realRun} from "./helpers";

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"]);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}
const NOW = 1_700_000_000.5;
const FILES = ["state/repos.json", "state/repo-paths.json", "project-strategies.json"];
const read = (home: string, file: string) => existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8") : null;
const events = (home: string) => (read(home, "link/outbox.jsonl") ?? "").trim().split("\n").filter(Boolean).map(line => {
  const {envelope} = JSON.parse(line);
  if (envelope.type === "entity" && envelope.data.kind === "activity") { delete envelope.data.id; delete envelope.data.value.id; }
  return envelope;
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {cwd, stdio: "ignore"});

type Step = {op: string; params: unknown; now?: number};
type Setup = (home: string) => void;

/**
 * Runs the steps through TypeScript, then rebuilds the same home and runs them through the
 * native driver: `local:` keys hash the checkout path, so both sides need the same paths.
 * Results (in key order), registry files and outbox events must match byte for byte.
 */
async function compare(steps: Step[], setup: Setup = () => {}) {
  const home = mkdtempSync(join(tmpdir(), "native-ra-"));
  const params = (step: Step) => JSON.parse(JSON.stringify(step.params ?? null).replaceAll("$HOME", home));
  setup(home);
  const expected: unknown[] = [];
  for (const step of steps) {
    const ctx = fakeCtx({pacerHome: home, home, now: step.now ?? NOW, env: {}, run: realRun});
    try { expected.push({result: await callOp(ctx, step.op, params(step))}); } catch (error) { expected.push({error: toApiError(error)}); }
  }
  const files = FILES.map(file => read(home, file)), outbox = events(home);
  rmSync(home, {recursive: true, force: true});
  mkdirSync(home);
  setup(home);
  const input = steps.map(step => JSON.stringify({op: step.op, params: params(step), home, now: step.now ?? NOW})).join("\n") + "\n";
  const actual = execFileSync(driver(), [], {input}).toString().trim().split("\n").map(line => JSON.parse(line));
  const label = JSON.stringify(steps);
  expect(JSON.stringify(actual), label).toBe(JSON.stringify(expected));
  FILES.forEach((file, i) => expect(read(home, file), `${label}: ${file}`).toBe(files[i]));
  expect(events(home), `${label}: events`).toEqual(outbox);
}

const STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\n";
function checkout(home: string, name: string, origin?: string) {
  const repo = join(home, name);
  mkdirSync(repo, {recursive: true});
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  if (origin) git(repo, "remote", "add", "origin", origin);
  return repo;
}
/** An origin checkout with a linked worktree and a subdirectory, a local checkout, a plain folder and a symlink. */
function repos(home: string) {
  writeFileSync(join(home, "strategy.yaml"), STRATEGY);
  const app = checkout(home, "app", "git@GitHub.com:Acme/App.git");
  mkdirSync(join(app, "sub"));
  git(app, "worktree", "add", "-q", join(home, "app-wt"));
  checkout(home, "tool");
  const upstream = checkout(home, "fork");
  git(upstream, "remote", "add", "upstream", "https://github.com/acme/fork.git");
  checkout(home, "mirror", "file:///srv/mirror.git");
  checkout(home, "web", "https://gitlab.com/acme/app.git");
  mkdirSync(join(home, "plain"));
  symlinkSync(join(home, "app"), join(home, "link"));
  mkdirSync(join(home, "unborn"));
  git(join(home, "unborn"), "init", "-q", "-b", "main");
}
/** A registry that already names the local checkout and an unrelated repository. */
function registered(home: string) {
  repos(home);
  mkdirSync(join(home, "state"), {recursive: true});
  const tool = execFileSync("git", ["-C", join(home, "tool"), "rev-parse", "--show-toplevel"]).toString().trim();
  writeFileSync(join(home, "state/repos.json"), JSON.stringify({
    "/srv/other": {key: "github.com/acme/other", path: "/srv/other", lastUsed: 1_699_999_000},
    [tool]: {key: "github.com/acme/tool", path: tool, lastUsed: 1_699_999_500.25},
  }));
  writeFileSync(join(home, "state/repo-paths.json"), JSON.stringify({"/srv/other-wt": "/srv/other"}));
}
const add = (path: string, now?: number): Step => ({op: "repo.add", params: {path}, now});

test("native repo.add matches TypeScript identity, registration files and errors", async () => {
  const cases: [Step[], Setup?][] = [
    [[add("$HOME/app")], repos],
    [[add("$HOME/app-wt/"), add("$HOME/app/sub", NOW + 5)], repos],
    [[add("$HOME/link"), add("$HOME/tool"), add("$HOME/fork"), add("$HOME/mirror"), add("$HOME/web"), add("$HOME/unborn")], repos],
    [[add("$HOME/tool"), add("$HOME/app-wt"), add("$HOME/app", 1_700_000_100)], registered],
    [[add("$HOME/plain"), add("$HOME/missing"), add("relative"), add("$HOME/app/../plain")], repos],
    [[{op: "repo.add", params: {path: "$HOME/app", extra: 1}}, {op: "repo.add", params: {}}, {op: "repo.add", params: null}]],
    [[{op: "repo.add", params: {path: 1}}, {op: "repo.add", params: {path: ""}}, {op: "repo.add", params: {path: "/".repeat(4097)}}, {op: "repo.add", params: "x"}, {op: "repo.add", params: []}]],
  ];
  for (const [steps, setup] of cases) await compare(steps, setup);
}, 600_000);

test("native project.strategy resolves absolute checkout paths like TypeScript", async () => {
  const get = (repo: string): Step => ({op: "project.strategy.get", params: {repo}});
  const cases: [Step[], Setup?][] = [
    [[get("$HOME/app/sub"), get("$HOME/app-wt"), get("$HOME/tool"), get("$HOME/plain"), get("$HOME/missing/x"), {op: "repo.list", params: {}}], repos],
    [[get("$HOME/tool"), get("$HOME/link")], registered],
    [[{op: "project.strategy.set", params: {repo: "$HOME/app-wt", executors: ["codex"], expect_rev: 0}}, get("$HOME/app"), {op: "project.strategy.list", params: {}}], repos],
    [[{op: "project.strategy.set", params: {repo: "$HOME/plain", executors: ["codex"], expect_rev: 0}}, {op: "project.strategy.set", params: {repo: "$HOME/tool", executors: ["unknown"], expect_rev: 0}}], repos],
    [[{op: "project.strategy.set", params: {repo: "$HOME/tool", executors: ["cursor"], expect_rev: 0}}, {op: "project.strategy.remove", params: {repo: "$HOME/tool", expect_rev: 1}}, {op: "project.strategy.remove", params: {repo: "$HOME/plain", expect_rev: 0}}], registered],
  ];
  for (const [steps, setup] of cases) await compare(steps, setup);
}, 600_000);
