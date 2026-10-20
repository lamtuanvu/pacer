import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.env?.GH_TOKEN).toBe("${{ secrets.RELEASE_TOKEN }}");
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
  return { origin, work, sha: git(work, "rev-parse", "HEAD") };
}
const script = tag.jobs.tag!.steps.find(s => s.name === "Tag the release commit")!.run!;
const runTag = (work: string, sha: string, subject: string) =>
  Bun.spawnSync(["bash", "-e", "-c", script], { cwd: work, env: { ...process.env, GH_TOKEN: "test-token", SUBJECT: subject, GITHUB_SHA: sha, GITHUB_STEP_SUMMARY: join(work, "summary") }, stdout: "pipe", stderr: "pipe" });

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
