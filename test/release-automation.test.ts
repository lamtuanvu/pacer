import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers";

interface Step { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] }
interface Workflow { on: Record<string, any>; permissions: Record<string, string>; concurrency?: { group: string }; jobs: Record<string, Job> }
const load = (file: string) => Bun.YAML.parse(readFileSync(resolve(".github/workflows", file), "utf8")) as Workflow;
const prepare = load("release-prepare.yml"), tag = load("release-tag.yml");

test("Prepare release is a manual, main-only, token-gated button with one release at a time", () => {
  expect(Object.keys(prepare.on)).toEqual(["workflow_dispatch"]);
  expect(prepare.on.workflow_dispatch.inputs.bump).toMatchObject({ type: "choice", options: ["auto", "patch", "minor", "major"], default: "auto" });
  expect(prepare.permissions).toEqual({});
  expect(prepare.concurrency?.group).toBe("release");
  const job = prepare.jobs.prepare!;
  expect(job.permissions).toEqual({ contents: "read", actions: "write" });
  expect(job.env?.GH_TOKEN).toBe("${{ secrets.RELEASE_TOKEN }}");
  // The PAT cannot dispatch workflows without the Actions permission; the job token can.
  expect(job.steps.find(s => s.name === "Dry-run the release on the PR branch")?.env?.GH_TOKEN).toBe("${{ github.token }}");
  const names = job.steps.map(s => s.name ?? s.uses ?? s.run);
  // Order matters: the dry run must pass before auto-merge is turned on.
  const at = (name: string) => names.findIndex(n => n === name);
  expect(at("Require main and the release token")).toBe(0);
  expect(at("Dry-run the release on the PR branch")).toBeGreaterThan(at("Prepare, commit and open the release PR"));
  expect(at("Turn on auto-merge")).toBeGreaterThan(at("Dry-run the release on the PR branch"));
  const script = job.steps.map(s => s.run ?? "").join("\n");
  expect(script).toContain('bun scripts/release/next-version.ts "$BUMP"');
  expect(script).toContain('bun run release:prepare "$VERSION"');
  expect(script).toContain('git commit -s -m "chore: release $VERSION"');
  expect(script).toContain("-f dry_run=true");
  expect(script).toContain("gh run watch \"$run\" --repo \"$GITHUB_REPOSITORY\" --interval 30 --exit-status");
  expect(script).toContain('gh pr merge "$URL" --auto --squash');
  expect(job.steps.find(s => s.name === "Report a failed dry run on the PR")?.if).toBe("failure() && steps.pr.outputs.url != ''");
});

test("Release tag only reacts to release commits on main and pushes with the release token", () => {
  expect(tag.on).toEqual({ push: { branches: ["main"] } });
  expect(tag.permissions).toEqual({});
  const job = tag.jobs.tag!;
  expect(job.if).toBe("startsWith(github.event.head_commit.message, 'chore: release ')");
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
const runTag = (work: string, sha: string, subject: string) =>
  Bun.spawnSync(["bash", "-e", "-c", script], { cwd: work, env: { ...process.env, GH_TOKEN: "test-token", GH_READ_TOKEN: "read-token", SUBJECT: subject, GITHUB_SHA: sha, GITHUB_REPOSITORY: "fixture/repo", PATH: `${join(work, "bin")}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: join(work, "summary") }, stdout: "pipe", stderr: "pipe" });

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
