import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NIGHTLY_STAMP_FILES } from "../scripts/release/nightly";
import { GATE_JOBS, LINUX_SHARD_PREFIX, MACOS_JOB, MACOS_STEP, SUITE_STEP } from "../scripts/release/ci-evidence";
import { tmpDir } from "./helpers";

interface Step { name?: string; id?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { needs?: string | string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] }
interface Workflow { on: Record<string, any>; permissions: Record<string, string>; concurrency?: { group: string; "cancel-in-progress": boolean }; jobs: Record<string, Job> }

const text = readFileSync(resolve(".github/workflows/nightly.yml"), "utf8");
const workflow = Bun.YAML.parse(text) as Workflow;
const nightly = workflow.jobs.nightly!;
const stepNamed = (name: string) => {
  const found = nightly.steps.find(s => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
};
const NIGHTLY = "0.16.0-nightly.202611171700";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/**
 * A clone of a bare origin whose main holds a minimal stampable tree (stubbed app:build), the stable
 * tag v0.15.1 and the real release scripts linked in. `bin` is first on PATH for fake tools.
 */
function fixture() {
  const root = tmpDir(), origin = join(root, "origin.git"), work = join(root, "work");
  git(root, "init", "-q", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "switch", "-q", "-c", "main");
  const desktop = join(work, "desktop", "src-tauri");
  mkdirSync(desktop, { recursive: true });
  mkdirSync(join(work, "tools"));
  mkdirSync(join(work, "app"), { recursive: true });
  mkdirSync(join(work, "bin"));
  writeFileSync(join(desktop, "Cargo.toml"), '[package]\nname = "pacer-desktop"\nversion = "0.15.1"\n');
  writeFileSync(join(desktop, "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "pacer-desktop"\nversion = "0.15.1"\n');
  writeFileSync(join(desktop, "tauri.conf.json"), '{\n  "version": "0.15.1"\n}\n');
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "fixture", version: "0.15.1", scripts: { "app:build": "bun tools/app.ts" } }, null, 2)}\n`);
  writeFileSync(join(work, "tools", "app.ts"), 'const { version } = await Bun.file("package.json").json();\nawait Bun.write("app/assets.generated.json", `${JSON.stringify({ version, files: [] }, null, 2)}\\n`);\n');
  writeFileSync(join(work, "app", "assets.generated.json"), `${JSON.stringify({ version: "0.15.1", files: [] }, null, 2)}\n`);
  writeFileSync(join(work, "CHANGELOG.md"), "# Changelog\n\n## [0.15.1]\n\n- Old.\n");
  symlinkSync(resolve("scripts"), join(work, "scripts"));
  appendFileSync(join(work, ".git", "info", "exclude"), "scripts\nbin\noutput\nsummary\nenv\ngh.log\n");
  git(work, "add", "-A"); git(work, "commit", "-qm", "chore: initial"); git(work, "tag", "-a", "v0.15.1", "-m", "pacer 0.15.1");
  git(work, "push", "-q", "origin", "HEAD:main", "refs/tags/v0.15.1");
  git(work, "fetch", "-q", "origin");
  return { origin, work, sha: git(work, "rev-parse", "HEAD") };
}

/** Commit on main and push it, as a merge to main would. */
function advanceMain(work: string, subject: string): string {
  git(work, "switch", "-q", "main");
  writeFileSync(join(work, `${subject.replace(/\W/g, "-")}.txt`), subject);
  git(work, "add", "-A"); git(work, "commit", "-qm", subject); git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "fetch", "-q", "origin");
  return git(work, "rev-parse", "HEAD");
}

/** A nightly stamp commit on `parent`, tagged and pushed the way nightly.yml does it. */
function pushedNightly(work: string, parent: string, version: string) {
  git(work, "switch", "-q", "--detach", parent);
  writeFileSync(join(work, "package.json"), readFileSync(join(work, "package.json"), "utf8").replace(/"version": "[^"]+"/, `"version": "${version}"`));
  git(work, "commit", "-qam", `chore: nightly ${version}`);
  git(work, "tag", "-a", `v${version}`, "-m", `pacer ${version}`);
  git(work, "push", "-q", "origin", `refs/tags/v${version}`);
  git(work, "switch", "-q", "main");
}

function runStep(work: string, script: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", "-e", "-c", script], { cwd: work,
    env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}`, SHA: "", GITHUB_REPOSITORY: "fixture/repo", GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SERVER_URL: "https://github.example", GITHUB_RUN_ID: "42", GITHUB_REF: "refs/heads/main",
      GITHUB_OUTPUT: join(work, "output"), GITHUB_STEP_SUMMARY: join(work, "summary"), GITHUB_ENV: join(work, "env"), GH_TOKEN: "fixture",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", ...extra },
    stdout: "pipe", stderr: "pipe" });
}
const outputs = (work: string): Record<string, string> => {
  let content = "";
  try { content = readFileSync(join(work, "output"), "utf8"); } catch { return {}; }
  return Object.fromEntries(content.trim().split("\n").filter(Boolean).map(line => line.split("=", 2) as [string, string]));
};

test("the schedule is held back until phase 7; manual dispatch takes a main commit and a dry run", () => {
  // Maintainer decision: no automatic nightlies until the first manual nightly succeeds.
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(text).toContain("  # Enabled in phase 7 after the first manual nightly succeeds\n  # schedule:\n");
  expect(text).toMatch(/^ {2}# {3}- cron: '0 17 \* \* \*'/m);
  expect(text).toMatch(/^ {2}# {3}- cron: '0 18 \* \* 0'/m);
  expect(workflow.on.workflow_dispatch.inputs.sha).toMatchObject({ type: "string", default: "" });
  expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: "boolean", default: false });
  // The prune-only weekly cron must not build.
  expect(nightly.if).toBe("github.event.schedule != '0 18 * * 0'");
});

test("one nightly at a time, least privilege, and the release token only where a tag is pushed", () => {
  expect(workflow.concurrency).toEqual({ group: "nightly", "cancel-in-progress": false });
  expect(workflow.permissions).toEqual({});
  // actions: write lets the CI gate dispatch CI on main when the selected commit has no full-suite evidence.
  expect(nightly.permissions).toEqual({ contents: "read", actions: "write", issues: "write" });
  expect(nightly.env?.GH_TOKEN).toBeUndefined();
  const push = stepNamed("Tag and push");
  expect(push.env?.GH_TOKEN).toBe("${{ secrets.RELEASE_TOKEN }}");
  expect(push.if).toBe("steps.skip.outputs.skip != 'true' && !inputs.dry_run");
  expect(stepNamed("Report failure").if).toBe("failure() && !inputs.dry_run");
  expect(stepNamed("Report failure").env?.GH_TOKEN).toBe("${{ github.token }}");
  const gate = stepNamed("Require CI's Linux and macOS test gates for the commit");
  expect(gate.run).toBe("bun scripts/release/ci-evidence.ts");
  expect(gate.env).toEqual({ GH_TOKEN: "${{ github.token }}", CI_SHA: "${{ steps.select.outputs.target }}", CI_REF: "main", CI_EVIDENCE_MINUTES: "90" });
  const names = nightly.steps.map(s => s.name ?? s.uses ?? s.run);
  const order = ["Require main and the release token", "Select the main commit", "Skip unchanged", "Require CI's Linux and macOS test gates for the commit", "Pick the nightly version", "Commit as the token's owner", "Stamp the nightly version", "Tag and push", "Report failure"];
  expect(order.map(name => names.indexOf(name))).toEqual([...order.map(name => names.indexOf(name))].sort((a, b) => a - b));
  expect(order.every(name => names.includes(name))).toBe(true);
  // After a skip, nothing else runs.
  for (const name of order.slice(3, 8)) expect(stepNamed(name).if ?? "").toContain("steps.skip.outputs.skip != 'true'");
  const checkout = nightly.steps.find(s => s.uses?.startsWith("actions/checkout@"))!;
  expect(checkout.with).toMatchObject({ "fetch-depth": 0, "fetch-tags": true, "persist-credentials": false });
});

// Amendment 0.24.0 (proposed): release.yml no longer re-runs the CI gate; nightly.yml
// already required CI's full suite for the commit it stamps, before tagging.
test("the nightly release path re-checks nothing in release.yml", () => {
  const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  expect(release).not.toContain("ci-suite");
  expect(release).not.toContain("ci-evidence");
  expect(release).not.toContain("gate:m1");
  expect(stepNamed("Require CI's Linux and macOS test gates for the commit").run).toBe("bun scripts/release/ci-evidence.ts");
});

test("every nightly action is SHA-pinned and checkout does not persist credentials", () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const action of job.steps.filter(s => s.uses)) {
      expect(action.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
      if (action.uses?.startsWith("actions/checkout@")) expect(action.with?.["persist-credentials"]).toBe(false);
    }
  }
  const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  for (const action of new Set(text.match(/uses: \S+/g))) expect(release).toContain(action);
});

test("Nightly runs only from main and needs the release token unless it is a dry run", () => {
  const { work } = fixture();
  const script = stepNamed("Require main and the release token").run!;
  expect(runStep(work, script, { RELEASE_TOKEN: "t", DRY_RUN: "false" }).exitCode).toBe(0);
  expect(runStep(work, script, { RELEASE_TOKEN: "", DRY_RUN: "true" }).exitCode).toBe(0);
  expect(runStep(work, script, { RELEASE_TOKEN: "", DRY_RUN: "false" }).exitCode).not.toBe(0);
  expect(runStep(work, script, { RELEASE_TOKEN: "t", DRY_RUN: "false", GITHUB_REF: "refs/heads/feature" }).exitCode).not.toBe(0);
});

test("Select pins main's head or a chosen main commit and refuses anything else", () => {
  const { work, sha } = fixture();
  const script = stepNamed("Select the main commit").run!;
  expect(runStep(work, script).exitCode).toBe(0);
  expect(outputs(work).target).toBe(sha);
  const head = advanceMain(work, "feat: later");
  writeFileSync(join(work, "output"), "");
  expect(runStep(work, script, { SHA: sha }).exitCode).toBe(0);
  expect(outputs(work).target).toBe(sha);
  writeFileSync(join(work, "output"), "");
  expect(runStep(work, script).exitCode).toBe(0);
  expect(outputs(work).target).toBe(head);
  git(work, "switch", "-q", "--detach", sha);
  writeFileSync(join(work, "side.txt"), "x"); git(work, "add", "-A"); git(work, "commit", "-qm", "fix: side");
  const off = runStep(work, script, { SHA: git(work, "rev-parse", "HEAD") });
  expect(off.exitCode).not.toBe(0);
  expect(off.stdout.toString()).toContain("is not on main");
});

test("Skip unchanged skips a scheduled run on the last nightly's parent, never a manual run", () => {
  const { work, sha } = fixture();
  const script = stepNamed("Skip unchanged").run!;
  // No nightly yet: build.
  expect(runStep(work, script, { TARGET: sha, GITHUB_EVENT_NAME: "schedule" }).exitCode).toBe(0);
  expect(outputs(work).skip).toBeUndefined();
  pushedNightly(work, sha, NIGHTLY);
  const unchanged = runStep(work, script, { TARGET: sha, GITHUB_EVENT_NAME: "schedule" });
  expect(unchanged.exitCode).toBe(0);
  expect(outputs(work).skip).toBe("true");
  expect(unchanged.stdout.toString()).toContain("::notice::");
  writeFileSync(join(work, "output"), "");
  expect(runStep(work, script, { TARGET: sha, GITHUB_EVENT_NAME: "workflow_dispatch" }).exitCode).toBe(0);
  expect(outputs(work).skip).toBeUndefined();
  const next = advanceMain(work, "feat: next");
  expect(runStep(work, script, { TARGET: next, GITHUB_EVENT_NAME: "schedule" }).exitCode).toBe(0);
  expect(outputs(work).skip).toBeUndefined();
  // Only the newest nightly counts.
  pushedNightly(work, next, "0.16.0-nightly.202611181700");
  expect(runStep(work, script, { TARGET: sha, GITHUB_EVENT_NAME: "schedule" }).exitCode).toBe(0);
  expect(outputs(work).skip).toBeUndefined();
});

/**
 * A fake gh for ci-evidence.ts: main's head is `head`, and the only CI run on `sha` is a completed push run
 * whose suite step was skipped (a docs-only or focused push). `workflow run` is logged, then fails so the
 * gate stops instead of polling for the dispatched run.
 */
function fakeCiGh(work: string, sha: string, head: string) {
  const log = join(work, "gh.log"), dir = join(work, "bin");
  const jobs = [
    ...GATE_JOBS.map(name => ({ name, conclusion: "success", steps: [] })),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ name: `${LINUX_SHARD_PREFIX}${i})`, conclusion: "success", steps: [{ name: SUITE_STEP, conclusion: "skipped" }] })),
    { name: MACOS_JOB, conclusion: "success", steps: [{ name: MACOS_STEP, conclusion: "skipped" }] },
  ];
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: [{ id: 5, event: "push", status: "completed", conclusion: "success", created_at: new Date(0).toISOString(), html_url: "run/5" }] }));
  writeFileSync(join(dir, "jobs.json"), JSON.stringify([{ jobs }]));
  writeFileSync(join(dir, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  "api repos/fixture/repo/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100") cat "${dir}/runs.json" ;;
  "api --paginate --slurp repos/fixture/repo/actions/runs/5/jobs?filter=latest&per_page=100") cat "${dir}/jobs.json" ;;
  "api repos/fixture/repo/commits/main --jq .sha") echo ${head} ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  return log;
}

test("the CI gate dispatches CI on main when main's head has no full-suite run, and fails if main moved", () => {
  const { work, sha } = fixture();
  const gate = stepNamed("Require CI's Linux and macOS test gates for the commit");
  // The step's literal env as written, with the selected commit for CI_SHA.
  const env = { ...Object.fromEntries(Object.entries(gate.env!).filter(([, value]) => !value.includes("${{"))), CI_SHA: sha };
  // main still points at the commit: one dispatch of CI on main (the fake gh then stops the gate).
  let log = fakeCiGh(work, sha, sha);
  const dispatched = runStep(work, gate.run!, env);
  expect(dispatched.stdout.toString()).toContain(`No usable CI run for ${sha}; dispatching CI on main`);
  expect(readFileSync(log, "utf8").trim().split("\n").at(-1)).toBe("workflow run ci.yml --repo fixture/repo --ref main");
  // main moved since the commit was selected: no dispatch, and a message that names both commits.
  writeFileSync(log, "");
  const moved = "b".repeat(40);
  log = fakeCiGh(work, sha, moved);
  const refused = runStep(work, gate.run!, env);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain(`main now points at ${moved}, not ${sha}`);
  expect(readFileSync(log, "utf8")).not.toContain("workflow run");
});

test("Pick the nightly version refuses a version that is already tagged on origin", () => {
  const { work, sha } = fixture();
  const script = stepNamed("Pick the nightly version").run!;
  const picked = runStep(work, script);
  expect(picked.exitCode).toBe(0);
  expect(outputs(work).version).toMatch(/^0\.16\.0-nightly\.[1-9]\d{11}$/);
  // A fake bun pins the version so the tag can exist already.
  writeFileSync(join(work, "bin", "bun"), `#!/bin/sh\nif test "$1 $2" = "scripts/release/nightly.ts version"; then echo ${NIGHTLY}; exit 0; fi\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  pushedNightly(work, sha, NIGHTLY);
  const taken = runStep(work, script);
  expect(taken.exitCode).not.toBe(0);
  expect(taken.stdout.toString()).toContain("already tagged");
});

test("Stamp reinstalls the selected commit's dependencies before app:build runs", () => {
  const lines = stepNamed("Stamp the nightly version").run!.split("\n").map(line => line.trim());
  const at = (line: string) => lines.indexOf(line);
  expect(at("bun install --frozen-lockfile")).toBeGreaterThan(at('git switch --quiet --detach "$TARGET"'));
  expect(at("bun install --frozen-lockfile")).toBeLessThan(at('bun scripts/release/nightly.ts stamp "$VERSION"'));
});

test("Stamp commits only the version files on the selected commit, signed off, and leaves main alone", () => {
  const { origin, work, sha } = fixture();
  const head = advanceMain(work, "feat: newer");
  const result = runStep(work, stepNamed("Stamp the nightly version").run!, { TARGET: sha, VERSION: NIGHTLY });
  expect(result.stderr.toString()).not.toContain("nightly:");
  expect(result.exitCode).toBe(0);
  expect(git(work, "rev-parse", "HEAD^")).toBe(sha);
  expect(git(work, "log", "-1", "--format=%B")).toContain(`chore: nightly ${NIGHTLY}`);
  expect(git(work, "log", "-1", "--format=%B")).toContain("Signed-off-by: Fixture <fixture@example.invalid>");
  const changed = git(work, "diff", "--name-only", "HEAD^", "HEAD").split("\n").sort();
  expect(changed).toEqual([...NIGHTLY_STAMP_FILES].sort());
  expect(JSON.parse(git(work, "show", "HEAD:package.json")).version).toBe(NIGHTLY);
  expect(git(work, "ls-remote", origin, "refs/heads/main").split(/\s/)[0]).toBe(head);
});

test("Tag and push pushes only the annotated nightly tag", () => {
  const { origin, work, sha } = fixture();
  expect(runStep(work, stepNamed("Stamp the nightly version").run!, { TARGET: sha, VERSION: NIGHTLY }).exitCode).toBe(0);
  const stampCommit = git(work, "rev-parse", "HEAD");
  const pushed = runStep(work, stepNamed("Tag and push").run!, { VERSION: NIGHTLY });
  expect(pushed.stderr.toString()).not.toContain("error");
  expect(pushed.exitCode).toBe(0);
  expect(git(work, "ls-remote", origin, `refs/tags/v${NIGHTLY}^{}`).split(/\s/)[0]).toBe(stampCommit);
  expect(git(work, "cat-file", "-t", `v${NIGHTLY}`)).toBe("tag");
  expect(git(work, "ls-remote", origin, "refs/heads/main").split(/\s/)[0]).toBe(sha);
  expect(git(work, "ls-remote", "--heads", origin).split("\n")).toHaveLength(1);
});

test("Report failure comments on the open nightly-failure issue or opens one", () => {
  const { work } = fixture();
  const log = join(work, "gh.log");
  const fakeGh = (open: string) => writeFileSync(join(work, "bin", "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif test "$1 $2" = "issue list"; then printf '${open}'; fi\n`, { mode: 0o755 });
  const script = stepNamed("Report failure").run!;
  const url = "https://github.example/fixture/repo/actions/runs/42";
  fakeGh("12\\n");
  expect(runStep(work, script).exitCode).toBe(0);
  let calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls[0]).toContain("issue list --repo fixture/repo --label nightly-failure --state open");
  expect(calls[1]).toBe(`issue comment 12 --repo fixture/repo --body Nightly failed again: ${url}`);
  expect(calls).toHaveLength(2);
  writeFileSync(log, "");
  fakeGh("");
  expect(runStep(work, script).exitCode).toBe(0);
  calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls[1]).toStartWith("label create nightly-failure --repo fixture/repo");
  expect(calls[2]).toStartWith("issue create --repo fixture/repo --title Nightly build failed --label nightly-failure --body ");
  expect(calls[2]).toContain(url);
});

test("prune runs after a successful or skipped nightly, never for a dry run, and keeps 14 days and the newest 3", () => {
  const prune = workflow.jobs.prune!;
  expect(prune.needs).toBe("nightly");
  expect(prune.if).toBe("!cancelled() && needs.nightly.result != 'failure' && !inputs.dry_run");
  expect(prune.permissions).toEqual({ contents: "write" });
  const step = prune.steps.find(s => s.name === "Delete old nightly releases")!;
  expect(step.run).toBe("bun scripts/release/nightly.ts prune --keep-days 14 --keep-min 3");
  expect(step.env?.GH_TOKEN).toBe("${{ github.token }}");
});
