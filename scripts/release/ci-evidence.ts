#!/usr/bin/env bun
// Release publication relies on CI for the exact release commit instead of rerunning it: the full suite
// on Linux and the macOS-specific files on macOS.
export const SUITE_STEP = "Test (full suite, sharded)";
/** The required checks; they also pass on documentation-only runs, so they are not sufficient alone. */
export const GATE_JOBS = ["Test (ubuntu-latest)", "Test (macos-latest)"];
export const LINUX_SHARD_PREFIX = "Test (ubuntu-latest, shard ";
export const MACOS_JOB = "Test (macos-latest, macOS-specific)";
export const MACOS_STEP = "Test (macOS-specific files)";

export type CiRun = { id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url: string };
export type CiJob = { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] };
export type Ci = {
  runs(sha: string): Promise<CiRun[]>;
  jobs(run: number): Promise<CiJob[]>;
  refSha(ref: string): Promise<string>;
  dispatch(ref: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

const ran = (job: CiJob, step: string) => job.conclusion === "success" && job.steps?.some(item => item.name === step && item.conclusion === "success") === true;

/** Both gates passed and the suite really executed: every Linux shard, however many there are, and the macOS job. */
export function fullSuitePassed(jobs: CiJob[]): boolean {
  const shards = jobs.filter(job => job.name.startsWith(LINUX_SHARD_PREFIX));
  return GATE_JOBS.every(name => jobs.some(job => job.name === name && job.conclusion === "success"))
    && shards.length > 0 && shards.every(job => ran(job, SUITE_STEP))
    && jobs.some(job => job.name === MACOS_JOB && ran(job, MACOS_STEP));
}

/** A suite step that ran and failed is a full-suite result; a skipped or missing step (path filter, earlier failure) is not. */
export function fullSuiteFailed(jobs: CiJob[]): boolean {
  const failedStep = (job: CiJob, step: string) => job.steps?.some(item => item.name === step && item.conclusion === "failure") === true;
  return jobs.some(job => (job.name.startsWith(LINUX_SHARD_PREFIX) && failedStep(job, SUITE_STEP)) || (job.name === MACOS_JOB && failedStep(job, MACOS_STEP)));
}

/** A dispatched run normally appears within seconds; past this grace, a moved ref means the dispatch tested another commit. */
const DISPATCH_GRACE_MS = 120_000;

export type CiEvidenceOptions = { dispatch: boolean };

/** Waits for a passing full suite on `sha`. With `dispatch` off (release.yml for a nightly tag), missing evidence fails instead of starting CI on `ref`. */
export async function awaitCiEvidence(ci: Ci, sha: string, ref: string, deadline: number, log = console.log, options: CiEvidenceOptions = { dispatch: true }): Promise<CiRun> {
  const checked = new Set<number>();
  let dispatchedAt: number | undefined;
  let failed: string | undefined;
  while (ci.now() < deadline) {
    const runs = (await ci.runs(sha)).filter(run => run.event !== "pull_request").sort((a, b) => b.id - a.id);
    for (const run of runs.filter(run => run.status === "completed" && !checked.has(run.id))) {
      checked.add(run.id);
      const jobs = await ci.jobs(run.id);
      if (fullSuitePassed(jobs)) return run;
      if (fullSuiteFailed(jobs)) failed = run.html_url;
      log(`CI run without a passing Linux suite and macOS job: ${run.html_url}`);
    }
    const pending = runs.filter(run => run.status !== "completed");
    for (const run of pending) checked.delete(run.id);
    if (pending.length) log(`Waiting for CI: ${pending.map(run => run.html_url).join(", ")}`);
    else if (!options.dispatch) {
      throw Error(`no CI evidence for ${sha}: no CI run passed the full suite on both OSes, and dispatch is off`);
    } else if (failed && dispatchedAt === undefined) {
      // A failed full suite is the answer for this commit: dispatching again would retry until it passes.
      throw Error(`CI ran the full suite on ${sha} and it failed (${failed}); not dispatching another run`);
    } else if (dispatchedAt === undefined) {
      const head = await ci.refSha(ref);
      if (head !== sha) throw Error(`${ref} now points at ${head}, not ${sha}; CI dispatched there would test another commit`);
      log(`No usable CI run for ${sha}; dispatching CI on ${ref}`);
      await ci.dispatch(ref);
      dispatchedAt = ci.now();
    } else if (runs.some(run => run.event === "workflow_dispatch" && Date.parse(run.created_at) >= dispatchedAt! - 60_000)) {
      throw Error(`Dispatched CI for ${sha} finished without a passing Linux suite and macOS job`);
    } else if (ci.now() - dispatchedAt >= DISPATCH_GRACE_MS) {
      // No run on the commit appeared after the dispatch: if the ref moved, the dispatch ran on another commit.
      const head = await ci.refSha(ref);
      if (head !== sha) throw Error(`${ref} moved to ${head} and no dispatched CI run appeared for ${sha}; the dispatch tested another commit`);
    }
    await ci.sleep(30_000);
  }
  throw Error(`Timed out waiting for CI evidence for ${sha}`);
}

function gh(args: string[]): string {
  const result = Bun.spawnSync(["gh", ...args], { stderr: "inherit" });
  if (result.exitCode !== 0) throw Error(`gh ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString();
}

export function githubCi(repo: string): Ci {
  return {
    runs: async sha => JSON.parse(gh(["api", `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`])).workflow_runs,
    jobs: async run => JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`])).flatMap((page: { jobs: CiJob[] }) => page.jobs),
    refSha: async ref => gh(["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`, "--jq", ".sha"]).trim(),
    dispatch: async ref => { gh(["workflow", "run", "ci.yml", "--repo", repo, "--ref", ref]); },
    sleep: ms => Bun.sleep(ms),
    now: () => Date.now(),
  };
}

if (import.meta.main) {
  const { GITHUB_REPOSITORY: repo, CI_SHA: sha, CI_REF: ref } = process.env;
  // release.yml never dispatches CI for a nightly tag: nightly.yml already required (or dispatched) evidence for the main commit.
  const dispatch = process.env.CI_NO_DISPATCH !== "1";
  if (!repo || !sha) throw Error("GITHUB_REPOSITORY and CI_SHA are required");
  if (dispatch && !ref) throw Error("CI_REF is required unless CI_NO_DISPATCH=1");
  const minutes = Number(process.env.CI_EVIDENCE_MINUTES ?? 140);
  const run = await awaitCiEvidence(githubCi(repo), sha, ref ?? sha, Date.now() + minutes * 60_000, console.log, { dispatch });
  console.log(`CI passed the Linux suite and macOS job for ${sha}: ${run.html_url}`);
}
