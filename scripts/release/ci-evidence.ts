#!/usr/bin/env bun
// Release publication relies on CI's full suite for the exact release commit instead of rerunning it.
export const SUITE_STEP = "Test (full suite, sharded)";
export const SUITE_JOBS = ["ubuntu-latest", "macos-latest"].flatMap(os => [0, 1, 2, 3].map(shard => `Test (${os}, shard ${shard})`));

export type CiRun = { id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url: string };
export type CiJob = { name: string; steps?: { name: string; conclusion: string | null }[] };
export type Ci = {
  runs(sha: string): Promise<CiRun[]>;
  jobs(run: number): Promise<CiJob[]>;
  dispatch(ref: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

/** Path-filtered and pull-request runs skip the suite step, so only an executed, passing step counts. */
export function fullSuitePassed(jobs: CiJob[]): boolean {
  return SUITE_JOBS.every(name => jobs.some(job => job.name === name && job.steps?.some(step => step.name === SUITE_STEP && step.conclusion === "success")));
}

export async function awaitCiEvidence(ci: Ci, sha: string, ref: string, deadline: number, log = console.log): Promise<CiRun> {
  const checked = new Set<number>();
  let dispatchedAt: number | undefined;
  while (ci.now() < deadline) {
    const runs = (await ci.runs(sha)).filter(run => run.event !== "pull_request").sort((a, b) => b.id - a.id);
    for (const run of runs.filter(run => run.status === "completed" && !checked.has(run.id))) {
      checked.add(run.id);
      if (fullSuitePassed(await ci.jobs(run.id))) return run;
      log(`CI run without a passing full suite on both OSes: ${run.html_url}`);
    }
    const pending = runs.filter(run => run.status !== "completed");
    for (const run of pending) checked.delete(run.id);
    if (pending.length) log(`Waiting for CI: ${pending.map(run => run.html_url).join(", ")}`);
    else if (dispatchedAt === undefined) {
      log(`No usable CI run for ${sha}; dispatching CI on ${ref}`);
      await ci.dispatch(ref);
      dispatchedAt = ci.now();
    } else if (runs.some(run => run.event === "workflow_dispatch" && Date.parse(run.created_at) >= dispatchedAt! - 60_000)) {
      throw Error(`Dispatched CI for ${sha} finished without a passing full suite on both OSes`);
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
    dispatch: async ref => { gh(["workflow", "run", "ci.yml", "--repo", repo, "--ref", ref]); },
    sleep: ms => Bun.sleep(ms),
    now: () => Date.now(),
  };
}

if (import.meta.main) {
  const { GITHUB_REPOSITORY: repo, CI_SHA: sha, CI_REF: ref } = process.env;
  if (!repo || !sha || !ref) throw Error("GITHUB_REPOSITORY, CI_SHA and CI_REF are required");
  const minutes = Number(process.env.CI_EVIDENCE_MINUTES ?? 140);
  const run = await awaitCiEvidence(githubCi(repo), sha, ref, Date.now() + minutes * 60_000);
  console.log(`CI passed the full suite on both OSes for ${sha}: ${run.html_url}`);
}
