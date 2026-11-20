#!/usr/bin/env bun
// Prepare release refuses to tag a commit whose post-merge CI on main has not passed
// (amendment 0.24.0, proposed): release.yml only builds and publishes, and validation
// runs post-merge on main. This check reads the existing CI result only — it never
// dispatches, re-runs or waits for CI (nightly.yml's ci-evidence.ts keeps that job).
export const TYPECHECK_JOB = "Typecheck, UI policy and build";
export const RUST_JOBS = ["Rust (ubuntu-latest)", "Rust (macos-latest)"];
export const LINUX_SHARD_PREFIX = "Test (ubuntu-latest, shard ";
export const MACOS_TEST_JOB = "Test (macos-latest, macOS-specific)";
export const M1_GATE_JOB = "M1 gate against built release artifacts (post-merge)";
export const M1_GATE_COUNT = 2; // One post-merge gate job per runner image (ubuntu and macOS).

export type MainCiRun = { id: number; event: string; head_branch: string | null; head_sha: string; status: string; conclusion: string | null; html_url: string };
export type MainCiJob = { name: string; conclusion: string | null };

/** The CI push run on main for `sha`; several entries can exist per sha, so the newest wins. */
export function mainPushRun(runs: MainCiRun[], sha: string): MainCiRun | undefined {
  return runs.filter(run => run.event === "push" && run.head_branch === "main" && run.head_sha === sha).sort((a, b) => b.id - a.id)[0];
}

/**
 * A green result means the run completed successfully and every required job passed.
 * On push to main none of these jobs may skip or be missing (only PR-only jobs such as
 * UI review readiness may skip), so a path-filtered or partial run never counts as green.
 */
export function mainCiFailures(jobs: MainCiJob[]): string[] {
  const failures: string[] = [];
  const require = (name: string) => {
    const job = jobs.find(candidate => candidate.name === name);
    if (!job || job.conclusion !== "success") failures.push(job ? `${name} ${job.conclusion}` : `${name} (missing)`);
  };
  const shards = jobs.filter(job => job.name.startsWith(LINUX_SHARD_PREFIX));
  if (shards.length === 0) failures.push(`${LINUX_SHARD_PREFIX}… (missing)`);
  for (const shard of shards) {
    if (shard.conclusion !== "success") failures.push(`${shard.name} ${shard.conclusion}`);
  }
  require(MACOS_TEST_JOB);
  for (const name of RUST_JOBS) require(name);
  require(TYPECHECK_JOB);
  const gates = jobs.filter(job => job.name.startsWith(M1_GATE_JOB));
  if (gates.length < M1_GATE_COUNT) failures.push(`${M1_GATE_JOB} (${M1_GATE_COUNT - gates.length} of ${M1_GATE_COUNT} missing)`);
  for (const gate of gates) {
    if (gate.conclusion !== "success") failures.push(`${gate.name} ${gate.conclusion}`);
  }
  return failures;
}

export type MainCi = {
  runs(sha: string): Promise<MainCiRun[]>;
  jobs(run: number): Promise<MainCiJob[]>;
};

/** Fails with a clear message naming the run URL and the offending jobs; never dispatches CI. */
export async function requireMainCiGreen(ci: MainCi, sha: string, log = console.log): Promise<MainCiRun> {
  const run = mainPushRun(await ci.runs(sha), sha);
  if (!run) throw Error(`no CI push run on main for ${sha}: wait for CI to run it on main, then rerun Prepare release`);
  if (run.status !== "completed") {
    log(`main's post-merge CI is ${run.status}: ${run.html_url}`);
    throw Error(`main's post-merge CI is still ${run.status} for ${sha}: ${run.html_url}; wait for it to finish, then rerun Prepare release`);
  }
  if (run.conclusion !== "success") {
    const failed = (await ci.jobs(run.id)).filter(job => job.conclusion === "failure" || job.conclusion === "cancelled").map(job => job.name);
    const named = failed.length ? ` (failed: ${failed.join(", ")})` : "";
    throw Error(`main's post-merge CI ended ${run.conclusion} for ${sha}: ${run.html_url}${named}; fix main first, then rerun Prepare release`);
  }
  const missing = mainCiFailures(await ci.jobs(run.id));
  if (missing.length) {
    throw Error(`main's post-merge CI passed without the required checks for ${sha}: ${run.html_url} (${missing.join(", ")}); run a full CI pass on main, then rerun Prepare release`);
  }
  return run;
}

function gh(args: string[]): string {
  const result = Bun.spawnSync(["gh", ...args], { stderr: "inherit" });
  if (result.exitCode !== 0) throw Error(`gh ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString();
}

export function githubMainCi(repo: string): MainCi {
  return {
    runs: async sha => JSON.parse(gh(["api", `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`])).workflow_runs,
    jobs: async run => JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`])).flatMap((page: { jobs: MainCiJob[] }) => page.jobs),
  };
}

if (import.meta.main) {
  const { GITHUB_REPOSITORY: repo, MAIN_CI_SHA: sha } = process.env;
  try {
    if (!repo || !sha) throw Error("GITHUB_REPOSITORY and MAIN_CI_SHA are required");
    const run = await requireMainCiGreen(githubMainCi(repo), sha);
    console.log(`main's post-merge CI passed for ${sha}: ${run.html_url}`);
  } catch (e) {
    console.error(`::error::${(e as Error).message}`);
    process.exit(1);
  }
}
