import type { ExperimentIdentity } from "./experiment-identity";

export type CandidateIdentity = Omit<ExperimentIdentity, "variant">;
// A lower bound for build viability only. Never a release, and never a 30-minute release result.
export const benchmarkRepository = "lamtuanvu/pacer";
export const benchmarkBranch = "benchmark/release-build-lower-bound";
export const benchmarkRef = `refs/heads/${benchmarkBranch}`;
export const benchmarkWorkflowPath = ".github/workflows/release-build-benchmark.yml";
export const benchmarkLimitations = [
  "Lower bound only: excludes Prepare PR, review and merge, tag creation, signing, notarization, publication and post-publication verification.",
  "Unsigned builds, focused validation and a no-write promotion simulation; the full test suite is not on this critical path.",
  "Fresh GitHub-hosted runners with no caches; one trial observes current queue conditions and does not predict others.",
  "Exceeding 1800 seconds disproves a 30-minute release on this design; finishing within it does not prove one.",
];
// Fixed native runners avoid cross-platform smoke claims. No signing keys or caches.
export const platforms = [
  { platform: "darwin-arm64", runner: "macos-15", target: "aarch64-apple-darwin", bundles: "app", arch: "aarch64" },
  { platform: "darwin-x64", runner: "macos-15-intel", target: "x86_64-apple-darwin", bundles: "app", arch: "x86_64" },
  { platform: "linux-x64", runner: "ubuntu-24.04", target: "x86_64-unknown-linux-gnu", bundles: "appimage,deb", arch: "x86_64" },
  { platform: "linux-arm64", runner: "ubuntu-24.04-arm", target: "aarch64-unknown-linux-gnu", bundles: "appimage,deb", arch: "aarch64" },
] as const;
export const variants = platforms.flatMap(p => [
  { id: `cli-${p.platform}`, ...p, target: p.target.replace("linux-gnu", "linux-musl"), bundles: "none", profile: "release", bun: "1.4.2", rust: "1.99.0", cache: "disabled", signing: "unsigned" },
  { id: `desktop-${p.platform}`, ...p, profile: "release", bun: "1.4.2", rust: "1.99.0", cache: "disabled", signing: "unsigned" },
]);
export const requiredJobs = ["candidate", "focused", ...variants.map(v => v.id), "promotion"];
export const jobDependencies: Record<string, string[]> = {
  candidate: [], focused: ["candidate"],
  ...Object.fromEntries(variants.map(v => [v.id, v.id.startsWith("cli-") ? ["candidate"] : ["candidate", v.id.replace("desktop-", "cli-")]])),
  promotion: requiredJobs.filter(name => name !== "promotion"), report: requiredJobs,
};

export interface BenchmarkStep {
  name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null;
}
export interface BenchmarkJob extends BenchmarkStep {
  id: number; run_id: number; head_sha: string; created_at?: string; steps: BenchmarkStep[];
}

function timestamp(value: string | null | undefined): number | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

/** Jobs are fetched from the current attempt endpoint, never from a latest-run search. */
export function benchmarkReport(identity: CandidateIdentity, t0: string, jobs: BenchmarkJob[], observedAt: string, pushedAt?: string | null) {
  const start = timestamp(t0), observed = timestamp(observedAt), pushed = timestamp(pushedAt);
  if (start === null || observed === null || observed < start) throw Error("Invalid benchmark clock");
  const problems: string[] = [];
  const expected = new Set(requiredJobs);
  const rows = jobs.map(job => {
    const created = timestamp(job.created_at), began = timestamp(job.started_at), ended = timestamp(job.completed_at);
    const dependencyEnds = (jobDependencies[job.name] ?? []).map(name => timestamp(jobs.find(j => j.name === name)?.completed_at));
    const ready = dependencyEnds.some(time => time === null) ? null : Math.max(start, ...dependencyEnds as number[]);
    // The report job is necessarily still running. Its own final duration belongs to the hosted run UI.
    const required = expected.has(job.name);
    if (required) {
      if (job.run_id !== Number(identity.run) || job.head_sha !== identity.commit) problems.push(`foreign job: ${job.name}`);
      if (job.status !== "completed" || job.conclusion !== "success") problems.push(`unsuccessful job: ${job.name}`);
      if (began === null || ended === null || ready === null || began < ready || ended < began || ended > observed ||
          (created !== null && (created < start || began < created))) problems.push(`invalid timing: ${job.name}`);
      if (!Array.isArray(job.steps) || !job.steps.length) problems.push(`missing stages: ${job.name}`);
    } else if (job.name !== "report") problems.push(`unexpected job: ${job.name}`);
    const setup = (job.steps ?? []).find(step => step.name === "Set up job");
    const setupEnd = timestamp(setup?.completed_at);
    const steps = (job.steps ?? []).map(step => {
      const a = timestamp(step.started_at), b = timestamp(step.completed_at);
      if (required && step.status !== "completed") problems.push(`incomplete stage: ${job.name}/${step.name}`);
      if (required && step.conclusion !== "skipped" && (a === null || b === null || b < a || began === null || ended === null || a < began || b > ended)) problems.push(`invalid stage timing: ${job.name}/${step.name}`);
      return { name: step.name, conclusion: step.conclusion, startedAt: step.started_at, completedAt: step.completed_at,
        seconds: a === null || b === null || b < a ? null : (b - a) / 1000 };
    });
    return { name: job.name, id: job.id, conclusion: job.conclusion, createdAt: job.created_at,
      startedAt: job.started_at, completedAt: job.completed_at,
      // This measures job creation to start; dependency wait is reported separately.
      queueSeconds: created === null || began === null ? null : (began - created) / 1000,
      dependenciesReadyAt: ready === null ? null : new Date(ready).toISOString(),
      dependencyReadyToStartSeconds: ready === null || began === null ? null : (began - ready) / 1000,
      dispatchToCreatedSeconds: created === null ? null : (created - start) / 1000,
      // Queue plus runner setup: dependencies ready (t0 for roots) until "Set up job" completes.
      setupCompletedAt: setup?.completed_at ?? null,
      setupSeconds: began === null || setupEnd === null ? null : (setupEnd - began) / 1000,
      queuePlusSetupSeconds: ready === null || setupEnd === null ? null : (setupEnd - ready) / 1000,
      runSeconds: began === null || ended === null ? null : (ended - began) / 1000, steps };
  });
  for (const name of requiredJobs) if (jobs.filter(j => j.name === name).length !== 1) problems.push(`missing or duplicate job: ${name}`);
  const complete = problems.length === 0;
  const end = complete ? Math.max(...jobs.filter(j => expected.has(j.name)).map(j => timestamp(j.completed_at)!)) : observed;
  const elapsedSeconds = (end - start) / 1000;
  // Exceeding the deadline disproves viability even when incomplete; within it is never a release result.
  const lowerBound = elapsedSeconds > 1800 ? "EXCEEDS_DEADLINE" : complete ? "WITHIN_DEADLINE" : "UNVERIFIED";
  return { kind: "hosted-lower-bound-build-benchmark", identity, pushedAt: pushedAt ?? null, t0, observedAt,
    pushToRunCreatedSeconds: pushed === null ? null : (start - pushed) / 1000,
    elapsedSeconds, observedSeconds: (observed - start) / 1000,
    deadlineSeconds: 1800, lowerBound, fullReleaseDeadline: "UNVERIFIED",
    verdict: complete && lowerBound === "WITHIN_DEADLINE" ? "PASS" : "FAIL", limitations: benchmarkLimitations, problems, jobs: rows };
}

export function benchmarkMarkdown(report: ReturnType<typeof benchmarkReport>): string {
  return [`# Hosted lower-bound build benchmark (not a release): ${report.verdict}`,
    "", "**This is not a 30-minute release result.** Full release deadline: **UNVERIFIED**.",
    ...report.limitations.map(l => `- ${l}`), "",
    `Candidate: ${report.identity.commit}; version ${report.identity.version}; run ${report.identity.run}, attempt ${report.identity.attempt}.`,
    `Push received: ${report.pushedAt ?? "unavailable"} (push → run created ${report.pushToRunCreatedSeconds ?? "unavailable"}s).`,
    `Run created (t0): ${report.t0}. Lower-bound elapsed: ${report.elapsedSeconds}s. Lower bound vs 1800s: **${report.lowerBound}**.`,
    `Observation: ${report.observedAt} (${report.observedSeconds}s since t0). Reporting/upload tail is excluded from promotion latency.`,
    "", "| Job | Conclusion | t0 → created s | Created → start s | Dependencies ready → start s | Setup s | Ready → setup done s | Run s |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.jobs.map(j => `| ${j.name} | ${j.conclusion ?? "pending"} | ${j.dispatchToCreatedSeconds ?? "unavailable"} | ${j.queueSeconds ?? "unavailable"} | ${j.dependencyReadyToStartSeconds ?? "unavailable"} | ${j.setupSeconds ?? "unavailable"} | ${j.queuePlusSetupSeconds ?? "unavailable"} | ${j.runSeconds ?? "pending"} |`),
    "", "Dependencies-ready → start includes scheduler and runner queue/handoff delay; it is not pure runner queue. The Jobs API may omit creation timestamps; those raw queue fields are explicitly unavailable. Raw stage timestamps are retained in JSON.",
    ...report.jobs.flatMap(j => ["", `Stages: ${j.name}`, ...j.steps.map(s => `- ${s.name}: ${s.seconds ?? "?"}s (${s.conclusion ?? "pending"})`)]),
    "", ...report.problems.map(p => `- FAIL: ${p}`),
    "", "Simulation only: no release, tag, registry, feed or production state was written. Full suite remains in existing CI; signing, notarization and distribution are UNVERIFIED.", ""].join("\n");
}
