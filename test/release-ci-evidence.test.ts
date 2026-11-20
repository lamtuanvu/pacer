import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { awaitCiEvidence, fullSuitePassed, GATE_JOBS, LINUX_SHARD_PREFIX, MACOS_JOB, MACOS_STEP, SUITE_STEP, type Ci, type CiJob, type CiRun } from "../scripts/release/ci-evidence";

const SHA = "a".repeat(40);
const SHARDS = [0, 1, 2].map(shard => `${LINUX_SHARD_PREFIX}${shard})`);
const suite = (conclusion: string | null = "success", skip?: string, job = conclusion === "skipped" ? "success" : conclusion): CiJob[] => [
  ...GATE_JOBS.map(name => ({ name, conclusion: "success" })),
  ...SHARDS.map(name => ({ name, conclusion: job, steps: [{ name: "Set up job", conclusion: "success" }, { name: SUITE_STEP, conclusion }] })),
  { name: MACOS_JOB, conclusion: "success", steps: [{ name: MACOS_STEP, conclusion: "success" }] },
].filter(item => item.name !== skip);
const ciRun = (id: number, event: string, status = "completed", created = 0): CiRun =>
  ({ id, event, status, conclusion: status === "completed" ? "success" : null, created_at: new Date(created).toISOString(), html_url: `run/${id}` });

function fake(script: (tick: number, dispatched: number | undefined) => CiRun[], jobs: Record<number, CiJob[]>, head = SHA) {
  let clock = 0, tick = 0, dispatched: number | undefined;
  const refs: string[] = [];
  const ci: Ci = {
    runs: async () => script(tick, dispatched),
    jobs: async id => jobs[id] ?? [],
    refSha: async () => head,
    dispatch: async ref => { refs.push(ref); dispatched = clock; },
    sleep: async ms => { clock += ms; tick++; },
    now: () => clock,
  };
  return { ci, refs };
}

test("only passing gates, executed Linux shards and an executed macOS job count", () => {
  expect(fullSuitePassed(suite())).toBe(true);
  expect(fullSuitePassed(suite("skipped"))).toBe(false);
  expect(fullSuitePassed(suite("failure"))).toBe(false);
  expect(fullSuitePassed(suite("success", undefined, "failure"))).toBe(false);
  for (const missing of [...GATE_JOBS, MACOS_JOB]) expect(fullSuitePassed(suite("success", missing))).toBe(false);
  const change = (name: string, patch: Partial<CiJob>) => suite().map(job => job.name === name ? { ...job, ...patch } : job);
  for (const gate of GATE_JOBS) expect(fullSuitePassed(change(gate, { conclusion: "failure" }))).toBe(false);
  expect(fullSuitePassed(change(MACOS_JOB, { conclusion: "failure" }))).toBe(false);
  expect(fullSuitePassed(change(MACOS_JOB, { steps: [{ name: MACOS_STEP, conclusion: "skipped" }] }))).toBe(false);
});

test("the shard count can change, but a run without any Linux shard never counts", () => {
  const others = suite().filter(job => !job.name.startsWith(LINUX_SHARD_PREFIX));
  const shard = (index: number): CiJob => ({ name: `${LINUX_SHARD_PREFIX}${index})`, conclusion: "success", steps: [{ name: SUITE_STEP, conclusion: "success" }] });
  for (const count of [1, 8, 16]) expect(fullSuitePassed([...others, ...Array.from({ length: count }, (_, index) => shard(index))])).toBe(true);
  expect(fullSuitePassed(others)).toBe(false);
  // A documentation-only run passes both gates and the single shard's job without executing the suite.
  expect(fullSuitePassed([...others.filter(job => job.name !== MACOS_JOB), { ...shard(0), steps: [{ name: SUITE_STEP, conclusion: "skipped" }] }])).toBe(false);
});

test("the required job and step names match CI's jobs", () => {
  const jobs = (Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any).jobs;
  expect(jobs.test.name.replace("${{ matrix.os }}", jobs.test.strategy.matrix.os[0]).replace("${{ matrix.shard }})", "")).toBe(LINUX_SHARD_PREFIX);
  expect(jobs.test.steps.map((step: any) => step.name)).toContain(SUITE_STEP);
  expect(jobs["macos-tests"].name).toBe(MACOS_JOB);
  expect(jobs["macos-tests"].steps.map((step: any) => step.name)).toContain(MACOS_STEP);
  expect(jobs["test-result"].strategy.matrix.os.map((os: string) => jobs["test-result"].name.replace("${{ matrix.os }}", os)).sort()).toEqual([...GATE_JOBS].sort());
});

test("an existing passing run is reused without dispatching", async () => {
  const { ci, refs } = fake(() => [ciRun(2, "push")], { 2: suite() });
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).id).toBe(2);
  expect(refs).toEqual([]);
});

test("pull request runs never count, even with a passing suite", async () => {
  const { ci, refs } = fake((_, d) => d === undefined ? [ciRun(1, "pull_request")] : [ciRun(1, "pull_request"), ciRun(3, "workflow_dispatch", "completed", d)], { 1: suite(), 3: suite() });
  expect((await awaitCiEvidence(ci, SHA, "release/v1.2.3", 1e9, () => {})).id).toBe(3);
  expect(refs).toEqual(["release/v1.2.3"]);
});

test("an in-progress pull request run is not awaited", async () => {
  const { ci, refs } = fake((_, d) => d === undefined ? [ciRun(10, "pull_request", "in_progress")] : [ciRun(10, "pull_request", "in_progress"), ciRun(11, "workflow_dispatch", "completed", d)], { 11: suite() });
  expect((await awaitCiEvidence(ci, SHA, "release/v1.2.3", 1e9, () => {})).id).toBe(11);
  expect(refs).toEqual(["release/v1.2.3"]);
});

test("a ref that moved off the release commit fails before dispatching", async () => {
  const { ci, refs } = fake(() => [], {}, "b".repeat(40));
  await expect(awaitCiEvidence(ci, SHA, "release/v1.2.3", 1e9, () => {})).rejects.toThrow("would test another commit");
  expect(refs).toEqual([]);
});

test("an in-progress run is awaited instead of dispatching another", async () => {
  const { ci, refs } = fake(tick => [ciRun(4, "push", tick < 3 ? "in_progress" : "completed")], { 4: suite() });
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).id).toBe(4);
  expect(refs).toEqual([]);
});

test("a path-filtered run leads to one dispatch on the release ref", async () => {
  const { ci, refs } = fake((tick, d) => d === undefined ? [ciRun(5, "push")] : [ciRun(5, "push"), ciRun(6, "workflow_dispatch", tick < 4 ? "queued" : "completed", d)], { 5: suite("skipped"), 6: suite() });
  expect((await awaitCiEvidence(ci, SHA, "v1.2.3", 1e9, () => {})).id).toBe(6);
  expect(refs).toEqual(["v1.2.3"]);
});

test("a failing dispatched run fails the gate without dispatching again", async () => {
  const { ci, refs } = fake((_, d) => d === undefined ? [] : [ciRun(7, "workflow_dispatch", "completed", d)], { 7: suite("failure") });
  await expect(awaitCiEvidence(ci, SHA, "release/recovery-v1.2.3-abc", 1e9, () => {})).rejects.toThrow("finished without a passing Linux suite and macOS job");
  expect(refs).toHaveLength(1);
});

test("a rerun of a checked run is examined again", async () => {
  const { ci, refs } = fake(tick => [ciRun(8, "push", tick === 1 ? "in_progress" : "completed")], {});
  let attempt = 0;
  ci.jobs = async () => (attempt++ === 0 ? suite("skipped") : suite());
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).id).toBe(8);
  expect(attempt).toBe(2);
  expect(refs).toEqual(["main"]);
});

test("waiting is bounded by the deadline", async () => {
  const { ci } = fake(() => [ciRun(9, "push", "in_progress")], {});
  await expect(awaitCiEvidence(ci, SHA, "main", 120_000, () => {})).rejects.toThrow("Timed out");
});

test("the aggregate jobs carry the check names main's ruleset requires", () => {
  const ci = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
  const aggregate = ci.jobs["test-result"];
  const names = aggregate.strategy.matrix.os.map((os: string) => aggregate.name.replace("${{ matrix.os }}", os));
  // Renaming the matrix label (not just the runner) leaves these required checks unreported and blocks every PR.
  expect(names.sort()).toEqual(["Test (macos-latest)", "Test (ubuntu-latest)"]);
});


test("with dispatch off, missing evidence fails instead of dispatching", async () => {
  const { ci, refs } = fake(() => [ciRun(5, "push")], { 5: suite("skipped") });
  let refChecked = false;
  ci.refSha = async () => { refChecked = true; return "b".repeat(40); };
  await expect(awaitCiEvidence(ci, SHA, "main", 1e9, () => {}, { dispatch: false })).rejects.toThrow("no CI evidence");
  expect(refs).toEqual([]);
  // The ref is only consulted before a dispatch; a moved main does not matter here.
  expect(refChecked).toBe(false);
  const empty = fake(() => [], {});
  await expect(awaitCiEvidence(empty.ci, SHA, "main", 1e9, () => {}, { dispatch: false })).rejects.toThrow("no CI evidence");
  expect(empty.refs).toEqual([]);
});

test("with dispatch off, an in-progress run is still awaited", async () => {
  const { ci, refs } = fake(tick => [ciRun(4, "push", tick < 3 ? "in_progress" : "completed")], { 4: suite() });
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {}, { dispatch: false })).id).toBe(4);
  expect(refs).toEqual([]);
});

test("CI_NO_DISPATCH=1 turns dispatch off and makes CI_REF optional", () => {
  const result = Bun.spawnSync([process.execPath, "scripts/release/ci-evidence.ts"], {
    env: { ...process.env, GITHUB_REPOSITORY: "", CI_SHA: SHA, CI_REF: "", CI_NO_DISPATCH: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("GITHUB_REPOSITORY and CI_SHA are required");
});

test("dispatched runs and pushes to main have their own concurrency groups and are never cancelled", () => {
  const { concurrency } = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
  // Evaluates the group and cancel expressions; GitHub's null-safe property access, `==`, `&&`, `||` and format() behave like these JS equivalents here.
  const evaluate = (template: string, github: Record<string, any>) => String(template).replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => {
    const format = (pattern: string, ...values: string[]) => pattern.replace(/\{(\d+)\}/g, (_m, i) => values[Number(i)]!);
    return String(new Function("github", "format", `return (${expression.replaceAll("'", '"').replaceAll(".", "?.")});`)(github, format));
  });
  const context = (event_name: string, sha: string, extra: Record<string, any> = {}) =>
    ({ workflow: "CI", event_name, sha, ref: "refs/heads/main", event: {}, ...extra });
  const push = context("push", "1".repeat(40));
  const dispatch = context("workflow_dispatch", "1".repeat(40));
  const pr = context("pull_request", "2".repeat(40), { ref: "refs/pull/7/merge", event: { pull_request: { number: 7 } } });
  const group = (github: Record<string, any>) => evaluate(concurrency.group, github);
  // Every push to main has its own per-commit group and is never cancelled, so a later merge cannot
  // cancel the post-merge validation Prepare release reads (amendment 0.24.0).
  expect(group(push)).toBe(`CI-refs/heads/main-push-${"1".repeat(40)}`);
  expect(group(context("push", "3".repeat(40)))).not.toBe(group(push));
  expect(evaluate(concurrency["cancel-in-progress"], push)).toBe("false");
  // Pushes to other branches keep one cancellable group per ref.
  const branch = context("push", "4".repeat(40), { ref: "refs/heads/topic" });
  expect(group(branch)).toBe("CI-refs/heads/topic-");
  expect(evaluate(concurrency["cancel-in-progress"], branch)).toBe("true");
  expect(group(pr)).toBe(`CI-7-${"2".repeat(40)}`);
  expect(group(context("schedule", "1".repeat(40)))).toBe("CI-refs/heads/main-");
  expect(group(dispatch)).toBe(`CI-refs/heads/main-dispatch-${"1".repeat(40)}`);
  expect(group(dispatch)).not.toBe(group(push));
  expect(evaluate(concurrency["cancel-in-progress"], dispatch)).toBe("false");
});

test("a failed full suite on the commit skips instead of dispatching another run", async () => {
  const { ci, refs } = fake(() => [ciRun(12, "push"), ciRun(13, "push")], { 12: suite("skipped"), 13: suite("failure") });
  await expect(awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).rejects.toThrow("it failed (run/13); not dispatching");
  expect(refs).toEqual([]);
  // A failed macOS-specific suite is a result too.
  const macFailed = suite().map(job => job.name === MACOS_JOB ? { ...job, conclusion: "failure", steps: [{ name: MACOS_STEP, conclusion: "failure" }] } : job);
  const mac = fake(() => [ciRun(16, "push")], { 16: macFailed });
  await expect(awaitCiEvidence(mac.ci, SHA, "main", 1e9, () => {})).rejects.toThrow("it failed (run/16); not dispatching");
  expect(mac.refs).toEqual([]);
  // A suite that never ran (path filter, or a job that failed before the suite step) is no result, so CI is dispatched.
  const unrun = fake((_, d) => d === undefined ? [ciRun(14, "push")] : [ciRun(14, "push"), ciRun(15, "workflow_dispatch", "completed", d)],
    { 14: suite("skipped", undefined, "failure"), 15: suite() });
  expect((await awaitCiEvidence(unrun.ci, SHA, "main", 1e9, () => {})).id).toBe(15);
  expect(unrun.refs).toEqual(["main"]);
});

test("a ref that moves around the dispatch fails soon instead of waiting out the deadline", async () => {
  const { ci, refs } = fake(() => [], {});
  let calls = 0;
  ci.refSha = async () => (calls++ === 0 ? SHA : "b".repeat(40));
  const started = ci.now();
  await expect(awaitCiEvidence(ci, SHA, "main", 90 * 60_000, () => {})).rejects.toThrow("the dispatch tested another commit");
  expect(refs).toEqual(["main"]);
  expect(ci.now() - started).toBeLessThanOrEqual(150_000);
});

test("a dispatched run on the commit is still awaited after the ref moves", async () => {
  const { ci, refs } = fake((tick, d) => d === undefined ? [] : [ciRun(16, "workflow_dispatch", tick < 10 ? "in_progress" : "completed", d)], { 16: suite() });
  let calls = 0;
  ci.refSha = async () => (calls++ === 0 ? SHA : "b".repeat(40));
  expect((await awaitCiEvidence(ci, SHA, "main", 1e9, () => {})).id).toBe(16);
  expect(refs).toEqual(["main"]);
});
