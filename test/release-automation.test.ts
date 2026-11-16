import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers";

interface Step { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; permissions?: Record<string, string>; env?: Record<string, string>; "timeout-minutes"?: number; steps: Step[] }
interface Workflow { on: Record<string, any>; permissions: Record<string, string>; concurrency?: { group: string }; jobs: Record<string, Job> }
const load = (file: string) => Bun.YAML.parse(readFileSync(resolve(".github/workflows", file), "utf8")) as Workflow;
const prepare = load("release-prepare.yml");
const readiness = load("ci.yml").jobs["release-readiness"]!.steps[0]!.run!;

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

/** A clone of a bare origin whose main holds one commit at `version`, with fake `gh` and `bun` on PATH. */
function fixture(version: string, subject: string) {
  const root = tmpDir(), origin = join(root, "origin.git"), work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, work);
  git(work, "switch", "--quiet", "-c", "main");
  writeFileSync(join(work, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(work, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-11-16\n\n- Fixture.\n`);
  git(work, "add", "-A"); git(work, "commit", "--quiet", "-m", subject); git(work, "push", "--quiet", "origin", "HEAD:main");
  const sha = git(work, "rev-parse", "HEAD");
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "bin", "gh"), '#!/bin/sh\ncase "$1 $2" in\n "run list") cat runs.json ;;\n *) exit 1 ;;\nesac\n');
  writeFileSync(join(work, "bin", "bun"), '#!/bin/sh\ncat next-version.txt\n');
  for (const tool of ["gh", "bun"]) chmodSync(join(work, "bin", tool), 0o755);
  writeFileSync(join(work, "runs.json"), "[]");
  return { origin, work, sha };
}

const prepareStep = (name: string) => prepare.jobs.prepare!.steps.find(s => s.name === name)!.run!;
function runStep(work: string, script: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", "-e", "-c", script], { cwd: work,
    env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}`, BUMP: "auto", COMMIT: "", GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_OUTPUT: join(work, "output"), GITHUB_STEP_SUMMARY: join(work, "summary"), GITHUB_ENV: join(work, "env"), GH_TOKEN: "fixture",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", ...extra },
    stdout: "pipe", stderr: "pipe" });
}
const outputs = (work: string) => Object.fromEntries(readFileSync(join(work, "output"), "utf8").trim().split("\n").map(line => line.split("=", 2) as [string, string]));

test("CI keeps production and test-enabled front doors separate for native dispatch", () => {
  const steps = load("ci.yml").jobs.test!.steps;
  const build = steps.find(step => step.name === "Build production and native dispatch test front doors");
  expect(build).toBeDefined();
  expect(build!.if).toBe("${{ env.RUN_CHECKS == 'true' && needs.changes.outputs.full == 'true' }}");
  expect(steps.indexOf(build!)).toBeLessThan(steps.findIndex(step => step.name === "Test (full suite, sharded)"));
  const lines = build!.run!.trim().split("\n").map(line => line.trim());
  expect(lines.filter(line => line.startsWith("cargo build --locked -p pacer"))).toEqual([
    "cargo build --locked -p pacer",
    "cargo build --locked -p pacer --features test-ops",
  ]);
  expect(lines.indexOf('cp target/debug/pacer "$RUNNER_TEMP/pacer-production"')).toBe(lines.indexOf("cargo build --locked -p pacer") + 1);
  expect(lines.indexOf('cp target/debug/pacer "$RUNNER_TEMP/pacer-native-test"')).toBe(lines.indexOf("cargo build --locked -p pacer --features test-ops") + 1);
  expect(lines).toContain('echo "PACER_TEST_FRONT_DOOR=$RUNNER_TEMP/pacer-production" >> "$GITHUB_ENV"');
  expect(lines).toContain('echo "PACER_TEST_NATIVE_FRONT_DOOR=$RUNNER_TEMP/pacer-native-test" >> "$GITHUB_ENV"');
  expect(lines.some(line => line.includes('outfile: join(process.env.RUNNER_TEMP!, "pacer-core")'))).toBe(true);
  expect(lines).toContain('echo "PACER_TEST_REFERENCE_CORE=$RUNNER_TEMP/pacer-core" >> "$GITHUB_ENV"');
});

test("Each CI test shard prebuilds and supplies the SQLite proof binary", () => {
  const steps = load("ci.yml").jobs.test!.steps;
  const build = steps.findIndex(s => s.run === "cargo build --locked -p pacer-sqlite-proof --bin pacer-sqlite-proof");
  const gate = steps.findIndex(s => s.name === "Test (full suite, sharded)");
  expect(build).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(build);
  expect(steps[gate]!.env?.PACER_SQLITE_PROOF_BIN).toBe("${{ github.workspace }}/target/debug/pacer-sqlite-proof");
});

test("Each CI test shard prebuilds and supplies the task store probe binary", () => {
  const steps = load("ci.yml").jobs.test!.steps;
  const build = steps.findIndex(s => s.run === "cargo build --locked -p pacer-store --bin task_store_probe");
  const gate = steps.findIndex(s => s.name === "Test (full suite, sharded)");
  expect(build).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(build);
  expect(steps[gate]!.env?.PACER_STORE_PROBE_BIN).toBe("${{ github.workspace }}/target/debug/task_store_probe");
});

test("Releases build from tags only; release branches get no pull-request dry run", () => {
  const release = load("release.yml");
  expect(Object.keys(release.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(release.on.push).toEqual({ tags: ["v*.*.*"] });
});

test("Required test jobs wait for release readiness", () => {
  const ci = load("ci.yml");
  expect((ci.jobs.test as any).needs).toContain("release-readiness");
  expect(ci.jobs.test!.steps.some(s => s.run?.includes('test "$RELEASE_READINESS_RESULT" = success'))).toBe(true);
  expect(ci.jobs["release-readiness"]!.permissions).toEqual({ contents: "read", actions: "read" });
  expect(ci.jobs["release-readiness"]!["timeout-minutes"]).toBeGreaterThan(180);
  expect(ci.jobs["release-readiness"]!.steps[0]!.run).toContain("seq 1 1400");
});

test("Release readiness never blocks a bookkeeping release/v* PR, even with a failed or missing dry run", () => {
  for (const conclusion of ["success", "failure", "cancelled"]) {
    const { work } = fixture("0.5.0", "chore: release 0.5.0");
    writeFileSync(join(work, "runs.json"), JSON.stringify([{ status: "completed", conclusion, url: "https://example.invalid/run" }]));
    const result = runStep(work, readiness, { EVENT: "pull_request", REPO: "fixture/repo", HEAD_REPO: "fixture/repo", BRANCH: "release/v0.5.0", HEAD: "fixture-head" });
    expect(result.exitCode).toBe(0);
  }
});

test("Prepare release is a manual, main-only, token-gated button that pins one commit and tags it", () => {
  expect(Object.keys(prepare.on)).toEqual(["workflow_dispatch"]);
  expect(prepare.on.workflow_dispatch.inputs.bump).toMatchObject({ type: "choice", options: ["auto", "patch", "minor", "major"], default: "auto" });
  expect(prepare.on.workflow_dispatch.inputs.commit).toMatchObject({ type: "string", default: "" });
  expect(prepare.permissions).toEqual({});
  expect(prepare.concurrency?.group).toBe("release");
  const job = prepare.jobs.prepare!;
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.env?.GH_TOKEN).toBe("${{ secrets.RELEASE_TOKEN }}");
  expect(job.steps.find(s => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
  const names = job.steps.map(s => s.name ?? s.uses ?? s.run);
  const at = (name: string) => names.findIndex(n => n === name);
  expect(at("Require main and the release token")).toBe(0);
  // The commit is pinned before anything reads the version, and the tag is pushed before main is touched.
  expect(at("Pin the commit to release")).toBeLessThan(at("Pick the version"));
  expect(at("Pick the version")).toBeLessThan(at("Commit the version bump on the pinned commit"));
  expect(at("Commit the version bump on the pinned commit")).toBeLessThan(at("Tag and push"));
  expect(at("Tag and push")).toBeLessThan(at("Open the bookkeeping PR that brings the bump to main"));
  const script = job.steps.map(s => s.run ?? "").join("\n");
  expect(script).toContain('bun run release:prepare "$VERSION"');
  expect(script).toContain('git commit -s -m "chore: release $VERSION"');
  expect(script).toContain('push origin "refs/tags/v$VERSION"');
  // No step waits for a release PR, a dry run or main before tagging.
  expect(script).not.toContain("gh run watch");
  expect(script).not.toContain("release-tag.yml");
  expect(existsSync(resolve(".github/workflows/release-tag.yml"))).toBe(false);
});

test("Prepare pins main's head when the run starts, or a chosen main commit, and refuses others", () => {
  const { origin, work, sha } = fixture("0.15.0", "chore: release 0.15.0");
  expect(runStep(work, prepareStep("Pin the commit to release")).exitCode).toBe(0);
  expect(outputs(work).target).toBe(sha);
  // Someone else merges to main after the run pinned its target; the pinned checkout is unaffected.
  const other = join(tmpDir(), "other");
  git(work, "clone", "--quiet", origin, other);
  writeFileSync(join(other, "later"), "x"); git(other, "add", "later"); git(other, "commit", "--quiet", "-m", "fix: later"); git(other, "push", "--quiet", "origin", "HEAD:main");
  expect(git(work, "rev-parse", "HEAD")).toBe(sha);
  writeFileSync(join(work, "output"), "");
  expect(runStep(work, prepareStep("Pin the commit to release"), { COMMIT: sha }).exitCode).toBe(0);
  expect(outputs(work).target).toBe(sha);
  git(work, "switch", "--quiet", "-c", "side", sha);
  writeFileSync(join(work, "side"), "x"); git(work, "add", "side"); git(work, "commit", "--quiet", "-m", "fix: side");
  const off = runStep(work, prepareStep("Pin the commit to release"), { COMMIT: git(work, "rev-parse", "HEAD") });
  expect(off.exitCode).not.toBe(0);
  expect(off.stdout.toString()).toContain("is not on main");
});

test("Prepare releases an untagged package.json version as is and bumps a tagged one", () => {
  const { work, sha } = fixture("0.15.0", "chore: release 0.15.0");
  expect(runStep(work, prepareStep("Pick the version")).exitCode).toBe(0);
  expect(outputs(work)).toMatchObject({ version: "0.15.0", bumped: "false" });
  git(work, "tag", "-a", "v0.15.0", sha, "-m", "pacer 0.15.0"); git(work, "push", "--quiet", "origin", "refs/tags/v0.15.0");
  writeFileSync(join(work, "next-version.txt"), "0.16.0\n"); writeFileSync(join(work, "output"), "");
  expect(runStep(work, prepareStep("Pick the version")).exitCode).toBe(0);
  expect(outputs(work)).toMatchObject({ version: "0.16.0", bumped: "true" });
  // A version that is already tagged anywhere on origin is never released again.
  writeFileSync(join(work, "next-version.txt"), "0.15.0\n");
  expect(runStep(work, prepareStep("Pick the version")).exitCode).not.toBe(0);
});

test("Prepare tags the pinned commit and pushes only the tag, leaving main alone", () => {
  const { origin, work, sha } = fixture("0.15.0", "chore: release 0.15.0");
  expect(runStep(work, prepareStep("Tag and push"), { VERSION: "0.15.0" }).exitCode).toBe(0);
  expect(git(work, "ls-remote", origin, "refs/tags/v0.15.0^{}").split(/\s/)[0]).toBe(sha);
  expect(git(work, "ls-remote", origin, "refs/heads/main").split(/\s/)[0]).toBe(sha);
  expect(outputs(work).release).toBe(sha);
  // The tag must match package.json and carry release notes.
  const { work: other } = fixture("0.15.0", "chore: release 0.15.0");
  expect(runStep(other, prepareStep("Tag and push"), { VERSION: "0.16.0" }).exitCode).not.toBe(0);
  writeFileSync(join(other, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
  expect(runStep(other, prepareStep("Tag and push"), { VERSION: "0.15.0" }).exitCode).not.toBe(0);
});

test("Prepare refuses to compute a version below a newer release whose bump hasn't reached main", () => {
  const { origin, work, sha } = fixture("0.15.0", "chore: release 0.15.0");
  git(work, "tag", "-a", "v0.15.0", sha, "-m", "pacer 0.15.0");
  // 0.15.1 was released from a later commit; its bookkeeping PR is still open, so main says 0.15.0.
  const other = join(tmpDir(), "other");
  git(work, "clone", "--quiet", origin, other);
  writeFileSync(join(other, "package.json"), JSON.stringify({ version: "0.15.1" })); git(other, "commit", "--quiet", "-am", "chore: release 0.15.1");
  git(other, "tag", "-a", "v0.15.1", "-m", "pacer 0.15.1"); git(other, "push", "--quiet", "origin", "refs/tags/v0.15.1");
  git(work, "fetch", "--quiet", "origin", "--tags");
  writeFileSync(join(work, "next-version.txt"), "0.16.0\n");
  const refused = runStep(work, prepareStep("Pick the version"));
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stdout.toString()).toContain("v0.15.1 is newer than this commit's v0.15.0");
  // An untagged version that would sort below the newest release is refused too.
  const { work: below } = fixture("0.15.0", "chore: release 0.15.0");
  git(below, "fetch", "--quiet", origin, "refs/tags/v0.15.1:refs/tags/v0.15.1");
  expect(runStep(below, prepareStep("Pick the version")).stdout.toString()).toContain("would sort below the newest release v0.15.1");
});

