import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {defaultRun} from "../src/ctx";
import {clearIssueSearchCache} from "../src/core/issue-import";
import {fakeCtx} from "./helpers";

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
const FIXTURES = join(import.meta.dir, "fixtures", "issue-import");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {cwd, stdio: "ignore"});

/** Answers by issue number or search query; every call is logged so both sides must run gh identically. */
function fakeGh(bin: string, log: string) {
  const issue = (n: number, url = `https://github.com/Acme/App/issues/${n}`) =>
    JSON.stringify({number: n, title: `Fix\u0007 \u202Eevil\u202C ${n}\r\n` + "x".repeat(300), body: "line\r\n<!-- hidden -->\n[ref]: https://x\n" + "é".repeat(40_000), labels: [{name: "bug\u0000"}, {name: "\u200B"}], url, state: "CLOSED"});
  const list = JSON.stringify([
    JSON.parse(issue(1)), {number: 2, title: "pr", labels: [], url: "https://github.com/acme/app/pull/2", state: "OPEN"},
    {number: 3, title: "other", labels: [{name: "x"}], url: "https://github.com/other/repo/issues/3", state: "OPEN"},
  ]);
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  "issue view 217 "*) cat '${FIXTURES}/view-217.json' ;;
  "issue view 5 "*) cat <<'EOF'
${issue(5)}
EOF
  ;;
  "issue view 6 "*) cat <<'EOF'
${issue(6, "https://github.com/acme/app/pull/6")}
EOF
  ;;
  "issue view 7 "*) printf '%s\\n' '{"number":"7"}' ;;
  "issue view 8 "*) printf 'not json\\n' ;;
  "issue view 9 "*) head -c 5000000 /dev/zero | tr '\\0' 'x' ;;
  "issue view 10 "*) cat '${FIXTURES}/stderr-not-found.txt' >&2; exit 1 ;;
  "issue view 11 "*) cat '${FIXTURES}/stderr-no-repo.txt' >&2; exit 1 ;;
  "issue view 12 "*) cat '${FIXTURES}/stderr-bad-token.txt' >&2; exit 1 ;;
  "issue view 13 "*) echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4 ;;
  "issue view 14 "*) echo 'HTTP 403: API rate limit exceeded for user ID 1.' >&2; exit 1 ;;
  "issue view 15 "*) printf '\\n  \\n\\033[31merror connecting\\001 to api.github.com\\n' >&2; exit 1 ;;
  "issue view 16 "*) exit 3 ;;
  "issue list "*"--search=delegate "*) cat '${FIXTURES}/list-delegate.json' ;;
  "issue list "*"--search=boom "*) echo 'HTTP 502: bad gateway' >&2; exit 1 ;;
  "issue list "*) cat <<'EOF'
${list}
EOF
  ;;
esac
`;
  mkdirSync(bin, {recursive: true});
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
}

/** A registered GitHub checkout, a registered GitLab checkout and an unregistered GitHub checkout. */
function setup(home: string) {
  const checkout = (name: string, origin: string) => {
    const repo = join(home, name);
    mkdirSync(repo, {recursive: true});
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", origin);
    return realpathSync(repo);
  };
  const app = checkout("app", "git@github.com:Acme/App.git"), web = checkout("web", "https://gitlab.com/acme/web.git");
  checkout("loose", "https://github.com/acme/loose.git");
  mkdirSync(join(home, "state"), {recursive: true});
  writeFileSync(join(home, "state/repos.json"), JSON.stringify({
    [app]: {key: "github.com/acme/app", path: app, lastUsed: 1},
    [web]: {key: "gitlab.com/acme/web", path: web, lastUsed: 2},
  }));
  fakeGh(join(home, "bin"), join(home, "gh.log"));
}

type Step = {op: string; params: unknown; env?: Record<string, string>};

/** TypeScript runs first; the home is rebuilt and the native driver must return the same bodies and gh calls. */
async function compare(steps: Step[], pathEnv = (home: string) => `${home}/bin:/usr/bin:/bin`) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "native-issue-")));
  const log = () => existsSync(join(home, "gh.log")) ? readFileSync(join(home, "gh.log"), "utf8").replaceAll(home, "$HOME") : "";
  const env = (step: Step) => ({PATH: pathEnv(home), ...step.env});
  setup(home);
  clearIssueSearchCache();
  const expected: unknown[] = [];
  for (const step of steps) {
    const stepEnv = env(step);
    const ctx = fakeCtx({pacerHome: home, home, now: NOW, env: stepEnv, run: defaultRun, which: bin => Bun.which(bin, {PATH: stepEnv.PATH})});
    try { expected.push({result: await callOp(ctx, step.op, step.params)}); } catch (error) { expected.push({error: toApiError(error)}); }
  }
  const calls = log();
  rmSync(home, {recursive: true, force: true});
  mkdirSync(home);
  setup(home);
  const input = steps.map(step => JSON.stringify({op: step.op, params: step.params, home, now: NOW, env: env(step)})).join("\n") + "\n";
  const actual = execFileSync(driver(), [], {input, maxBuffer: 64 * 1024 * 1024}).toString().trim().split("\n").map(line => JSON.parse(line));
  const label = JSON.stringify(steps).slice(0, 300);
  expect(JSON.stringify(actual), label).toBe(JSON.stringify(expected));
  expect(log(), `${label}: gh calls`).toBe(calls);
  rmSync(home, {recursive: true, force: true});
}

const imp = (issue: unknown, repo: unknown = "github.com/acme/app"): Step => ({op: "issue.import", params: {repo, issue}});
const search = (params: Record<string, unknown>): Step => ({op: "issue.search", params: {repo: "github.com/acme/app", ...params}});

test("native issue.import matches TypeScript results, errors and gh calls", async () => {
  await compare([imp("217"), imp("#5"), imp(" https://github.com/ACME/app/issues/5/ "), imp("https://www.github.com:443/acme/app/issues/5#x")]);
  await compare(["6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"].map(n => imp(n)));
  await compare([
    imp("https://github.com/other/repo/issues/1"), imp("http://github.com/acme/app/issues/1"), imp("https://u@github.com/acme/app/issues/1"),
    imp("https://github.com:8443/acme/app/issues/1"), imp("https://github.com/acme/app/pull/1"), imp("--web"), imp("0"), imp("2147483648"), imp("12345678901"), imp(""),
    imp("1", "github.com/acme/loose"), imp("1", "gitlab.com/acme/web"), imp("1", ""), imp("1", "x".repeat(513)), imp("x".repeat(2049)),
  ]);
  await compare([
    imp(217), imp("1", 1), {op: "issue.import", params: {repo: "github.com/acme/app", issue: "1", x: 1, y: 2}}, {op: "issue.import", params: null},
    {op: "issue.import", params: []}, {op: "issue.import", params: "x"}, {op: "issue.import", params: {}},
    {...imp("217"), env: {PACER_ROLE: "executor"}}, {...imp(1), env: {PACER_ROLE: "executor"}}, {...imp("217"), env: {PACER_ENFORCEMENT_TOKEN: "t"}},
  ]);
  await compare([imp("217")], home => join(home, "no-bin"));
}, 600_000);

test("native issue.search matches TypeScript filtering, validation and caching", async () => {
  await compare([
    search({query: "delegate"}), search({query: "anything", state: "all", limit: 50}), search({query: "anything", state: "all", limit: 50}),
    search({query: "  multi\nline\u200B --web  ", state: "closed", limit: 1}), search({query: "boom"}), search({query: "boom"}),
  ]);
  await compare([
    search({query: ""}), search({query: " \u200B "}), search({query: "x repo:a/b"}), search({query: "ORG:acme"}), search({query: "label:bug user: x"}),
    search({query: "q", state: "OPEN"}), search({query: "q", limit: 0}), search({query: "q", limit: 51}), search({query: "q", limit: 1.5}),
    search({query: "q", limit: -1}), search({query: "q", limit: 2 ** 53}), search({query: "q", limit: "5"}), search({query: "q", state: 1}),
    search({query: "x".repeat(257)}), search({query: 1, extra: true}), {op: "issue.search", params: {query: "q"}},
    search({query: "q", repo: "gitlab.com/acme/web"}), search({query: "q", repo: "github.com/acme/loose"}), {...search({query: "q", limit: 0}), env: {PACER_ROLE: "executor"}},
  ]);
  await compare([search({query: "delegate"})], home => join(home, "no-bin"));
}, 600_000);

test("registries that only TypeScript reads keep issue ops forwarded", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "native-issue-")));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "state/repos.json"), JSON.stringify({"relative/path": {key: "github.com/a/b", path: "relative/path", lastUsed: 1}}));
  const input = ["issue.import", "issue.search"].map(op => JSON.stringify({op, params: {repo: "github.com/a/b", issue: "1", query: "q"}, home})).join("\n") + "\n";
  const lines = execFileSync(driver(), [], {input}).toString().trim().split("\n");
  expect(lines).toEqual(['{"forwarded":true}', '{"forwarded":true}']);
  rmSync(home, {recursive: true, force: true});
}, 600_000);
