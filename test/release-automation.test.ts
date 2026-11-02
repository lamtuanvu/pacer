import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers";

interface Step { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; permissions?: Record<string, string>; env?: Record<string, string>; "timeout-minutes"?: number; steps: Step[] }
interface Workflow { on: Record<string, any>; permissions: Record<string, string>; concurrency?: { group: string }; jobs: Record<string, Job> }
const load = (file: string) => Bun.YAML.parse(readFileSync(resolve(".github/workflows", file), "utf8")) as Workflow;
const prepare = load("release-prepare.yml"), tag = load("release-tag.yml");

test("CI keeps production and test-enabled front doors separate for native dispatch", () => {
  const steps = load("ci.yml").jobs.test!.steps;
  const build = steps.find(step => step.name === "Build production and native dispatch test front doors");
  expect(build).toBeDefined();
  expect(build!.if).toBe("${{ needs.changes.outputs.bun == 'true' }}");
  expect(steps.indexOf(build!)).toBeLessThan(steps.findIndex(step => step.name === "Test"));
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

test("Prepare release is a manual, main-only, token-gated button with one release at a time", () => {
  expect(Object.keys(prepare.on)).toEqual(["workflow_dispatch"]);
  expect(prepare.on.workflow_dispatch.inputs.bump).toMatchObject({ type: "choice", options: ["auto", "patch", "minor", "major"], default: "auto" });
  expect(prepare.permissions).toEqual({});
  expect(prepare.concurrency?.group).toBe("release");
  const job = prepare.jobs.prepare!;
  expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read", actions: "write" });
  expect(job.env?.GH_TOKEN).toBe("${{ secrets.RELEASE_TOKEN }}");
  expect(job.steps.find(s => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
  // The PAT cannot dispatch workflows without the Actions permission; the job token can.
  expect(job.steps.find(s => s.name === "Dry-run the release on the PR branch")?.env?.GH_TOKEN).toBe("${{ github.token }}");
  expect(job["timeout-minutes"]).toBeGreaterThan(240);
  const names = job.steps.map(s => s.name ?? s.uses ?? s.run);
  // Order matters: the dry run must pass before auto-merge is turned on.
  const at = (name: string) => names.findIndex(n => n === name);
  expect(at("Require main and the release token")).toBe(0);
  expect(at("Refresh main to its latest head")).toBeLessThan(at("Resume an interrupted release"));
  expect(at("Find an open release PR")).toBeLessThan(at("Pick the version"));
  expect(at("Dry-run the release on the PR branch")).toBeGreaterThan(at("Prepare, commit and open the release PR"));
  expect(at("Rerun failed or cancelled CI for the existing PR head")).toBeGreaterThan(at("Dry-run the release on the PR branch"));
  expect(at("Turn on auto-merge")).toBeGreaterThan(at("Dry-run the release on the PR branch"));
  const script = job.steps.map(s => s.run ?? "").join("\n");
  expect(script).toContain('bun scripts/release/next-version.ts "$BUMP"');
  expect(script).toContain('bun run release:prepare "$VERSION"');
  expect(script).toContain('git commit -s -m "chore: release $VERSION"');
  expect(script).toContain('--commit "$head" --event pull_request');
  expect(script).not.toContain("gh workflow run release.yml");
  expect(script).toContain("gh run watch \"$run\" --repo \"$GITHUB_REPOSITORY\" --interval 30 --exit-status");
  expect(script).toContain('gh pr merge "$URL" --auto --squash --match-head-commit "$head"');
  expect(job.steps.find(s => s.name === "Report a failed dry run on the PR")?.if).toBe("failure() && steps.dry.outcome == 'failure'");
});

test("Release tag only reacts to release commits on main and pushes with the release token", () => {
  expect(tag.on.push).toEqual({ branches: ["main"] });
  expect(tag.permissions).toEqual({});
  const job = tag.jobs.tag!;
  expect(job.if).toBe("github.event_name == 'workflow_dispatch' || startsWith(github.event.head_commit.message, 'chore: release ')");
  expect(job.env?.GH_TOKEN).toBe("${{ secrets.RELEASE_TOKEN }}");
});

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

function fixture(version: string, subject: string) {
  const root = tmpDir(), origin = join(root, "origin.git"), work = join(root, "work");
  git(root, "init", "--quiet", "--bare", origin);
  git(root, "clone", "--quiet", origin, work);
  writeFileSync(join(work, "package.json"), JSON.stringify({ version }));
  git(work, "add", "package.json"); git(work, "commit", "--quiet", "-m", subject); git(work, "push", "--quiet", "origin", "HEAD");
  const sha = git(work, "rev-parse", "HEAD");
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "pr.json"), JSON.stringify({ state: "MERGED", baseRefName: "main", headRefName: `release/v${version}`, headRefOid: sha, mergeCommit: { oid: sha } }));
  writeFileSync(join(work, "runs.json"), JSON.stringify([{ headSha: sha, status: "completed", conclusion: "success" }]));
  writeFileSync(join(work, "bin", "gh"), '#!/bin/sh\ncase "$1 $2" in\n "pr view") cat pr.json ;;\n "run list") cat runs.json ;;\n *) exit 1 ;;\nesac\n');
  chmodSync(join(work, "bin", "gh"), 0o755);
  return { origin, work, sha };
}
const script = tag.jobs.tag!.steps.find(s => s.name === "Tag the release commit")!.run!;
const runTag = (work: string, sha: string, subject: string, extra: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", "-e", "-c", script], { cwd: work, env: { ...process.env, GH_TOKEN: "test-token", GH_READ_TOKEN: "read-token", SUBJECT: subject, GITHUB_SHA: sha, GITHUB_REPOSITORY: "fixture/repo", PATH: `${join(work, "bin")}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: join(work, "summary"), ...extra }, stdout: "pipe", stderr: "pipe" });

test("Release tag tags a squash-merged release commit and never moves an existing tag", () => {
  const subject = "chore: release 0.5.0 (#220)";
  const { origin, work, sha } = fixture("0.5.0", subject);
  const first = runTag(work, sha, `${subject}\n\n* body`);
  expect(first.stderr.toString()).not.toContain("error");
  expect(first.exitCode).toBe(0);
  expect(git(origin, "rev-parse", "v0.5.0^{commit}")).toBe(sha);
  expect(git(origin, "cat-file", "-p", "v0.5.0")).toContain("pacer 0.5.0");
  const again = runTag(work, sha, subject);
  expect(again.exitCode).toBe(1);
  expect(again.stdout.toString()).toContain("v0.5.0 already exists; tags are never moved");
});

test("Release tag ignores a commit that does not release the package.json version", () => {
  for (const subject of ["chore: release 0.4.9 (#220)", "chore: release 0.5.0 docs", "chore: release 0x5x0"]) {
    const { origin, work, sha } = fixture("0.5.0", subject);
    const result = runTag(work, sha, subject);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("nothing to tag");
    expect(git(origin, "tag", "--list")).toBe("");
  }
});


test("Release tag refuses missing, failed, pending and stale dry runs", () => {
  for (const runs of [[], [{ status: "completed", conclusion: "failure" }], [{ status: "in_progress", conclusion: null }], [{ status: "completed", conclusion: "success", headSha: "0".repeat(40) }], [{ status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }]]) {
    const subject = "chore: release 0.5.0 (#220)";
    const { origin, work, sha } = fixture("0.5.0", subject);
    writeFileSync(join(work, "runs.json"), JSON.stringify(runs.map(run => ({ headSha: sha, ...run }))));
    const result = runTag(work, sha, subject);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("Latest release dry run");
    expect(git(origin, "tag", "--list")).toBe("");
  }
});

for (const mismatch of ["tree", "merge", "base", "branch"]) {
  test(`Release tag refuses an untested release: ${mismatch}`, () => {
    const subject = "chore: release 0.5.0 (#220)";
    const { origin, work, sha } = fixture("0.5.0", subject);
    if (mismatch === "tree") {
      writeFileSync(join(work, "extra"), "untested merge change");
      git(work, "add", "extra"); git(work, "commit", "-qm", "merge change");
    }
    const mergeSha = git(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "pr.json"), JSON.stringify({ state: "MERGED", baseRefName: mismatch === "base" ? "other" : "main", headRefName: mismatch === "branch" ? "other" : "release/v0.5.0", headRefOid: sha, mergeCommit: { oid: mismatch === "merge" ? "0".repeat(40) : mergeSha } }));
    expect(runTag(work, mergeSha, subject).exitCode).not.toBe(0);
    expect(git(origin, "tag", "--list")).toBe("");
  });
}

test("Release verify prebuilds Rust fixtures before the test timeout starts", () => {
  const steps = load("release.yml").jobs.verify!.steps;
  const build = steps.findIndex(s => s.run === "cargo build --locked -p pacer-fixtures --bin pacer-fixture");
  expect(build).toBeGreaterThan(-1);
  expect(build).toBeLessThan(steps.findIndex(s => s.run === "bun run test"));
});

test("Release verify and each M1 build prebuild and supply the SQLite proof binary", () => {
  const release = load("release.yml");
  const proofBuild = "cargo build --locked -p pacer-sqlite-proof --bin pacer-sqlite-proof";
  const proofPath = "${{ github.workspace }}/target/debug/pacer-sqlite-proof";
  for (const [jobName, invocation] of [
    ["verify", "bun run test"],
    ["build", "bun run gate:m1 --release-dir"],
  ]) {
    const steps = release.jobs[jobName]!.steps;
    const build = steps.findIndex(s => s.run === proofBuild);
    const testStep = steps.findIndex(s => s.run?.includes(invocation));
    expect(build).toBeGreaterThan(-1);
    expect(testStep).toBeGreaterThan(build);
    expect(steps[testStep]!.env?.PACER_SQLITE_PROOF_BIN).toBe(proofPath);
  }
});

test("Release verify and each M1 build prebuild and supply the task store probe binary", () => {
  const release = load("release.yml");
  const probeBuild = "cargo build --locked -p pacer-store --bin task_store_probe";
  const probePath = "${{ github.workspace }}/target/debug/task_store_probe";
  for (const [jobName, invocation] of [
    ["verify", "bun run test"],
    ["build", "bun run gate:m1 --release-dir"],
  ]) {
    const steps = release.jobs[jobName]!.steps;
    const build = steps.findIndex(s => s.run === probeBuild);
    const testStep = steps.findIndex(s => s.run?.includes(invocation));
    expect(build).toBeGreaterThan(-1);
    expect(testStep).toBeGreaterThan(build);
    expect(steps[testStep]!.env?.PACER_STORE_PROBE_BIN).toBe(probePath);
  }
});

test("Release tag accepts a squash commit with the tested tree", () => {
  const subject = "chore: release 0.5.0 (#220)";
  const { origin, work, sha } = fixture("0.5.0", subject);
  git(work, "commit", "--allow-empty", "-qm", subject + " squash");
  const mergeSha = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "pr.json"), JSON.stringify({ state: "MERGED", baseRefName: "main", headRefName: "release/v0.5.0", headRefOid: sha, mergeCommit: { oid: mergeSha } }));
  const result = runTag(work, mergeSha, subject);
  expect(result.exitCode).toBe(0);
  expect(git(origin, "rev-parse", "v0.5.0^{commit}")).toBe(mergeSha);
});

test("Release tag fails closed without a PR number or when GitHub reads fail", () => {
  for (const apiFailure of [false, true]) {
    const subject = apiFailure ? "chore: release 0.5.0 (#220)" : "chore: release 0.5.0";
    const { origin, work, sha } = fixture("0.5.0", subject);
    if (apiFailure) writeFileSync(join(work, "bin", "gh"), "#!/bin/sh\nexit 1\n");
    expect(runTag(work, sha, subject).exitCode).not.toBe(0);
    expect(git(origin, "tag", "--list")).toBe("");
  }
});

test("Every release PR head gets a dry run with exact-head checkout", () => {
  const release = load("release.yml");
  expect(release.on.pull_request).toEqual({ branches: ["main"], types: ["opened", "synchronize", "reopened", "ready_for_review"] });
  expect((release as any).env.DRY_RUN).toContain("github.event_name == 'pull_request'");
  expect(release.jobs.verify!.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  for (const job of Object.values(release.jobs)) {
    for (const step of job.steps.filter(s => s.uses?.startsWith("actions/checkout@"))) {
      expect(step.with?.ref).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
    }
  }
});

test("Required test jobs wait for release readiness", () => {
  const ci = load("ci.yml");
  expect((ci.jobs.test as any).needs).toContain("release-readiness");
  expect(ci.jobs.test!.steps.some(s => s.run?.includes('test "$RELEASE_READINESS_RESULT" = success'))).toBe(true);
  expect(ci.jobs["release-readiness"]!.permissions).toEqual({ contents: "read", actions: "read" });
  expect(ci.jobs["release-readiness"]!["timeout-minutes"]).toBeGreaterThan(180);
  expect(ci.jobs["release-readiness"]!.steps[0]!.run).toContain("seq 1 1400");
});

test("Release tag recovery selects a merged PR and validates it before tagging", () => {
  expect(tag.on.workflow_dispatch.inputs.pr.required).toBe(true);
  const steps = tag.jobs.tag!.steps;
  const resolve = steps.findIndex(s => s.name === "Resolve interrupted release");
  const validate = steps.findIndex(s => s.name === "Validate interrupted release");
  expect(resolve).toBeGreaterThan(-1);
  expect(validate).toBeGreaterThan(resolve);
  expect(steps.findIndex(s => s.name === "Tag the release commit")).toBeGreaterThan(validate);
  expect(steps[resolve]!.run).toContain('.state == "MERGED"');
  expect(steps[validate]!.run).toContain("--exit-status");
});

const resolveRecovery = tag.jobs.tag!.steps.find(s => s.name === "Resolve interrupted release")!.run!;
const validateRecovery = tag.jobs.tag!.steps.find(s => s.name === "Validate interrupted release")!.run!;
function recoveryFixture() {
  const f = fixture("0.5.0", "chore: release 0.5.0 (#220)");
  git(f.work, "branch", "-M", "main");
  git(f.work, "push", "--quiet", "origin", "main");
  const pr = JSON.parse(readFileSync(join(f.work, "pr.json"), "utf8"));
  writeFileSync(join(f.work, "pr.json"), JSON.stringify({ ...pr, title: "chore: release 0.5.0", isCrossRepository: false }));
  writeFileSync(join(f.work, "bin", "gh"), `#!/bin/sh
case "$1 $2" in
  "pr view") cat pr.json ;;
  "run list") case "$*" in *--branch*) echo 101 ;; *) echo 100 ;; esac ;;
  "run view") if test -f run-view.json; then cat run-view.json; else printf '{"headSha":"%s","headBranch":"release/recovery-v0.5.0-%s","event":"workflow_dispatch","status":"completed","conclusion":"success"}\n' "$RELEASE_COMMIT" "$(printf '%s' "$RELEASE_COMMIT" | cut -c 1-12)"; fi ;;
  "workflow run") touch dispatched ;;
  "run watch") exit "\${WATCH_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`);
  return f;
}
function recoveryStep(work: string, script: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", "-e", "-c", script], {
    cwd: work,
    env: { ...process.env, PR: "220", GITHUB_REPOSITORY: "fixture/repo", GITHUB_ENV: join(work, "env"),
      PATH: `${join(work, "bin")}:${process.env.PATH}`, GH_TOKEN: "fixture", RELEASE_PUSH_TOKEN: "fixture", ...extra },
    stdout: "pipe", stderr: "pipe",
  });
}
function recoveryEnv(work: string) {
  return Object.fromEntries(readFileSync(join(work, "env"), "utf8").trim().split("\n").map(line => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

test("Recovery restores a deleted branch only at the reviewed head and validates it", () => {
  const { work, origin, sha } = recoveryFixture();
  expect(recoveryStep(work, resolveRecovery).exitCode).toBe(0);
  const result = recoveryStep(work, validateRecovery, recoveryEnv(work));
  expect(result.stderr.toString()).not.toContain("error");
  expect(result.exitCode).toBe(0);
  expect(git(origin, "rev-parse", `refs/heads/release/recovery-v0.5.0-${sha.slice(0, 12)}`)).toBe(sha);
  expect(git(origin, "tag", "--list")).toBe(""); // Validation alone cannot publish.
});

test("Recovery refuses a recovery branch changed after creation without overwriting it", () => {
  const { work, origin } = recoveryFixture();
  expect(recoveryStep(work, resolveRecovery).exitCode).toBe(0);
  git(work, "commit", "--allow-empty", "-qm", "unreviewed branch change");
  const changed = git(work, "rev-parse", "HEAD");
  const branch = `release/recovery-v0.5.0-${recoveryEnv(work).RELEASE_MERGE_COMMIT!.slice(0, 12)}`;
  git(work, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  git(work, "checkout", "--quiet", recoveryEnv(work).RELEASE_MERGE_COMMIT!);
  const result = recoveryStep(work, validateRecovery, recoveryEnv(work));
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toContain("Recovery branch does not point to selected main commit");
  expect(git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(changed);
});

test("Recovery validates the exact merge commit when main changed after the release PR branched", () => {
  const { work, origin, sha: head } = recoveryFixture();
  writeFileSync(join(work, "unrelated-fix"), "merged before release");
  git(work, "add", "unrelated-fix");
  git(work, "commit", "--quiet", "-m", "fix: intervening change");
  git(work, "commit", "--allow-empty", "--quiet", "-m", "chore: release 0.5.0 (#220)");
  const merge = git(work, "rev-parse", "HEAD");
  git(work, "push", "--quiet", "origin", "main");
  const pr = JSON.parse(readFileSync(join(work, "pr.json"), "utf8"));
  writeFileSync(join(work, "pr.json"), JSON.stringify({ ...pr, headRefOid: head, mergeCommit: { oid: merge } }));
  expect(recoveryStep(work, resolveRecovery).exitCode).toBe(0);
  const result = recoveryStep(work, validateRecovery, recoveryEnv(work));
  expect(result.exitCode).toBe(0);
  expect(git(origin, "rev-parse", `refs/heads/release/recovery-v0.5.0-${merge.slice(0, 12)}`)).toBe(merge);
  expect(recoveryEnv(work).RECOVERY_DRY_RUN_ID).toBe("101");
  expect(git(origin, "tag", "--list")).toBe("");
  const tagged = runTag(work, merge, "chore: release 0.5.0 (#220)", { ...recoveryEnv(work), GITHUB_STEP_SUMMARY: join(work, "summary") });
  expect(tagged.exitCode).toBe(0);
  expect(git(origin, "rev-parse", "v0.5.0^{commit}")).toBe(merge);
});

test("Recovery validates and tags a later main commit containing a CI fix", () => {
  const { work, origin, sha: merge } = recoveryFixture();
  writeFileSync(join(work, "gate-fix"), "fixed");
  git(work, "add", "gate-fix");
  git(work, "commit", "--quiet", "-m", "fix: repair release gate");
  const fixed = git(work, "rev-parse", "HEAD");
  git(work, "push", "--quiet", "origin", "main");
  expect(recoveryStep(work, resolveRecovery).exitCode).toBe(0);
  const validated = recoveryStep(work, validateRecovery, recoveryEnv(work));
  expect(validated.exitCode).toBe(0);
  expect(recoveryEnv(work).RELEASE_MERGE_COMMIT).toBe(merge);
  expect(recoveryEnv(work).RELEASE_COMMIT).toBe(fixed);
  expect(git(origin, "rev-parse", `refs/heads/release/recovery-v0.5.0-${fixed.slice(0, 12)}`)).toBe(fixed);
  const tagged = runTag(work, fixed, "chore: release 0.5.0 (#220)", recoveryEnv(work));
  expect(tagged.exitCode).toBe(0);
  expect(git(origin, "rev-parse", "v0.5.0^{commit}")).toBe(fixed);
});

test("Recovery refuses to tag if main advances after its dry run", () => {
  const { work, origin } = recoveryFixture();
  expect(recoveryStep(work, resolveRecovery).exitCode).toBe(0);
  expect(recoveryStep(work, validateRecovery, recoveryEnv(work)).exitCode).toBe(0);
  const validated = recoveryEnv(work);
  git(work, "switch", "--quiet", "main");
  git(work, "commit", "--allow-empty", "--quiet", "-m", "fix: another main change");
  git(work, "push", "--quiet", "origin", "main");
  git(work, "switch", "--detach", "--quiet", validated.RELEASE_COMMIT!);
  const result = runTag(work, validated.RELEASE_COMMIT!, "chore: release 0.5.0 (#220)", validated);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toContain("Main advanced during recovery validation");
  expect(git(origin, "tag", "--list")).toBe("");
});

test("Recovery rejects version changes and newer releases on main", () => {
  for (const change of ["version", "release"]) {
    const { work, origin } = recoveryFixture();
    if (change === "version") {
      writeFileSync(join(work, "package.json"), JSON.stringify({ version: "0.6.0" }));
      git(work, "add", "package.json");
      git(work, "commit", "--quiet", "-m", "fix: bump package version");
    } else {
      git(work, "commit", "--allow-empty", "--quiet", "-m", "chore: release 0.6.0 (#221)");
    }
    git(work, "push", "--quiet", "origin", "main");
    expect(recoveryStep(work, resolveRecovery).exitCode).toBe(0);
    const result = recoveryStep(work, validateRecovery, recoveryEnv(work));
    expect(result.exitCode).not.toBe(0);
    expect(git(origin, "tag", "--list")).toBe("");
    expect(existsSync(join(work, "dispatched"))).toBe(false);
  }
});

test("Recovery refuses a stale or unsuccessful exact-merge validation run", () => {
  for (const change of [{ headSha: "0".repeat(40) }, { conclusion: "failure" }, { headBranch: "main" }]) {
    const { work, origin, sha } = recoveryFixture();
    writeFileSync(join(work, "run-view.json"), JSON.stringify({
      headSha: sha, headBranch: `release/recovery-v0.5.0-${sha.slice(0, 12)}`,
      event: "workflow_dispatch", status: "completed", conclusion: "success", ...change,
    }));
    const result = runTag(work, sha, "chore: release 0.5.0 (#220)", { RECOVERY_DRY_RUN_ID: "101", RELEASE_COMMIT: sha });
    expect(result.exitCode).not.toBe(0);
    expect(git(origin, "tag", "--list")).toBe("");
  }
});

test("Recovery stops when fresh validation fails and leaves tags absent", () => {
  const { work, origin } = recoveryFixture();
  expect(recoveryStep(work, resolveRecovery).exitCode).toBe(0);
  const result = recoveryStep(work, validateRecovery, { ...recoveryEnv(work), WATCH_EXIT: "1" });
  expect(result.exitCode).not.toBe(0);
  expect(git(origin, "tag", "--list")).toBe("");
});

test("Recovery refuses open, cross-repository and incorrectly named PRs", () => {
  for (const change of [{ state: "OPEN" }, { isCrossRepository: true }, { title: "feat: something else" }, { headRefName: "feature/v0.5.0" }]) {
    const { work, origin } = recoveryFixture();
    const pr = JSON.parse(readFileSync(join(work, "pr.json"), "utf8"));
    writeFileSync(join(work, "pr.json"), JSON.stringify({ ...pr, ...change }));
    expect(recoveryStep(work, resolveRecovery).exitCode).not.toBe(0);
    expect(git(origin, "tag", "--list")).toBe("");
  }
});

const readiness = load("ci.yml").jobs["release-readiness"]!.steps[0]!.run!;
test("Release readiness fails on failed validation and succeeds only for a completed successful run", () => {
  for (const conclusion of ["success", "failure", "cancelled", "skipped"]) {
    const { work } = fixture("0.5.0", "release fixture");
    writeFileSync(join(work, "runs.json"), JSON.stringify([{ status: "completed", conclusion, url: "https://example.invalid/run" }]));
    const result = recoveryStep(work, readiness, { EVENT: "pull_request", REPO: "fixture/repo", HEAD_REPO: "fixture/repo", BRANCH: "release/v0.5.0", HEAD: "fixture-head" });
    expect(result.exitCode === 0).toBe(conclusion === "success");
  }
});


test("Recovery tags the original release merge rather than the dispatch main commit", () => {
  const subject = "chore: release 0.5.0 (#220)";
  const { origin, work, sha } = fixture("0.5.0", subject);
  git(work, "commit", "--allow-empty", "-qm", "later main commit");
  const later = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "--quiet", sha);
  expect(runTag(work, later, subject, { RELEASE_COMMIT: sha }).exitCode).toBe(0);
  expect(git(origin, "rev-parse", "v0.5.0^{commit}")).toBe(sha);
});

test("Prepare resumes an unfinished release before choosing another version", () => {
  const steps = prepare.jobs.prepare!.steps;
  const resume = steps.findIndex(s => s.name === "Resume an interrupted release");
  expect(resume).toBeGreaterThan(-1);
  expect(resume).toBeLessThan(steps.findIndex(s => s.name === "Find an open release PR"));
  expect(resume).toBeLessThan(steps.findIndex(s => s.name === "Pick the version"));
  for (const name of ["Pick the version", "Refuse a release that is already in flight", "Prepare, commit and open the release PR"]) {
    expect(steps.find(s => s.name === name)!.if).toBe("steps.existing.outputs.found != 'true' && steps.resume.outputs.resumed != 'true'");
  }
  expect(steps.find(s => s.name === "Find an open release PR")!.if).toBe("steps.resume.outputs.resumed != 'true'");
  for (const name of ["Dry-run the release on the PR branch", "Turn on auto-merge"]) expect(steps.find(s => s.name === name)!.if).toBe("steps.resume.outputs.resumed != 'true'");
});

test("Prepare automatically recovers the unique pending release and propagates failure", () => {
  const script = prepare.jobs.prepare!.steps.find(s => s.name === "Resume an interrupted release")!.run!;
  for (const outcome of ["success", "failure", "ambiguous", "tagged"]) {
    const { work, origin, sha } = recoveryFixture();
    if (outcome === "tagged") git(work, "tag", "v0.5.0");
    writeFileSync(join(work, "candidates.json"), JSON.stringify(Array.from({ length: outcome === "ambiguous" ? 2 : 1 }, (_, i) => ({ number: 220 + i, title: "chore: release 0.5.0", isCrossRepository: false, mergeCommit: { oid: sha } }))));
    writeFileSync(join(work, "bin", "gh"), `#!/bin/sh
case "$1 $2" in
 "pr list") cat candidates.json ;;
 "run list") case "$*" in *--branch*) echo 101 ;; *) echo 100 ;; esac ;;
 "workflow run") printf '%s' "$*" > dispatch ;;
 "run watch") exit "\${WATCH_EXIT:-0}" ;;
 *) exit 1 ;;
esac
`);
    const output = join(work, "output");
    const result = recoveryStep(work, script, { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(work, "summary"), GITHUB_SERVER_URL: "https://example.invalid", WATCH_EXIT: outcome === "failure" ? "1" : "0" });
    expect(result.exitCode === 0).toBe(outcome === "success" || outcome === "tagged");
    if (outcome === "success") {
      expect(readFileSync(output, "utf8")).toContain("resumed=true");
      expect(readFileSync(join(work, "dispatch"), "utf8")).toContain("-f pr=220");
      expect(readFileSync(join(work, "summary"), "utf8")).toContain("/actions/runs/101");
    }
    if (outcome === "tagged") expect(readFileSync(output, "utf8")).toContain("resumed=false");
    expect(git(origin, "tag", "--list")).toBe("");
  }
});

const prepareStep = (name: string) => prepare.jobs.prepare!.steps.find(s => s.name === name)!.run!;
function openReleaseFixture() {
  const f = recoveryFixture();
  git(f.work, "branch", "release/v0.5.0", f.sha);
  git(f.work, "checkout", "--quiet", "release/v0.5.0");
  git(f.work, "commit", "--allow-empty", "-qm", "chore: release 0.5.0");
  const head = git(f.work, "rev-parse", "HEAD");
  git(f.work, "push", "--quiet", "origin", "release/v0.5.0");
  git(f.work, "checkout", "--quiet", "main");
  const candidate = { number: 220, title: "chore: release 0.5.0", headRefName: "release/v0.5.0",
    headRefOid: head, isCrossRepository: false, url: "https://example.invalid/pr/220" };
  writeFileSync(join(f.work, "candidates.json"), JSON.stringify([candidate]));
  writeFileSync(join(f.work, "details.json"), JSON.stringify({ body: "Prepared by the **Prepare release** workflow", mergeable: "MERGEABLE", headRefOid: head }));
  writeFileSync(join(f.work, "bin", "gh"), `#!/bin/sh
case "$1 $2" in
  "pr list") cat candidates.json ;;
  "pr view") cat details.json ;;
  "run list")
    case "$*" in *ci.yml*) state="\${CI_STATE:-failure}"; id=201 ;; *) state="\${DRY_STATE:-success}"; id=101 ;; esac
    case "$state" in queued|in_progress) status="$state"; conclusion=null ;; *) status=completed; conclusion=$(printf '"%s"' "$state") ;; esac
    printf '[{"databaseId":%s,"headSha":"%s","status":"%s","conclusion":%s}]\n' "$id" "$HEAD" "$status" "$conclusion" ;;
  "run rerun") printf '%s\n' "$3" >> reruns ;;
  "run watch") exit "\${WATCH_EXIT:-0}" ;;
  "workflow run") printf '%s\n' "$*" > redispatch ;;
  "pr merge") printf '%s\n' "$*" > merge ;;
  "pr close")
    printf '%s\n' "$*" > closed
    case "$*" in *--delete-branch*) git push --quiet origin --delete release/v0.5.0 ;; esac ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(f.work, "bin", "gh"), 0o755);
  writeFileSync(join(f.work, "bin", "bun"), '#!/bin/sh\nif test -n "${DESIRED_VERSION:-}"; then printf "%s\\n" "$DESIRED_VERSION"; else exit 1; fi\n');
  chmodSync(join(f.work, "bin", "bun"), 0o755);
  return { ...f, sha: head, candidate };
}
function runPrepareStep(work: string, name: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", "-e", "-c", prepareStep(name)], { cwd: work,
    env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}`, BUMP: "auto", GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_SERVER_URL: "https://example.invalid", GITHUB_OUTPUT: join(work, "output"),
      GITHUB_STEP_SUMMARY: join(work, "summary"), GH_TOKEN: "fixture", ...extra }, stdout: "pipe", stderr: "pipe" });
}

test("Prepare finds the unique open release PR before version selection and pins its head", () => {
  const { work, sha } = openReleaseFixture();
  const result = runPrepareStep(work, "Find an open release PR");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = readFileSync(join(work, "output"), "utf8");
  expect(output).toContain("found=true");
  expect(output).toContain(`head=${sha}`);
  expect(output).toContain("version=0.5.0");
  expect(output).toContain("url=https://example.invalid/pr/220");
});

test("Prepare keeps the new-release path when no release PR is open", () => {
  const { work } = openReleaseFixture();
  writeFileSync(join(work, "candidates.json"), "[]");
  expect(runPrepareStep(work, "Find an open release PR").exitCode).toBe(0);
  expect(readFileSync(join(work, "output"), "utf8")).toBe("found=false\n");
});

test("Prepare supersedes a stale release PR when current main selects a newer version", () => {
  const { work, candidate } = openReleaseFixture();
  const result = runPrepareStep(work, "Find an open release PR", { DESIRED_VERSION: "0.6.0" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(join(work, "output"), "utf8")).toBe("found=false\n");
  expect(readFileSync(join(work, "closed"), "utf8")).toContain(candidate.url);
  expect(readFileSync(join(work, "summary"), "utf8")).toContain("current main requires 0.6.0");
});

test("Prepare recreates a conflicted generated release PR at the same version", () => {
  const { work, candidate } = openReleaseFixture();
  writeFileSync(join(work, "details.json"), JSON.stringify({ body: "Prepared by the **Prepare release** workflow", mergeable: "CONFLICTING", headRefOid: candidate.headRefOid }));
  const result = runPrepareStep(work, "Find an open release PR", { DESIRED_VERSION: "0.5.0" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(join(work, "output"), "utf8")).toBe("found=false\n");
  expect(readFileSync(join(work, "closed"), "utf8")).toContain("--delete-branch");
  expect(git(work, "ls-remote", "origin", "refs/heads/release/v0.5.0")).toBe("");
  expect(git(work, "ls-remote", "origin", `refs/heads/release/retired-v0.5.0-${candidate.headRefOid.slice(0, 12)}`)).toContain(candidate.headRefOid);
});

test("Prepare recreates a generated release PR whose validated tree predates main", () => {
  const { work, candidate } = openReleaseFixture();
  git(work, "commit", "--allow-empty", "-qm", "docs: later main change");
  const result = runPrepareStep(work, "Find an open release PR", { DESIRED_VERSION: "0.5.0" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(join(work, "closed"), "utf8")).toContain("--delete-branch");
  expect(git(work, "ls-remote", "origin", `refs/heads/release/retired-v0.5.0-${candidate.headRefOid.slice(0, 12)}`)).toContain(candidate.headRefOid);
});

test("Prepare preserves an edited conflicted release PR", () => {
  const { work, candidate } = openReleaseFixture();
  writeFileSync(join(work, "details.json"), JSON.stringify({ body: "Maintainer edited release", mergeable: "CONFLICTING", headRefOid: candidate.headRefOid }));
  expect(runPrepareStep(work, "Find an open release PR", { DESIRED_VERSION: "0.5.0" }).exitCode).not.toBe(0);
  expect(existsSync(join(work, "closed"))).toBe(false);
});

for (const invalid of ["ambiguous", "foreign", "branch", "head", "version", "tag"]) {
  test(`Prepare refuses ${invalid} open release PRs`, () => {
    const { work, candidate } = openReleaseFixture();
    if (invalid === "tag") git(work, "tag", "v0.5.0");
    const changed = { ...candidate };
    if (invalid === "foreign") changed.isCrossRepository = true;
    if (invalid === "branch") changed.headRefName = "release/v0.4.0";
    if (invalid === "head") changed.headRefOid = "0".repeat(40);
    if (invalid === "version") changed.title = "chore: release 0.6.0";
    writeFileSync(join(work, "candidates.json"), JSON.stringify(invalid === "ambiguous" ? [candidate, candidate] : [changed]));
    expect(runPrepareStep(work, "Find an open release PR").exitCode).not.toBe(0);
    expect(git(work, "tag", "--list")).toBe(invalid === "tag" ? "v0.5.0" : "");
  });
}

for (const state of ["failure", "cancelled", "timed_out", "success", "in_progress"]) {
  test(`Prepare handles ${state} exact-head dry runs and CI before auto-merge`, () => {
    const { work, sha } = openReleaseFixture();
    const env = { HEAD: sha, EXISTING_HEAD: sha, EXISTING_BRANCH: "release/v0.5.0", VERSION: "", DRY_STATE: state, CI_STATE: state };
    const dry = runPrepareStep(work, "Dry-run the release on the PR branch", env);
    expect(dry.exitCode, dry.stderr.toString()).toBe(0);
    expect(runPrepareStep(work, "Rerun failed or cancelled CI for the existing PR head", { ...env, BRANCH: "release/v0.5.0" }).exitCode).toBe(0);
    const reruns = existsSync(join(work, "reruns")) ? readFileSync(join(work, "reruns"), "utf8").trim().split("\n") : [];
    expect(reruns).toEqual(["failure", "cancelled", "timed_out"].includes(state) ? ["101", "201"] : []);
    expect(runPrepareStep(work, "Turn on auto-merge", { ...env, URL: "https://example.invalid/pr/220" }).exitCode).toBe(0);
    expect(readFileSync(join(work, "merge"), "utf8")).toContain(`--match-head-commit ${sha}`);
  });
}

test("Prepare redispatches itself when main advances before auto-merge", () => {
  const { work, sha } = openReleaseFixture();
  git(work, "commit", "--allow-empty", "-qm", "feat: later main change");
  git(work, "push", "--quiet", "origin", "main");
  const result = runPrepareStep(work, "Turn on auto-merge", { EXISTING_HEAD: sha, URL: "https://example.invalid/pr/220", ACTIONS_TOKEN: "fixture" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(existsSync(join(work, "merge"))).toBe(false);
  expect(readFileSync(join(work, "redispatch"), "utf8")).toContain("release-prepare.yml");
});

test("Prepare never enables auto-merge after a failed dry-run watch", () => {
  const { work, sha } = openReleaseFixture();
  const result = runPrepareStep(work, "Dry-run the release on the PR branch", {
    HEAD: sha, EXISTING_HEAD: sha, EXISTING_BRANCH: "release/v0.5.0", VERSION: "", DRY_STATE: "failure", WATCH_EXIT: "1",
  });
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(join(work, "reruns"), "utf8")).toContain("101");
});
